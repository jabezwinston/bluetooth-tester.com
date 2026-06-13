// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Controller bring-up: reset, configure event masks, read capabilities, and populate
// store.controller. Optional/extended reads are guarded so an unsupported command on a
// limited controller (e.g. classic ESP32, BLE 4.2) doesn't abort the sequence.

import * as cmd from '../hci/commands.js';
import { bitSet } from '../util/bytes.js';

// LE Read Local Supported Features bit positions (Core v6.0 Vol 6 Part B §4.6).
const LE_FEAT = {
  ENCRYPTION: 0,
  CONN_PARAM_REQUEST: 1,
  DATA_LENGTH_EXTENSION: 5,
  LL_PRIVACY: 6,
  PHY_2M: 8,
  PHY_CODED: 11,
  EXTENDED_ADVERTISING: 12,
  PERIODIC_ADVERTISING: 13,
  CHANNEL_SELECTION_2: 14,
  CIS_PERIPHERAL: 28,
  ISO_BROADCASTER: 30,
};

// `optional` reads are capability probes that a limited/LE-only controller may legitimately not
// support (Unknown HCI Command) or disallow — those failures go to the console, not a user warning.
async function tryCmd(hci, store, command, label, optional = false) {
  try {
    return await hci.command(command);
  } catch (e) {
    if (optional) console.warn(`[controller] ${label || command.name}: ${e.message}`);
    else pushNotice(store, 'warn', `${label || command.name} failed: ${e.message}`, 'controller');
    return null;
  }
}

function pushNotice(store, level, msg, source) {
  store.update((s) => { s.notices = [...s.notices.filter((w) => w.msg !== msg), { level, msg, source }]; });
}

/**
 * Probe the controller with HCI Reset, tolerant of an ESP boot-banner burst that can desync the H4
 * deframer right after a reset/flash. Each try calls hci.resync() (flush the deframer + restore the
 * command credit a desync-eaten reply left stuck at 0), then resends a fresh Reset — which a working
 * controller always answers — so a response lost to a mid-boot desync self-heals instead of wedging
 * bring-up. ~3 tries × 1300ms ≈ a 4-second give-up window before we conclude "no HCI firmware".
 */
async function probeReset(hci) {
  for (let i = 0; i < 3; i++) {
    hci.resync();
    try { return await hci.command(cmd.reset(), { timeoutMs: 1300 }); }
    catch { /* timed out or desynced — flush + resend */ }
  }
  return null;
}

export async function bringUp(hci, store) {
  const c = store.state.controller;
  c.ready = false;
  c.needsFirmware = false;
  store.update((s) => { s.notices = s.notices.filter((n) => n.source !== 'controller'); });

  // Guard: if the very first command gets no answer, the rest would each time out
  // (~5s × ~13 commands). Bail immediately with an actionable message instead, and flag that the
  // device needs HCI firmware so the OOB wizard can offer to flash it. probeReset() is boot-banner
  // safe (flush+resync between tries) so a freshly-flashed controller comes up cleanly here.
  const reset = await probeReset(hci);
  if (!reset) {
    pushNotice(store, 'error', 'No response to HCI Reset — the device isn’t speaking H4 HCI. Flash the controller firmware (Firmware tab / the popup).', 'controller');
    c.ready = false;
    c.needsFirmware = true;
    store.touch();
    return c;
  }
  // Enable all defined events incl. LE Meta (bit 61), and a wide LE sub-event set.
  await tryCmd(hci, store, cmd.setEventMask(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f])), 'Set Event Mask');
  await tryCmd(hci, store, cmd.leSetEventMask(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00])), 'LE Set Event Mask');

  const ver = await tryCmd(hci, store, cmd.readLocalVersion(), 'Read Local Version');
  if (ver?.decoded) c.version = pick(ver.decoded, ['hciVersion', 'hciSubversion', 'lmpVersion', 'manufacturer', 'lmpSubversion']);

  const bd = await tryCmd(hci, store, cmd.readBdAddr(), 'Read BD_ADDR');
  if (bd?.decoded) c.bdAddr = bd.decoded.bdAddr;
  // Zephyr/nRF controllers ship with no public identity address (BD_ADDR all-zero). Advertising
  // from 00:00:00:00:00:00 with own=public is ignored by most centrals, so fall back to a random
  // static address — gap.js already programs it via LE Set Random Address before advertising.
  c.publicAddrValid = !!c.bdAddr && c.bdAddr !== '00:00:00:00:00:00';
  if (!c.publicAddrValid && store.state.advertiser.ownAddressType === 'public') {
    store.update((s) => { s.advertiser.ownAddressType = 'random'; });
    pushNotice(store, 'warn', `Controller has no public address — advertising with random static ${store.state.advertiser.randomAddress}.`, 'controller');
  }

  const lsf = await tryCmd(hci, store, cmd.readLocalSupportedFeatures(), 'Read Local Supported Features');
  if (lsf?.decoded) c.localFeatures = lsf.decoded.features;

  const lsc = await tryCmd(hci, store, cmd.readLocalSupportedCommands(), 'Read Local Supported Commands');
  if (lsc?.decoded) c.supportedCommands = lsc.decoded.supportedCommands;

  // BR/EDR buffer size — absent on LE-only controllers (LE Read Buffer Size below covers LE). Optional.
  const bs = await tryCmd(hci, store, cmd.readBufferSize(), 'Read Buffer Size', true);
  if (bs?.decoded) c.bufferSize = pick(bs.decoded, ['aclLen', 'scoLen', 'numAcl', 'numSco']);

  const lef = await tryCmd(hci, store, cmd.leReadLocalSupportedFeatures(), 'LE Read Local Supported Features');
  if (lef?.decoded) c.leFeatures = lef.decoded.features;

  const lbs = await tryCmd(hci, store, cmd.leReadBufferSize(), 'LE Read Buffer Size');
  if (lbs?.decoded) c.leBufferSize = pick(lbs.decoded, ['aclLen', 'numAcl']);

  const ls = await tryCmd(hci, store, cmd.leReadSupportedStates(), 'LE Read Supported States');
  if (ls?.decoded) c.leStates = ls.decoded.states;

  // Derive capabilities from LE features — needed before the mode-sensitive reads below.
  const f = c.leFeatures || new Uint8Array(8);
  c.caps = {
    extendedAdvertising: bitSet(f, LE_FEAT.EXTENDED_ADVERTISING),
    periodicAdvertising: bitSet(f, LE_FEAT.PERIODIC_ADVERTISING),
    le2mPhy: bitSet(f, LE_FEAT.PHY_2M),
    leCodedPhy: bitSet(f, LE_FEAT.PHY_CODED),
    leSecureConnections: bitSet(f, LE_FEAT.ENCRYPTION), // refined in M3 via supported-commands
    leDataLengthExtension: bitSet(f, LE_FEAT.DATA_LENGTH_EXTENSION),
    channelSelection2: bitSet(f, LE_FEAT.CHANNEL_SELECTION_2),
  };

  // A raw-HCI Zephyr controller locks to *legacy* or *extended* advertising on first use and disallows
  // the other set (you can't mix them). So bring-up must not issue a mode-locking advertising command on
  // an extended-capable controller, or the user's chosen adv mode could be refused later. LE Read Adv
  // Physical Channel Tx Power is a *legacy* command — only read it on legacy-only controllers. And we
  // skip the *extended* Max-Adv-Data-Length / Num-Adv-Sets reads (they'd lock extended), using defaults;
  // the advertiser validates the real per-PDU limit at enable time.
  if (!c.caps.extendedAdvertising) {
    const tx = await tryCmd(hci, store, cmd.leReadAdvPhysicalChannelTxPower(), 'LE Read Adv Tx Power', true);
    if (tx?.decoded) c.txPower = tx.decoded.txPower;
  }
  c.maxAdvDataLen = c.caps.extendedAdvertising ? 255 : 31;
  c.numAdvSets = 1;

  c.ready = true;
  // Bring-up succeeded — drop any stale connect-time error (e.g. "No response to HCI Reset" or a
  // transient "device has been lost" raised during the flash reset) so the header shows a clean state.
  store.state.serial.error = null;
  store.touch();
  return c;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
