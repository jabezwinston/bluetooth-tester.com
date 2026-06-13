// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GATT attribute database. Builds a flat, handle-indexed attribute list from the editable
// services table and provides the range/type lookups the ATT server needs. Core v6.0 Vol 3
// Part G (declarations) + Part F (ATT). Pure — no I/O.

import { ByteWriter, hexToBytes } from '../util/bytes.js';
import { uuidToBytesLE, normalizeUuid, uuid16Value, uuidEqual } from '../util/uuid.js';

export const GATT_UUID = {
  PRIMARY_SERVICE: 0x2800,
  SECONDARY_SERVICE: 0x2801,
  INCLUDE: 0x2802,
  CHARACTERISTIC: 0x2803,
  CHAR_EXT_PROPS: 0x2900,
  CHAR_USER_DESC: 0x2901,
  CCCD: 0x2902,
  SERVER_CHAR_CONFIG: 0x2903,
  CHAR_PRESENTATION: 0x2904,
};

export const PROP = { BROADCAST: 0x01, READ: 0x02, WRITE_NR: 0x04, WRITE: 0x08, NOTIFY: 0x10, INDICATE: 0x20, SIGNED: 0x40, EXT: 0x80 };

const PROP_MAP = { read: PROP.READ, write: PROP.WRITE, writeNoResp: PROP.WRITE_NR, notify: PROP.NOTIFY, indicate: PROP.INDICATE, broadcast: PROP.BROADCAST, signed: PROP.SIGNED };

export function propsByte(list) {
  let p = 0;
  for (const x of list || []) p |= PROP_MAP[x] || 0;
  return p;
}

const hex16 = (n) => normalizeUuid(n);

function valueBytes(c) {
  if (c.valueHex != null && c.valueHex !== '') return hexToBytes(c.valueHex);
  if (c.valueText) return new TextEncoder().encode(c.valueText);
  return new Uint8Array(0);
}

export function buildDb(table) {
  const attributes = [];
  const services = [];
  const layout = []; // mirrors the table with allocated handles (for the editor UI)
  let handle = 0;
  const next = () => ++handle;

  for (const svc of table.services || []) {
    const startHandle = next();
    const svcType = svc.primary === false ? GATT_UUID.SECONDARY_SERVICE : GATT_UUID.PRIMARY_SERVICE;
    attributes.push({ handle: startHandle, type: hex16(svcType), value: uuidToBytesLE(svc.uuid), perms: { read: true }, meta: { kind: 'service', uuid: normalizeUuid(svc.uuid), name: svc.name } });
    const chLayout = [];

    for (const ch of svc.characteristics || []) {
      const declHandle = next();
      const valueHandle = next();
      const props = propsByte(ch.properties);
      const declValue = new ByteWriter().u8(props).u16(valueHandle).bytes(uuidToBytesLE(ch.uuid)).build();
      attributes.push({ handle: declHandle, type: hex16(GATT_UUID.CHARACTERISTIC), value: declValue, perms: { read: true }, meta: { kind: 'charDecl', uuid: normalizeUuid(ch.uuid) } });

      const sec = ch.security || 'open';
      const canRead = !!(props & PROP.READ);
      const canWrite = !!(props & (PROP.WRITE | PROP.WRITE_NR));
      attributes.push({
        handle: valueHandle, type: normalizeUuid(ch.uuid), value: valueBytes(ch),
        perms: { read: canRead, write: canWrite, readEnc: sec !== 'open' && canRead, writeEnc: sec !== 'open' && canWrite },
        meta: { kind: 'charValue', uuid: normalizeUuid(ch.uuid), props, declHandle, name: ch.name },
      });

      const descs = ch.descriptors ? [...ch.descriptors] : [];
      const hasCccd = descs.some((d) => uuid16Value(d.uuid) === GATT_UUID.CCCD);
      if ((props & (PROP.NOTIFY | PROP.INDICATE)) && !hasCccd) descs.unshift({ uuid: '2902', valueHex: '0000', cccd: true });
      let cccdHandle = null;
      const descriptors = [];
      for (const d of descs) {
        const h = next();
        const isCccd = uuid16Value(d.uuid) === GATT_UUID.CCCD;
        if (isCccd) cccdHandle = h;
        descriptors.push({ handle: h, uuid: normalizeUuid(d.uuid), isCCCD: isCccd, auto: !!d.cccd,
          value: isCccd ? new Uint8Array([0, 0]) : valueBytes(d), writable: isCccd || !!d.writable });
        attributes.push({
          handle: h, type: normalizeUuid(d.uuid),
          value: isCccd ? new Uint8Array([0, 0]) : valueBytes(d),
          perms: { read: true, write: isCccd || !!d.writable },
          meta: { kind: 'descriptor', uuid: normalizeUuid(d.uuid), isCCCD: isCccd, charValueHandle: valueHandle },
        });
      }
      chLayout.push({ declHandle, valueHandle, cccdHandle, props, descriptors });
    }
    services.push({ startHandle, endHandle: handle, uuid: normalizeUuid(svc.uuid), type: svcType });
    layout.push({ startHandle, endHandle: handle, chars: chLayout });
  }

  return { attributes, byHandle: new Map(attributes.map((a) => [a.handle, a])), services, layout, maxHandle: handle };
}

// ---- lookups used by the ATT server ----

export const attrsInRange = (db, s, e) => db.attributes.filter((a) => a.handle >= s && a.handle <= e);

export const findByType = (db, s, e, typeUuid) => attrsInRange(db, s, e).filter((a) => uuidEqual(a.type, typeUuid));

/** Service groups in range matching the group type (0x2800/0x2801). */
export function servicesInRange(db, s, e, typeUuid) {
  const want = uuid16Value(typeUuid);
  return db.services
    .filter((svc) => svc.type === want && svc.startHandle >= s && svc.startHandle <= e)
    .map((svc) => ({ startHandle: svc.startHandle, endHandle: svc.endHandle, valueBytes: uuidToBytesLE(svc.uuid) }));
}

/** For Find By Type Value (discover primary service by UUID). */
export function servicesByUuid(db, s, e, typeUuid, valueBytesLE) {
  const want = uuid16Value(typeUuid);
  const target = bytesToHex(valueBytesLE);
  return db.services
    .filter((svc) => svc.type === want && svc.startHandle >= s && svc.startHandle <= e && bytesToHex(uuidToBytesLE(svc.uuid)) === target)
    .map((svc) => ({ startHandle: svc.startHandle, endHandle: svc.endHandle }));
}

function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
