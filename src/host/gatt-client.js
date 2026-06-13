// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GATT client — runs over the same ATT bearer as our server (GATT is symmetric, so the
// peripheral can browse the connected central's GATT database). Sends ATT requests
// sequentially (one outstanding per bearer), parses responses, and handles inbound
// notifications/indications. Core v6.0 Vol 3 Part F/G.

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { bytesLEToUuid, uuidToBytesLE, normalizeUuid } from '../util/uuid.js';
import { ATT_OP, ATT_ERR_NAMES, DEFAULT_MTU, attChunks } from './att.js';

const RESPONSE_OPS = new Set([0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x11, 0x13, 0x17, 0x19]);
/** True if an inbound ATT PDU belongs to our client (response / notification / indication). */
export function isClientInbound(op) {
  return RESPONSE_OPS.has(op) || op === ATT_OP.HANDLE_VALUE_NTF || op === ATT_OP.HANDLE_VALUE_IND;
}

export class AttError extends Error {
  constructor(reqOpcode, handle, code) {
    super(`ATT error 0x${code.toString(16)} (${ATT_ERR_NAMES[code] || 'unknown'}) on handle 0x${handle.toString(16)}`);
    this.reqOpcode = reqOpcode; this.handle = handle; this.code = code;
  }
}

export class GattClient {
  constructor() {
    this.send = null;     // (conn, pdu) => void
    this.onEvent = null;  // (conn, { type, ... }) => void
  }

  _state(conn) {
    if (!conn.client) conn.client = { mtu: DEFAULT_MTU, pending: null, queue: [], tree: null };
    return conn.client;
  }

  // ---- inbound routing ----
  handle(conn, pdu) {
    const op = pdu[0];
    if (op === ATT_OP.HANDLE_VALUE_NTF) return this._onNotify(conn, pdu, false);
    if (op === ATT_OP.HANDLE_VALUE_IND) { this._onNotify(conn, pdu, true); this.send(conn, new Uint8Array([ATT_OP.HANDLE_VALUE_CFM])); return; }
    const st = this._state(conn);
    const p = st.pending;
    if (!p) return; // unsolicited response — ignore
    clearTimeout(p.timer);
    st.pending = null;
    if (op === ATT_OP.ERROR_RSP) {
      const r = new ByteReader(pdu); r.u8();
      p.reject(new AttError(r.u8(), r.u16(), r.u8()));
    } else {
      p.resolve(pdu);
    }
    this._pump(conn);
  }

  _onNotify(conn, pdu, indication) {
    const handle = pdu[1] | (pdu[2] << 8);
    const value = pdu.subarray(3);
    if (this.onEvent) this.onEvent(conn, { type: 'notification', handle, value: Uint8Array.from(value), indication });
  }

  // ---- sequential request engine ----
  request(conn, pdu) {
    return new Promise((resolve, reject) => {
      this._state(conn).queue.push({ pdu, resolve, reject });
      this._pump(conn);
    });
  }
  _pump(conn) {
    const st = this._state(conn);
    if (st.pending || !st.queue.length) return;
    const item = st.queue.shift();
    st.pending = {
      resolve: item.resolve, reject: item.reject,
      timer: setTimeout(() => { st.pending = null; item.reject(new Error('ATT request timeout')); this._pump(conn); }, 5000),
    };
    this.send(conn, item.pdu);
  }

  // ---- procedures ----
  async exchangeMtu(conn, clientRxMtu = 247) {
    const rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.EXCHANGE_MTU_REQ).u16(clientRxMtu).build());
    const serverRxMtu = rsp[1] | (rsp[2] << 8);
    this._state(conn).mtu = Math.max(DEFAULT_MTU, Math.min(clientRxMtu, serverRxMtu));
    return this._state(conn).mtu;
  }

  async discoverServices(conn) {
    const services = [];
    let start = 0x0001;
    for (;;) {
      let rsp;
      try { rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.READ_BY_GROUP_TYPE_REQ).u16(start).u16(0xffff).u16(0x2800).build()); }
      catch (e) { if (e instanceof AttError) break; throw e; }
      const len = rsp[1];
      const r = new ByteReader(rsp.subarray(2));
      let last = 0;
      while (r.remaining >= len) {
        const s = r.u16(), end = r.u16();
        const uuid = bytesLEToUuid(r.read(len - 4));
        services.push({ uuid, startHandle: s, endHandle: end, characteristics: [] });
        last = end;
      }
      if (last >= 0xffff || last < start) break;
      start = last + 1;
    }
    return services;
  }

  async discoverCharacteristics(conn, svc) {
    const chars = [];
    let start = svc.startHandle;
    for (;;) {
      let rsp;
      try { rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.READ_BY_TYPE_REQ).u16(start).u16(svc.endHandle).u16(0x2803).build()); }
      catch (e) { if (e instanceof AttError) break; throw e; }
      const len = rsp[1];
      const r = new ByteReader(rsp.subarray(2));
      let last = 0;
      while (r.remaining >= len) {
        const declHandle = r.u16();
        const props = r.u8();
        const valueHandle = r.u16();
        const uuid = bytesLEToUuid(r.read(len - 5));
        chars.push({ uuid, declHandle, valueHandle, properties: decodeProps(props), descriptors: [], cccdHandle: null, value: null });
        last = declHandle;
      }
      if (last >= svc.endHandle || last < start) break;
      start = last + 1;
    }
    // end handle per characteristic = next char decl - 1, else service end
    chars.forEach((c, i) => { c.endHandle = i + 1 < chars.length ? chars[i + 1].declHandle - 1 : svc.endHandle; });
    return chars;
  }

  async discoverDescriptors(conn, ch) {
    if (ch.valueHandle >= ch.endHandle) return [];
    const descs = [];
    let start = ch.valueHandle + 1;
    for (;;) {
      let rsp;
      try { rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.FIND_INFORMATION_REQ).u16(start).u16(ch.endHandle).build()); }
      catch (e) { if (e instanceof AttError) break; throw e; }
      const fmt = rsp[1]; const uuidLen = fmt === 1 ? 2 : 16;
      const r = new ByteReader(rsp.subarray(2));
      let last = 0;
      while (r.remaining >= 2 + uuidLen) {
        const handle = r.u16();
        const uuid = bytesLEToUuid(r.read(uuidLen));
        descs.push({ handle, uuid });
        if (normalizeUuid(uuid) === '2902') ch.cccdHandle = handle;
        last = handle;
      }
      if (last >= ch.endHandle || last < start) break;
      start = last + 1;
    }
    return descs;
  }

  /** Full discovery: services → characteristics → descriptors. Stored on conn.client.tree. */
  async discoverAll(conn) {
    this.onEvent?.(conn, { type: 'discovery-start' });
    const services = await this.discoverServices(conn);
    for (const svc of services) {
      svc.characteristics = await this.discoverCharacteristics(conn, svc);
      for (const ch of svc.characteristics) ch.descriptors = await this.discoverDescriptors(conn, ch);
    }
    this._state(conn).tree = services;
    this.onEvent?.(conn, { type: 'discovered', services });
    return services;
  }

  async read(conn, handle) {
    const rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.READ_REQ).u16(handle).build());
    let value = rsp.subarray(1);
    // long read if the value filled (MTU-1)
    if (value.length === this._state(conn).mtu - 1) {
      let offset = value.length;
      const chunks = [Uint8Array.from(value)];
      for (;;) {
        let blob;
        try { blob = await this.request(conn, new ByteWriter().u8(ATT_OP.READ_BLOB_REQ).u16(handle).u16(offset).build()); }
        catch (e) { if (e instanceof AttError) break; throw e; }
        const part = blob.subarray(1);
        if (!part.length) break;
        chunks.push(Uint8Array.from(part));
        offset += part.length;
        if (part.length < this._state(conn).mtu - 1) break;
      }
      value = chunks.reduce((a, c) => { const o = new Uint8Array(a.length + c.length); o.set(a); o.set(c, a.length); return o; });
    }
    return Uint8Array.from(value);
  }

  // Best-effort one-round-trip read of the peer's GAP Device Name (0x2A00): a Read By Type Request
  // over the whole handle range returns the value of the first match. Returns null if absent/empty;
  // throws AttError if the read is refused (e.g. needs encryption) — callers treat that as "unknown".
  async readDeviceName(conn) {
    const rsp = await this.request(conn, new ByteWriter().u8(ATT_OP.READ_BY_TYPE_REQ).u16(0x0001).u16(0xffff).bytes(uuidToBytesLE('2A00')).build());
    if (rsp[0] !== ATT_OP.READ_BY_TYPE_RSP) return null;
    const pairLen = rsp[1];                      // handle(2) + value(pairLen-2)
    const value = rsp.subarray(4, 2 + pairLen);  // first attribute's value
    return value.length ? new TextDecoder().decode(value) : null;
  }

  async write(conn, handle, value, withResponse = true) {
    if (!withResponse) {
      // Write Without Response is an ATT command capped at ATT_MTU-3 — stream a longer value (e.g. a
      // NUS RX message) as several commands instead of one oversized PDU the peer would drop.
      for (const chunk of attChunks(value, this._state(conn).mtu)) {
        this.send(conn, new ByteWriter().u8(ATT_OP.WRITE_CMD).u16(handle).bytes(chunk).build());
      }
      return;
    }
    await this.request(conn, new ByteWriter().u8(ATT_OP.WRITE_REQ).u16(handle).bytes(value).build());
  }

  /** Subscribe via the CCCD: notify (0x0001), indicate (0x0002), or off (0x0000). */
  async configureCccd(conn, cccdHandle, value16) {
    await this.write(conn, cccdHandle, new Uint8Array([value16 & 0xff, (value16 >> 8) & 0xff]), true);
  }
}

function decodeProps(p) {
  const out = [];
  if (p & 0x02) out.push('read');
  if (p & 0x04) out.push('writeNoResp');
  if (p & 0x08) out.push('write');
  if (p & 0x10) out.push('notify');
  if (p & 0x20) out.push('indicate');
  if (p & 0x01) out.push('broadcast');
  if (p & 0x40) out.push('signed');
  return out;
}
