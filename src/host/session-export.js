// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Snapshot the whole live session into one downloadable .zip: advertising + scan-response data,
// both GATT tables (our server + the discovered remote/client view), full SMP info (including key
// material), and the HCI log as PCAPNG, plus a README manifest. buildSessionFiles() is pure and
// Node-testable; downloadSession() is the thin browser wrapper that zips + triggers the download.

import { computeAdv } from './gap.js';
import { buildAdExport } from './ad-io.js';
import { toPcapngBytes, pcapngMetaFromState, shortUserAgent } from '../log/pcapng.js';
import { zipStore } from '../util/zip.js';
import { bytesToHex } from '../util/bytes.js';
import { APP_NAME, APP_VERSION, APP_SITE, APP_REPO, stampExport } from '../app-meta.js';

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (v) => bytesToHex(v, '').toUpperCase();

// JSON.stringify replacer: render any byte data as uppercase hex so the export stays readable + lossless.
function hexReplacer(_key, value) {
  if (value instanceof Uint8Array) return hex(value);
  if (value instanceof ArrayBuffer) return hex(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return value;
}

// Every exported JSON is stamped with its origin (site + tool version) before the payload, so a file
// pulled out of the archive still says where it came from. advertisingData/scanResponseData etc. stay
// at the top level, so re-import (which reads those keys) is unaffected by the extra fields.
const json = (obj) => JSON.stringify(stampExport(obj), hexReplacer, 2);

// The durable SMP picture the panel surfaces — parameters, live status, distributed keys and bonds —
// plus per-connection encryption. Excludes ephemeral pairing crypto intermediates (Na/Nb/DHKey).
function smpInfo(state) {
  const s = state.smp || {};
  return {
    parameters: { io: s.io, bonding: s.bonding, mitm: s.mitm, sc: s.sc, maxKey: s.maxKey, passkey: s.passkey },
    status: s.status,
    current: s.current,
    lastKeys: s.lastKeys,
    bonds: state.bonds || [],
    connections: (state.connections || []).map((c) => ({ handle: c.handle, peerAddr: c.peerAddr, encrypted: !!c.encrypted })),
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Compact local timestamp for the archive filename: YYYYMMDD-HHMMSS. */
export function timestamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function readme(state, logEntries, when) {
  const c = state.controller || {};
  const v = c.version;
  const ver = v ? `HCI ${v.hciVersion} · LMP ${v.lmpVersion} · manufacturer ${v.manufacturer}` : 'unknown';
  const adv = state.advertiser || {};
  return [
    `${APP_NAME} — session export`,
    `Version : ${APP_VERSION}`,
    `Site    : ${APP_SITE}`,
    `Source  : ${APP_REPO}`,
    `Exported: ${when.toISOString()}`,
    '',
    'Contents:',
    '  advertising.json  — advertising + scan-response AD structures (Len/Type/Value hex, on-air order)',
    '  gatt-server.json  — our GATT server table (services, characteristics, descriptors)',
    '  gatt-client.json  — discovered remote GATT, keyed by connection handle (services, values, notifications)',
    '  smp.json          — SMP parameters, pairing status, distributed keys (LTK/IRK/CSRK) and bonds',
    '  hci.pcapng        — full HCI packet log (open in Wireshark)',
    '',
    'Session summary:',
    `  Controller : ${c.bdAddr || 'n/a'} · ${ver}`,
    `  Connections: ${(state.connections || []).length}`,
    `  Advertiser : name "${adv.name ?? ''}" · ${adv.enabled ? 'enabled' : 'disabled'}`,
    `  Bonds      : ${(state.bonds || []).length}`,
    `  HCI packets: ${logEntries.length}`,
    '',
    'Note: smp.json contains real key material. Keep this archive private.',
    '',
  ].join('\n');
}

/** Pure: gather the session into an ordered array of { name, data:Uint8Array } ZIP entries. */
export function buildSessionFiles({ state, logEntries = [], now = new Date(), os }) {
  const adv = computeAdv(state);
  return [
    { name: 'README.txt', data: utf8(readme(state, logEntries, now)) },
    { name: 'advertising.json', data: utf8(json(buildAdExport(adv.advBytes, adv.scanBytes))) },
    { name: 'gatt-server.json', data: utf8(json(state.gatt)) },
    { name: 'gatt-client.json', data: utf8(json(state.client || {})) },
    { name: 'smp.json', data: utf8(json(smpInfo(state))) },
    { name: 'hci.pcapng', data: toPcapngBytes(logEntries, pcapngMetaFromState(state, os ? { os } : {})) },
  ];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Browser: build + zip + download the current session as bt-session-<timestamp>.zip. */
export function downloadSession({ store, log }, now = new Date()) {
  const os = typeof navigator !== 'undefined' ? shortUserAgent(navigator.userAgent) : undefined;
  const files = buildSessionFiles({ state: store.state, logEntries: log.entries, now, os });
  downloadBlob(zipStore(files, { date: now }), `bt-session-${timestamp(now)}.zip`);
  return files;
}
