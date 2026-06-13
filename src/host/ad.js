// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Advertising Data (AD) assembly and parsing. AD structures are [length][type][data...]
// where length covers type + data. Used for both advertising data and scan response.

import { ByteWriter, hexToBytes, bytesToHex, concatBytes } from '../util/bytes.js';
import { AD_TYPE, AD_TYPE_NAMES, FLAG_BITS, uuid16Name, appearanceName, companyName, SWIFT_PAIR_COMPANY, SWIFT_PAIR_BEACON_ID, SWIFT_PAIR_SUB } from '../data/assigned.js';

export const LEGACY_AD_MAX = 31;

/** "6E400001-B5A3-F393-E0A9-E50E24DCCA9E" -> 16 little-endian bytes. */
export function uuid128ToBytes(str) {
  const hex = str.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 32) throw new Error(`invalid 128-bit UUID: ${str}`);
  const be = hexToBytes(hex);
  return be.reverse();
}

export function bytesToUuid128(bytes) {
  const be = Array.from(bytes).reverse();
  const h = be.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

// ---- structure builders: each returns { type, data:Uint8Array } ----
const flagsStruct = (bits) => ({ type: AD_TYPE.FLAGS, data: new Uint8Array([bits & 0xff]) });
const nameStruct = (name, complete) => ({
  type: complete ? AD_TYPE.COMPLETE_NAME : AD_TYPE.SHORT_NAME,
  data: new TextEncoder().encode(name),
});
const appearanceStruct = (value) => ({ type: AD_TYPE.APPEARANCE, data: new ByteWriter().u16(value).build() });
const txPowerStruct = (dbm) => ({ type: AD_TYPE.TX_POWER, data: new ByteWriter().i8(dbm).build() });

function uuids16Struct(list, complete) {
  const w = new ByteWriter();
  for (const u of list) w.u16(u);
  return { type: complete ? AD_TYPE.COMPLETE_UUID16 : AD_TYPE.INCOMPLETE_UUID16, data: w.build() };
}

function uuids128Struct(list, complete) {
  const parts = list.map((u) => uuid128ToBytes(u));
  return { type: complete ? AD_TYPE.COMPLETE_UUID128 : AD_TYPE.INCOMPLETE_UUID128, data: concatBytes(...parts) };
}

function manufacturerStruct({ company, dataHex }) {
  const data = new ByteWriter().u16(company).bytes(hexToBytes(dataHex || '')).build();
  return { type: AD_TYPE.MANUFACTURER_DATA, data };
}

// Service Data: the AD type (0x16 / 0x20 / 0x21) is chosen by the UUID width. The UUID is emitted
// little-endian (like the Service UUID lists), then the service payload follows.
function serviceDataStruct({ uuid, dataHex }) {
  const hex = String(uuid || '').replace(/[^0-9a-fA-F]/g, '');
  const payload = hexToBytes(dataHex || '');
  if (hex.length === 4) {
    return { type: AD_TYPE.SERVICE_DATA_UUID16, data: new ByteWriter().u16(parseInt(hex, 16)).bytes(payload).build() };
  }
  if (hex.length === 8) {
    return { type: AD_TYPE.SERVICE_DATA_UUID32, data: new ByteWriter().u32(parseInt(hex, 16) >>> 0).bytes(payload).build() };
  }
  if (hex.length === 32) {
    return { type: AD_TYPE.SERVICE_DATA_UUID128, data: concatBytes(uuid128ToBytes(uuid), payload) };
  }
  throw new Error(`service-data UUID must be 16, 32 or 128-bit: "${uuid}"`);
}

/**
 * Build the AD structures for one PDU from the advertiser config. `pdu` is 'adv' or 'scanrsp'.
 * Each field is emitted into the PDU(s) named by `adv.placement[field]` ('adv' | 'scanrsp' | 'both' |
 * 'off'). txPower is the value used for the Tx Power Level AD. Every returned struct is tagged with the
 * source `field` so the preview can label/group it. Field order is fixed (flags first, name last).
 */
export function buildStructures(adv, { pdu = 'adv', txPower = 0 } = {}) {
  const place = adv.placement || {};
  const inP = (f) => place[f] === pdu || place[f] === 'both';
  const out = [];
  const add = (field, struct) => out.push({ ...struct, field });
  // Complete/Incomplete (UUID list) and Complete/Shortened (name) per PDU. 'auto' follows the spec
  // split: when a field is placed in both PDUs the advertising copy is the lesser (Incomplete /
  // Shortened) and the scan response carries the Complete form; a single-PDU field is Complete.
  const complete = (field) => {
    const mode = adv[`${field}Mode`];
    if (mode === 'complete') return true;
    if (mode === 'incomplete' || mode === 'shortened') return false;
    return place[field] === 'both' ? pdu === 'scanrsp' : true; // auto
  };
  // name + UUID lists can hold a distinct value per PDU: the scan-response copy uses the *Scan
  // override when the field is in both PDUs and the override is non-empty, otherwise the adv value.
  const dual = (field, primary, override) => {
    if (place[field] === 'both' && pdu === 'scanrsp' && (Array.isArray(override) ? override.length : override)) return override;
    return primary;
  };

  if (inP('flags')) add('flags', flagsStruct(adv.flags));
  const u16 = dual('uuids16', adv.serviceUuids16, adv.serviceUuids16Scan);
  if (inP('uuids16') && u16?.length) add('uuids16', uuids16Struct(u16, complete('uuids16')));
  const u128 = dual('uuids128', adv.serviceUuids128, adv.serviceUuids128Scan);
  if (inP('uuids128') && u128?.length) add('uuids128', uuids128Struct(u128, complete('uuids128')));
  if (inP('appearance')) add('appearance', appearanceStruct(adv.appearance));
  if (inP('txPower')) add('txPower', txPowerStruct(txPower));
  if (inP('manufacturer') && adv.manufacturer) add('manufacturer', manufacturerStruct(adv.manufacturer));
  if (inP('serviceData')) for (const sd of adv.serviceData || []) if (sd && sd.uuid) add('serviceData', serviceDataStruct(sd));
  if (inP('name')) add('name', nameStruct(dual('name', adv.name, adv.nameScan), complete('name')));

  const extra = pdu === 'adv' ? adv.extraAdHex : adv.scanRespExtraHex;
  if (extra?.trim()) {
    // Raw, already-formed AD structures appended verbatim.
    for (const s of parse(hexToBytes(extra))) out.push({ type: s.type, data: s.data, field: 'raw' });
  }
  return out;
}

/** Concatenate structures into the on-air AD byte sequence. */
export function assemble(structures) {
  const w = new ByteWriter();
  for (const s of structures) {
    w.u8(s.data.length + 1).u8(s.type).bytes(s.data);
  }
  return w.build();
}

/** Parse a raw AD byte sequence into displayable structures. */
export function parse(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i];
    if (len === 0) break; // early termination / padding
    const type = bytes[i + 1];
    const data = bytes.subarray(i + 2, i + 1 + len);
    out.push({ type, typeName: AD_TYPE_NAMES[type] || `Unknown 0x${type.toString(16)}`, data, decoded: decodeStruct(type, data) });
    i += 1 + len;
  }
  return out;
}

function decodeStruct(type, data) {
  switch (type) {
    case AD_TYPE.FLAGS: {
      const bits = data[0] || 0;
      const set = FLAG_BITS.filter(([m]) => bits & m).map(([, n]) => n);
      return set.length ? set.join(', ') : 'none';
    }
    case AD_TYPE.COMPLETE_NAME:
    case AD_TYPE.SHORT_NAME:
      return new TextDecoder().decode(data);
    case AD_TYPE.COMPLETE_UUID16:
    case AD_TYPE.INCOMPLETE_UUID16:
    case AD_TYPE.SOLICIT_UUID16: {
      const ids = [];
      for (let i = 0; i + 1 < data.length; i += 2) {
        const u = data[i] | (data[i + 1] << 8);
        ids.push(uuid16Name(u) ? `${hex16(u)} (${uuid16Name(u)})` : hex16(u));
      }
      return ids.join(', ');
    }
    case AD_TYPE.COMPLETE_UUID128:
    case AD_TYPE.INCOMPLETE_UUID128: {
      const ids = [];
      for (let i = 0; i + 15 < data.length; i += 16) ids.push(bytesToUuid128(data.subarray(i, i + 16)));
      return ids.join(', ');
    }
    case AD_TYPE.APPEARANCE: {
      const v = data[0] | (data[1] << 8);
      return `${appearanceName(v)} (0x${v.toString(16).padStart(4, '0')})`;
    }
    case AD_TYPE.TX_POWER: {
      const v = data[0] > 0x7f ? data[0] - 0x100 : data[0];
      return `${v} dBm`;
    }
    case AD_TYPE.SERVICE_DATA_UUID16: {
      const u = data[0] | (data[1] << 8);
      const label = uuid16Name(u) ? `${hex16(u)} (${uuid16Name(u)})` : hex16(u);
      return `${label} · ${bytesToHex(data.subarray(2))}`;
    }
    case AD_TYPE.SERVICE_DATA_UUID32: {
      const u = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
      return `0x${u.toString(16).padStart(8, '0')} · ${bytesToHex(data.subarray(4))}`;
    }
    case AD_TYPE.SERVICE_DATA_UUID128:
      return `${bytesToUuid128(data.subarray(0, 16))} · ${bytesToHex(data.subarray(16))}`;
    case AD_TYPE.MANUFACTURER_DATA: {
      const company = data[0] | (data[1] << 8);
      const payload = data.subarray(2);
      // Microsoft Swift Pair beacon: company 0x0006, [Beacon ID 0x03][sub][reserved RSSI][name…]
      if (company === SWIFT_PAIR_COMPANY && payload[0] === SWIFT_PAIR_BEACON_ID) {
        const subName = SWIFT_PAIR_SUB[payload[1]] || `sub 0x${(payload[1] || 0).toString(16).padStart(2, '0')}`;
        const name = payload.length > 3 ? new TextDecoder().decode(payload.subarray(3)) : '';
        return `Microsoft Swift Pair · ${subName}${name ? ` · name="${name}"` : ''}`;
      }
      return `${companyName(company)} · ${bytesToHex(payload)}`;
    }
    default:
      return bytesToHex(data);
  }
}

const hex16 = (u) => `0x${u.toString(16).padStart(4, '0')}`;
