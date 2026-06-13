// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Nordic secure serial DFU — the protocol `nrfutil dfu usb-serial` speaks to the nRF Open
// Bootloader (the nRF52840 dongle in bootloader mode, 1915:521F). Messages are SLIP-framed.
// Flow: SetPRN(0) → GetMTU → for the init packet (command object) then the firmware (data
// object): Select → Create → Write(0x08, chunks) → CRC (verify) → Execute. CRC is standard
// CRC32 accumulated over each object stream. Reference: nRF5 SDK secure bootloader / pc-nrfutil.
//
// The protocol is transport-agnostic: `NrfDfu` takes a transport with send()/request() so it's
// unit-testable (see test/smoke-nrfdfu.mjs); dfu-serial.js provides the Web Serial transport.

import { crc32 } from '../util/crc32.js';
export { crc32 }; // re-exported for existing importers (and the ZIP writer shares the same impl)

const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;
const OP = { CREATE: 0x01, SET_PRN: 0x02, CRC: 0x03, EXECUTE: 0x04, SELECT: 0x06, MTU: 0x07, WRITE: 0x08, RESPONSE: 0x60 };
const OBJ = { COMMAND: 0x01, DATA: 0x02 };
const RES_OK = 0x01;
const RES_MSG = { 0x00: 'invalid', 0x02: 'opcode not supported', 0x03: 'invalid parameter', 0x04: 'insufficient resources', 0x05: 'invalid object', 0x07: 'unsupported object type', 0x08: 'operation not permitted', 0x0a: 'operation failed', 0x0b: 'extended error' };

// ---- SLIP framing (RFC 1055) ----
export function slipEncode(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return new Uint8Array(out);
}
export function slipDecode(frame) {
  const out = [];
  for (let i = 0; i < frame.length; i++) {
    let b = frame[i];
    if (b === END) continue;
    if (b === ESC) { const n = frame[++i]; b = n === ESC_END ? END : n === ESC_ESC ? ESC : n; }
    out.push(b);
  }
  return new Uint8Array(out);
}

// CRC32 (used for DFU object verification) now lives in util/crc32.js — imported + re-exported above.

const u32le = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
/** Largest data payload per Write that still fits the serial MTU after worst-case SLIP escaping. */
export const maxWritePayload = (mtu) => Math.max(1, Math.floor((mtu - 1) / 2) - 1);

export class NrfDfu {
  constructor(transport, { log = () => {}, onProgress = () => {} } = {}) {
    this.t = transport; this.log = log; this.onProgress = onProgress; this.mtu = 64;
  }

  async _cmd(op, ...params) {
    const res = await this.t.request(new Uint8Array([op, ...params]));
    if (res[0] !== OP.RESPONSE) throw new Error(`DFU: not a response (0x${res[0].toString(16)})`);
    if (res[1] !== op) throw new Error(`DFU: response for 0x${res[1].toString(16)}, expected 0x${op.toString(16)}`);
    if (res[2] !== RES_OK) throw new Error(`DFU: ${RES_MSG[res[2]] || 'error 0x' + res[2].toString(16)}`);
    return res.subarray(3);
  }
  _setPrn(n) { return this._cmd(OP.SET_PRN, n & 0xff, (n >> 8) & 0xff); }
  async _getMtu() { const p = await this._cmd(OP.MTU); this.mtu = (p[0] | (p[1] << 8)) || 64; }
  async _select(type) { const p = await this._cmd(OP.SELECT, type); return { maxSize: rd32(p, 0), offset: rd32(p, 4), crc: rd32(p, 8) }; }
  _create(type, size) { return this._cmd(OP.CREATE, type, ...u32le(size)); }
  async _crc() { const p = await this._cmd(OP.CRC); return { offset: rd32(p, 0), crc: rd32(p, 4) }; }
  _execute() { return this._cmd(OP.EXECUTE); }

  async _stream(data, crc) {
    const max = maxWritePayload(this.mtu);
    for (let i = 0; i < data.length; i += max) {
      const chunk = data.subarray(i, i + max);
      await this.t.send(new Uint8Array([OP.WRITE, ...chunk])); // no response when PRN=0
      crc = crc32(chunk, crc);
    }
    return crc;
  }

  // Transfer one object stream (command or data) in maxSize-sized objects, verifying the
  // accumulated CRC after each and executing it. `crc` accumulates across the whole stream.
  async _object(type, data, maxSize, crc, onChunk) {
    for (let off = 0; off < data.length; off += maxSize) {
      const part = data.subarray(off, off + maxSize);
      await this._create(type, part.length);
      crc = await this._stream(part, crc);
      const got = await this._crc();
      if (got.crc !== crc) throw new Error(`DFU CRC mismatch @${off + part.length} (0x${got.crc.toString(16)} != 0x${crc.toString(16)})`);
      await this._execute();
      if (onChunk) onChunk(Math.min(off + maxSize, data.length), data.length);
    }
    return crc;
  }

  /** Flash a DFU package: initPacket (the .dat) then firmware (the .bin). */
  async flash(initPacket, firmware) {
    await this._setPrn(0);
    await this._getMtu();
    this.log(`bootloader MTU ${this.mtu}`);

    const selCmd = await this._select(OBJ.COMMAND);
    if (initPacket.length > selCmd.maxSize) throw new Error('init packet exceeds command object size');
    await this._object(OBJ.COMMAND, initPacket, selCmd.maxSize, 0);
    this.log('init packet accepted');

    const selData = await this._select(OBJ.DATA);
    const objMax = selData.maxSize || 4096;
    await this._object(OBJ.DATA, firmware, objMax, 0, (w, t) => this.onProgress({ written: w, total: t }));
    this.log('firmware transferred');
  }
}
