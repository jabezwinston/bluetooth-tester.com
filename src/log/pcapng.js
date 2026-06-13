// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Export the packet log as a PCAPNG file for Wireshark.
// Link type: LINKTYPE_BLUETOOTH_HCI_H4_WITH_PHDR (201) — each packet is prefixed by a
// 4-byte big-endian direction pseudo-header (bit0 set => received/incoming), followed by
// the H4 packet (type byte + HCI payload).

import { concatBytes } from '../util/bytes.js';
import { APP_NAME, APP_VERSION, APP_SITE } from '../app-meta.js';
import { companyName, CORE_VERSION } from '../data/assigned.js';

const LINKTYPE_BLUETOOTH_HCI_H4_WITH_PHDR = 201;
const WRITER = `${APP_NAME} v${APP_VERSION} (${APP_SITE})`;

// SHB option codes: shb_hardware=2, shb_os=3, shb_userappl=4.
// IDB option codes: if_name=2, if_description=3, if_speed=8 (u64 bit/s), if_tsresol=9.
const pad4 = (n) => (4 - (n & 3)) & 3;
const utf8 = (s) => new TextEncoder().encode(s);

function block(type, body) {
  const padLen = pad4(body.length);
  const total = 12 + body.length + padLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, type >>> 0, true);
  dv.setUint32(4, total, true);
  out.set(body, 8);
  dv.setUint32(total - 4, total, true);
  return out;
}

// One option TLV: u16 code, u16 length, value, padded to 4 bytes.
function option(code, value) {
  const out = new Uint8Array(4 + value.length + pad4(value.length));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, code, true);
  dv.setUint16(2, value.length, true);
  out.set(value, 4);
  return out;
}
const strOption = (code, s) => option(code, utf8(s));

// A u64 (8-byte LE) option — e.g. if_speed in bits/second.
function u64Option(code, n) {
  const val = new Uint8Array(8);
  const dv = new DataView(val.buffer);
  dv.setUint32(0, n >>> 0, true);
  dv.setUint32(4, Math.floor(n / 4294967296) >>> 0, true);
  return option(code, val);
}

// Assemble an options list (skipping falsy entries) + the terminating opt_endofopt (code 0, len 0).
function options(list) {
  const opts = list.filter(Boolean);
  if (!opts.length) return new Uint8Array(0);
  return concatBytes(...opts, new Uint8Array(4));
}

function sectionHeaderBlock(meta = {}) {
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, 0x1a2b3c4d, true); // byte-order magic
  dv.setUint16(4, 1, true); // version major
  dv.setUint16(6, 0, true); // version minor
  dv.setUint32(8, 0xffffffff, true); // section length: unknown (-1)
  dv.setUint32(12, 0xffffffff, true);
  return block(0x0a0d0d0a, concatBytes(head, options([
    meta.hardware && strOption(2, meta.hardware), // shb_hardware — the controller
    meta.os && strOption(3, meta.os),             // shb_os — host browser/OS
    strOption(4, meta.app || WRITER),             // shb_userappl — this tool
  ])));
}

function interfaceDescriptionBlock(meta = {}) {
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, LINKTYPE_BLUETOOTH_HCI_H4_WITH_PHDR, true);
  dv.setUint16(2, 0, true); // reserved
  dv.setUint32(4, 0, true); // snaplen 0 = no limit
  return block(0x00000001, concatBytes(head, options([
    strOption(2, meta.ifName || 'Bluetooth HCI (H4)'),      // if_name
    strOption(3, meta.ifDescription || 'UART-HCI'),         // if_description
    meta.speed && u64Option(8, meta.speed),                 // if_speed — UART baud rate (bit/s)
    option(9, new Uint8Array([6])),                         // if_tsresol — 10^-6 s (microseconds)
  ])));
}

/**
 * Condense a browser User-Agent into a short "Linux - Chrome 145"-style OS/Browser label for shb_os.
 * The full UA string is too long/noisy for a capture file. Pure (takes the string).
 */
export function shortUserAgent(ua = '') {
  let os = 'Unknown OS';
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/(iPhone|iPad|iPod)/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  let br = 'Browser', m;
  if ((m = /Edg\/(\d+)/.exec(ua))) br = `Edge ${m[1]}`;
  else if ((m = /OPR\/(\d+)/.exec(ua))) br = `Opera ${m[1]}`;
  else if ((m = /Chrome\/(\d+)/.exec(ua))) br = `Chrome ${m[1]}`;
  else if ((m = /Firefox\/(\d+)/.exec(ua))) br = `Firefox ${m[1]}`;
  else if ((m = /Version\/(\d+).*Safari/.exec(ua))) br = `Safari ${m[1]}`;
  return `${os} - ${br}`;
}

/**
 * Derive PCAPNG SHB/IDB metadata from the live store state:
 *   • shb_hardware   — the controller hardware: vendor (named from its Bluetooth SIG Company ID) - LMP version
 *   • if_description — "UART-HCI" (the transport)
 *   • if_speed       — the serial baud rate
 * Pure — pass `extra` (e.g. { os: shortUserAgent(navigator.userAgent) }) from the browser caller.
 */
export function pcapngMetaFromState(state = {}, extra = {}) {
  const v = (state.controller || {}).version || {};
  const hw = [];
  if (v.manufacturer != null) hw.push(companyName(v.manufacturer));
  if (v.lmpVersion != null) hw.push(`LMP ${CORE_VERSION[v.lmpVersion] || `0x${v.lmpVersion.toString(16)}`}`);
  return {
    app: WRITER,
    hardware: hw.length ? hw.join(' - ') : undefined,
    ifName: 'Bluetooth HCI (H4)',
    ifDescription: 'UART-HCI',
    speed: state.serial?.baudRate || undefined,
    ...extra,
  };
}

function enhancedPacketBlock(entry) {
  // packet bytes = [direction:4 BE][H4 type][HCI payload...]
  const h4 = concatBytes(new Uint8Array([entry.h4]), entry.data);
  const data = new Uint8Array(4 + h4.length);
  new DataView(data.buffer).setUint32(0, entry.dir === 'rx' ? 1 : 0, false); // big-endian
  data.set(h4, 4);

  const us = entry.ts * 1000; // ms -> microseconds
  const high = Math.floor(us / 4294967296);
  const low = us - high * 4294967296;

  const body = new Uint8Array(20 + data.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 0, true); // interface id
  dv.setUint32(4, high >>> 0, true); // timestamp high
  dv.setUint32(8, low >>> 0, true); // timestamp low
  dv.setUint32(12, data.length, true); // captured length
  dv.setUint32(16, data.length, true); // original length
  body.set(data, 20);
  return block(0x00000006, body);
}

/** Build the raw PCAPNG bytes from packet-log entries (for embedding, e.g. in the session ZIP). */
export function toPcapngBytes(entries, meta = {}) {
  const blocks = [sectionHeaderBlock(meta), interfaceDescriptionBlock(meta)];
  for (const e of entries) blocks.push(enhancedPacketBlock(e));
  return concatBytes(...blocks);
}

/** Build a PCAPNG Blob from packet-log entries. */
export function toPcapngBlob(entries, meta = {}) {
  return new Blob([toPcapngBytes(entries, meta)], { type: 'application/octet-stream' });
}

/** Trigger a browser download of the log as a .pcapng file. */
export function downloadPcapng(entries, filename = 'bt-tester.pcapng', meta = {}) {
  const url = URL.createObjectURL(toPcapngBlob(entries, meta));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
