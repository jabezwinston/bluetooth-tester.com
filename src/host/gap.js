// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GAP advertising orchestration. Builds AD payloads from the advertiser config and programs the
// controller. Uses the legacy advertising HCI commands; when the user selects extended mode AND the
// controller reports support (caps.extendedAdvertising), it uses the extended set instead — which
// lifts the 31-byte payload cap and exposes the primary/secondary PHY, SID and duration.

import * as cmd from '../hci/commands.js';
import { ADV_TYPE } from '../data/assigned.js';
import { buildStructures, assemble, parse, LEGACY_AD_MAX } from './ad.js';
import { stringToAddr } from '../util/bytes.js';

const SCANNABLE = new Set(['ADV_IND', 'ADV_SCAN_IND']);
const CONNECTABLE = new Set(['ADV_IND', 'ADV_DIRECT_IND_HIGH', 'ADV_DIRECT_IND_LOW']);
const DIRECTED = new Set(['ADV_DIRECT_IND_HIGH', 'ADV_DIRECT_IND_LOW']);

// Largest payload a single extended Set Adv Data operation (length is one octet) can carry.
const EXT_AD_MAX = 251;
const ADV_HANDLE = 0; // we drive a single advertising set
const PHY = { '1M': 0x01, '2M': 0x02, 'Coded': 0x03 };

// True when extended advertising should actually be used: user selected it and the controller can do it.
export function extendedActive(state) {
  return state.advertiser.mode === 'extended' && !!state.controller.caps?.extendedAdvertising;
}

// Extended advertising event-property bits for a given (legacy-named) advertising type. Extended PDUs
// are NOT scannable-and-connectable at once: a connectable set carries its data in the adv data, a
// scannable set carries it in the scan response. The LEGACY bit is deliberately never set.
export function extEventProps(advType) {
  const CONN = 0x01, SCAN = 0x02, DIR = 0x04;
  if (advType === 'ADV_IND') return CONN;                 // connectable (non-scannable) extended
  if (advType === 'ADV_SCAN_IND') return SCAN;            // scannable: data goes in the scan response
  if (DIRECTED.has(advType)) return CONN | DIR;           // connectable directed (low duty in extended)
  return 0;                                               // ADV_NONCONN_IND → non-conn, non-scan beacon
}

/** Compute AD payloads + parsed views for the current advertiser config. Pure, no I/O. */
export function computeAdv(state) {
  const adv = state.advertiser;
  const txPower = state.controller.txPower ?? 0;

  const advStructures = buildStructures(adv, { pdu: 'adv', txPower });
  const advBytes = assemble(advStructures);

  // Scan response is sent for scannable types only; its content is whatever fields are placed there.
  const scannable = SCANNABLE.has(adv.advType);
  const scanStructures = scannable ? buildStructures(adv, { pdu: 'scanrsp', txPower }) : [];
  const scanBytes = assemble(scanStructures);

  // The per-PDU budget: 31 bytes legacy, or the controller's reported max (capped at a single
  // extended Set-Adv-Data operation) in extended mode.
  const extended = extendedActive(state);
  const maxAdv = state.controller.maxAdvDataLen || EXT_AD_MAX;
  const perPduMax = extended ? Math.min(maxAdv, EXT_AD_MAX) : LEGACY_AD_MAX;

  return {
    advType: adv.advType,
    scannable,
    connectable: CONNECTABLE.has(adv.advType),
    directed: DIRECTED.has(adv.advType),
    extended,
    perPduMax,
    txPower,
    advStructures,
    advBytes,
    advParsed: parse(advBytes),
    scanStructures,
    scanBytes,
    scanParsed: parse(scanBytes),
    advLen: advBytes.length,
    scanLen: scanBytes.length,
    overLegacy: advBytes.length > LEGACY_AD_MAX || scanBytes.length > LEGACY_AD_MAX,
  };
}

export async function startAdvertising(hci, store) {
  // Going extended: learn the controller's *real* max AD length first. Bring-up deliberately skips
  // this read because it locks the controller into extended mode — but here we're committing to
  // extended anyway. Without it the app assumes the full 251-byte budget, and a payload the firmware
  // can't fit (e.g. a controller built with the default 31-byte BT_CTLR_ADV_DATA_LEN_MAX) would
  // surface as a bare "Command Disallowed (0x0c)" on Set Ext Adv Data. Validate up front instead.
  if (extendedActive(store.state)) {
    try {
      const mad = await hci.command(cmd.leReadMaxAdvDataLength());
      if (mad?.decoded?.maxAdvDataLen) store.update((s) => { s.controller.maxAdvDataLen = mad.decoded.maxAdvDataLen; });
    } catch { /* keep the existing default; the length check below still applies */ }
  }
  const a = computeAdv(store.state);
  if (a.advLen > a.perPduMax) throw new Error(`advertising data ${a.advLen} > ${a.perPduMax} bytes (${a.extended ? 'extended' : 'legacy'} limit) — the controller firmware caps extended AD data at ${a.perPduMax} bytes`);
  if (a.scanLen > a.perPduMax) throw new Error(`scan response data ${a.scanLen} > ${a.perPduMax} bytes (${a.extended ? 'extended' : 'legacy'} limit) — the controller firmware caps extended AD data at ${a.perPduMax} bytes`);
  if (a.extended) return startExtAdvertising(hci, store, a);
  return startLegacyAdvertising(hci, store, a);
}

async function startLegacyAdvertising(hci, store, a) {
  const adv = store.state.advertiser;
  const ownAddressType = adv.ownAddressType === 'random' ? 0x01 : 0x00;
  if (ownAddressType === 0x01) {
    await hci.command(cmd.leSetRandomAddress(stringToAddr(adv.randomAddress)));
  }

  await hci.command(cmd.leSetAdvParameters({
    intervalMin: adv.intervalMin,
    intervalMax: adv.intervalMax,
    advType: ADV_TYPE[adv.advType] ?? ADV_TYPE.ADV_IND,
    ownAddressType,
    peerAddressType: adv.peerAddressType === 'random' ? 0x01 : 0x00,
    peerAddress: a.directed ? stringToAddr(adv.peerAddress) : new Uint8Array(6),
    channelMap: adv.channelMap,
    filterPolicy: adv.filterPolicy,
  }));

  // ADV_DIRECT_IND carries no advertising data.
  if (!a.directed) await hci.command(cmd.leSetAdvData(a.advBytes));
  if (a.scannable) await hci.command(cmd.leSetScanResponseData(a.scanBytes));

  await hci.command(cmd.leSetAdvEnable(true));
  store.update((s) => { s.advertiser.enabled = true; });
}

async function startExtAdvertising(hci, store, a) {
  const adv = store.state.advertiser;
  const caps = store.state.controller.caps || {};
  // Guard PHY choices against controller support (the UI hides these, but enforce here too).
  const primaryPhy = adv.primaryPhy === 'Coded' ? 'Coded' : '1M';
  const secondaryPhy = adv.secondaryPhy || '1M';
  if ((primaryPhy === 'Coded' || secondaryPhy === 'Coded') && !caps.leCodedPhy) throw new Error('Coded PHY selected but the controller does not support it.');
  if (secondaryPhy === '2M' && !caps.le2mPhy) throw new Error('2M PHY selected but the controller does not support it.');

  const ownAddressType = adv.ownAddressType === 'random' ? 0x01 : 0x00;
  const props = extEventProps(adv.advType);
  const scannable = !!(props & 0x02);

  await hci.command(cmd.leSetExtAdvParameters({
    handle: ADV_HANDLE,
    eventProps: props,
    primaryIntervalMin: adv.intervalMin,
    primaryIntervalMax: adv.intervalMax,
    primaryChannelMap: adv.channelMap,
    ownAddressType,
    peerAddressType: adv.peerAddressType === 'random' ? 0x01 : 0x00,
    peerAddress: a.directed ? stringToAddr(adv.peerAddress) : new Uint8Array(6),
    filterPolicy: adv.filterPolicy,
    primaryPhy: PHY[primaryPhy],
    secondaryPhy: PHY[secondaryPhy],
    advSid: adv.advSid & 0x0f,
  }));

  // The set needs its own random address (the controller uses it for this set's PDUs).
  if (ownAddressType === 0x01) await hci.command(cmd.leSetAdvSetRandomAddress(ADV_HANDLE, stringToAddr(adv.randomAddress)));

  // A scannable extended set carries its payload in the scan response (adv data must be empty); any
  // other set carries it in the adv data. operation 0x03 = complete data in a single fragment.
  if (scannable) {
    await hci.command(cmd.leSetExtScanResponseData({ handle: ADV_HANDLE, data: a.scanBytes }));
  } else if (!a.directed || a.advBytes.length) {
    await hci.command(cmd.leSetExtAdvData({ handle: ADV_HANDLE, data: a.advBytes }));
  }

  await hci.command(cmd.leSetExtAdvEnable({
    enable: true,
    sets: [{ handle: ADV_HANDLE, duration: Math.round((adv.advDuration || 0) / 10), maxEvents: adv.advMaxEvents || 0 }],
  }));
  store.update((s) => { s.advertiser.enabled = true; });
}

export async function stopAdvertising(hci, store) {
  if (extendedActive(store.state)) await hci.command(cmd.leSetExtAdvEnable({ enable: false, sets: [{ handle: ADV_HANDLE }] }));
  else await hci.command(cmd.leSetAdvEnable(false));
  store.update((s) => { s.advertiser.enabled = false; });
}
