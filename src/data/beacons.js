// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Beacon payload encoders for the Advertiser quick-fills: Apple iBeacon (Manufacturer Specific
// Data) and Google Eddystone (Service Data on UUID 0xFEAA). Pure helpers returning hex strings the
// advertiser's manufacturer / serviceData fields consume.

import { ByteWriter, bytesToHex, hexToBytes } from '../util/bytes.js';

export const APPLE_COMPANY = 0x004c;
export const EDDYSTONE_UUID = 'FEAA';

const clean = (s) => String(s || '').replace(/[^0-9a-fA-F]/g, '');

/**
 * iBeacon manufacturer payload (everything after the 0x004C company id, which the manufacturer field
 * prepends): 0x02 0x15, 16-byte proximity UUID, 2-byte major, 2-byte minor, 1-byte measured power
 * (signed, RSSI at 1 m). Returns the data-hex for advertiser.manufacturer.
 */
export function iBeaconData({ uuid, major = 0, minor = 0, power = -59 }) {
  const u = clean(uuid);
  if (u.length !== 32) throw new Error('iBeacon needs a 128-bit proximity UUID');
  const w = new ByteWriter().u8(0x02).u8(0x15).bytes(hexToBytes(u)); // type + length, then UUID big-endian
  w.u8((major >> 8) & 0xff).u8(major & 0xff); // major/minor are big-endian in iBeacon
  w.u8((minor >> 8) & 0xff).u8(minor & 0xff);
  w.i8(power);
  return bytesToHex(w.build(), '');
}

// Eddystone-URL scheme prefixes and .xxx expansion codes (Eddystone spec, distinct from the AD URI
// table). The encoded URL is: <frame 0x10><tx power><scheme byte><expanded url bytes>.
const URL_SCHEMES = ['http://www.', 'https://www.', 'http://', 'https://'];
const URL_EXPANSIONS = ['.com/', '.org/', '.edu/', '.net/', '.info/', '.biz/', '.gov/', '.com', '.org', '.edu', '.net', '.info', '.biz', '.gov'];

/** Eddystone-URL Service Data payload (after the 0xFEAA UUID): 0x10, tx power, scheme, encoded URL. */
export function eddystoneUrlData({ url = 'https://bluetooth-tester.com/', power = -20 }) {
  let scheme = -1;
  let rest = url;
  for (let i = 0; i < URL_SCHEMES.length; i++) {
    if (url.startsWith(URL_SCHEMES[i])) { scheme = i; rest = url.slice(URL_SCHEMES[i].length); break; }
  }
  if (scheme < 0) throw new Error('Eddystone-URL must start with http(s)://[www.]');
  const out = [0x10, power & 0xff, scheme];
  for (let i = 0; i < rest.length;) {
    const exp = URL_EXPANSIONS.findIndex((e) => rest.startsWith(e, i));
    if (exp >= 0) { out.push(exp); i += URL_EXPANSIONS[exp].length; }
    else { out.push(rest.charCodeAt(i) & 0x7f); i += 1; }
  }
  if (out.length > 20) throw new Error('Eddystone-URL too long (>17 encoded bytes)');
  return bytesToHex(Uint8Array.from(out), '');
}

/** Eddystone-UID Service Data payload: 0x00, tx power, 10-byte namespace, 6-byte instance, 2 RFU. */
export function eddystoneUidData({ namespace, instance, power = -20 }) {
  const ns = clean(namespace).padStart(20, '0').slice(0, 20);
  const inst = clean(instance).padStart(12, '0').slice(0, 12);
  const w = new ByteWriter().u8(0x00).i8(power).bytes(hexToBytes(ns)).bytes(hexToBytes(inst)).u8(0x00).u8(0x00);
  return bytesToHex(w.build(), '');
}
