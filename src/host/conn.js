// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Connection manager: tracks LE connections, reassembles L2CAP, routes fixed channels to
// the GATT server / signaling / SMP, drives notifications, and mirrors state to the store.

import { L2CAP_CID, L2capReassembler, l2capFrame, sigConnParamUpdateReq, sigCommandReject, parseSignaling, SIG } from './l2cap.js';
import { GattServer } from './gatt-server.js';
import { attChunks } from './att.js';
import { SMP, SMP_OP } from './smp.js';
import { GattClient, isClientInbound } from './gatt-client.js';
import { startAdvertising } from './gap.js';
import { generateRpa, randomBytes } from './crypto.js';
import { bytesToHex, addrToString, bytesEqual } from '../util/bytes.js';
import { normalizeUuid } from '../util/uuid.js';
import { hciError } from '../hci/codes.js';
import * as cmd from '../hci/commands.js';

const reverse = (b) => Uint8Array.from(b).reverse();
// "AA:BB:..:FF" -> bytes in display (MSO-first) order, as the SMP crypto toolbox expects.
const parseAddrBE = (str) => new Uint8Array(String(str).split(/[:\-]/).map((h) => parseInt(h, 16)));

export class ConnectionManager {
  constructor(store, hci, notices = null) {
    this.store = store;
    this.hci = hci;
    this.notices = notices; // NoticeFeed for discrete connect/disconnect events (toast + log record)
    this.gatt = new GattServer();
    this.gatt.onWrite = (attr, value) => this._onGattWrite(attr, value);
    this.smp = new SMP();
    this.smp.send = (conn, pdu) => this._send(conn, L2CAP_CID.SMP, pdu);
    this.smp.getLocalAddr = (conn) => this._localAddr(conn);
    this.smp.onEvent = (conn, ev) => this._onSmpEvent(conn, ev);
    this.applySmpConfig();
    this.gattClient = new GattClient();
    this.gattClient.send = (conn, pdu) => this._send(conn, L2CAP_CID.ATT, pdu);
    this.gattClient.onEvent = (conn, ev) => this._onClientEvent(conn, ev);
    this.conns = new Map(); // handle -> live connection
    this.bonds = []; // in-memory; persisted in a later step
    this._sigId = 1;

    hci.on('connection_complete', (ev) => this._onConnect(ev));
    hci.on('disconnection_complete', (ev) => this._onDisconnect(ev));
    hci.on('read_remote_version_complete', (ev) => this._onRemoteVersion(ev));
    hci.on('remote_conn_param_request', (ev) => this._onRemoteConnParamReq(ev));
    hci.on('connection_update_complete', (ev) => this._onConnUpdate(ev));
    hci.on('long_term_key_request', (ev) => this._onLtkRequest(ev));
    hci.on('encryption_change', (ev) => this._onEncryptionChange(ev));
    hci.on('acl', (pkt) => this._onAcl(pkt));
  }

  applySmpConfig() {
    const s = this.store.state.smp;
    this.smp.configure({
      io: s.io, bonding: s.bonding, mitm: s.mitm, sc: s.sc, maxKey: s.maxKey,
      passkey: s.passkey, acceptPairing: s.acceptPairing !== false, initKeyDist: 0x07, respKeyDist: 0x07,
    });
  }

  _localAddr(conn) {
    // The address we actually advertised with for this connection. With own-address-type = random
    // the link (and SC f5/f6 + legacy c1, which fold our address+type into the keys) uses the
    // random static address with type 1 — using the controller's public BD_ADDR (00:..:00 on
    // Zephyr/nRF) instead makes pairing fail with DHKey Check Failed. Snapshotted at connect time.
    if (conn && conn.localAddr) return conn.localAddr;
    return this._advLocalAddr();
  }

  _advLocalAddr() {
    const adv = this.store.state.advertiser;
    if (adv.ownAddressType === 'random') return { type: 1, bytesBE: parseAddrBE(adv.randomAddress) };
    return { type: 0, bytesBE: parseAddrBE(this.store.state.controller.bdAddr || '00:00:00:00:00:00') };
  }

  setGattTable(table) {
    this.gatt.setTable(table);
    this._sync();
  }

  // ---- HCI events ----

  _onConnect(ev) {
    if (ev.status !== 0) {
      this._notice('warn', `Connection failed: 0x${ev.status.toString(16)}`);
      return;
    }
    const lb = this.store.state.controller.leBufferSize;
    if (lb) this.hci.configureAcl(lb.aclLen, lb.numAcl);

    const localAddr = this._advLocalAddr(); // the address/type we advertised with → used by SMP
    this.conns.set(ev.handle, {
      handle: ev.handle, role: ev.role, peerAddr: ev.peerAddr, peerAddrType: ev.peerAddrType,
      localAddr, localAddrType: localAddr.type, interval: ev.interval, latency: ev.latency, timeout: ev.timeout,
      mtu: 23, encrypted: false, cccd: new Map(), reass: new L2capReassembler(), pairing: null,
    });
    this.store.update((s) => { s.advertiser.enabled = false; }); // connectable adv auto-stops
    this._sync();
    // Ask the controller to fetch the remote's LMP/LL version, manufacturer and subversion. The
    // answer comes back asynchronously as a Read Remote Version Information Complete event.
    this.hci.command(cmd.readRemoteVersion(ev.handle)).catch(() => {});
    this._announceConnect(ev.handle);
  }

  // Emit a "Connected" notification, resolving the peer's GAP Device Name (0x2A00) best-effort so it
  // reads "Name (address)". The name read can fail (not exposed / needs encryption) or time out, in
  // which case we announce the address alone.
  async _announceConnect(handle) {
    const conn = this.conns.get(handle);
    if (!conn) return;
    let name = null;
    try {
      name = await Promise.race([
        this.gattClient.readDeviceName(conn),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
      ]);
    } catch { /* name unavailable — announce the address only */ }
    if (!this.conns.has(handle)) return; // disconnected while resolving
    if (name) { conn.peerName = name; this._sync(); }
    const role = conn.role === 1 ? 'central' : 'peripheral';
    this._event('info', `🔗 Connected: ${name ? `${name} (${conn.peerAddr})` : conn.peerAddr} · ${role}`);
  }

  _onRemoteVersion(ev) {
    const conn = this.conns.get(ev.handle);
    if (!conn || ev.status !== 0) return;
    conn.remoteVersion = { version: ev.version, manufacturer: ev.manufacturer, subversion: ev.subversion };
    this._sync();
  }

  _onDisconnect(ev) {
    const conn = this.conns.get(ev.handle);
    if (conn) {
      const who = conn.peerName ? `${conn.peerName} (${conn.peerAddr})` : conn.peerAddr;
      this._event('info', `🔌 Disconnected: ${who} · ${hciError(ev.reason)}`);
    }
    this.conns.delete(ev.handle);
    this.store.update((s) => { const c = { ...s.client }; delete c[ev.handle]; s.client = c; });
    this._sync();
    if (this.store.state.advertiser.autoReadvertise && this.conns.size === 0) {
      startAdvertising(this.hci, this.store).catch((e) => this._notice('warn', `Re-advertise failed: ${e.message}`));
    }
  }

  // The central asked to change connection parameters. Because we unmask this LE event,
  // the spec requires the host to reply — accept the requested parameters.
  _onRemoteConnParamReq(ev) {
    this.hci.command(cmd.leRemoteConnParamReqReply({
      handle: ev.handle, intervalMin: ev.intervalMin, intervalMax: ev.intervalMax,
      latency: ev.latency, timeout: ev.timeout,
    })).catch((e) => this._notice('warn', `Conn param reply failed: ${e.message}`));
  }

  _onConnUpdate(ev) {
    const conn = this.conns.get(ev.handle);
    if (!conn || ev.status !== 0) return;
    conn.interval = ev.interval;
    conn.latency = ev.latency;
    conn.timeout = ev.timeout;
    this._sync();
  }

  _onAcl(pkt) {
    const handle = (pkt[0] | (pkt[1] << 8)) & 0x0fff;
    const len = pkt[2] | (pkt[3] << 8);
    const conn = this.conns.get(handle);
    if (!conn) return;
    for (const { cid, payload } of conn.reass.push(pkt.subarray(4, 4 + len))) this._onL2cap(conn, cid, payload);
  }

  _onL2cap(conn, cid, payload) {
    if (cid === L2CAP_CID.ATT) {
      if (isClientInbound(payload[0])) {
        this.gattClient.handle(conn, payload); // response / notification for our client
      } else {
        const rsp = this.gatt.handle(conn, payload); // request / command for our server
        if (rsp) this._send(conn, L2CAP_CID.ATT, rsp);
        this._sync(); // MTU / CCCD may have changed
      }
    } else if (cid === L2CAP_CID.SIGNALING) {
      this._onSignaling(conn, payload);
    } else if (cid === L2CAP_CID.SMP) {
      this.smp.handlePdu(conn, payload);
    }
  }

  _onSignaling(conn, payload) {
    const sig = parseSignaling(payload);
    if (sig.code === SIG.CONN_PARAM_UPDATE_RSP) {
      const result = sig.data[0] | (sig.data[1] << 8);
      this._notice(result === 0 ? 'warn' : 'warn', `Conn param update ${result === 0 ? 'accepted' : 'rejected'} by peer`);
    } else if (sig.code & 0x01) {
      // Unhandled request → Command Reject (not understood).
      this._send(conn, L2CAP_CID.SIGNALING, sigCommandReject(sig.identifier, 0x0000));
    }
  }

  // ---- SMP / encryption ----
  _onLtkRequest(ev) {
    const conn = this.conns.get(ev.handle);
    if (conn && conn.pairing && conn.pairing.ltk) {
      // Active pairing: provide the freshly derived LTK (reverse BE crypto LTK -> LE for HCI).
      this.hci.command(cmd.leLongTermKeyRequestReply(ev.handle, reverse(conn.pairing.ltk))).catch((e) => this._notice('warn', `LTK reply failed: ${e.message}`));
      return;
    }
    const bond = this._findBond(conn, ev.ediv, ev.rand);
    if (bond) {
      this.hci.command(cmd.leLongTermKeyRequestReply(ev.handle, reverse(bond.ltkBE))).catch((e) => this._notice('warn', `LTK reply failed: ${e.message}`));
      this._notice('warn', 'Bonded peer reconnected; LTK provided');
    } else {
      this.hci.command(cmd.leLongTermKeyRequestNegReply(ev.handle)).catch(() => {});
    }
  }

  _onEncryptionChange(ev) {
    const conn = this.conns.get(ev.handle);
    if (!conn) return;
    conn.encrypted = ev.status === 0 && ev.enabled !== 0;
    if (conn.encrypted && conn.pairing && conn.pairing.state === 'await-encrypt') this.smp.startKeyDistribution(conn);
    this._sync();
  }

  _onSmpEvent(conn, ev) {
    const s = this.store.state.smp;
    if (ev.type === 'start') { s.status = 'pairing'; s.current = { handle: conn.handle, peerAddr: conn.peerAddr, method: ev.method, sc: ev.sc }; }
    else if (ev.type === 'passkey-display') { s.status = 'passkey-display'; s.current = { ...(s.current || {}), passkey: ev.passkey }; this._notice('warn', `Passkey: ${String(ev.passkey).padStart(6, '0')}`); }
    else if (ev.type === 'passkey-request') { s.status = 'passkey-input'; }
    else if (ev.type === 'numeric-comparison') { s.status = 'numeric-comparison'; s.current = { ...(s.current || {}), ncValue: ev.value }; }
    else if (ev.type === 'complete') this._onPairingComplete(conn, ev);
    else if (ev.type === 'failed') { s.status = 'failed'; this._notice('warn', `Pairing failed: ${ev.reasonName || ev.reason}`); }
    this.store.touch();
  }

  _onPairingComplete(conn, ev) {
    const s = this.store.state.smp;
    s.status = 'paired';
    const sessionLtk = conn.pairing?.ltk;    // encrypts THIS session (the STK in legacy pairing)
    const ltk = ev.keys?.ltk || sessionLtk;  // persistent LTK for bonding/reconnection
    s.lastKeys = {
      ltk: ltk ? bytesToHex(ltk) : null,
      irk: ev.keys?.irk ? bytesToHex(ev.keys.irk) : null,
      csrk: ev.keys?.csrk ? bytesToHex(ev.keys.csrk) : null,
      peerIrk: ev.peerKeys?.irk ? bytesToHex(ev.peerKeys.irk) : null,
      sc: ev.sc, method: ev.method, keySize: ev.keySize,
    };
    if (ev.bonding && ltk) {
      const bond = {
        id: `${conn.peerAddr}-${Date.now()}`, peerAddr: conn.peerAddr,
        idAddr: ev.peerKeys?.idAddr ? bytesToHex(ev.peerKeys.idAddr, ':') : conn.peerAddr,
        ltkBE: ltk, ltkHex: bytesToHex(ltk),
        ediv: ev.keys?.ediv ?? 0, rand: ev.keys?.rand || new Uint8Array(8), // legacy reconnect tags (0 for SC)
        irkHex: ev.peerKeys?.irk ? bytesToHex(ev.peerKeys.irk) : null,
        csrkHex: ev.peerKeys?.csrk ? bytesToHex(ev.peerKeys.csrk) : null,
        peerIrk: ev.peerKeys?.irk || null, sc: ev.sc, keySize: ev.keySize, when: Date.now(),
      };
      this.bonds = [...this.bonds.filter((b) => b.peerAddr !== bond.peerAddr), bond];
      this._syncBonds();
    }
    this._notice('warn', `Paired (${ev.sc ? 'LE SC' : 'legacy'}, ${ev.method})`);
  }

  _findBond(conn, ediv, rand) {
    // Legacy reconnection: the peer returns the EDIV/Rand we distributed during pairing. Its
    // address may now be a fresh RPA, so match on those tags first. SC bonds store ediv/rand = 0
    // and fall back to matching by peer address.
    const legacy = this.bonds.find((b) => b.ediv && b.ediv === ediv && b.rand && bytesEqual(b.rand, rand));
    if (legacy) return legacy;
    return this.bonds.find((b) => conn && b.peerAddr === conn.peerAddr) || null;
  }

  _syncBonds() {
    this.store.update((st) => {
      st.bonds = this.bonds.map((b) => ({ id: b.id, peerAddr: b.peerAddr, idAddr: b.idAddr, ltkHex: b.ltkHex, irkHex: b.irkHex, csrkHex: b.csrkHex, sc: b.sc, keySize: b.keySize, when: b.when }));
    });
  }

  deleteBond(id) { this.bonds = this.bonds.filter((b) => b.id !== id); this._syncBonds(); }

  localIrkHex() { return this.smp.local.irk ? bytesToHex(this.smp.local.irk) : null; }

  /** Create a Resolvable Private Address from a local IRK and point the advertiser at it. */
  async enablePrivacy() {
    if (!this.smp.local.irk) this.smp.local.irk = randomBytes(16);
    const display = addrToString(await generateRpa(this.smp.local.irk));
    this.store.update((s) => { s.advertiser.ownAddressType = 'random'; s.advertiser.randomAddress = display; });
    return { rpa: display, irk: bytesToHex(this.smp.local.irk) };
  }

  confirmNumeric(handle, yes) { const c = this.conns.get(handle); if (c) this.smp.confirmNumeric(c, yes); }
  inputPasskey(handle, passkey) { const c = this.conns.get(handle); if (c) this.smp.inputPasskey(c, passkey); }
  sendSecurityRequest(handle) {
    const c = this.conns.get(handle); if (!c) return;
    this._send(c, L2CAP_CID.SMP, new Uint8Array([SMP_OP.SECURITY_REQUEST, this.smp.authReqByte()]));
  }

  // ---- GATT client (browse the connected central's GATT server) ----
  async discoverPeer(handle) {
    const c = this.conns.get(handle); if (!c) return;
    this._setClient(handle, { discovering: true, error: null });
    try {
      await this.gattClient.exchangeMtu(c).catch(() => {});
      this._mirrorClient(handle, await this.gattClient.discoverAll(c));
    } catch (e) {
      this._setClient(handle, { error: e.message });
      this._notice('warn', `Discovery failed: ${e.message}`);
    }
    this._setClient(handle, { discovering: false });
  }

  async readPeer(handle, valueHandle) {
    const c = this.conns.get(handle); if (!c) return;
    try { this._updateCharValue(handle, valueHandle, await this.gattClient.read(c, valueHandle)); }
    catch (e) { this._notice('warn', `Read 0x${valueHandle.toString(16)} failed: ${e.message}`); }
  }

  async readDescriptor(handle, descHandle) {
    const c = this.conns.get(handle); if (!c) return;
    try { this._updateDescValue(handle, descHandle, await this.gattClient.read(c, descHandle)); }
    catch (e) { this._notice('warn', `Read descriptor 0x${descHandle.toString(16)} failed: ${e.message}`); }
  }

  async writePeer(handle, valueHandle, value, withResponse = true) {
    const c = this.conns.get(handle); if (!c) return;
    try { await this.gattClient.write(c, valueHandle, value, withResponse); this._notice('warn', `Wrote 0x${valueHandle.toString(16)} (${value.length} B)`); }
    catch (e) { this._notice('warn', `Write 0x${valueHandle.toString(16)} failed: ${e.message}`); }
  }

  async writeDescriptor(handle, descHandle, value, withResponse = true) {
    const c = this.conns.get(handle); if (!c) return;
    try { await this.gattClient.write(c, descHandle, value, withResponse); this._notice('warn', `Wrote descriptor 0x${descHandle.toString(16)} (${value.length} B)`); await this.readDescriptor(handle, descHandle); }
    catch (e) { this._notice('warn', `Write descriptor 0x${descHandle.toString(16)} failed: ${e.message}`); }
  }

  async subscribePeer(handle, cccdHandle, value16) {
    const c = this.conns.get(handle); if (!c) return;
    try { await this.gattClient.configureCccd(c, cccdHandle, value16); this._setCccdState(handle, cccdHandle, value16); }
    catch (e) { this._notice('warn', `CCCD write failed: ${e.message}`); }
  }

  _onClientEvent(conn, ev) {
    if (ev.type === 'notification') this._addNotification(conn.handle, ev.handle, ev.value);
  }

  _setClient(handle, patch) {
    this.store.update((s) => { s.client = { ...s.client, [handle]: { ...(s.client[handle] || {}), ...patch } }; });
  }
  _mirrorClient(handle, services) {
    const view = services.map((svc) => ({
      uuid: svc.uuid, startHandle: svc.startHandle, endHandle: svc.endHandle,
      characteristics: svc.characteristics.map((ch) => ({
        uuid: ch.uuid, declHandle: ch.declHandle, valueHandle: ch.valueHandle, properties: ch.properties,
        cccdHandle: ch.cccdHandle, value: null, cccd: 0,
        descriptors: ch.descriptors.map((d) => ({ uuid: d.uuid, handle: d.handle, value: null })),
      })),
    }));
    this._setClient(handle, { services: view });
  }
  _eachChar(handle, matchHandle, fn) {
    const c = this.store.state.client[handle]; if (!c || !c.services) return;
    for (const svc of c.services) for (const ch of svc.characteristics) if (ch.valueHandle === matchHandle || ch.cccdHandle === matchHandle) fn(ch);
    this.store.touch();
  }
  _updateCharValue(handle, valueHandle, value) { this._eachChar(handle, valueHandle, (ch) => { ch.value = bytesToHex(value); }); }
  _setCccdState(handle, cccdHandle, value16) { this._eachChar(handle, cccdHandle, (ch) => { ch.cccd = value16; }); }
  _updateDescValue(handle, descHandle, value) {
    const c = this.store.state.client[handle]; if (!c || !c.services) return;
    for (const svc of c.services) for (const ch of svc.characteristics) for (const d of (ch.descriptors || [])) if (d.handle === descHandle) d.value = bytesToHex(value);
    this.store.touch();
  }
  _addNotification(handle, valueHandle, value) {
    this.store.update((s) => {
      const c = s.client[handle] || {};
      const notes = [{ handle: valueHandle, value: bytesToHex(value), t: Date.now() }, ...(c.notifications || [])].slice(0, 50);
      s.client = { ...s.client, [handle]: { ...c, notifications: notes } };
    });
    this._updateCharValue(handle, valueHandle, value);
  }

  // ---- actions ----

  async disconnect(handle, reason = 0x13) {
    try { await this.hci.command(cmd.disconnect(handle, reason)); } catch (e) { this._notice('warn', `Disconnect failed: ${e.message}`); }
  }

  requestConnParamUpdate(handle, params) {
    const conn = this.conns.get(handle);
    if (!conn) return;
    this._send(conn, L2CAP_CID.SIGNALING, sigConnParamUpdateReq(this._sigId++ & 0xff || 1, params));
  }

  /** Send a notification/indication for a characteristic value handle to subscribed peers. */
  notify(valueHandle, value) {
    let sent = 0;
    for (const conn of this.conns.values()) {
      const sub = this.gatt.cccd(conn, valueHandle);
      if (!sub.notify && !sub.indicate) continue;
      // An ATT notification/indication value can't exceed ATT_MTU-3; a longer payload (e.g. a NUS
      // stream) is split into several PDUs — sending it as one oversized PDU is illegal and the peer
      // silently drops it (so long messages never arrive).
      for (const chunk of attChunks(value, conn.mtu)) {
        this._send(conn, L2CAP_CID.ATT, sub.notify ? this.gatt.notification(valueHandle, chunk) : this.gatt.indication(valueHandle, chunk));
      }
      sent++;
    }
    return sent;
  }

  // ---- helpers ----

  _send(conn, cid, payload) {
    this.hci.sendAcl(conn.handle, l2capFrame(cid, payload));
  }

  _onGattWrite(attr, value) {
    const cb = this._charWriteHandlers && this._charWriteHandlers.get(attr.meta?.uuid);
    if (cb) { try { cb(value, attr); } catch (e) { console.error('charWrite handler', e); } }
    // The write is surfaced visually (the GATT panel flashes the row + shows the new value), so no notice.
    this._mirrorServerWrite(attr, value);
  }

  // Reflect a client's write into the editable GATT table (so the panel shows the new value) and
  // record the handle + time so the GATT panel can flash the row/descriptor for ~2 s.
  _mirrorServerWrite(attr, value) {
    const layout = this.gatt.db?.layout || [];
    const hex = bytesToHex(value);
    const isDesc = attr.meta?.kind === 'descriptor';
    this.store.update((s) => {
      found:
      for (let si = 0; si < layout.length; si++) {
        const chars = layout[si].chars || [];
        for (let ci = 0; ci < chars.length; ci++) {
          const cl = chars[ci];
          const sc = s.gatt.services[si]?.characteristics?.[ci];
          if (!sc) continue;
          if (!isDesc && cl.valueHandle === attr.handle) { sc.valueHex = hex; sc.valueText = null; break found; }
          if (isDesc && cl.valueHandle === attr.meta.charValueHandle) {
            const d = (sc.descriptors || []).find((x) => { try { return normalizeUuid(x.uuid) === attr.meta.uuid; } catch { return false; } });
            if (d) { d.valueHex = hex; d.valueText = null; }
            break found;
          }
        }
      }
      const now = Date.now();
      const writes = {};
      for (const [h, ts] of Object.entries(s.serverWrites || {})) if (now - ts < 5000) writes[h] = ts;
      writes[attr.handle] = now;
      s.serverWrites = writes;
    });
  }

  /** Register a handler called when a client writes a characteristic with the given UUID. */
  onCharWrite(uuid, cb) {
    if (!this._charWriteHandlers) this._charWriteHandlers = new Map();
    this._charWriteHandlers.set(normalizeUuid(uuid), cb);
  }

  /** Value handle of a characteristic in the current server DB (optional notify filter). */
  findCharValueHandle(uuid, requireNotify = false) {
    const u = normalizeUuid(uuid);
    const a = this.gatt.db.attributes.find((x) => x.meta && x.meta.kind === 'charValue' && x.meta.uuid === u && (!requireNotify || (x.meta.props & 0x10)));
    return a ? a.handle : null;
  }

  /**
   * Value handle of the HID Report characteristic with a given Report Reference (HID reports all
   * share UUID 0x2A4D, told apart by their 0x2908 descriptor = [reportId, type]; type 1=input,
   * 2=output, 3=feature). Lets a caller address a specific report among several same-UUID ones.
   */
  findReportValueHandle(reportId, type = 1) {
    const ref = normalizeUuid('2908');
    const d = this.gatt.db.attributes.find((x) => x.meta && x.meta.kind === 'descriptor'
      && x.meta.uuid === ref && x.value && x.value[0] === reportId && x.value[1] === type);
    return d ? d.meta.charValueHandle : null;
  }

  _notice(level, msg) {
    this.store.update((s) => { s.notices = [...s.notices.filter((n) => n.source !== 'conn' || n.msg !== msg), { level, msg, source: 'conn' }].slice(-12); });
  }

  // Discrete one-off events (connect/disconnect): pushed straight to the NoticeFeed so each fires its
  // own toast + log entry, rather than through the deduped store-warnings path.
  _event(level, msg) {
    this.notices?.add({ level, source: 'conn', msg });
  }

  _sync() {
    const list = [...this.conns.values()].map((c) => ({
      handle: c.handle, peerAddr: c.peerAddr, peerName: c.peerName || null, role: c.role,
      interval: c.interval, latency: c.latency, timeout: c.timeout, mtu: c.mtu,
      encrypted: c.encrypted, pairing: c.pairing ? c.pairing.state : null,
      remoteVersion: c.remoteVersion || null,
      subscriptions: [...c.cccd.entries()].filter(([, v]) => v).map(([h, v]) => ({ handle: h, value: v })),
    }));
    this.store.update((s) => { s.connections = list; });
  }
}
