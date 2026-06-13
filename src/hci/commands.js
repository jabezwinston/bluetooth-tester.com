// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI command builders. Each returns { opcode, name, params } where params is the
// parameter byte block (the HCI engine prepends opcode + length). Core v6.0 Vol 4 Part E §7.

import { ByteWriter } from '../util/bytes.js';
import { OPCODE, opcodeName } from './opcodes.js';

function cmd(opcode, params = new Uint8Array(0)) {
  return { opcode, name: opcodeName(opcode), params };
}

// ---- Controller & Baseband / Informational ----
export const reset = () => cmd(OPCODE.RESET);
export const setEventMask = (mask8) => cmd(OPCODE.SET_EVENT_MASK, mask8);
export const readLocalVersion = () => cmd(OPCODE.READ_LOCAL_VERSION);
export const readLocalSupportedCommands = () => cmd(OPCODE.READ_LOCAL_SUPPORTED_COMMANDS);
export const readLocalSupportedFeatures = () => cmd(OPCODE.READ_LOCAL_SUPPORTED_FEATURES);
export const readBufferSize = () => cmd(OPCODE.READ_BUFFER_SIZE);
export const readBdAddr = () => cmd(OPCODE.READ_BD_ADDR);

// ---- LE informational ----
export const leSetEventMask = (mask8) => cmd(OPCODE.LE_SET_EVENT_MASK, mask8);
export const leReadBufferSize = () => cmd(OPCODE.LE_READ_BUFFER_SIZE);
export const leReadBufferSizeV2 = () => cmd(OPCODE.LE_READ_BUFFER_SIZE_V2);
export const leReadLocalSupportedFeatures = () => cmd(OPCODE.LE_READ_LOCAL_SUPPORTED_FEATURES);
export const leReadSupportedStates = () => cmd(OPCODE.LE_READ_SUPPORTED_STATES);
export const leReadMaxAdvDataLength = () => cmd(OPCODE.LE_READ_MAX_ADV_DATA_LENGTH);
export const leReadNumberOfSupportedAdvSets = () => cmd(OPCODE.LE_READ_NUMBER_OF_SUPPORTED_ADV_SETS);
export const leReadAdvPhysicalChannelTxPower = () => cmd(OPCODE.LE_READ_ADV_PHYSICAL_CHANNEL_TX_POWER);

// ---- LE legacy advertising ----
export const leSetRandomAddress = (addr6) => cmd(OPCODE.LE_SET_RANDOM_ADDRESS, addr6);

export function leSetAdvParameters({
  intervalMin = 0x00a0,
  intervalMax = 0x00f0,
  advType = 0x00,
  ownAddressType = 0x00,
  peerAddressType = 0x00,
  peerAddress = new Uint8Array(6),
  channelMap = 0x07,
  filterPolicy = 0x00,
} = {}) {
  const w = new ByteWriter()
    .u16(intervalMin)
    .u16(intervalMax)
    .u8(advType)
    .u8(ownAddressType)
    .u8(peerAddressType)
    .bytes(peerAddress)
    .u8(channelMap)
    .u8(filterPolicy);
  return cmd(OPCODE.LE_SET_ADV_PARAMETERS, w.build());
}

/** Advertising_Data_Length (1) + Advertising_Data (fixed 31 octets, zero-padded). */
export function leSetAdvData(data) {
  const buf = new Uint8Array(32);
  buf[0] = Math.min(data.length, 31);
  buf.set(data.subarray(0, 31), 1);
  return cmd(OPCODE.LE_SET_ADV_DATA, buf);
}

export function leSetScanResponseData(data) {
  const buf = new Uint8Array(32);
  buf[0] = Math.min(data.length, 31);
  buf.set(data.subarray(0, 31), 1);
  return cmd(OPCODE.LE_SET_SCAN_RESPONSE_DATA, buf);
}

export const leSetAdvEnable = (enable) => cmd(OPCODE.LE_SET_ADV_ENABLE, new Uint8Array([enable ? 1 : 0]));

// ---- LE extended advertising (gated on controller support) ----
export const leSetAdvSetRandomAddress = (handle, addr6) =>
  cmd(OPCODE.LE_SET_ADV_SET_RANDOM_ADDRESS, new ByteWriter().u8(handle).bytes(addr6).build());

export function leSetExtAdvParameters({
  handle = 0,
  eventProps = 0x0013, // connectable + scannable + legacy PDUs (ADV_IND)
  primaryIntervalMin = 0x0000a0,
  primaryIntervalMax = 0x0000f0,
  primaryChannelMap = 0x07,
  ownAddressType = 0x00,
  peerAddressType = 0x00,
  peerAddress = new Uint8Array(6),
  filterPolicy = 0x00,
  txPower = 0x7f, // 0x7F = host has no preference
  primaryPhy = 0x01, // LE 1M
  secondaryMaxSkip = 0x00,
  secondaryPhy = 0x01,
  advSid = 0x00,
  scanReqNotify = 0x00,
} = {}) {
  const w = new ByteWriter()
    .u8(handle)
    .u16(eventProps)
    .u24(primaryIntervalMin)
    .u24(primaryIntervalMax)
    .u8(primaryChannelMap)
    .u8(ownAddressType)
    .u8(peerAddressType)
    .bytes(peerAddress)
    .u8(filterPolicy)
    .i8(txPower)
    .u8(primaryPhy)
    .u8(secondaryMaxSkip)
    .u8(secondaryPhy)
    .u8(advSid)
    .u8(scanReqNotify);
  return cmd(OPCODE.LE_SET_EXT_ADV_PARAMETERS, w.build());
}

export function leSetExtAdvData({ handle = 0, operation = 0x03, fragmentPref = 0x01, data = new Uint8Array(0) }) {
  const w = new ByteWriter().u8(handle).u8(operation).u8(fragmentPref).u8(data.length).bytes(data);
  return cmd(OPCODE.LE_SET_EXT_ADV_DATA, w.build());
}

export function leSetExtScanResponseData({ handle = 0, operation = 0x03, fragmentPref = 0x01, data = new Uint8Array(0) }) {
  const w = new ByteWriter().u8(handle).u8(operation).u8(fragmentPref).u8(data.length).bytes(data);
  return cmd(OPCODE.LE_SET_EXT_SCAN_RESPONSE_DATA, w.build());
}

export function leSetExtAdvEnable({ enable = true, sets = [{ handle: 0, duration: 0, maxEvents: 0 }] }) {
  const w = new ByteWriter().u8(enable ? 1 : 0).u8(sets.length);
  for (const s of sets) w.u8(s.handle).u16(s.duration || 0).u8(s.maxEvents || 0);
  return cmd(OPCODE.LE_SET_EXT_ADV_ENABLE, w.build());
}

export const leClearAdvSets = () => cmd(OPCODE.LE_CLEAR_ADV_SETS);
export const leRemoveAdvSet = (handle) => cmd(OPCODE.LE_REMOVE_ADV_SET, new Uint8Array([handle]));

// ---- Misc utility ----
export const leRand = () => cmd(OPCODE.LE_RAND);

// ---- Direct Test Mode (RF test) ----
// PHY: 0x01 LE 1M · 0x02 LE 2M · 0x03 LE Coded S=8 · 0x04 LE Coded S=2 (receiver uses 0x03 for Coded).
export const leTransmitterTest = (channel, dataLength, payload) =>
  cmd(OPCODE.LE_TRANSMITTER_TEST, new ByteWriter().u8(channel).u8(dataLength).u8(payload).build());
export const leReceiverTest = (channel) => cmd(OPCODE.LE_RECEIVER_TEST, new Uint8Array([channel & 0xff]));
export const leTestEnd = () => cmd(OPCODE.LE_TEST_END);

// v2 adds PHY; the receiver also takes a Modulation_Index (0x00 standard · 0x01 stable).
export const leTransmitterTestV2 = (channel, dataLength, payload, phy) =>
  cmd(OPCODE.LE_TRANSMITTER_TEST_V2, new ByteWriter().u8(channel).u8(dataLength).u8(payload).u8(phy).build());
export const leReceiverTestV2 = (channel, phy, modulationIndex) =>
  cmd(OPCODE.LE_RECEIVER_TEST_V2, new ByteWriter().u8(channel).u8(phy).u8(modulationIndex).build());
// v4 adds a Transmit_Power_Level (signed dBm, or 0x7E min / 0x7F max). CTE is disabled here
// (CTE_Length 0); Switching_Pattern_Length is still sent in-range (0x02) with two dummy antenna IDs.
export const leTransmitterTestV4 = (channel, dataLength, payload, phy, txPower) =>
  cmd(OPCODE.LE_TRANSMITTER_TEST_V4, new ByteWriter()
    .u8(channel).u8(dataLength).u8(payload).u8(phy)
    .u8(0x00).u8(0x00).u8(0x02).bytes(new Uint8Array([0x00, 0x00]))
    .i8(txPower).build());

// ltk16 must be in the byte order the controller expects (little-endian: same order as the
// SMP Encryption Information PDU; i.e. reverse of the big-endian crypto LTK).
export const leLongTermKeyRequestReply = (handle, ltk16) =>
  cmd(OPCODE.LE_LTK_REQUEST_REPLY, new ByteWriter().u16(handle).bytes(ltk16).build());
export const leLongTermKeyRequestNegReply = (handle) =>
  cmd(OPCODE.LE_LTK_REQUEST_NEG_REPLY, new ByteWriter().u16(handle).build());

export function leRemoteConnParamReqReply({ handle, intervalMin, intervalMax, latency, timeout, minCeLen = 0, maxCeLen = 0 }) {
  const w = new ByteWriter().u16(handle).u16(intervalMin).u16(intervalMax).u16(latency).u16(timeout).u16(minCeLen).u16(maxCeLen);
  return cmd(OPCODE.LE_REMOTE_CONN_PARAM_REQ_REPLY, w.build());
}

export const leRemoteConnParamReqNegReply = (handle, reason = 0x3b) =>
  cmd(OPCODE.LE_REMOTE_CONN_PARAM_REQ_NEG_REPLY, new ByteWriter().u16(handle).u8(reason).build());

export const disconnect = (handle, reason = 0x13) =>
  cmd(OPCODE.DISCONNECT, new ByteWriter().u16(handle).u8(reason).build());

// Read the remote device's LMP/LL version, manufacturer and subversion (result arrives later as the
// Read Remote Version Information Complete event, 0x0C).
export const readRemoteVersion = (handle) =>
  cmd(OPCODE.READ_REMOTE_VERSION, new ByteWriter().u16(handle).build());

/** Build a command from a raw opcode + parameter bytes (for the HCI console). */
export const raw = (opcode, params = new Uint8Array(0)) => cmd(opcode, params);
