// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Conflict / warning engine. Pure: validate(state) -> warnings[]. Recomputed on every
// store change; surfaces issues before they hit the controller ("conflicts resolved with
// warning", per idea.md). Extend as features land in later milestones.

import { computeAdv } from './host/gap.js';
import { stringToAddr } from './util/bytes.js';
import { SWIFT_PAIR_COMPANY, SWIFT_PAIR_BEACON_ID } from './data/assigned.js';

const err = (msg, source = 'advertiser') => ({ level: 'error', msg, source });
const warn = (msg, source = 'advertiser') => ({ level: 'warn', msg, source });

function isValidAddr(s) {
  try { stringToAddr(s); return true; } catch { return false; }
}

function firstDuplicate(list) {
  const seen = new Set();
  for (const v of list || []) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

export function validate(state) {
  const w = [];
  const adv = state.advertiser;
  const caps = state.controller.caps || {};
  const ready = state.controller.ready;

  // Payload sizes + scan-response placement.
  const place = adv.placement || {};
  const inScan = (f) => place[f] === 'scanrsp' || place[f] === 'both';
  try {
    const a = computeAdv(state);
    const hasScanContent = Object.values(place).some((p) => p === 'scanrsp' || p === 'both');
    const limitNote = a.extended ? `the ${a.perPduMax}-byte extended limit` : '31-byte legacy limit — move fields to the scan response, drop some, or switch to extended advertising';
    if (a.advLen > a.perPduMax) w.push(err(`Advertising data is ${a.advLen} bytes — exceeds ${limitNote}.`));
    if (a.scanLen > a.perPduMax) w.push(err(`Scan response data is ${a.scanLen} bytes — exceeds ${limitNote}.`));
    if (hasScanContent && !a.scannable) w.push(warn(`Fields are placed in the scan response, but ${adv.advType} is not scannable — they will be ignored.`));
    if (inScan('flags')) w.push(warn('Flags are placed in the scan response; scanners read Flags from the advertising data, so this copy is wasted.'));
    // Swift Pair needs the device name in the advertising data — Windows doesn't active-scan.
    const mfr = adv.manufacturer;
    const dh = (mfr?.dataHex || '').replace(/\s+/g, '');
    const isSwift = mfr && mfr.company === SWIFT_PAIR_COMPANY && parseInt(dh.slice(0, 2), 16) === SWIFT_PAIR_BEACON_ID;
    const nameInAdv = place.name === 'adv' || place.name === 'both';
    if (isSwift && (place.manufacturer === 'adv' || place.manufacturer === 'both') && !nameInAdv) {
      w.push(warn('Swift Pair is advertised but the device name is not in the advertising data — Windows can’t show it (it doesn’t active-scan).'));
    }
  } catch (e) {
    w.push(err(`Cannot build advertising data: ${e.message}`));
  }

  // Mode vs controller capability.
  if (adv.mode === 'extended' && ready && !caps.extendedAdvertising) {
    w.push(err('Extended advertising is selected, but this controller does not support it (BLE 4.2-class). Use legacy mode.'));
  }
  if (adv.mode === 'extended' && ready && caps.extendedAdvertising) {
    if ((adv.primaryPhy === 'Coded' || adv.secondaryPhy === 'Coded') && !caps.leCodedPhy) w.push(err('Coded PHY is selected, but this controller does not support LE Coded PHY.'));
    if (adv.secondaryPhy === '2M' && !caps.le2mPhy) w.push(err('2M PHY is selected, but this controller does not support LE 2M PHY.'));
    if (adv.advType === 'ADV_IND') w.push(warn('Extended connectable advertising is non-scannable — its payload is the advertising data; any scan-response fields are ignored.'));
  }

  // Addresses.
  if (adv.ownAddressType === 'random' && !isValidAddr(adv.randomAddress)) {
    w.push(err('Own address type is Random, but the random address is not a valid 6-octet address.'));
  }
  if (adv.ownAddressType === 'public' && ready && (!state.controller.bdAddr || state.controller.bdAddr === '00:00:00:00:00:00')) {
    w.push(warn('Controller has no public address (00:00:00:00:00:00) — most centrals will not connect. Set Own Address Type to Random.'));
  }
  if ((adv.advType === 'ADV_DIRECT_IND_HIGH' || adv.advType === 'ADV_DIRECT_IND_LOW') && !isValidAddr(adv.peerAddress)) {
    w.push(err('Directed advertising requires a valid peer address.'));
  }

  // Intervals (units of 0.625 ms; range 0x0020–0x4000).
  if (adv.intervalMin > adv.intervalMax) w.push(warn('Advertising interval min is greater than max.'));
  if (adv.intervalMin < 0x20 || adv.intervalMax > 0x4000) {
    w.push(warn('Advertising interval is outside 0x0020–0x4000 (20 ms – 10.24 s).'));
  }

  // Channels.
  if ((adv.channelMap & 0x07) === 0) w.push(err('At least one primary advertising channel (37/38/39) must be enabled.'));

  // Service UUIDs.
  const dup = firstDuplicate(adv.serviceUuids16);
  if (dup != null) w.push(warn(`Duplicate 16-bit service UUID 0x${dup.toString(16).padStart(4, '0')} in the advertised list.`));

  // Fields in both PDUs with identical content waste bytes (name/UUID lists can hold a distinct
  // per-PDU value via the *Scan override, so only warn when that override is empty).
  for (const [f, label, has, sameContent] of [
    ['uuids16', '16-bit Service UUIDs', adv.serviceUuids16?.length, !adv.serviceUuids16Scan?.length],
    ['uuids128', '128-bit Service UUIDs', adv.serviceUuids128?.length, !adv.serviceUuids128Scan?.length],
    ['manufacturer', 'Manufacturer Specific Data', !!adv.manufacturer, true],
  ]) {
    if (place[f] === 'both' && has && sameContent) w.push(warn(`${label} is in both PDUs with identical content — duplicated on air. Give the scan response its own value to differ.`));
  }

  // Beacon vs name.
  if (adv.advType === 'ADV_NONCONN_IND' && (place.name === 'adv' || place.name === 'both')) {
    w.push(warn('Non-connectable beacon includes a Complete Local Name in the primary payload — common, but consumes scarce bytes.'));
  }

  return w;
}
