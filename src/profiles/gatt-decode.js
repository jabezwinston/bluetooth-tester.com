// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Shared GATT value/name decoders — turn raw attribute bytes for standard SIG
// characteristics & descriptors into readable fields. Used by both the GATT Client and the
// GATT Server panels so a decode looks identical wherever a value appears.
//
// Names reuse the existing SERVICE_UUID16 table (assigned.js); only characteristic and
// descriptor names are added here. Decoders reuse ByteReader / appearanceName / companyName.

import { ByteReader, bytesToHex } from '../util/bytes.js';
import { normalizeUuid } from '../util/uuid.js';
import { SERVICE_UUID16, appearanceName, companyName } from '../data/assigned.js';

// ---- 16-bit characteristic & descriptor names (services come from SERVICE_UUID16) ----
export const CHAR_NAMES = {
  // GAP / GATT
  '2A00': 'Device Name', '2A01': 'Appearance', '2A02': 'Peripheral Privacy Flag',
  '2A03': 'Reconnection Address', '2A04': 'Peripheral Preferred Connection Parameters',
  '2AA6': 'Central Address Resolution', '2AC9': 'Resolvable Private Address Only',
  '2A05': 'Service Changed', '2B29': 'Client Supported Features', '2B2A': 'Database Hash',
  '2B3A': 'Server Supported Features',
  // Device Information
  '2A23': 'System ID', '2A24': 'Model Number String', '2A25': 'Serial Number String',
  '2A26': 'Firmware Revision String', '2A27': 'Hardware Revision String',
  '2A28': 'Software Revision String', '2A29': 'Manufacturer Name String',
  '2A2A': 'IEEE 11073-20601 Regulatory Certification', '2A50': 'PnP ID',
  // Battery
  '2A19': 'Battery Level', '2A1A': 'Battery Power State', '2BED': 'Battery Level Status',
  // HID
  '2A4A': 'HID Information', '2A4B': 'Report Map', '2A4C': 'HID Control Point',
  '2A4D': 'Report', '2A4E': 'Protocol Mode', '2A22': 'Boot Keyboard Input Report',
  '2A32': 'Boot Keyboard Output Report', '2A33': 'Boot Mouse Input Report',
  // Time
  '2A2B': 'Current Time', '2A0F': 'Local Time Information', '2A14': 'Reference Time Information',
  // Heart Rate
  '2A37': 'Heart Rate Measurement', '2A38': 'Body Sensor Location', '2A39': 'Heart Rate Control Point',
  // Health Thermometer
  '2A1C': 'Temperature Measurement', '2A1D': 'Temperature Type',
  '2A1E': 'Intermediate Temperature', '2A21': 'Measurement Interval',
  // Environmental Sensing
  '2A6E': 'Temperature', '2A6F': 'Humidity', '2A6D': 'Pressure', '2A7B': 'Dew Point',
  '2A76': 'UV Index', '2A77': 'Irradiance', '2A78': 'Rainfall', '2A8E': 'Elevation',
  // Tx Power / Alert
  '2A07': 'Tx Power Level', '2A06': 'Alert Level', '2A3F': 'Alert Status',
  // Cycling Speed & Cadence
  '2A5B': 'CSC Measurement', '2A5C': 'CSC Feature', '2A5D': 'Sensor Location',
  // Scan Parameters
  '2A4F': 'Scan Interval Window', '2A31': 'Scan Refresh',
  // LE Audio — Media Control Service (MCS / GMCS)
  '2B93': 'Media Player Name', '2B96': 'Track Changed', '2B97': 'Track Title',
  '2B98': 'Track Duration', '2B99': 'Track Position', '2BA1': 'Playing Order',
  '2BA2': 'Playing Orders Supported', '2BA3': 'Media State', '2BA4': 'Media Control Point',
  '2BA5': 'Media Control Point Opcodes Supported',
  // LE Audio — Telephone Bearer Service (TBS / GTBS) + TMAP
  '2B51': 'TMAP Role', '2BB3': 'Bearer Provider Name', '2BB4': 'Bearer UCI',
  '2BB5': 'Bearer Technology', '2BB6': 'Bearer URI Schemes Supported List',
  '2BB9': 'Bearer List Current Calls', '2BBA': 'Content Control ID', '2BBB': 'Status Flags',
  '2BBD': 'Call State', '2BBE': 'Call Control Point', '2BBF': 'Call Control Point Optional Opcodes',
  '2BC0': 'Termination Reason', '2BC1': 'Incoming Call', '2BC2': 'Call Friendly Name',
  // Descriptors
  '2900': 'Characteristic Extended Properties', '2901': 'Characteristic User Description',
  '2902': 'Client Characteristic Configuration', '2903': 'Server Characteristic Configuration',
  '2904': 'Characteristic Presentation Format', '2905': 'Characteristic Aggregate Format',
  '2906': 'Valid Range', '2907': 'External Report Reference', '2908': 'Report Reference',
  '290B': 'Environmental Sensing Configuration', '290C': 'Environmental Sensing Measurement',
  '290D': 'Environmental Sensing Trigger Setting',
};

/** Human name for a service / characteristic / descriptor UUID, or null if unknown. */
export function gattName(uuid) {
  let u;
  try { u = normalizeUuid(uuid); } catch { return null; }
  if (u.length !== 4) return null;
  if (CHAR_NAMES[u]) return CHAR_NAMES[u];
  return SERVICE_UUID16[parseInt(u, 16)] || null;
}

// ---- small shared formatters ----
const utf8 = (b) => new TextDecoder().decode(b);
const kv = (k, v) => ({ k, v });
const hexW = (n, w) => '0x' + (n >>> 0).toString(16).padStart(w, '0').toUpperCase();
const enumOf = (map, v) => map[v] || `0x${v.toString(16).padStart(2, '0')} (reserved)`;
const setBits = (v, bits) => bits.filter(([m]) => v & m).map(([, n]) => n);

// PnP ID product version 0xJJMN → "JJ.M.N"; HID bcdHID 0x0JKM (BCD) → "J.KM".
const verJMN = (v) => `${v >> 8}.${(v >> 4) & 0xf}.${v & 0xf}`;
const bcd = (v) => `${(v >> 8).toString(16)}.${(v & 0xff).toString(16).padStart(2, '0')}`;

// IEEE-11073 32-bit FLOAT: sint24 mantissa (LE) · 10^(sint8 exponent).
function float11073(r) {
  const b0 = r.u8(), b1 = r.u8(), b2 = r.u8(), exp = r.i8();
  let mant = b0 | (b1 << 8) | (b2 << 16);
  if (mant & 0x800000) mant -= 0x1000000;
  return mant * Math.pow(10, exp);
}

const FORMAT_TYPES = {
  0x01: 'boolean', 0x04: 'uint8', 0x06: 'uint16', 0x07: 'uint24', 0x08: 'uint32',
  0x0c: 'sint8', 0x0e: 'sint16', 0x10: 'sint32', 0x19: 'utf8s', 0x1a: 'utf16s',
};
const COMMON_UNITS = {
  0x2700: 'unitless', 0x2703: 'second', 0x272f: '°C', 0x2728: 'volt', 0x2724: 'pascal',
  0x27ad: '%', 0x27c4: 'bpm', 0x2731: 'dBm', 0x2781: 'hertz',
};
// ---- LE Audio enums / bitfields (values from the SIG MCS/TBS/TMAP specs) ----
const MEDIA_STATE = ['Inactive', 'Playing', 'Paused', 'Seeking'];
const PLAYING_ORDER = { 1: 'Single Once', 2: 'Single Repeat', 3: 'In Order Once', 4: 'In Order Repeat', 5: 'Oldest Once', 6: 'Oldest Repeat', 7: 'Newest Once', 8: 'Newest Repeat', 9: 'Shuffle Once', 10: 'Shuffle Repeat' };
const PLAYING_ORDERS_BITS = [[0x001, 'Single Once'], [0x002, 'Single Repeat'], [0x004, 'In Order Once'], [0x008, 'In Order Repeat'], [0x010, 'Oldest Once'], [0x020, 'Oldest Repeat'], [0x040, 'Newest Once'], [0x080, 'Newest Repeat'], [0x100, 'Shuffle Once'], [0x200, 'Shuffle Repeat']];
const MCS_OPC_BITS = [[1 << 0, 'Play'], [1 << 1, 'Pause'], [1 << 2, 'Fast Rewind'], [1 << 3, 'Fast Forward'], [1 << 4, 'Stop'], [1 << 5, 'Move Relative'], [1 << 6, 'Prev Segment'], [1 << 7, 'Next Segment'], [1 << 8, 'First Segment'], [1 << 9, 'Last Segment'], [1 << 10, 'Goto Segment'], [1 << 11, 'Prev Track'], [1 << 12, 'Next Track'], [1 << 13, 'First Track'], [1 << 14, 'Last Track'], [1 << 15, 'Goto Track'], [1 << 16, 'Prev Group'], [1 << 17, 'Next Group'], [1 << 18, 'First Group'], [1 << 19, 'Last Group'], [1 << 20, 'Goto Group']];
const TMAP_ROLE_BITS = [[0x01, 'Call Gateway'], [0x02, 'Call Terminal'], [0x04, 'Unicast Media Receiver'], [0x08, 'Unicast Media Sender'], [0x10, 'Broadcast Media Receiver']];
const BEARER_TECH = { 1: '3G', 2: '4G', 3: 'LTE', 4: 'Wi-Fi', 5: '5G', 6: 'GSM', 7: 'CDMA', 8: '2G', 9: 'WCDMA' };
const CALL_STATE = ['Incoming', 'Dialing', 'Alerting', 'Active', 'Locally Held', 'Remotely Held', 'Locally and Remotely Held'];
const TERM_REASON = ['Bad Remote URI', 'Call Failed', 'Remote Ended Call', 'Server Ended Call', 'Line Busy', 'Network Congested', 'Client Terminated', 'No Service', 'No Answer', 'Unspecified'];
// Track Duration/Position: signed, units of 1/100 s; negative (0xFFFFFFFF) means unknown/unavailable.
const durationCs = (v) => {
  if (v < 0) return 'unknown';
  const s = v / 100, m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')} (${s.toFixed(2)} s)`;
};
function callStateRows(r) {
  const rows = [];
  while (r.remaining >= 3) { const idx = r.u8(), st = r.u8(), fl = r.u8(); rows.push(kv(`Call ${idx}`, `${enumOf(CALL_STATE, st)}${fl ? ` · flags 0x${fl.toString(16).padStart(2, '0')}` : ''}`)); }
  return rows.length ? rows : [kv('Call State', 'no active calls')];
}

const BODY_LOC = ['Other', 'Chest', 'Wrist', 'Finger', 'Hand', 'Ear Lobe', 'Foot'];
const CSC_LOC = ['Other', 'Top of shoe', 'In shoe', 'Hip', 'Front Wheel', 'Left Crank',
  'Right Crank', 'Left Pedal', 'Right Pedal', 'Front Hub', 'Rear Dropout', 'Chainstay',
  'Rear Wheel', 'Rear Hub', 'Chest', 'Spider', 'Chain Ring'];

// ---- per-UUID decoders: ByteReader → [{k,v}] (throwing is caught → falls back to hex) ----
const textRow = (r) => [kv('Text', `"${utf8(r.rest())}"`)];
const DECODERS = {
  // DIS text strings
  '2A29': textRow, '2A24': textRow, '2A25': textRow, '2A26': textRow, '2A27': textRow,
  '2A28': textRow, '2A00': textRow,
  '2A2A': (r) => [kv('Hex', bytesToHex(r.rest()))],
  '2A23': (r) => {
    const b = r.rest();
    return [kv('Manufacturer Id', bytesToHex(b.subarray(0, 5).slice().reverse())),
      kv('OUI', bytesToHex(b.subarray(5, 8).slice().reverse()))];
  },
  '2A50': (r) => {
    const src = r.u8(), vid = r.u16(), pid = r.u16(), ver = r.u16();
    const srcName = src === 1 ? 'Bluetooth SIG' : src === 2 ? 'USB-IF' : `reserved (${src})`;
    const vidName = src === 1 ? companyName(vid) : hexW(vid, 4);
    return [kv('Vendor Id Source', srcName), kv('Vendor Id', vidName),
      kv('Product Id', hexW(pid, 4)), kv('Product Version', verJMN(ver))];
  },
  '2A01': (r) => { const v = r.u16(); return [kv('Appearance', `${hexW(v, 4)} ${appearanceName(v)}`)]; },
  '2A04': (r) => {
    const mn = r.u16(), mx = r.u16(), lat = r.u16(), to = r.u16();
    return [kv('Min Interval', `${(mn * 1.25).toFixed(2)} ms`), kv('Max Interval', `${(mx * 1.25).toFixed(2)} ms`),
      kv('Slave Latency', String(lat)), kv('Supervision Timeout', `${to * 10} ms`)];
  },
  '2AA6': (r) => [kv('Address Resolution', r.u8() ? 'Supported' : 'Not supported')],
  '2A19': (r) => [kv('Battery Level', `${r.u8()} %`)],
  '2A4A': (r) => {
    const ver = r.u16(), country = r.u8(), flags = r.u8();
    return [kv('bcdHID', `${bcd(ver)} (${hexW(ver, 4)})`), kv('Country Code', String(country)),
      kv('Flags', setBits(flags, [[0x01, 'RemoteWake'], [0x02, 'NormallyConnectable']]).join(', ') || 'none')];
  },
  '2A4E': (r) => [kv('Protocol Mode', r.u8() ? 'Report' : 'Boot')],
  '2A4C': (r) => [kv('Control Point', r.u8() ? 'Exit Suspend' : 'Suspend')],
  '2A4B': (r) => [kv('Report Map', `${r.bytes.length} bytes (USB HID descriptor)`)],
  '2A07': (r) => [kv('Tx Power', `${r.i8()} dBm`)],
  '2A06': (r) => [kv('Alert Level', enumOf(['No Alert', 'Mild Alert', 'High Alert'], r.u8()))],
  '2A38': (r) => [kv('Body Sensor Location', enumOf(BODY_LOC, r.u8()))],
  '2A5D': (r) => [kv('Sensor Location', enumOf(CSC_LOC, r.u8()))],
  '2A6E': (r) => [kv('Temperature', `${(r.i16() * 0.01).toFixed(2)} °C`)],
  '2A6F': (r) => [kv('Humidity', `${(r.u16() * 0.01).toFixed(2)} %`)],
  '2A6D': (r) => [kv('Pressure', `${(r.u32() * 0.1).toFixed(1)} Pa`)],
  '2A2B': (r) => {
    const y = r.u16(), mo = r.u8(), d = r.u8(), h = r.u8(), mi = r.u8(), s = r.u8(), dow = r.u8();
    const days = ['—', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return [kv('Date/Time', `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`),
      kv('Day of Week', days[dow] || String(dow))];
  },
  '2A37': (r) => {
    const flags = r.u8();
    const hr = (flags & 0x01) ? r.u16() : r.u8();
    const rows = [kv('Heart Rate', `${hr} bpm`)];
    if (flags & 0x04) rows.push(kv('Sensor Contact', (flags & 0x02) ? 'detected' : 'not detected'));
    if (flags & 0x08) rows.push(kv('Energy Expended', `${r.u16()} kJ`));
    if (flags & 0x10) { const rr = []; while (r.remaining >= 2) rr.push((r.u16() / 1024).toFixed(3)); rows.push(kv('RR Intervals', rr.join(', ') + ' s')); }
    return rows;
  },
  '2A1C': (r) => {
    const flags = r.u8();
    const t = float11073(r);
    return [kv('Temperature', `${t.toFixed(2)} ${(flags & 0x01) ? '°F' : '°C'}`)];
  },
  '2A5B': (r) => {
    const flags = r.u8(); const rows = [];
    if (flags & 0x01) { rows.push(kv('Wheel Revolutions', String(r.u32()))); rows.push(kv('Last Wheel Event', `${(r.u16() / 1024).toFixed(3)} s`)); }
    if (flags & 0x02) { rows.push(kv('Crank Revolutions', String(r.u16()))); rows.push(kv('Last Crank Event', `${(r.u16() / 1024).toFixed(3)} s`)); }
    return rows;
  },
  // LE Audio — Media Control Service
  '2B93': textRow, '2B97': textRow,
  '2B98': (r) => [kv('Track Duration', durationCs(r.i32()))],
  '2B99': (r) => [kv('Track Position', durationCs(r.i32()))],
  '2BA1': (r) => [kv('Playing Order', enumOf(PLAYING_ORDER, r.u8()))],
  '2BA2': (r) => [kv('Supported', setBits(r.u16(), PLAYING_ORDERS_BITS).join(', ') || 'none')],
  '2BA3': (r) => [kv('Media State', enumOf(MEDIA_STATE, r.u8()))],
  '2BA5': (r) => [kv('Supported Opcodes', setBits(r.u32(), MCS_OPC_BITS).join(', ') || 'none')],
  // LE Audio — Telephone Bearer Service + TMAP
  '2B51': (r) => [kv('TMAP Role', setBits(r.u16(), TMAP_ROLE_BITS).join(', ') || 'none')],
  '2BB3': textRow, '2BB4': textRow, '2BB6': textRow,
  '2BB5': (r) => [kv('Bearer Technology', enumOf(BEARER_TECH, r.u8()))],
  '2BBA': (r) => [kv('Content Control ID', String(r.u8()))],
  '2BBB': (r) => [kv('Status Flags', setBits(r.u16(), [[0x01, 'Inband Ringtone'], [0x02, 'Silent Mode']]).join(', ') || 'none')],
  '2BBD': (r) => callStateRows(r),
  '2BBF': (r) => [kv('Optional Opcodes', setBits(r.u16(), [[0x01, 'Local Hold/Retrieve'], [0x02, 'Join']]).join(', ') || 'none')],
  '2BC0': (r) => [kv('Call Index', String(r.u8())), kv('Reason', enumOf(TERM_REASON, r.u8()))],
  '2BC1': (r) => [kv('Call Index', String(r.u8())), kv('URI', `"${utf8(r.rest())}"`)],
  '2BC2': (r) => [kv('Call Index', String(r.u8())), kv('Friendly Name', `"${utf8(r.rest())}"`)],
  // Descriptors
  '2902': (r) => { const v = r.u16(); return [kv('CCCD', setBits(v, [[0x01, 'Notifications'], [0x02, 'Indications']]).join(' + ') || 'disabled')]; },
  '2900': (r) => { const v = r.u16(); return [kv('Ext Properties', setBits(v, [[0x01, 'Reliable Write'], [0x02, 'Writable Auxiliaries']]).join(', ') || 'none')]; },
  '2908': (r) => [kv('Report Id', String(r.u8())), kv('Report Type', enumOf(['', 'Input', 'Output', 'Feature'], r.u8()))],
  '2901': textRow,
  '2904': (r) => {
    const fmt = r.u8(), exp = r.i8(), unit = r.u16(), ns = r.u8(), desc = r.u16();
    return [kv('Format', FORMAT_TYPES[fmt] || hexW(fmt, 2)), kv('Exponent', String(exp)),
      kv('Unit', `${hexW(unit, 4)} ${COMMON_UNITS[unit] || ''}`.trim()),
      kv('Namespace', String(ns)), kv('Description', hexW(desc, 4))];
  },
};

function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Decode a standard characteristic / descriptor value into readable rows.
 * @returns {Array<{k,v}>|null} null when the value is empty or the UUID has no decoder.
 */
export function decodeValue(uuid, bytes) {
  if (!bytes || !bytes.length) return null;
  let u;
  try { u = normalizeUuid(uuid); } catch { return null; }
  const fn = DECODERS[u];
  if (!fn) return null;
  try { const rows = fn(new ByteReader(bytes)); return rows && rows.length ? rows : null; } catch { return null; }
}

/** One-line summary for inline display (e.g. "87 %", "Keyboard"), or null. */
export function summarizeValue(uuid, bytes) {
  const rows = decodeValue(uuid, bytes);
  if (!rows) return null;
  return rows.slice(0, 2).map((r) => r.v).join(' · ');
}

/**
 * Generic decode driven by a Characteristic Presentation Format (0x2904) descriptor value:
 * read the scalar per its format, scale by 10^exponent, and label with its unit. Lets a
 * characteristic with no dedicated decoder still render readably when it advertises a CPF.
 * @param {Uint8Array} cpf  the 7-byte 0x2904 descriptor value
 * @param {Uint8Array} bytes the characteristic value
 * @returns {Array<{k,v}>|null}
 */
export function decodeByPresentationFormat(cpf, bytes) {
  if (!cpf || cpf.length < 4 || !bytes || !bytes.length) return null;
  const format = cpf[0];
  const exponent = cpf[1] > 0x7f ? cpf[1] - 0x100 : cpf[1];
  const unit = cpf[2] | (cpf[3] << 8);
  const r = new ByteReader(bytes);
  let raw, numeric = true;
  try {
    switch (format) {
      case 0x01: raw = r.u8() ? 'true' : 'false'; numeric = false; break;
      case 0x04: raw = r.u8(); break;
      case 0x06: raw = r.u16(); break;
      case 0x07: raw = r.u24(); break;
      case 0x08: raw = r.u32(); break;
      case 0x0c: raw = r.i8(); break;
      case 0x0e: raw = r.i16(); break;
      case 0x10: raw = r.i32(); break;
      case 0x19: raw = `"${utf8(bytes)}"`; numeric = false; break;
      case 0x1a: raw = `"${new TextDecoder('utf-16le').decode(bytes)}"`; numeric = false; break;
      default: return null; // unsupported format → caller falls back to hex/ASCII
    }
  } catch { return null; }
  const unitSym = COMMON_UNITS[unit] || (unit ? hexW(unit, 4) : '');
  const value = numeric ? +(exponent ? raw * Math.pow(10, exponent) : raw).toFixed(6) : raw;
  return [
    { k: 'Value', v: `${value}${unitSym ? ' ' + unitSym : ''}` },
    { k: 'Format', v: `${FORMAT_TYPES[format] || hexW(format, 2)}${exponent ? ` ×10^${exponent}` : ''}` },
  ];
}
