// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Web Serial adapter for esp-flasher.js: open/reopen at a baud, pump RX to a sink, write,
// and the DTR/RTS reset pulses that drive the ESP into the ROM download loader and back to
// run. Used only while flashing (the HCI session must be disconnected first). Reset
// sequences mirror esptool's classic reset. Port backend is getSerial() (Web Serial / WebUSB shim).

import { getSerial, serialSupported } from '../transport/serial.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ESP auto-reset into download mode, mirrored from esptool-js (the Web Serial port of esptool) — its
// ClassicReset is the proven button-free sequence for a browser/Web Serial environment, NOT esptool.py's
// "UnixTightReset" (that's tuned for pyserial on Linux). Per its src/esploader.ts constructResetSequence,
// for a USB-UART bridge esptool-js runs ClassicReset twice each round — a short 50ms GPIO0-low hold then
// a long 550ms (DEFAULT_RESET_DELAY + 500) hold for boards with a slow auto-reset RC circuit (and ESP32
// silicon rev 0). connect() alternates these across its retries; the long hold is what lets a fresh board
// strap into download mode with no BOOT button press.
const RESET_HOLDS = [50, 550];

export class FlashSerial {
  constructor() {
    this.port = null;
    this.writer = null;
    this.reader = null;
    this._keep = false;
    this._loop = null;
    this.onBytes = null; // (Uint8Array) => void
    this.onLog = null;   // (msg) => void — surfaces the reset sequence in the flash log
  }

  static get supported() {
    return serialSupported();
  }

  /**
   * Set DTR (→GPIO0) and RTS (→/EN) together in ONE Web Serial setSignals call. This is deliberately
   * NOT esptool-js's separate setDTR/setRTS: in Chromium one setSignals is a single mojo message →
   * a single SerialIoHandlerPosix::SetControlSignals → its two TIOCMBIS/TIOCMBIC ioctls run back-to-back
   * on the device thread, MICROSECONDS apart. Two *separate* setSignals calls are two mojo round-trips,
   * MILLISECONDS apart — long enough that during the (0,1)→(1,1)→(1,0) reset transition the EN capacitor
   * (RC ~ms) crosses threshold while GPIO0 is still high, so the chip boots normally instead of strapping
   * into download. Combining keeps the intermediate glitch sub-µs (≈ esptool.py's atomic TIOCMSET) and
   * also carries DTR in every request (handles the Windows usbser.sys RTS-latch quirk for free).
   */
  sig(dtr, rts) {
    return this.port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  }

  /**
   * True when the open port is an ESP32-S3/C3/C6's *integrated* USB-Serial/JTAG peripheral
   * (VID 0x303A), not an external CP210x/CH34x/FTDI bridge. The two need different reset
   * sequences and the integrated one ignores baud changes (it's a USB CDC link).
   */
  get isUsbJtag() {
    return this.port?.getInfo?.().usbVendorId === 0x303a;
  }

  /**
   * Choose the port to flash. Prefer the exact handle passed in — the open HCI session's port —
   * so reflashing never re-prompts (a closed Web Serial port can be reopened). Otherwise reuse the
   * single granted port, or fall back to a picker (needs a user gesture) when several are granted.
   */
  async acquire(existingPort) {
    if (existingPort) { this.port = existingPort; return this.port; }
    const serial = getSerial();
    const granted = await serial.getPorts();
    this.port = granted.length === 1 ? granted[0] : await serial.requestPort();
    return this.port;
  }

  async open({ baudRate = 115200 } = {}) {
    await this.port.open({ baudRate, bufferSize: 8192, flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
  }

  /**
   * Take over an already-open port handed off from the HCI transport (keep the same connection):
   * grab a writer; startReading() then grabs the reader. No open() — the port stays open at its
   * session baud (115200, which is also the ESP ROM download baud), so the connection is preserved.
   */
  adopt(port) {
    this.port = port;
    this.writer = this.port.writable.getWriter();
  }

  startReading() {
    if (this._loop) return;
    this._keep = true;
    this._loop = this._pump();
  }

  async _pump() {
    while (this._keep) {
      // The DTR/RTS reset that drops the ESP into the download loader glitches the USB-UART line,
      // which errors the read *stream* (not the port). The old `break` here aborted the pump on that
      // first glitch, so the flasher never saw the ROM's SYNC/command replies and wrote nothing. The
      // port stays open with a fresh `readable`, so re-acquire a reader and keep feeding bytes.
      const readable = this.port?.readable;
      if (!readable) { if (!this.port) break; await sleep(30); continue; }
      try {
        this.reader = readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length && this.onBytes) this.onBytes(value);
        }
      } catch (e) {
        console.warn('[flash-serial] read stream error (recovering):', e?.message || e);
        await sleep(30);
      } finally {
        try { this.reader?.releaseLock(); } catch {}
        this.reader = null;
      }
    }
  }

  async write(data) {
    await this.writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  }

  /** /EN pulse → boot the application (GPIO0 left high so it runs, not download). */
  async rtsReset(bootWaitMs = 1000) {
    await this.sig(false, true);   // IO0=HIGH, /EN=LOW (reset)
    await sleep(100);
    await this.sig(false, false);  // IO0=HIGH, /EN=HIGH → boot the app
    await sleep(bootWaitMs);
  }

  /**
   * Drive the board into the ROM download loader via the DTR/RTS auto-reset circuit (DTR→GPIO0,
   * RTS→/EN). `attempt` alternates the GPIO0-low hold between esptool-js's 50ms and 550ms ClassicReset
   * variants (RESET_HOLDS); EspFlasher.connect() increments it each retry, so a board the short hold
   * can't strap still gets in on a long-hold try — without the user holding BOOT.
   */
  async bootloaderReset(attempt = 0) {
    if (this.isUsbJtag) return this.usbJtagReset();
    const hold = RESET_HOLDS[attempt % RESET_HOLDS.length];
    this.onLog?.(`auto-reset into download mode — classic, ${hold}ms GPIO0 hold`);
    await this.classicReset(hold);
  }

  /**
   * esptool ClassicReset, but with DTR+RTS driven together in one setSignals (see sig() — combining keeps
   * the (0,1)→(1,0) transition near-atomic on Chromium, which is what reliably straps GPIO0). `resetDelay`
   * is the GPIO0-low hold after /EN releases: 50ms default, 550ms for boards with a slow auto-reset RC
   * circuit (and ESP32 silicon rev 0).
   */
  async classicReset(resetDelay = 50) {
    await this.sig(false, true);   // IO0=HIGH, /EN=LOW (chip held in reset)
    await sleep(100);
    await this.sig(true, false);   // IO0=LOW, /EN=HIGH (released → straps into download) — both lines, one call
    await sleep(resetDelay);       // GPIO0-low hold
    await this.sig(false, false);  // IO0=HIGH (release the strap)
    await sleep(50);
  }

  /**
   * /EN pulse for the manual-BOOT fallback: toggle /EN while leaving GPIO0 (DTR) deasserted so the user's
   * *physical* BOOT button — not the auto-reset transistor — holds the download strap. The flasher loops
   * this + SYNC while the user holds BOOT, so a board whose auto-reset can't strap GPIO0 still drops into
   * the ROM loader. DTR stays low throughout, so we never fight the held button.
   */
  async manualBootReset() {
    await this.sig(false, true);   // /EN low (reset); IO0 left to the held BOOT button
    await sleep(100);
    await this.sig(false, false);  // /EN high → straps into download on the held GPIO0
    await sleep(50);
  }

  /**
   * Reset into the ROM download loader over the integrated USB-Serial/JTAG. On those chips DTR/RTS aren't
   * wired to a CP210x-style auto-reset transistor pair; the peripheral itself watches the two lines and
   * drives the CPU reset + GPIO0 strap. Ported from esptool's USBJTAGSerialReset — the transition
   * deliberately passes through DTR=RTS=1 (not 0,0) so the peripheral latches the strap. The USB-Serial/
   * JTAG lives in the always-on domain, so the port survives the reset (no re-grant).
   */
  async usbJtagReset() {
    await this.sig(false, false);     // idle
    await sleep(100);
    await this.sig(true, false);      // assert GPIO0 strap
    await sleep(100);
    await this.port.setSignals({ requestToSend: true });        // → (1,1) transient
    await this.port.setSignals({ dataTerminalReady: false });   // → (0,1): pulse CPU reset
    await sleep(100);
    await this.sig(false, false);     // release → boots into the ROM loader
    await sleep(100);
  }

  /** Web Serial can't change baud live — close and re-open the same (granted) port. */
  async reopen({ baudRate }) {
    this._keep = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this._loop; } catch {}
    this._loop = null;
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    try { await this.port.close(); } catch {}
    await this.port.open({ baudRate, bufferSize: 8192, flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    this.startReading();
  }

  async close() {
    this._keep = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this._loop; } catch {}
    this._loop = null;
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    try { await this.port?.close(); } catch {}
    this.port = null;
  }

  /**
   * Release the reader/writer locks WITHOUT closing the port — so the still-open port can be handed
   * back to the HCI transport and the same connection continues after flashing. Mirrors
   * SerialTransport.detach(); used only on the keep-the-connection (adopt) path.
   */
  async release() {
    this._keep = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this._loop; } catch {}
    this._loop = null;
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    const port = this.port;
    this.port = null;
    return port;
  }
}
