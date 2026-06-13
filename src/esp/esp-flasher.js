// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// esp-flasher.js — a from-scratch, dependency-free reimplementation of the
// esptool ROM-loader serial protocol, enough to (re)flash the ESP32/ESP8266
// gateway from the browser. No stub upload: we drive the chip's mask-ROM
// download loader directly with uncompressed writes, exactly as
// `esptool.py --no-stub write_flash` does. Integrity rests on the ROM's
// per-block XOR checksum (the same guarantee esptool gives for uncompressed
// ROM writes); MD5 verify is ESP32-only in ROM and needs an MD5 we don't have
// in WebCrypto, so it's left as a follow-up.
//
// The wire format (see tools/esptool/esptool/loader.py, which this mirrors):
//   request : C0 | 00 op len16 chk32 <data...> | C0   (SLIP-framed)
//   response: C0 | 01 op len16 val32 <data... status> | C0
// SLIP escapes C0->DB DC and DB->DB DD. The trailing 2 (ESP8266) or 4 (ESP32)
// status bytes carry the result; status[0]==0 means success.
//
// Transport is injected so this file stays pure logic (unit-tested in Node):
//   transport.write(bytes)        — send raw bytes to the serial port
//   transport.resetToBootloader() — DTR/RTS "classic reset" into download mode
//   transport.resetToRun()        — RTS pulse to boot the freshly-flashed app
// plus a SlipReader the caller feeds incoming bytes into.

// ---- command opcodes (subset we use) ----
const CMD = {
  FLASH_BEGIN: 0x02, FLASH_DATA: 0x03, FLASH_END: 0x04,
  SYNC: 0x08, READ_REG: 0x0A, SPI_SET_PARAMS: 0x0B, SPI_ATTACH: 0x0D,
  CHANGE_BAUDRATE: 0x0F,
};

const CHECKSUM_MAGIC = 0xEF;          // XOR seed for FLASH_DATA payloads
const FLASH_WRITE_SIZE = 0x400;       // 1024 — ROM-loader block size
const FLASH_SECTOR_SIZE = 0x1000;     // 4096
const CHIP_MAGIC_REG = 0x40001000;    // read_reg here → chip-detect magic

// ESP8266 ROM erases in whole 64 KB blocks and has a long-standing off-by-a-
// block bug; esptool works around it by under-erasing. Ported verbatim from
// ESP8266ROM.get_erase_size so our erase request matches what the ROM expects.
function esp8266EraseSize(offset, size) {
  const sectorsPerBlock = 16;
  const numSectors = Math.floor((size + FLASH_SECTOR_SIZE - 1) / FLASH_SECTOR_SIZE);
  const startSector = Math.floor(offset / FLASH_SECTOR_SIZE);
  let headSectors = sectorsPerBlock - (startSector % sectorsPerBlock);
  if (numSectors < headSectors) headSectors = numSectors;
  if (numSectors < 2 * headSectors) return Math.floor((numSectors + 1) / 2) * FLASH_SECTOR_SIZE;
  return (numSectors - headSectors) * FLASH_SECTOR_SIZE;
}

// Per-chip facts pulled from tools/esptool/esptool/targets/{esp32,esp8266}.py.
export const CHIPS = {
  esp32: {
    name: 'ESP32', magic: 0x00F01D83, statusLen: 4,
    spiAttach: true,                  // ESP32 ROM needs an explicit SPI_ATTACH
    setParams: true,                  // and accepts SPI_SET_PARAMS
    canChangeBaud: true,              // ROM supports CHANGE_BAUDRATE
    eraseSize: (off, size) => size,   // no erase quirk
    // Three images at fixed offsets (bootloader / partition table / app). The
    // `default` URLs are the bundled built images (firmware/, populated by
    // sync-firmware.sh); a slot uses its default unless overridden by a file.
    layout: [
      { offset: 0x1000,  label: 'bootloader',         default: 'firmware/esp32/bootloader.bin' },
      { offset: 0x8000,  label: 'partition-table',     default: 'firmware/esp32/partition-table.bin' },
      { offset: 0x10000, label: 'app (firmware.bin)',  default: 'firmware/esp32/firmware.bin' },
    ],
  },
  // Newer ESP32 variants: same --no-stub ROM flashing as ESP32 (SPI attach + set-params + change
  // baud), but the simple-boot image lives at 0x0 (vs 0x1000 on classic ESP32). Magic values are
  // esptool's CHIP_DETECT_MAGIC_VALUE; the C3 ROM reports one of two depending on silicon revision.
  esp32s3: {
    name: 'ESP32-S3', magic: 0x00000009, statusLen: 4,
    spiAttach: true, setParams: true, canChangeBaud: true, encryptParam: true, eraseSize: (off, size) => size,
    layout: [{ offset: 0x0, label: 'app', default: 'firmware/esp32s3/app.bin' }],
  },
  esp32c3: {
    // Four CHIP_DETECT_MAGIC values across C3 silicon revisions (esptool targets/esp32c3.py).
    name: 'ESP32-C3', magic: [0x6921506F, 0x1B31506F, 0x4881606F, 0x4361606F], statusLen: 4,
    spiAttach: true, setParams: true, canChangeBaud: true, encryptParam: true, eraseSize: (off, size) => size,
    layout: [{ offset: 0x0, label: 'app', default: 'firmware/esp32c3/app.bin' }],
  },
  esp32c6: {
    name: 'ESP32-C6', magic: 0x2CE0806F, statusLen: 4,
    spiAttach: true, setParams: true, canChangeBaud: true, encryptParam: true, eraseSize: (off, size) => size,
    layout: [{ offset: 0x0, label: 'app', default: 'firmware/esp32c6/app.bin' }],
  },
  esp8266: {
    name: 'ESP8266', magic: 0xFFF0C101, statusLen: 2,
    spiAttach: false,                 // ROM attaches implicitly on flash_begin
    setParams: false,                 // not implemented in ROM
    canChangeBaud: false,             // CHANGE_BAUDRATE is stub-only on ESP8266
    eraseSize: esp8266EraseSize,
    // Single combined image at 0x0; the phy-init/rf-cal/sys-param blobs near
    // the top of flash are SDK calibration and rarely change, so the simple
    // "update firmware" path writes just the app. (Advanced UI can add more.)
    layout: [
      { offset: 0x00000, label: 'app (firmware.bin)', default: 'firmware/esp8266/firmware.bin' },
    ],
  },
};

export { FLASH_WRITE_SIZE };

// ---- little-endian packers ----
const u32 = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
function concat(arrays) {
  let len = 0; for (const a of arrays) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
function padTo(data, align) {
  const rem = data.length % align;
  if (rem === 0) return data;
  const out = new Uint8Array(data.length + (align - rem));
  out.set(data);
  return out;
}

// XOR checksum over the data block, seeded as the ROM defines.
export function checksum(data) {
  let state = CHECKSUM_MAGIC;
  for (const b of data) state ^= b;
  return state >>> 0;
}

// SLIP-frame a raw command packet: C0 | escaped(payload) | C0.
export function slipEncode(payload) {
  const out = [0xC0];
  for (const b of payload) {
    if (b === 0xC0) out.push(0xDB, 0xDC);
    else if (b === 0xDB) out.push(0xDB, 0xDD);
    else out.push(b);
  }
  out.push(0xC0);
  return Uint8Array.from(out);
}

// Streaming SLIP decoder. Bytes are fed in as they arrive off the serial
// port; complete frames are queued and handed to readFrame() (which waits,
// with a timeout, when none are ready yet).
export class SlipReader {
  constructor() {
    this._frames = [];      // decoded, ready frames
    this._waiters = [];     // { resolve, reject, timer }
    this._buf = [];         // bytes of the in-progress frame
    this._inFrame = false;
    this._escape = false;
  }

  feed(bytes) {
    for (const b of bytes) {
      if (!this._inFrame) {
        if (b === 0xC0) { this._inFrame = true; this._buf = []; this._escape = false; }
        continue;                              // junk between frames (boot log etc.)
      }
      if (this._escape) {
        this._buf.push(b === 0xDC ? 0xC0 : b === 0xDD ? 0xDB : b);
        this._escape = false;
      } else if (b === 0xDB) {
        this._escape = true;
      } else if (b === 0xC0) {
        if (this._buf.length) this._deliver(Uint8Array.from(this._buf));
        this._inFrame = false;                 // C0 closes (or, if empty, re-opens)
      } else {
        this._buf.push(b);
      }
    }
  }

  _deliver(frame) {
    const w = this._waiters.shift();
    if (w) { clearTimeout(w.timer); w.resolve(frame); }
    else this._frames.push(frame);
  }

  /** Resolve with the next SLIP frame, or reject after timeoutMs. */
  readFrame(timeoutMs) {
    if (this._frames.length) return Promise.resolve(this._frames.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._waiters.findIndex((x) => x.timer === timer);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('timeout waiting for SLIP frame'));
      }, timeoutMs);
      this._waiters.push({ resolve, reject, timer });
    });
  }

  /** Drop any buffered frames (used between sync attempts). */
  reset() { this._frames = []; this._buf = []; this._inFrame = false; this._escape = false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class EspFlasher {
  /** @param transport { write(bytes), resetToBootloader(), resetToRun() }
   *  @param slip SlipReader the caller feeds incoming serial bytes into
   *  @param opts { log(msg), onProgress({phase,label,written,total}) } */
  constructor(transport, slip, opts = {}) {
    this.t = transport;
    this.slip = slip;
    this.log = opts.log || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.chip = null;
  }

  // ---- low-level command/response ----

  // Build [00 op len16 chk32 data], SLIP-frame, send, then read responses
  // until one echoes our op. Returns { val, data } (data includes status).
  async _command(op, data = new Uint8Array(0), chk = 0, timeoutMs = 3000) {
    if (op != null) {
      const header = Uint8Array.of(0x00, op, data.length & 0xff, (data.length >>> 8) & 0xff, ...u32(chk));
      this.t.write(slipEncode(concat([header, data])));
    }
    for (let i = 0; i < 100; i++) {
      const p = await this.slip.readFrame(timeoutMs);
      if (p.length < 8) continue;
      const resp = p[0], opRet = p[1];
      if (resp !== 1) continue;
      const val = (p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24)) >>> 0;
      if (op == null || opRet === op) return { val, data: p.subarray(8) };
    }
    throw new Error(`no matching response for op 0x${op.toString(16)}`);
  }

  // Send a command and assert success (status[0] === 0). Returns the payload
  // before the status bytes, or the header `val` when there's no extra payload.
  async _check(desc, op, data, chk = 0, timeoutMs = 3000) {
    const { val, data: ret } = await this._command(op, data, chk, timeoutMs);
    const sl = this.chip ? this.chip.statusLen : 2;
    if (ret.length < sl) throw new Error(`${desc}: short status (${ret.length}B)`);
    const status = ret.subarray(ret.length - sl);
    if (status[0] !== 0) throw new Error(`${desc}: failed (status ${status[0]},${status[1]})`);
    return ret.length > sl ? ret.subarray(0, ret.length - sl) : val;
  }

  async _readReg(addr) {
    // read_reg returns the value in the header `val` field.
    const { val } = await this._command(CMD.READ_REG, u32(addr), 0, 3000);
    return val;
  }

  // ---- connect: reset into the ROM loader, sync, identify the chip ----

  /**
   * Reset into the ROM loader, sync, and identify the chip from its magic. Two phases:
   *  1. auto-reset — esptool-js ClassicReset, alternating a 50ms / 550ms GPIO0 hold (flash-serial
   *     RESET_HOLDS), hammering SYNC after each, so most boards enter download mode with no user action.
   *  2. manual-BOOT — if auto-reset can't strap GPIO0, DON'T fail: keep pulsing /EN + hammering SYNC while
   *     the user holds the BOOT button, until it syncs (or the caller aborts). No re-click needed.
   * `onPhase(name, detail)` drives the wizard UI: 'auto-reset'{attempt} | 'manual-boot' | 'detecting' |
   * 'detected'(chip). `signal` is an AbortSignal — abort throws so the caller can unwind cleanly.
   */
  async connect({ signal, onPhase = () => {} } = {}) {
    const checkAbort = () => { if (signal?.aborted) throw new Error('cancelled'); };
    let synced = false;
    // Phase 1: auto-reset. Eight tries so both ClassicReset holds (50ms / 550ms — connect passes
    // attempt-1 and resetToBootloader alternates them) get several turns. Most healthy boards strap into
    // download mode on the first try; a board that needs a held BOOT falls through to phase 2 in ~7s.
    for (let attempt = 1; attempt <= 8 && !synced; attempt++) {
      checkAbort();
      onPhase('auto-reset', { attempt });
      this.log(`reset into download mode (try ${attempt})…`);
      await this.t.resetToBootloader(attempt - 1);
      await sleep(50);                          // let the ROM boot + emit its banner before we SYNC
      synced = await this._syncRound(5, signal);
      if (synced) this.log(`synced on try ${attempt}`);
    }
    // Phase 2: auto-reset couldn't strap GPIO0 — the user holds BOOT. Pulse /EN each cycle (GPIO0 left to
    // the held button), settle for the boot banner, then SYNC — flushing the banner RX before every
    // attempt — until it enters the loader (or the caller aborts). No re-click needed.
    if (!synced) {
      onPhase('manual-boot');
      this.log('hold BOOT (tap RST/EN) — waiting for the ROM loader…');
      while (!synced) {
        checkAbort();
        if (this.t.resetManualBoot) await this.t.resetManualBoot();
        await sleep(80);                        // ROM boot + banner settle after the /EN pulse
        synced = await this._syncRound(8, signal);
      }
      this.log('synced — BOOT detected');
    }

    onPhase('detecting');
    this.log('synced; identifying chip…');
    const magic = await this._readReg(CHIP_MAGIC_REG);
    const m = magic >>> 0;
    const match = Object.values(CHIPS).find((c) => (Array.isArray(c.magic) ? c.magic.includes(m) : c.magic === m));
    if (!match) throw new Error(`unknown chip (magic 0x${magic.toString(16)})`);
    this.chip = match;
    this.log(`detected ${match.name} (magic 0x${magic.toString(16).padStart(8, '0')})`);
    onPhase('detected', match);
    return match;
  }

  /**
   * One round of SYNC hammering. Flushes the SLIP reader before EVERY attempt — the ESP ROM prints a
   * boot banner after each reset, and those bytes (and any stray 0xC0) would otherwise desync the
   * response matcher. This mirrors esptool's flush_input() before each sync, and is the key to syncing
   * reliably right after a reset — including while the user holds BOOT. Returns true once synced.
   */
  async _syncRound(tries, signal) {
    for (let i = 0; i < tries; i++) {
      if (signal?.aborted) throw new Error('cancelled');
      this.slip.reset();                        // drop boot-banner / stale frames (esptool flush_input)
      try { await this._sync(); return true; } catch { await sleep(50); }
    }
    return false;
  }

  // SYNC frame: 07 07 12 20 then 32×0x55. The ROM echoes it; drain a few extra replies some ESP8266 ROMs
  // emit so they don't desync later commands. 100ms SYNC timeout matches esptool-js (fast retries — a
  // missing reply means the board isn't in download mode yet, so we want to reset + re-hammer quickly).
  async _sync() {
    const frame = concat([Uint8Array.of(0x07, 0x07, 0x12, 0x20), new Uint8Array(32).fill(0x55)]);
    await this._command(CMD.SYNC, frame, 0, 100);
    for (let i = 0; i < 7; i++) {
      try { await this._command(null, undefined, 0, 50); } catch { break; }
    }
  }

  // Switch the link to a faster baud for the bulk transfer (ESP32 ROM only).
  // The ROM acknowledges at the OLD baud and then switches, so we send the
  // command, follow with transport.setBaud(), then discard any straggler bytes.
  // second arg is 0 for the ROM loader (it's the old baud only under the stub).
  async changeBaud(baud) {
    if (!this.chip.canChangeBaud) { this.log(`${this.chip.name} ROM can't change baud — staying put`); return false; }
    this.log(`switching link to ${baud} baud…`);
    await this._command(CMD.CHANGE_BAUDRATE, concat([u32(baud), u32(0)]), 0, 3000);
    if (this.t.setBaud) await this.t.setBaud(baud);
    await sleep(100);
    this.slip.reset();
    return true;
  }

  // ---- flash setup + write ----

  async _spiSetup(flashSizeBytes) {
    if (this.chip.spiAttach) {
      // arg = hspi(0) + 4 reserved bytes (ROM also wants an 'is legacy' byte).
      await this._check('SPI attach', CMD.SPI_ATTACH, concat([u32(0), u32(0)]));
    } else {
      // ESP8266 ROM: a zero-length flash_begin performs the implicit attach.
      await this._flashBegin(0, 0);
    }
    if (this.chip.setParams) {
      const p = concat([u32(0), u32(flashSizeBytes), u32(64 * 1024), u32(4 * 1024), u32(256), u32(0xFFFF)]);
      await this._check('set SPI params', CMD.SPI_SET_PARAMS, p);
    }
  }

  async _flashBegin(size, offset) {
    const numBlocks = Math.floor((size + FLASH_WRITE_SIZE - 1) / FLASH_WRITE_SIZE);
    const eraseSize = this.chip.eraseSize(offset, size);
    const fields = [u32(eraseSize), u32(numBlocks), u32(FLASH_WRITE_SIZE), u32(offset)];
    if (this.chip.encryptParam) fields.push(u32(0)); // ESP32-S2+ ROM flash_begin takes a 5th "encrypted" word
    const params = concat(fields);
    // The ROM erases the whole region up front here, so allow generous time.
    const timeout = Math.max(10000, Math.ceil((size / 1e6) * 30000) + 5000);
    await this._check('flash begin', CMD.FLASH_BEGIN, params, 0, timeout);
    return numBlocks;
  }

  async _flashBlock(block, seq) {
    const header = concat([u32(block.length), u32(seq), u32(0), u32(0)]);
    await this._check(`flash data seq ${seq}`, CMD.FLASH_DATA, concat([header, block]), checksum(block), 3000);
  }

  /**
   * Write images to flash. `images` is [{ offset, data: Uint8Array, label }].
   * Must be connected first. Reports progress via onProgress.
   */
  async flashImages(images, { flashSizeBytes = 4 * 1024 * 1024 } = {}) {
    if (!this.chip) throw new Error('not connected — call connect() first');
    await this._spiSetup(flashSizeBytes);

    const grandTotal = images.reduce((n, im) => n + padTo(im.data, 4).length, 0);
    let writtenAll = 0;

    for (const im of images) {
      const data = padTo(im.data, 4);
      const label = im.label || `0x${im.offset.toString(16)}`;
      this.log(`flashing ${label} — ${data.length} B @ 0x${im.offset.toString(16)}`);
      const blocks = await this._flashBegin(data.length, im.offset);
      for (let seq = 0; seq < blocks; seq++) {
        const chunk = data.subarray(seq * FLASH_WRITE_SIZE, (seq + 1) * FLASH_WRITE_SIZE);
        // Pad the final short block to a full write size with 0xFF (erased flash).
        const block = chunk.length === FLASH_WRITE_SIZE
          ? chunk
          : concat([chunk, new Uint8Array(FLASH_WRITE_SIZE - chunk.length).fill(0xFF)]);
        await this._flashBlock(block, seq);
        writtenAll += chunk.length;
        this.onProgress({ phase: 'write', label, written: writtenAll, total: grandTotal });
      }
    }
    this.log('flash write complete');
  }

  // Leave download mode and boot the application. We deliberately reset via
  // RTS (the existing run-mode reset) rather than FLASH_END's reboot, which is
  // unreliable on the ROM loader. On the keep-the-HCI-connection path the caller
  // drives the authoritative reboot (transport.espRunReset, which also drains the
  // boot-log burst), so it passes reset:false to avoid a redundant double reset.
  async finish({ reset = true } = {}) {
    if (!reset) { this.log('flash complete — leaving the reboot to the caller'); return; }
    this.log('rebooting into the new firmware…');
    await this.t.resetToRun();
  }
}
