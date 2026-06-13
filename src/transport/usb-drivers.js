// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// USB-serial bridge drivers for the WebUSB serial shim (webusb-serial.js). Web Serial doesn't exist on
// Android, but WebUSB does — so on Android we talk to the bridge chip directly: configure baud + the
// DTR/RTS control lines over USB control transfers, and move data over the bulk endpoints. One driver per
// chip family. The wire-format encoders (baud divisors, control-line bitfields) are PURE exported
// functions so they're unit-tested in Node without hardware (test/smoke-usb-drivers.mjs).
//
// Protocol references (these mirror, from scratch, the Linux kernel + usb-serial-for-android drivers):
//   CDC-ACM : USB CDC PSTN spec (SET_LINE_CODING 0x20, SET_CONTROL_LINE_STATE 0x22)
//   CP210x  : drivers/usb/serial/cp210x.c (Silicon Labs)
//   CH34x   : drivers/usb/serial/ch341.c (WCH)            ← baud math is the fiddliest; verify on HW
//   FTDI    : drivers/usb/serial/ftdi_sio.c (FTDI)        ← prepends 2 modem-status bytes to every read

// ---- little-endian helpers ----
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);

// =====================================================================================================
// Pure wire-format encoders (exported for unit tests)
// =====================================================================================================

/** USB-CDC SET_LINE_CODING payload: dwDTERate(u32 LE) | bCharFormat | bParityType | bDataBits. */
export function cdcLineCoding(baud, { dataBits = 8, parity = 'none', stop = 1 } = {}) {
  const stopByte = stop === 2 ? 2 : stop === 1.5 ? 1 : 0;            // 0=1, 1=1.5, 2=2
  const parityByte = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[parity] ?? 0;
  return Uint8Array.of(...u32le(baud), stopByte, parityByte, dataBits);
}

/** USB-CDC SET_CONTROL_LINE_STATE wValue: bit0 = DTR, bit1 = RTS. */
export const cdcControlLineState = (dtr, rts) => (dtr ? 0x1 : 0) | (rts ? 0x2 : 0);

/** CP210x SET_BAUDRATE payload — the literal baud as a u32 LE (modern CP210x firmware). */
export const cp210xBaud = (baud) => u32le(baud);

/** CP210x SET_LINE_CTL wValue: (dataBits<<8) | (parity<<4) | stopBits. 8N1 = 0x0800. */
export function cp210xLineCtl({ dataBits = 8, parity = 'none', stop = 1 } = {}) {
  const parityNib = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[parity] ?? 0;
  const stopNib = stop === 2 ? 2 : stop === 1.5 ? 1 : 0;
  return ((dataBits & 0xf) << 8) | (parityNib << 4) | stopNib;
}

/** CP210x SET_MHS wValue: low byte = DTR(0x1)/RTS(0x2) state, high byte = write mask. */
export const cp210xMhs = (dtr, rts) => (dtr ? 0x01 : 0) | (rts ? 0x02 : 0) | 0x0300;

/**
 * FTDI baud divisor (FT232R/BM family, 3 MHz base). Returns { value, index } for SET_BAUDRATE.
 * 14-bit integer divisor + 3-bit fractional code in the high bits; 3M and 2M are special-cased.
 * Mirrors ftdi_232bm_baud_to_divisor. Test vectors: 115200→0x001A, 9600→0x4138.
 */
export function ftdiDivisor(baud, base = 3000000) {
  const frac = [0, 3, 2, 4, 1, 5, 6, 7]; // 0, .125, .25, .375, .5, .625, .75, .875
  let divisor3 = Math.floor((base * 8) / baud);
  let divisor = (divisor3 >> 3) | (frac[divisor3 & 7] << 14);
  if (divisor === 1) divisor = 0;            // 3,000,000 baud
  else if (divisor === 0x4001) divisor = 1;  // 2,000,000 baud
  return { value: divisor & 0xffff, index: (divisor >>> 16) & 0xff };
}

/** FTDI SET_DATA wValue: dataBits | parity<<8 | stopBits<<11. 8N1 = 0x0008. */
export function ftdiData({ dataBits = 8, parity = 'none', stop = 1 } = {}) {
  const parityCode = { none: 0, odd: 1, even: 2, mark: 3, space: 4 }[parity] ?? 0;
  const stopCode = stop === 2 ? 2 : stop === 1.5 ? 1 : 0;
  return (dataBits & 0xf) | (parityCode << 8) | (stopCode << 11);
}

/**
 * CH341 baud → the single 16-bit wIndex for the 0x9A "write reg" request (wValue 0x1312 selects the
 * DIVISOR/PRESCALER reg pair). Mirrors ch341.c's set_baudrate (CH341_BAUDBASE_FACTOR = 1532620800, max
 * prescale 3): high byte → DIVISOR reg, low 2 bits → prescaler select. Bit 7 of the low byte forces the
 * CH341 to flush RX immediately instead of buffering until a full 32-byte bulk packet — without it the
 * ESP ROM's short SYNC reply sits in the chip and the flasher never syncs (the old-kernel CH340 bug).
 * Test vectors (this is the touchy part — keep them): 115200→0xCC83, 921600→0xF983, 9600→0xB282.
 */
export function ch341Baud(baud) {
  const FACTOR = 1532620800;
  let factor = Math.floor(FACTOR / baud);
  let divisor = 3;
  while (factor > 0xfff0 && divisor > 0) { factor >>= 3; divisor -= 1; }
  factor = 0x10000 - factor;
  return ((factor & 0xff00) | divisor | 0x80) & 0xffff;
}

/** CH341 modem-control byte (0xA4 request): DTR=bit5, RTS=bit6, active-low. */
export const ch341Modem = (dtr, rts) => ~((dtr ? 0x20 : 0) | (rts ? 0x40 : 0)) & 0xff;

// =====================================================================================================
// Driver base + endpoint discovery
// =====================================================================================================

function findBulkEndpoints(iface) {
  const alt = iface.alternate || iface.alternates?.[0];
  let epIn = null, epOut = null, pkt = 64;
  for (const ep of alt?.endpoints || []) {
    if (ep.type !== 'bulk') continue;
    if (ep.direction === 'in') { epIn = ep.endpointNumber; pkt = ep.packetSize || pkt; }
    else if (ep.direction === 'out') epOut = ep.endpointNumber;
  }
  return { epIn, epOut, pkt };
}

class BaseDriver {
  constructor(device) { this.device = device; this.epIn = null; this.epOut = null; this.packetSize = 64; this.ctrlIface = 0; }
  readFilter(bytes) { return bytes; }
  async _vendorOut(request, value, index, data) {
    await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request, value, index }, data);
  }
  async _classOut(request, value, index, data) {
    await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request, value, index }, data);
  }
}

// ---- CDC-ACM (nRF dongle/DK VCOM, ESP native USB-Serial/JTAG, generic CDC) ----
class CdcAcmDriver extends BaseDriver {
  async init() {
    const ifaces = this.device.configuration.interfaces;
    const data = ifaces.find((i) => (i.alternate || i.alternates[0]).interfaceClass === 0x0a); // CDC Data
    const comm = ifaces.find((i) => (i.alternate || i.alternates[0]).interfaceClass === 0x02); // CDC Comm
    const dataIf = data || ifaces[0];
    this.ctrlIface = (comm || dataIf).interfaceNumber;
    if (comm) { try { await this.device.claimInterface(comm.interfaceNumber); } catch {} }
    await this.device.claimInterface(dataIf.interfaceNumber);
    Object.assign(this, findBulkEndpoints(dataIf));
    this.packetSize = this.pkt;
  }
  async setBaud(baud, opts) { await this._classOut(0x20, 0, this.ctrlIface, cdcLineCoding(baud, opts)); }
  async setSignals(dtr, rts) { await this._classOut(0x22, cdcControlLineState(dtr, rts), this.ctrlIface); }
}

// ---- CP210x (Silicon Labs, classic ESP32 DevKit) ----
class Cp210xDriver extends BaseDriver {
  async init() {
    const iface = this.device.configuration.interfaces[0];
    this.ctrlIface = iface.interfaceNumber;
    await this.device.claimInterface(this.ctrlIface);
    Object.assign(this, findBulkEndpoints(iface)); this.packetSize = this.pkt;
    await this._vendorOut(0x00, 0x0001, this.ctrlIface); // IFC_ENABLE
  }
  async setBaud(baud, opts) {
    await this._vendorOut(0x1e, 0, this.ctrlIface, cp210xBaud(baud));       // SET_BAUDRATE
    await this._vendorOut(0x03, cp210xLineCtl(opts), this.ctrlIface);       // SET_LINE_CTL
  }
  async setSignals(dtr, rts) { await this._vendorOut(0x07, cp210xMhs(dtr, rts), this.ctrlIface); } // SET_MHS
}

// ---- FTDI (FT232 boards) ----
class FtdiDriver extends BaseDriver {
  async init() {
    const iface = this.device.configuration.interfaces[0];
    this.ctrlIface = iface.interfaceNumber;
    await this.device.claimInterface(this.ctrlIface);
    Object.assign(this, findBulkEndpoints(iface)); this.packetSize = this.pkt;
    // FTDI vendor requests are DEVICE-recipient with wIndex = port (1-based).
    await this._dev(0x00, 0x0000, 1); // RESET
  }
  async _dev(request, value, index, data) {
    await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }, data);
  }
  async setBaud(baud, opts) {
    const d = ftdiDivisor(baud);
    await this._dev(0x03, d.value, (d.index << 8) | 1);  // SET_BAUDRATE (wIndex high = divisor[16+], low = port)
    await this._dev(0x04, ftdiData(opts), 1);            // SET_DATA
  }
  async setSignals(dtr, rts) {
    await this._dev(0x01, dtr ? 0x0101 : 0x0100, 1);     // MODEM_CTRL: DTR
    await this._dev(0x01, rts ? 0x0202 : 0x0200, 1);     // MODEM_CTRL: RTS
  }
  // FTDI prepends 2 modem/line-status bytes to EVERY bulk-IN packet — strip them.
  readFilter(bytes) { return bytes.length >= 2 ? bytes.subarray(2) : new Uint8Array(0); }
}

// ---- CH34x (WCH legacy CH340/CH341 vendor protocol; CH343/CH9102 are CDC-ACM, handled above) ----
class Ch34xDriver extends BaseDriver {
  // ch341 vendor requests are DEVICE-recipient (drivers/usb/serial/ch341.c), not interface-recipient.
  _dev(request, value, index) {
    return this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
  }
  async init() {
    const iface = this.device.configuration.interfaces[0];
    this.ctrlIface = iface.interfaceNumber;
    await this.device.claimInterface(this.ctrlIface);
    Object.assign(this, findBulkEndpoints(iface)); this.packetSize = this.pkt;
    await this._dev(0xa1, 0xc29c, 0xb2b9);          // serial init
    await this._dev(0x9a, 0x2518, 0x00c3);          // LCR: 8 data bits, no parity, 1 stop, enable RX/TX
    await this._dev(0xa1, 0x4f, 0);                 // handshake/clear
  }
  async setBaud(baud) {
    await this._dev(0x9a, 0x1312, ch341Baud(baud)); // write DIVISOR/PRESCALER reg pair (single 16-bit wIndex)
  }
  async setSignals(dtr, rts) { await this._dev(0xa4, ch341Modem(dtr, rts), 0); }
}

const VENDOR_DRIVERS = { 0x10c4: Cp210xDriver, 0x1a86: Ch34xDriver, 0x0403: FtdiDriver };

/**
 * Pick a driver for a USBDevice. CDC-ACM FIRST: prefer it whenever the device exposes a CDC interface,
 * because newer WCH chips (CH343/CH9102, e.g. 1a86:55d3) are standard CDC-ACM despite sharing the CH34x
 * VID — using the vendor protocol on them fails ("interface not supported"). CP210x/FTDI are always
 * vendor-class (no CDC interface), so they still fall through to their VID-matched drivers.
 */
export function pickDriver(device) {
  const ifaces = device.configuration?.interfaces || [];
  const isCdc = ifaces.some((i) => { const c = (i.alternate || i.alternates?.[0])?.interfaceClass; return c === 0x02 || c === 0x0a; });
  if (isCdc) return new CdcAcmDriver(device);
  const D = VENDOR_DRIVERS[device.vendorId];
  if (D) return new D(device);
  return new CdcAcmDriver(device); // best-effort fallback
}
