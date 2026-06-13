// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Export / import advertising + scan-response data as a single JSON document in Length/Type/Value
// form. Each AD structure becomes one { comment, len, type, value } entry: `type` and `len` are
// 0x-prefixed hex strings, `value` is continuous uppercase hex in on-air (big-endian) byte order.
// JSON has no comment syntax, so the human-readable note lives in a real "comment" field per entry
// (and a top-level "_comment" describing the format) — never `//`-style comments.

import { ByteWriter, bytesToHex, hexToBytes } from '../util/bytes.js';
import { parse } from './ad.js';

const FORMAT_COMMENT = 'Bluetooth AD structures: Len, Type, Value (hex, on-air order)';

const hexByte = (n) => '0x' + (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

// One { comment, len, type, value } entry per parsed AD structure. The comment reuses the panel's
// decoded view (typeName + human-readable value), dropping it when it's just the raw hex again.
function entriesFor(bytes) {
  return parse(bytes).map((s) => {
    const value = bytesToHex(s.data, '').toUpperCase();
    const decoded = s.decoded == null ? '' : String(s.decoded);
    const sameAsHex = decoded.replace(/\s+/g, '').toUpperCase() === value;
    return {
      comment: decoded && !sameAsHex ? `${s.typeName}: ${decoded}` : s.typeName,
      len: hexByte(s.data.length + 1),
      type: hexByte(s.type),
      value,
    };
  });
}

/** Build the export document from assembled advertising + scan-response byte payloads. */
export function buildAdExport(advBytes, scanBytes) {
  return {
    _comment: FORMAT_COMMENT,
    advertisingData: entriesFor(advBytes),
    scanResponseData: entriesFor(scanBytes),
  };
}

// Accept "0x01" | "01" | 1 for a single byte (type / len).
function toByte(x, what) {
  const n = typeof x === 'number' ? x : parseInt(String(x).trim(), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`invalid ${what}: ${JSON.stringify(x)}`);
  return n;
}

// Reassemble [len][type][value…] AD bytes from a list of entries. The JSON `len` is advisory — it's
// recomputed from the value so a hand-edited file can't desync — but a stated mismatch is reported.
function assembleEntries(entries, where) {
  const w = new ByteWriter();
  entries.forEach((e, i) => {
    if (e == null || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where}[${i}] is not an object`);
    if (e.type == null) throw new Error(`${where}[${i}] is missing "type"`);
    const type = toByte(e.type, `${where}[${i}].type`);
    const val = hexToBytes(e.value == null ? '' : String(e.value));
    if (e.len != null) {
      const declared = toByte(e.len, `${where}[${i}].len`);
      if (declared !== val.length + 1) throw new Error(`${where}[${i}]: len ${hexByte(declared)} ≠ value length + 1 (${hexByte(val.length + 1)})`);
    }
    w.u8(val.length + 1).u8(type).bytes(val);
  });
  return w.build();
}

/**
 * Parse + validate an import document → { advBytes, scanBytes } (Uint8Array). Throws on malformed
 * input. Accepts the export's `advertisingData`/`scanResponseData`; either may be omitted (→ empty).
 */
export function parseAdImport(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
  const adv = doc.advertisingData ?? [];
  const scan = doc.scanResponseData ?? [];
  if (!Array.isArray(adv)) throw new Error('"advertisingData" must be an array');
  if (!Array.isArray(scan)) throw new Error('"scanResponseData" must be an array');
  return {
    advBytes: assembleEntries(adv, 'advertisingData'),
    scanBytes: assembleEntries(scan, 'scanResponseData'),
  };
}
