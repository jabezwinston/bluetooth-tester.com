// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// UUID handling for GATT. Canonical form: 4-hex-uppercase for 16-bit (e.g. '2A00'),
// full 36-char dashed for 128-bit. 128-bit UUIDs built on the Bluetooth Base UUID
// collapse to their 16-bit short form so short/long requests match.

import { hexToBytes } from './bytes.js';

const BASE = '00001000800000805F9B34FB'; // base suffix (bytes 4..15, big-endian hex)

export function normalizeUuid(input) {
  if (typeof input === 'number') return input.toString(16).padStart(4, '0').toUpperCase();
  let s = String(input).trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (s.length === 4) return s;
  if (s.length === 8) s = s.padStart(32, '0'); // 32-bit → expand against base later if needed
  if (s.length === 32) {
    if (s.slice(8) === BASE && s.slice(0, 4) === '0000') return s.slice(4, 8); // collapse base UUID
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  throw new Error(`invalid UUID: ${input}`);
}

export function is16(uuidStr) {
  return normalizeUuid(uuidStr).length === 4;
}

export function uuid16Value(uuidStr) {
  const u = normalizeUuid(uuidStr);
  return u.length === 4 ? parseInt(u, 16) : null;
}

/** Canonical UUID → little-endian on-wire bytes (2 or 16). */
export function uuidToBytesLE(uuidStr) {
  const u = normalizeUuid(uuidStr);
  if (u.length === 4) {
    const v = parseInt(u, 16);
    return new Uint8Array([v & 0xff, v >> 8]);
  }
  return hexToBytes(u.replace(/-/g, '')).reverse();
}

/** Little-endian on-wire bytes (2 or 16) → canonical UUID string. */
export function bytesLEToUuid(bytes) {
  if (bytes.length === 2) return ((bytes[0] | (bytes[1] << 8)) >>> 0).toString(16).padStart(4, '0').toUpperCase();
  const be = Array.from(bytes).reverse().map((b) => b.toString(16).padStart(2, '0')).join('');
  return normalizeUuid(be);
}

export function uuidEqual(a, b) {
  try { return normalizeUuid(a) === normalizeUuid(b); } catch { return false; }
}
