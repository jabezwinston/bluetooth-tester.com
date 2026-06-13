// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Which Direct Test Mode features a controller supports, derived from its reported
// Supported_Commands bitmap and LE feature set. Pure — takes store.state.controller.

import { bitSet } from '../util/bytes.js';

// Supported_Commands bit indices (octet*8 + bit) for the DTM commands — Core v6.0 Vol 4 Part E §6.27.
const CMD = {
  rxV1: 28 * 8 + 4, txV1: 28 * 8 + 5, testEnd: 28 * 8 + 6,
  rxV2: 35 * 8 + 5, txV2: 35 * 8 + 6,
  txV4: 45 * 8 + 0,
};
// LE feature bits for Stable Modulation Index — Core v6.0 Vol 6 Part B §4.6.
const FEAT_STABLE_MOD_TX = 9, FEAT_STABLE_MOD_RX = 10;

export function dtmCaps(controller = {}) {
  const sc = controller.supportedCommands; // Uint8Array(64) | null
  const f = controller.leFeatures;         // Uint8Array(8) | null
  const caps = controller.caps || {};
  const known = !!sc;
  const has = (idx) => known && bitSet(sc, idx);

  const txV2 = has(CMD.txV2), txV4 = has(CMD.txV4), rxV2 = has(CMD.rxV2);
  return {
    known,
    // When the controller hasn't reported its commands, assume the basic v1 test exists (the panel
    // always allowed it) but nothing enhanced — sending an unsupported v2/v4 just errors gracefully.
    txV1: known ? has(CMD.txV1) : true,
    rxV1: known ? has(CMD.rxV1) : true,
    testEnd: known ? has(CMD.testEnd) : true,
    txV2, txV4, rxV2,
    txVersion: txV4 ? 4 : txV2 ? 2 : 1,
    rxVersion: rxV2 ? 2 : 1,
    phy2m: !!caps.le2mPhy,
    phyCoded: !!caps.leCodedPhy,
    stableModTx: !!f && bitSet(f, FEAT_STABLE_MOD_TX),
    stableModRx: !!f && bitSet(f, FEAT_STABLE_MOD_RX),
    canSelectTxPhy: (txV2 || txV4) && (!!caps.le2mPhy || !!caps.leCodedPhy),
    canSelectRxPhy: rxV2 && (!!caps.le2mPhy || !!caps.leCodedPhy),
    canSetTxPower: txV4,
    canSetModIndex: rxV2,
  };
}

// HCI PHY byte → label. Transmitter distinguishes the two Coded coding schemes; the receiver doesn't.
export const TX_PHYS = [[1, 'LE 1M'], [2, 'LE 2M'], [3, 'LE Coded S=8'], [4, 'LE Coded S=2']];
export const RX_PHYS = [[1, 'LE 1M'], [2, 'LE 2M'], [3, 'LE Coded']];

const okPhy = (c, v) => v === 1 || (v === 2 && c.phy2m) || (v >= 3 && c.phyCoded);
export const availableTxPhys = (c) => TX_PHYS.filter(([v]) => okPhy(c, v));
export const availableRxPhys = (c) => RX_PHYS.filter(([v]) => okPhy(c, v));
