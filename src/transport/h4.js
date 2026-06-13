// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI H4 (UART) transport framing. Each packet is a 1-byte type indicator followed
// by the HCI packet. We frame outgoing packets and incrementally deframe the byte
// stream coming back from the controller.

import { concatBytes } from '../util/bytes.js';

export const H4 = {
  COMMAND: 0x01,
  ACL: 0x02,
  SCO: 0x03,
  EVENT: 0x04,
  ISO: 0x05,
};

export const H4_NAMES = {
  0x01: 'CMD',
  0x02: 'ACL',
  0x03: 'SCO',
  0x04: 'EVT',
  0x05: 'ISO',
};

/** Prepend the H4 type byte to an HCI packet. */
export function frame(type, packet) {
  return concatBytes(new Uint8Array([type]), packet);
}

/**
 * Incremental H4 deframer. Feed raw bytes; emits complete packets as
 * onPacket(type, hciPacketBytes) where hciPacketBytes excludes the type byte.
 */
export class H4Deframer {
  constructor() {
    this.buf = new Uint8Array(0);
    this.onPacket = null; // (type, Uint8Array) => void
    this.onError = null; // (msg) => void
  }

  feed(chunk) {
    this.buf = this.buf.length ? concatBytes(this.buf, chunk) : chunk;
    this._drain();
  }

  /** Drop any buffered bytes (e.g. an ESP boot-log burst) so the next packet parses cleanly. */
  flush() { this.buf = new Uint8Array(0); }

  _drain() {
    for (;;) {
      if (this.buf.length < 1) return;
      const type = this.buf[0];
      const total = this._packetLength(type, this.buf); // includes type byte
      if (total === -1) {
        // Unknown type byte — desync. Drop one byte and try to resync.
        if (this.onError) this.onError(`unknown H4 type 0x${type.toString(16)} — resyncing`);
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (total === 0) return; // need more bytes for the header
      if (this.buf.length < total) return; // need more bytes for the body
      const packet = this.buf.slice(1, total);
      this.buf = this.buf.subarray(total);
      if (this.onPacket) this.onPacket(type, packet);
    }
  }

  /** Total packet length (incl. type byte), 0 if header incomplete, -1 if bad type. */
  _packetLength(type, b) {
    switch (type) {
      case H4.EVENT: // [type][code][plen][params...]
        if (b.length < 3) return 0;
        return 3 + b[2];
      case H4.ACL: // [type][handle:2][len:2][payload...]
        if (b.length < 5) return 0;
        return 5 + (b[3] | (b[4] << 8));
      case H4.ISO: // [type][handle:2][len:2 (14-bit)][payload...]
        if (b.length < 5) return 0;
        return 5 + ((b[3] | (b[4] << 8)) & 0x3fff);
      case H4.SCO: // [type][handle:2][len:1][payload...]
        if (b.length < 4) return 0;
        return 4 + b[3];
      case H4.COMMAND: // [type][opcode:2][plen:1][params...] (host→controller; unexpected inbound)
        if (b.length < 4) return 0;
        return 4 + b[3];
      default:
        return -1;
    }
  }
}
