// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GATT server: handles ATT requests against the attribute database and per-connection
// state (MTU, CCCDs). Pure with respect to I/O — handle() returns response bytes (or null
// for commands); the connection manager sends them and drives notifications.

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { bytesLEToUuid, uuidToBytesLE } from '../util/uuid.js';
import { ATT_OP, ATT_ERR, DEFAULT_MTU, errorRsp, handleValueNotification, handleValueIndication } from './att.js';
import * as db from './gatt-db.js';

const MAX_ATTR_VALUE_LEN = 512;   // GATT maximum attribute value length (Core v6.0 Vol 3 Part F §3.2.9)
const MAX_PREPARED_WRITES = 1024; // bound the per-connection prepare queue (Write Long / Reliable Write)

export class GattServer {
  constructor() {
    this.db = db.buildDb({ services: [] });
    this.serverRxMtu = 247;
    this.onWrite = null; // (attr, value, conn) => void
  }

  setTable(table) {
    this.db = db.buildDb(table);
  }

  /** Dispatch an ATT PDU. Returns response bytes, or null for commands / no-response. */
  handle(conn, pdu) {
    if (!pdu.length) return null;
    const op = pdu[0];
    const r = new ByteReader(pdu);
    r.u8();
    try {
      switch (op) {
        case ATT_OP.EXCHANGE_MTU_REQ: {
          const clientMtu = r.u16();
          conn.mtu = Math.max(DEFAULT_MTU, Math.min(clientMtu, this.serverRxMtu));
          return new ByteWriter().u8(ATT_OP.EXCHANGE_MTU_RSP).u16(this.serverRxMtu).build();
        }
        case ATT_OP.FIND_INFORMATION_REQ: return this.findInformation(conn, r);
        case ATT_OP.FIND_BY_TYPE_VALUE_REQ: return this.findByTypeValue(conn, r);
        case ATT_OP.READ_BY_TYPE_REQ: return this.readByType(conn, r);
        case ATT_OP.READ_BY_GROUP_TYPE_REQ: return this.readByGroupType(conn, r);
        case ATT_OP.READ_REQ: return this.read(conn, r);
        case ATT_OP.READ_BLOB_REQ: return this.readBlob(conn, r);
        case ATT_OP.WRITE_REQ: return this.write(conn, r, true);
        case ATT_OP.WRITE_CMD: this.write(conn, r, false); return null;
        case ATT_OP.PREPARE_WRITE_REQ: return this.prepareWrite(conn, r);
        case ATT_OP.EXECUTE_WRITE_REQ: return this.executeWrite(conn, r);
        case ATT_OP.HANDLE_VALUE_CFM: return null; // indication acknowledged
        default: return errorRsp(op, 0, ATT_ERR.REQUEST_NOT_SUPPORTED);
      }
    } catch (e) {
      return errorRsp(op, 0, ATT_ERR.UNLIKELY_ERROR);
    }
  }

  // ---- request handlers ----

  findInformation(conn, r) {
    const start = r.u16(), end = r.u16();
    const attrs = db.attrsInRange(this.db, start, end);
    if (!attrs.length) return errorRsp(ATT_OP.FIND_INFORMATION_REQ, start, ATT_ERR.ATTRIBUTE_NOT_FOUND);
    const fmt = attrs[0].type.length === 4 ? 1 : 2;
    const uuidLen = fmt === 1 ? 2 : 16;
    const maxPairs = Math.max(1, Math.floor((conn.mtu - 2) / (2 + uuidLen)));
    const w = new ByteWriter().u8(ATT_OP.FIND_INFORMATION_RSP).u8(fmt);
    let n = 0;
    for (const a of attrs) {
      const aFmt = a.type.length === 4 ? 1 : 2;
      if (aFmt !== fmt) break;
      w.u16(a.handle).bytes(uuidToBytesLE(a.type));
      if (++n >= maxPairs) break;
    }
    return w.build();
  }

  findByTypeValue(conn, r) {
    const start = r.u16(), end = r.u16();
    const type = r.u16();
    const value = r.rest();
    const groups = db.servicesByUuid(this.db, start, end, type, value);
    if (!groups.length) return errorRsp(ATT_OP.FIND_BY_TYPE_VALUE_REQ, start, ATT_ERR.ATTRIBUTE_NOT_FOUND);
    const w = new ByteWriter().u8(ATT_OP.FIND_BY_TYPE_VALUE_RSP);
    const max = Math.max(1, Math.floor((conn.mtu - 1) / 4));
    groups.slice(0, max).forEach((g) => w.u16(g.startHandle).u16(g.endHandle));
    return w.build();
  }

  readByType(conn, r) {
    const start = r.u16(), end = r.u16();
    const type = bytesLEToUuid(r.rest());
    const found = db.findByType(this.db, start, end, type);
    if (!found.length) return errorRsp(ATT_OP.READ_BY_TYPE_REQ, start, ATT_ERR.ATTRIBUTE_NOT_FOUND);
    const firstVal = this.readValue(conn, found[0]);
    if (typeof firstVal === 'number') return errorRsp(ATT_OP.READ_BY_TYPE_REQ, found[0].handle, firstVal);
    const vlen = Math.min(firstVal.length, conn.mtu - 4, 253);
    const entrySize = 2 + vlen;
    const maxEntries = Math.max(1, Math.floor((conn.mtu - 2) / entrySize));
    const w = new ByteWriter().u8(ATT_OP.READ_BY_TYPE_RSP).u8(entrySize);
    let n = 0;
    for (const a of found) {
      const v = this.readValue(conn, a);
      if (typeof v === 'number' || v.length !== firstVal.length) break;
      w.u16(a.handle).bytes(v.subarray(0, vlen));
      if (++n >= maxEntries) break;
    }
    return w.build();
  }

  readByGroupType(conn, r) {
    const start = r.u16(), end = r.u16();
    const type = bytesLEToUuid(r.rest());
    if (type !== '2800' && type !== '2801') return errorRsp(ATT_OP.READ_BY_GROUP_TYPE_REQ, start, ATT_ERR.UNSUPPORTED_GROUP_TYPE);
    const groups = db.servicesInRange(this.db, start, end, type);
    if (!groups.length) return errorRsp(ATT_OP.READ_BY_GROUP_TYPE_REQ, start, ATT_ERR.ATTRIBUTE_NOT_FOUND);
    const vlen = Math.min(groups[0].valueBytes.length, conn.mtu - 6);
    const entrySize = 4 + vlen;
    const maxEntries = Math.max(1, Math.floor((conn.mtu - 2) / entrySize));
    const w = new ByteWriter().u8(ATT_OP.READ_BY_GROUP_TYPE_RSP).u8(entrySize);
    let n = 0;
    for (const g of groups) {
      if (g.valueBytes.length !== groups[0].valueBytes.length) break;
      w.u16(g.startHandle).u16(g.endHandle).bytes(g.valueBytes.subarray(0, vlen));
      if (++n >= maxEntries) break;
    }
    return w.build();
  }

  read(conn, r) {
    const handle = r.u16();
    const attr = this.db.byHandle.get(handle);
    if (!attr) return errorRsp(ATT_OP.READ_REQ, handle, ATT_ERR.INVALID_HANDLE);
    const v = this.readValue(conn, attr);
    if (typeof v === 'number') return errorRsp(ATT_OP.READ_REQ, handle, v);
    return new ByteWriter().u8(ATT_OP.READ_RSP).bytes(v.subarray(0, conn.mtu - 1)).build();
  }

  readBlob(conn, r) {
    const handle = r.u16(), offset = r.u16();
    const attr = this.db.byHandle.get(handle);
    if (!attr) return errorRsp(ATT_OP.READ_BLOB_REQ, handle, ATT_ERR.INVALID_HANDLE);
    const v = this.readValue(conn, attr);
    if (typeof v === 'number') return errorRsp(ATT_OP.READ_BLOB_REQ, handle, v);
    if (offset > v.length) return errorRsp(ATT_OP.READ_BLOB_REQ, handle, ATT_ERR.INVALID_OFFSET);
    return new ByteWriter().u8(ATT_OP.READ_BLOB_RSP).bytes(v.subarray(offset, offset + conn.mtu - 1)).build();
  }

  write(conn, r, withResponse) {
    const handle = r.u16();
    const value = r.rest();
    const attr = this.db.byHandle.get(handle);
    if (!attr) return withResponse ? errorRsp(ATT_OP.WRITE_REQ, handle, ATT_ERR.INVALID_HANDLE) : null;
    const err = this.writeValue(conn, attr, value);
    if (err) return withResponse ? errorRsp(ATT_OP.WRITE_REQ, handle, err) : null;
    return withResponse ? new Uint8Array([ATT_OP.WRITE_RSP]) : null;
  }

  // Write Long / Reliable Write: the client queues value fragments with Prepare Write, then commits
  // (or cancels) them all with Execute Write. Used to write a value longer than ATT_MTU-3. Fragments
  // are held per connection until execute; permission is checked up front so a bad handle is rejected
  // before anything is queued. The response echoes the handle/offset/value (clients verify this).
  prepareWrite(conn, r) {
    const handle = r.u16();
    const offset = r.u16();
    const value = r.rest();
    const attr = this.db.byHandle.get(handle);
    if (!attr) return errorRsp(ATT_OP.PREPARE_WRITE_REQ, handle, ATT_ERR.INVALID_HANDLE);
    if (!attr.perms.write) return errorRsp(ATT_OP.PREPARE_WRITE_REQ, handle, ATT_ERR.WRITE_NOT_PERMITTED);
    if (attr.perms.writeEnc && !conn.encrypted) return errorRsp(ATT_OP.PREPARE_WRITE_REQ, handle, ATT_ERR.INSUFFICIENT_ENCRYPTION);
    const q = (conn.prepared ||= []);
    if (q.length >= MAX_PREPARED_WRITES) return errorRsp(ATT_OP.PREPARE_WRITE_REQ, handle, ATT_ERR.PREPARE_QUEUE_FULL);
    q.push({ handle, offset, value: value.slice() }); // copy: the PDU buffer is reused after we return
    return new ByteWriter().u8(ATT_OP.PREPARE_WRITE_RSP).u16(handle).u16(offset).bytes(value).build();
  }

  executeWrite(conn, r) {
    const flags = r.u8();
    const queue = conn.prepared || [];
    conn.prepared = []; // executing (commit or cancel) always empties the queue
    if (flags === 0x00) return new Uint8Array([ATT_OP.EXECUTE_WRITE_RSP]); // 0x00 = cancel all

    // Commit: reassemble each handle's fragments in offset order (must be contiguous from 0), then
    // apply as a single write so onWrite sees the whole value. On any error the queue is already
    // cleared and we report it against the offending handle (per spec).
    const byHandle = new Map();
    for (const p of queue) {
      if (!byHandle.has(p.handle)) byHandle.set(p.handle, []);
      byHandle.get(p.handle).push(p);
    }
    for (const [handle, parts] of byHandle) {
      parts.sort((a, b) => a.offset - b.offset);
      let assembled = new Uint8Array(0);
      for (const p of parts) {
        if (p.offset > assembled.length) return errorRsp(ATT_OP.EXECUTE_WRITE_REQ, handle, ATT_ERR.INVALID_OFFSET);
        const end = Math.max(assembled.length, p.offset + p.value.length);
        if (end > MAX_ATTR_VALUE_LEN) return errorRsp(ATT_OP.EXECUTE_WRITE_REQ, handle, ATT_ERR.INVALID_ATTRIBUTE_VALUE_LENGTH);
        const buf = new Uint8Array(end);
        buf.set(assembled);
        buf.set(p.value, p.offset);
        assembled = buf;
      }
      const attr = this.db.byHandle.get(handle);
      if (!attr) return errorRsp(ATT_OP.EXECUTE_WRITE_REQ, handle, ATT_ERR.INVALID_HANDLE);
      const err = this.writeValue(conn, attr, assembled);
      if (err) return errorRsp(ATT_OP.EXECUTE_WRITE_REQ, handle, err);
    }
    return new Uint8Array([ATT_OP.EXECUTE_WRITE_RSP]);
  }

  // ---- value access with permission checks ----

  readValue(conn, attr) {
    if (attr.meta?.isCCCD) {
      const v = conn.cccd.get(attr.meta.charValueHandle) || 0;
      return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
    }
    if (!attr.perms.read) return ATT_ERR.READ_NOT_PERMITTED;
    if (attr.perms.readEnc && !conn.encrypted) return ATT_ERR.INSUFFICIENT_ENCRYPTION;
    return attr.value;
  }

  writeValue(conn, attr, value) {
    if (!attr.perms.write) return ATT_ERR.WRITE_NOT_PERMITTED;
    if (attr.perms.writeEnc && !conn.encrypted) return ATT_ERR.INSUFFICIENT_ENCRYPTION;
    if (attr.meta?.isCCCD) {
      conn.cccd.set(attr.meta.charValueHandle, (value[0] || 0) | ((value[1] || 0) << 8));
      return 0;
    }
    attr.value = value.slice();
    if (this.onWrite) this.onWrite(attr, value, conn);
    return 0;
  }

  // ---- notifications / indications (built here, sent by the connection manager) ----

  cccd(conn, valueHandle) {
    const v = conn.cccd.get(valueHandle) || 0;
    return { notify: !!(v & 0x0001), indicate: !!(v & 0x0002) };
  }

  notification(handle, value) { return handleValueNotification(handle, value); }
  indication(handle, value) { return handleValueIndication(handle, value); }
}
