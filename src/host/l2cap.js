// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// L2CAP over LE: fixed-channel framing and reassembly. An L2CAP PDU is
// [length:2][CID:2][payload(length)]. We reassemble using the length field, so it works
// regardless of the controller's RX packet-boundary-flag polarity. Core v6.0 Vol 3 Part A.

import { ByteWriter, concatBytes } from '../util/bytes.js';

export const L2CAP_CID = {
  SIGNALING: 0x0005, // LE signaling
  ATT: 0x0004,
  SMP: 0x0006,
};

/** Build an L2CAP PDU for a fixed channel. */
export function l2capFrame(cid, payload) {
  return new ByteWriter().u16(payload.length).u16(cid).bytes(payload).build();
}

/** Per-connection reassembler. push() returns any newly completed { cid, payload } PDUs. */
export class L2capReassembler {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(fragment) {
    this.buf = this.buf.length ? concatBytes(this.buf, fragment) : fragment;
    const out = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf[0] | (this.buf[1] << 8);
      const total = 4 + len;
      if (this.buf.length < total) break;
      const cid = this.buf[2] | (this.buf[3] << 8);
      out.push({ cid, payload: this.buf.slice(4, total) });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

// ---- LE signaling channel (CID 0x0005) ----
export const SIG = {
  COMMAND_REJECT: 0x01,
  DISCONNECTION_REQ: 0x06,
  DISCONNECTION_RSP: 0x07,
  CONN_PARAM_UPDATE_REQ: 0x12,
  CONN_PARAM_UPDATE_RSP: 0x13,
};

export function sigConnParamUpdateReq(identifier, { intervalMin, intervalMax, latency, timeout }) {
  const data = new ByteWriter().u16(intervalMin).u16(intervalMax).u16(latency).u16(timeout).build();
  return new ByteWriter().u8(SIG.CONN_PARAM_UPDATE_REQ).u8(identifier).u16(data.length).bytes(data).build();
}

export function sigCommandReject(identifier, reason = 0x0000) {
  const data = new ByteWriter().u16(reason).build();
  return new ByteWriter().u8(SIG.COMMAND_REJECT).u8(identifier).u16(data.length).bytes(data).build();
}

export function parseSignaling(payload) {
  return { code: payload[0], identifier: payload[1], length: payload[2] | (payload[3] << 8), data: payload.subarray(4) };
}
