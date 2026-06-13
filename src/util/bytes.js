// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Byte / hex utilities and little-endian readers/writers used across the stack.

/** Parse a hex string (spaces, colons, 0x, newlines tolerated) into a Uint8Array. */
export function hexToBytes(str) {
  if (!str) return new Uint8Array(0);
  const clean = str.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Format bytes as hex. `sep` between bytes (default space). */
export function bytesToHex(bytes, sep = ' ') {
  if (!bytes) return '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    s += arr[i].toString(16).padStart(2, '0');
    if (i !== arr.length - 1) s += sep;
  }
  return s;
}

/** Bluetooth addresses are little-endian on the wire; display is big-endian colon-separated. */
export function addrToString(bytes) {
  const a = Array.from(bytes).reverse().map((b) => b.toString(16).padStart(2, '0'));
  return a.join(':').toUpperCase();
}

/** Parse "AA:BB:CC:DD:EE:FF" (display order) into little-endian wire bytes. */
export function stringToAddr(str) {
  const parts = str.split(/[:\-\s]/).filter(Boolean);
  if (parts.length !== 6) throw new Error('address must have 6 octets');
  return new Uint8Array(parts.map((p) => parseInt(p, 16)).reverse());
}

export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Sequential little-endian writer. Grows automatically. */
export class ByteWriter {
  constructor() {
    this._parts = [];
    this._len = 0;
  }
  u8(v) {
    this._parts.push(new Uint8Array([v & 0xff]));
    this._len += 1;
    return this;
  }
  u16(v) {
    this._parts.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff]));
    this._len += 2;
    return this;
  }
  u24(v) {
    this._parts.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]));
    this._len += 3;
    return this;
  }
  u32(v) {
    this._parts.push(new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]));
    this._len += 4;
    return this;
  }
  i8(v) {
    return this.u8(v < 0 ? v + 0x100 : v);
  }
  bytes(arr) {
    const a = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
    this._parts.push(a);
    this._len += a.length;
    return this;
  }
  /** UTF-8 encode a string. */
  str(s) {
    return this.bytes(new TextEncoder().encode(s));
  }
  get length() {
    return this._len;
  }
  build() {
    return concatBytes(...this._parts);
  }
}

/** Sequential little-endian reader over a Uint8Array. */
export class ByteReader {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.offset = 0;
  }
  get remaining() {
    return this.bytes.length - this.offset;
  }
  u8() {
    return this.bytes[this.offset++];
  }
  i8() {
    const v = this.bytes[this.offset++];
    return v > 0x7f ? v - 0x100 : v;
  }
  u16() {
    const v = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return v >>> 0;
  }
  i16() {
    const v = this.u16();
    return v > 0x7fff ? v - 0x10000 : v;
  }
  u24() {
    const v =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16);
    this.offset += 3;
    return v >>> 0;
  }
  u32() {
    const v =
      (this.bytes[this.offset] |
        (this.bytes[this.offset + 1] << 8) |
        (this.bytes[this.offset + 2] << 16) |
        (this.bytes[this.offset + 3] << 24)) >>>
      0;
    this.offset += 4;
    return v;
  }
  i32() {
    const v = this.u32();
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  read(n) {
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  rest() {
    return this.read(this.remaining);
  }
}

/** Is bit `n` set in a little-endian bitmask byte array? */
export function bitSet(bytes, n) {
  const byte = n >> 3;
  const bit = n & 7;
  return byte < bytes.length && (bytes[byte] & (1 << bit)) !== 0;
}
