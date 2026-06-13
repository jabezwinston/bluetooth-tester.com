// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Minimal ZIP archive writer — STORE method (no compression). Enough to bundle a handful of
// text/binary files into one downloadable .zip with valid CRC32s, no dependencies. Layout per
// APPNOTE (PKWARE): each file is a Local File Header + raw data, followed by a Central Directory
// and an End-Of-Central-Directory record. Reused by the session export.

import { crc32 } from './crc32.js';
import { concatBytes } from './bytes.js';

const LFH_SIG = 0x04034b50;  // local file header
const CDH_SIG = 0x02014b50;  // central directory header
const EOCD_SIG = 0x06054b50; // end of central directory

const utf8 = (s) => new TextEncoder().encode(s);

// Pack a Date into MS-DOS time/date fields (DOS epoch = 1980; 2-second time resolution).
function dosDateTime(date) {
  const y = date.getFullYear();
  if (y < 1980) return { time: 0, date: 0x21 }; // 1980-01-01
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dt = (((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, date: dt };
}

/**
 * Build a STORE-method ZIP Blob. `files` = [{ name, data }] where `data` is a Uint8Array or string.
 * `date` stamps every entry (default fixed MS-DOS epoch → deterministic output for tests).
 */
export function zipStore(files, { date = new Date(1980, 0, 1) } = {}) {
  const { time: dosTime, date: dosDate } = dosDateTime(date);
  const parts = [];   // local headers + file data, in order
  const central = []; // central directory headers
  let offset = 0;     // running offset of each local header

  for (const f of files) {
    const nameBytes = utf8(f.name);
    const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    const crc = crc32(data);
    const n = data.length;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, LFH_SIG, true);
    dv.setUint16(4, 20, true);      // version needed to extract
    dv.setUint16(6, 0x0800, true);  // general-purpose flags: UTF-8 filename
    dv.setUint16(8, 0, true);       // compression method 0 = store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, n, true);      // compressed size
    dv.setUint32(22, n, true);      // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);      // extra field length
    lfh.set(nameBytes, 30);
    parts.push(lfh, data);

    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, CDH_SIG, true);
    cv.setUint16(4, 20, true);      // version made by
    cv.setUint16(6, 20, true);      // version needed
    cv.setUint16(8, 0x0800, true);  // flags
    cv.setUint16(10, 0, true);      // method
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, n, true);
    cv.setUint32(24, n, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);      // extra length
    cv.setUint16(32, 0, true);      // comment length
    cv.setUint16(34, 0, true);      // disk number start
    cv.setUint16(36, 0, true);      // internal attributes
    cv.setUint32(38, 0, true);      // external attributes
    cv.setUint32(42, offset, true); // relative offset of local header
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.length + n;
  }

  const cdBytes = concatBytes(...central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true);                // this disk number
  ev.setUint16(6, 0, true);                // disk with central directory
  ev.setUint16(8, files.length, true);     // entries on this disk
  ev.setUint16(10, files.length, true);    // total entries
  ev.setUint32(12, cdBytes.length, true);  // central directory size
  ev.setUint32(16, offset, true);          // central directory offset
  ev.setUint16(20, 0, true);               // comment length

  return new Blob([...parts, cdBytes, eocd], { type: 'application/zip' });
}
