// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder run-mode bridge (parent side): relays the sandboxed iframe's `bt` calls to the live
// ConnectionManager / GATT server and pushes inbound BLE events back into the iframe. The iframe
// never touches conn/store directly — everything crosses this postMessage boundary.
//
//  bt.notify/setValue/read/onWrite  → our GATT server (the central reads/writes us)
//  bt.peer.discover/read/write/subscribe → the central's GATT server (we are the client, e.g.
//                                          Windows 11's Media Control Service)

import { normalizeUuid } from '../../util/uuid.js';
import { hexToBytes } from '../../util/bytes.js';

export function createRunSession({ iframe, conn, store, routeCharWrite, unrouteCharWrite, onConsole }) {
  const subs = new Set();      // our-server onCharWrite UUIDs (routed via the panel's router)
  const peerSubs = new Set();  // peer (client) subscribed UUIDs (normalized)
  let stopped = false;
  const safe = (u) => { try { return normalizeUuid(u); } catch { return ''; } };
  const toIframe = (m) => { try { iframe.contentWindow && iframe.contentWindow.postMessage({ __bt: 1, ...m }, '*'); } catch { /* not loaded */ } };
  const reply = (id, result) => toIframe({ type: 'reply', id, ...result });
  // A server-side bt.* call named a characteristic that isn't in our GATT server → loud console error.
  const charText = (call, uuid) => `bt.${call}("${uuid}"): no such characteristic in the GATT server`;
  const charError = (call, uuid) => { onConsole && onConsole('error', [charText(call, uuid)]); };

  // ---- our GATT server value access ----
  function readValue(uuid) {
    const h = conn.findCharValueHandle(uuid, false);
    if (h == null) return new Uint8Array(0);
    const a = conn.gatt.db.byHandle.get(h);
    return a ? a.value : new Uint8Array(0);
  }
  function setValue(uuid, bytes) {
    const h = conn.findCharValueHandle(uuid, false);
    if (h == null) return;
    const a = conn.gatt.db.byHandle.get(h);
    if (a) a.value = bytes; // central Reads now return this; structure unchanged so handles are stable
  }

  // ---- the connected central's GATT server (we are the client) ----
  function activeHandle() { const cs = store.state.connections || []; return cs.length ? cs[0].handle : null; }
  function clientServices(h) { return ((store.state.client[h] || {}).services) || []; }
  function findClientChar(h, uuid) {
    const u = safe(uuid);
    for (const s of clientServices(h)) for (const c of s.characteristics) if (safe(c.uuid) === u) return c;
    return null;
  }
  function charByValueHandle(h, vh) {
    for (const s of clientServices(h)) for (const c of s.characteristics) if (c.valueHandle === vh) return c;
    return null;
  }

  async function onMessage(ev) {
    if (stopped || ev.source !== iframe.contentWindow) return;
    const m = ev.data;
    if (!m || !m.__bt) return;
    if (m.type === 'console') { onConsole && onConsole(m.level, m.args || []); return; }
    if (m.type === 'ready') {
      onConsole && onConsole('info', ['▶ running']);
      for (const c of (store.state.connections || [])) toIframe({ type: 'connect', info: { handle: c.handle, peer: c.peerAddr, name: c.peerName } });
      return;
    }
    if (m.type !== 'bt') return;
    try {
      switch (m.op) {
        case 'notify': {
          // reportId (optional) targets a specific HID report among same-UUID (0x2A4D) characteristics;
          // otherwise resolve by UUID (first match).
          const h = m.reportId != null ? conn.findReportValueHandle(m.reportId, m.reportType || 1)
            : conn.findCharValueHandle(m.uuid, false);
          if (h == null) return charError('notify', m.uuid);
          conn.notify(h, Uint8Array.from(m.bytes || []));
          break;
        }
        case 'setValue': {
          if (conn.findCharValueHandle(m.uuid, false) == null) return charError('setValue', m.uuid);
          setValue(m.uuid, Uint8Array.from(m.bytes || []));
          break;
        }
        case 'read': {
          if (conn.findCharValueHandle(m.uuid, false) == null) return reply(m.id, { error: charText('read', m.uuid) });
          reply(m.id, { bytes: Array.from(readValue(m.uuid)) });
          break;
        }
        case 'subscribeWrite': {
          const u = safe(m.uuid); if (!u) break;
          if (conn.findCharValueHandle(m.uuid, false) == null) return charError('onWrite', m.uuid);
          if (subs.has(u)) break;
          subs.add(u);
          routeCharWrite(u, (bytes) => toIframe({ type: 'charWrite', uuid: m.uuid, bytes: Array.from(bytes || []) }));
          break;
        }
        case 'peerDiscover': {
          const h = activeHandle(); if (h == null) return reply(m.id, { error: 'no connection' });
          await conn.discoverPeer(h);
          reply(m.id, { services: clientServices(h).map((s) => ({ uuid: s.uuid, characteristics: s.characteristics.map((c) => c.uuid) })) });
          break;
        }
        case 'peerRead': {
          const h = activeHandle(); const ch = h != null && findClientChar(h, m.uuid);
          if (!ch) return reply(m.id, { error: 'characteristic not found (discover first)' });
          const bytes = await conn.gattClient.read(conn.conns.get(h), ch.valueHandle);
          reply(m.id, { bytes: Array.from(bytes) });
          break;
        }
        case 'peerWrite': {
          const h = activeHandle(); const ch = h != null && findClientChar(h, m.uuid);
          if (!ch) return reply(m.id, { error: 'characteristic not found (discover first)' });
          await conn.gattClient.write(conn.conns.get(h), ch.valueHandle, Uint8Array.from(m.bytes || []), m.withResponse !== false);
          reply(m.id, { ok: true });
          break;
        }
        case 'peerSubscribe': {
          const h = activeHandle(); const ch = h != null && findClientChar(h, m.uuid);
          if (!ch || ch.cccdHandle == null) return reply(m.id, { error: 'characteristic not notifiable (discover first)' });
          await conn.subscribePeer(h, ch.cccdHandle, 0x0001);
          peerSubs.add(safe(m.uuid));
          reply(m.id, { ok: true });
          break;
        }
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (m.id != null) reply(m.id, { error: msg }); else onConsole && onConsole('error', [msg]);
    }
  }

  // ---- store-driven: connection lifecycle + peer notifications → iframe ----
  let lastHandles = new Set((store.state.connections || []).map((c) => c.handle));
  let lastNotifT = (() => { const h = activeHandle(); const n = h != null ? ((store.state.client[h] || {}).notifications || []) : []; return n.length ? n[0].t : 0; })();
  const unsub = store.subscribe(() => {
    if (stopped) return;
    const conns = store.state.connections || [];
    const now = new Set(conns.map((c) => c.handle));
    for (const h of now) if (!lastHandles.has(h)) { const c = conns.find((x) => x.handle === h); toIframe({ type: 'connect', info: { handle: h, peer: c ? c.peerAddr : null, name: c ? c.peerName : null } }); }
    for (const h of lastHandles) if (!now.has(h)) toIframe({ type: 'disconnect', info: { handle: h } });
    lastHandles = now;

    // peer (client) notifications: store.state.client[h].notifications is newest-first.
    const h = activeHandle();
    if (h != null && peerSubs.size) {
      const notes = (store.state.client[h] || {}).notifications || [];
      let maxT = lastNotifT;
      for (const n of notes) {
        if (n.t <= lastNotifT) break;
        maxT = Math.max(maxT, n.t);
        const ch = charByValueHandle(h, n.handle);
        if (ch && peerSubs.has(safe(ch.uuid))) toIframe({ type: 'peerNotify', uuid: ch.uuid, bytes: Array.from(hexToBytes(n.value || '')) });
      }
      lastNotifT = maxT;
    }
  });

  window.addEventListener('message', onMessage);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('message', onMessage);
      unsub();
      for (const u of subs) unrouteCharWrite(u);
      subs.clear(); peerSubs.clear();
    },
  };
}
