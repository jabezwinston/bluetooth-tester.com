// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Standard CRC32 (reversed polynomial 0xEDB88320). Chainable across chunks:
// crc32(b2, crc32(b1, 0)) === crc32(concat(b1, b2)). Shared by the nRF DFU protocol
// (per-object verification) and the ZIP writer (per-file checksum).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  crc = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
