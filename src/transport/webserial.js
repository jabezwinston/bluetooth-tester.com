// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Web Serial transport. Opens a serial port chosen by the user (must be called from a
// user gesture), pumps incoming bytes to onData, and exposes write(). The backend is getSerial() —
// real Web Serial on desktop, or the WebUSB shim on Android — so this code is backend-agnostic.

import { getSerial, serialSupported } from './serial.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SerialTransport {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._reading = false;
    this._discard = false; // while true, swallow inbound bytes (used during ESP boot)
    this._lastRx = 0;      // timestamp of the last received chunk (for "wait until idle")
    this.onData = null; // (Uint8Array) => void
    this.onClose = null; // (reason) => void
  }

  static get supported() {
    return serialSupported();
  }

  /**
   * Prompt the user to pick a port and open it. Call from a click handler. `paramsFor(info)` (optional)
   * can override baud/flow control based on the *picked* port's USB IDs — known only after requestPort —
   * e.g. a J-Link VCOM gets opened at 1M/RTS-CTS. The actual params used are exposed on this.baudRate /
   * this.flowControl so the caller can reflect them.
   */
  async open({ baudRate = 115200, flowControl = 'none', filters, paramsFor } = {}) {
    if (!SerialTransport.supported) throw new Error('No serial backend — use desktop Chrome/Edge (Web Serial) or Android Chrome (WebUSB).');
    this.port = await getSerial().requestPort(filters ? { filters } : {});
    if (paramsFor) {
      const p = paramsFor(this.port.getInfo ? this.port.getInfo() : {});
      if (p) { baudRate = p.baudRate ?? baudRate; flowControl = p.flowControl ?? flowControl; }
    }
    this.baudRate = baudRate; this.flowControl = flowControl;
    await this.port.open({ baudRate, flowControl, bufferSize: 4096 });
    this.writer = this.port.writable.getWriter();
    this._loopDone = this._startReadLoop();
    this.port.addEventListener('disconnect', () => this._handleClose('device disconnected'));
    return this.label();
  }

  label() {
    if (!this.port) return null;
    const info = this.port.getInfo ? this.port.getInfo() : {};
    if (info.usbVendorId != null) {
      const v = info.usbVendorId.toString(16).padStart(4, '0');
      const p = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
      return `USB ${v}:${p}`;
    }
    return 'Serial port';
  }

  async _startReadLoop() {
    this._reading = true;
    while (this._reading) {
      // A recoverable serial stream error (framing/parity/overrun/break — and the transient "device
      // has been lost" Chrome raises when an ESP reset glitches the USB-UART line) errors only the
      // *stream*: the port stays open and exposes a fresh `readable`, so we re-acquire a reader and
      // keep going. Tearing the transport down here (the old behavior) abandoned a still-open port and
      // broke flashing/bring-up. A genuine unplug is delivered by the 'disconnect' event → _handleClose
      // (which clears _reading/port), so this loop exits cleanly without guessing from read errors.
      const readable = this.port?.readable;
      if (!readable) {
        if (!this.port) break;            // closed/detached on purpose
        await sleep(30); continue;        // stream momentarily absent after an error — wait for it
      }
      try {
        this.reader = readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            this._lastRx = Date.now();
            if (!this._discard && this.onData) this.onData(value);
          }
        }
      } catch (e) {
        console.warn('[serial] read stream error (recovering):', e?.message || e);
        await sleep(30);                  // avoid a hot loop if the error persists
      } finally {
        try { this.reader?.releaseLock(); } catch {}
        this.reader = null;
      }
    }
  }

  async write(bytes) {
    if (!this.writer) throw new Error('port not open');
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /**
   * Reset an attached ESP (CP210x/CH34x/FTDI auto-reset circuit) into RUN mode so it boots its HCI
   * firmware: keep IO0 high (DTR deasserted) and pulse EN (RTS low→high). Without this, Web Serial's
   * open/close cycling can leave the ESP in the ROM download loader, so a second connect sees no HCI.
   * No-op on ports that don't support control signals (e.g. CDC-ACM dongles ignore them).
   */
  async espRunReset() {
    if (!this.port?.setSignals) return;
    this._discard = true; // swallow the boot-log burst so it never reaches the H4 parser
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });  // IO0 high, EN low (reset)
      await sleep(120);
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); // EN high → boot into run mode
      // The ESP prints its boot log on this UART; wait until it goes quiet (idle ≥250ms) before HCI,
      // since boot duration varies by chip (an S3's log is longer/slower than a classic ESP32's).
      await sleep(150);
      this._lastRx = Date.now();
      const start = Date.now();
      while (Date.now() - start < 3000) {
        if (Date.now() - this._lastRx >= 250) break;
        await sleep(50);
      }
    } catch { /* setSignals unsupported on this platform/port — ignore */ } finally {
      this._discard = false;
    }
  }

  async close() {
    this._reading = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    try { await this.port?.close(); } catch {}
    this.port = null;
  }

  /**
   * Hand the OPEN port to another driver (the ESP flasher) without closing it — keeping the same
   * connection. Stops our read loop and releases the reader/writer locks (awaiting the loop so the
   * lock is actually free before we return), then relinquishes ownership. The port stays open at the
   * current baud, so the flasher can take it over with no port picker and no reconnect. Returns the
   * open port (or null if nothing was open). Used only for ESP reflash; nRF DFU uses close().
   */
  async detach() {
    const port = this.port;
    if (!port) return null;
    this._reading = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this._loopDone; } catch {}   // wait for the read loop to release its reader lock
    this.reader = null;
    try { this.writer?.releaseLock(); } catch {}
    this.writer = null;
    this.port = null;                        // ownership transferred; transport no longer drives it
    return port;
  }

  /**
   * Re-take ownership of a port previously handed off via detach() (once the ESP flasher releases
   * it), WITHOUT reopening it — so the same WebSerial connection continues after flashing. Grabs a
   * fresh writer and restarts the read loop. The 'disconnect' listener added in open() is still
   * attached to this port object, so we don't re-add it.
   */
  reattach(port) {
    this.port = port;
    this._discard = false;
    this.writer = this.port.writable.getWriter();
    this._loopDone = this._startReadLoop();
  }

  _handleClose(reason) {
    if (!this._reading && !this.port) return;
    this._reading = false;
    this.writer = null;
    this.port = null;
    if (this.onClose) this.onClose(reason);
  }
}
