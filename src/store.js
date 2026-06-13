// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Deep-reactive global state store. Plain object wrapped in a recursive Proxy that
// notifies subscribers on any mutation. No framework — this is the single source of
// truth that every UI panel binds to ("parameters modified globally", per idea.md).

import { defaultGattTable } from './data/gatt-defaults.js';

function makeReactive(target, notify) {
  const cache = new WeakMap();

  function wrap(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    // Don't proxy binary/byte data — treat as opaque values.
    if (obj instanceof Uint8Array || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj;
    if (cache.has(obj)) return cache.get(obj);

    const proxy = new Proxy(obj, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (typeof prop === 'symbol') return v;
        return wrap(v);
      },
      set(t, prop, value) {
        const old = t[prop];
        const changed = old !== value;
        Reflect.set(t, prop, value);
        if (changed) notify(prop);
        return true;
      },
      deleteProperty(t, prop) {
        const had = prop in t;
        Reflect.deleteProperty(t, prop);
        if (had) notify(prop);
        return true;
      },
    });
    cache.set(obj, proxy);
    return proxy;
  }

  return wrap(target);
}

export function createStore(initial) {
  const subscribers = new Set();
  let scheduled = false;

  function flush() {
    scheduled = false;
    for (const fn of subscribers) {
      try {
        fn(state);
      } catch (e) {
        console.error('store subscriber error', e);
      }
    }
  }

  // Coalesce bursts of mutations into a single async notification.
  function notify() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  const state = makeReactive(initial, notify);

  return {
    state,
    /** Subscribe to changes; returns an unsubscribe fn. */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Run mutations then notify (notification is async/coalesced regardless). */
    update(fn) {
      fn(state);
    },
    /** Force a synchronous notification (e.g. after non-tracked external change). */
    touch() {
      flush();
    },
  };
}

/** The initial global state shape. Panels read/write sub-trees of this. */
export function initialState() {
  return {
    serial: {
      connected: false,
      connecting: false,
      baudRate: 115200,
      flowControl: 'none', // 'none' | 'hardware'
      portLabel: null,
      error: null,
    },
    controller: {
      ready: false,
      needsFirmware: false, // set when a connected device doesn't answer HCI → the OOB wizard offers to flash
      version: null, // {hciVersion, hciSubversion, lmpVersion, manufacturer, lmpSubversion}
      bdAddr: null, // display string
      localFeatures: null, // Uint8Array(8)
      leFeatures: null, // Uint8Array(8)
      supportedCommands: null, // Uint8Array(64)
      bufferSize: null, // {aclLen, numAcl, scoLen, numSco}
      leBufferSize: null, // {aclLen, numAcl}
      leStates: null, // Uint8Array(8)
      maxAdvDataLen: null,
      numAdvSets: null,
      txPower: null, // adv physical channel tx power (dBm)
      caps: {
        extendedAdvertising: false,
        periodicAdvertising: false,
        le2mPhy: false,
        leCodedPhy: false,
        leSecureConnections: false,
        leDataLengthExtension: false,
        channelSelection2: false,
      },
    },
    advertiser: {
      enabled: false,
      autoReadvertise: true, // re-enable advertising after a disconnect (handy for repeated test connects)
      mode: 'legacy', // 'legacy' | 'extended'
      // ---- AD field content (where-independent; `placement` decides which PDU each lands in) ----
      flags: 0x06, // LE General Discoverable + BR/EDR Not Supported
      name: 'BT-Tester',
      nameScan: '', // scan-response name when placed in 'both' (empty → reuse `name`)
      nameMode: 'auto', // 'complete' (0x09) | 'shortened' (0x08) | 'auto' (shortened in adv + complete in scan when placed in both)
      appearance: 0x0000,
      serviceUuids16: [], // numbers
      serviceUuids16Scan: [], // scan-response 16-bit list when placed in 'both' (empty → reuse the adv list)
      uuids16Mode: 'auto', // 'complete' (0x03) | 'incomplete' (0x02) | 'auto'
      serviceUuids128: [], // canonical UUID strings
      serviceUuids128Scan: [], // scan-response 128-bit list when placed in 'both' (empty → reuse the adv list)
      uuids128Mode: 'auto', // 'complete' (0x07) | 'incomplete' (0x06) | 'auto'
      manufacturer: null, // {company: number, dataHex: string} — single block, placed via placement.manufacturer
      serviceData: [], // [{uuid: '180F'|'0000180F'|'full-128', dataHex}] — AD type chosen by UUID width (0x16/0x20/0x21)
      // ---- placement: which PDU each field is emitted into ('adv' | 'scanrsp' | 'both' | 'off'). Scan
      // response carries the same AD types as advertising data (its own 31-byte budget) but is only sent
      // for scannable adv types and only to active scanners. Default = classic flags+name advertising
      // payload with an empty scan response. ----
      placement: {
        flags: 'adv',
        name: 'adv',
        appearance: 'off',
        uuids16: 'off',
        uuids128: 'off',
        txPower: 'off',
        manufacturer: 'off',
        serviceData: 'off',
      },
      extraAdHex: '', // raw appended AD structures into the advertising PDU (advanced)
      scanRespExtraHex: '', // raw appended AD structures into the scan-response PDU (advanced)
      // ---- Advertising parameters ----
      advType: 'ADV_IND', // ADV_IND | ADV_SCAN_IND | ADV_NONCONN_IND | ADV_DIRECT_IND_HIGH | ADV_DIRECT_IND_LOW
      intervalMin: 160, // units of 0.625ms (160 = 100ms)
      intervalMax: 240, // 240 = 150ms
      ownAddressType: 'public', // 'public' | 'random'
      randomAddress: 'C0:DE:CA:FE:00:01',
      channelMap: 0x07, // ch 37/38/39
      filterPolicy: 0,
      peerAddress: '00:00:00:00:00:00',
      peerAddressType: 'public',
      // ---- Extended advertising (mode === 'extended'; needs controller support) ----
      primaryPhy: '1M', // '1M' | 'Coded' — primary channel PHY
      secondaryPhy: '1M', // '1M' | '2M' | 'Coded' — secondary (AUX) channel PHY
      advSid: 0, // Advertising Set ID (0–15)
      advDuration: 0, // ms, 0 = no timeout (units of 10 ms on the wire)
      advMaxEvents: 0, // 0 = unlimited extended advertising events
    },
    connections: [], // mirrored from ConnectionManager: [{handle, peerAddr, role, interval, latency, timeout, mtu, encrypted, subscriptions}]
    gatt: defaultGattTable(), // editable services table; built into the attribute DB
    smp: {
      // NoInputNoOutput + LE legacy by default → Just Works pairing, no user interaction. Switch to
      // KeyboardDisplay (and enable LE Secure Connections) for Numeric Comparison / Passkey Entry.
      io: 3, // 0 DisplayOnly · 1 DisplayYesNo · 2 KeyboardOnly · 3 NoInputNoOutput · 4 KeyboardDisplay
      bonding: true,
      mitm: false,
      sc: false, // LE Secure Connections
      acceptPairing: true, // false → refuse an incoming Pairing Request with "Pairing Not Supported"
                           // (0x05); the LE connection stays up, unencrypted/unbonded (transparent)
      maxKey: 16,
      passkey: null, // fixed passkey to display (null = random each time)
      status: 'idle', // idle | pairing | passkey-display | passkey-input | numeric-comparison | paired | failed
      current: null, // { handle, method, sc, passkey, ncValue }
      lastKeys: null, // { ltk, irk, csrk, ediv, sc, method, keySize } for the key viewer
    },
    bonds: [], // [{ id, peerAddr, idAddr, idAddrType, ltkHex, irkHex, csrkHex, sc, keySize, when }]
    client: {}, // GATT client: per-connection-handle { services:[...], notifications:[...], discovering, error }
    serverWrites: {}, // { attributeHandle: timestampMs } — recent client writes, for the GATT panel's flash highlight
    log: {
      paused: false,
      filter: 'all', // 'all' | 'cmd' | 'evt' | 'acl'
    },
    warnings: [], // validation-derived, recomputed on every change [{level:'error'|'warn', msg, source}]
    notices: [], // runtime/transport messages (connection, bring-up), appended not recomputed
    builder: {
      // Drag-and-drop front-panel designer (Builder panel) — one monolithic app (no multi-layout).
      // Restored from / saved to localStorage by the panel itself (not here — initialState must stay
      // Node-safe for tests).
      widgets: [], // [{ id, type, x, y, name?, props, binding:{uuid}|null }]
      script: '', // run-mode sandboxed script
      selectedId: null, // selected widget id
      mode: 'design', // 'design' | 'run' (run = sandboxed live script)
    },
    ui: { activePanel: 'controller' },
  };
}
