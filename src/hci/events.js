// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI event parsing + Command Complete return-parameter decoders. Core v6.0 Vol 4 Part E §7.7.

import { ByteReader, addrToString } from '../util/bytes.js';
import { EVENT, LE_META } from './codes.js';
import { OPCODE } from './opcodes.js';

/**
 * Parse a top-level event packet (without H4 type byte): [code][plen][params...].
 * Returns { code, params, ...decoded } where decoded fields depend on the event.
 */
export function parseEvent(packet) {
  const r = new ByteReader(packet);
  const code = r.u8();
  const plen = r.u8();
  const params = r.read(plen);
  const base = { code, params };

  switch (code) {
    case EVENT.COMMAND_COMPLETE: {
      const rr = new ByteReader(params);
      const numHciCommandPackets = rr.u8();
      const opcode = rr.u16();
      const returnParams = rr.rest();
      const status = returnParams.length ? returnParams[0] : undefined;
      return { ...base, type: 'command_complete', numHciCommandPackets, opcode, status, returnParams };
    }
    case EVENT.COMMAND_STATUS: {
      const rr = new ByteReader(params);
      const status = rr.u8();
      const numHciCommandPackets = rr.u8();
      const opcode = rr.u16();
      return { ...base, type: 'command_status', status, numHciCommandPackets, opcode };
    }
    case EVENT.DISCONNECTION_COMPLETE: {
      const rr = new ByteReader(params);
      return {
        ...base,
        type: 'disconnection_complete',
        status: rr.u8(),
        handle: rr.u16(),
        reason: rr.u8(),
      };
    }
    case EVENT.NUMBER_OF_COMPLETED_PACKETS: {
      const rr = new ByteReader(params);
      const n = rr.u8();
      const handles = [];
      for (let i = 0; i < n; i++) handles.push({ handle: rr.u16(), count: rr.u16() });
      return { ...base, type: 'number_of_completed_packets', handles };
    }
    case EVENT.HARDWARE_ERROR:
      return { ...base, type: 'hardware_error', hardwareCode: params[0] };
    case EVENT.ENCRYPTION_CHANGE: {
      const rr = new ByteReader(params);
      return { ...base, type: 'encryption_change', status: rr.u8(), handle: rr.u16(), enabled: rr.u8() };
    }
    case EVENT.READ_REMOTE_VERSION_COMPLETE: {
      const rr = new ByteReader(params);
      return {
        ...base,
        type: 'read_remote_version_complete',
        status: rr.u8(),
        handle: rr.u16(),
        version: rr.u8(),      // remote LMP/LL Core version (VersNr)
        manufacturer: rr.u16(),
        subversion: rr.u16(),
      };
    }
    case EVENT.LE_META:
      return { ...base, type: 'le_meta', ...parseLeMeta(params) };
    default:
      return { ...base, type: 'event' };
  }
}

function parseLeMeta(params) {
  const r = new ByteReader(params);
  const subevent = r.u8();
  switch (subevent) {
    case LE_META.CONNECTION_COMPLETE:
    case LE_META.ENHANCED_CONNECTION_COMPLETE: {
      const status = r.u8();
      const handle = r.u16();
      const role = r.u8();
      const peerAddrType = r.u8();
      const peerAddr = addrToString(r.read(6));
      if (subevent === LE_META.ENHANCED_CONNECTION_COMPLETE) {
        r.read(6); // local RPA
        r.read(6); // peer RPA
      }
      const interval = r.u16();
      const latency = r.u16();
      const timeout = r.u16();
      const accuracy = r.u8();
      return {
        subevent,
        subName: 'connection_complete',
        status, handle, role, peerAddrType, peerAddr,
        interval, latency, timeout, accuracy,
      };
    }
    case LE_META.ADV_SET_TERMINATED: {
      return {
        subevent,
        subName: 'adv_set_terminated',
        status: r.u8(),
        advHandle: r.u8(),
        connHandle: r.u16(),
        numCompletedExtAdvEvents: r.u8(),
      };
    }
    case LE_META.SCAN_REQUEST_RECEIVED: {
      return { subevent, subName: 'scan_request_received', advHandle: r.u8(), scannerAddrType: r.u8(), scannerAddr: addrToString(r.read(6)) };
    }
    case LE_META.LONG_TERM_KEY_REQUEST: {
      return { subevent, subName: 'long_term_key_request', handle: r.u16(), rand: r.read(8), ediv: r.u16() };
    }
    case LE_META.REMOTE_CONN_PARAM_REQUEST: {
      return { subevent, subName: 'remote_conn_param_request', handle: r.u16(), intervalMin: r.u16(), intervalMax: r.u16(), latency: r.u16(), timeout: r.u16() };
    }
    case LE_META.CONNECTION_UPDATE_COMPLETE: {
      return { subevent, subName: 'connection_update_complete', status: r.u8(), handle: r.u16(), interval: r.u16(), latency: r.u16(), timeout: r.u16() };
    }
    case LE_META.DATA_LENGTH_CHANGE: {
      return { subevent, subName: 'data_length_change', handle: r.u16(), maxTxOctets: r.u16(), maxTxTime: r.u16(), maxRxOctets: r.u16(), maxRxTime: r.u16() };
    }
    case LE_META.PHY_UPDATE_COMPLETE: {
      return { subevent, subName: 'phy_update_complete', status: r.u8(), handle: r.u16(), txPhy: r.u8(), rxPhy: r.u8() };
    }
    default:
      return { subevent, subName: null, data: r.rest() };
  }
}

// ---- Command Complete return-parameter decoders, keyed by opcode ----
// Each returns a plain object of decoded fields (status included).

export const RETURN_DECODERS = {
  [OPCODE.READ_LOCAL_VERSION]: (r) => ({
    status: r.u8(),
    hciVersion: r.u8(),
    hciSubversion: r.u16(),
    lmpVersion: r.u8(),
    manufacturer: r.u16(),
    lmpSubversion: r.u16(),
  }),
  [OPCODE.READ_LOCAL_SUPPORTED_COMMANDS]: (r) => ({ status: r.u8(), supportedCommands: r.read(64) }),
  [OPCODE.READ_LOCAL_SUPPORTED_FEATURES]: (r) => ({ status: r.u8(), features: r.read(8) }),
  [OPCODE.READ_BUFFER_SIZE]: (r) => ({
    status: r.u8(),
    aclLen: r.u16(),
    scoLen: r.u8(),
    numAcl: r.u16(),
    numSco: r.u16(),
  }),
  [OPCODE.READ_BD_ADDR]: (r) => ({ status: r.u8(), bdAddr: addrToString(r.read(6)) }),
  [OPCODE.LE_READ_BUFFER_SIZE]: (r) => ({ status: r.u8(), aclLen: r.u16(), numAcl: r.u8() }),
  [OPCODE.LE_READ_BUFFER_SIZE_V2]: (r) => ({
    status: r.u8(),
    aclLen: r.u16(),
    numAcl: r.u8(),
    isoLen: r.u16(),
    numIso: r.u8(),
  }),
  [OPCODE.LE_READ_LOCAL_SUPPORTED_FEATURES]: (r) => ({ status: r.u8(), features: r.read(8) }),
  [OPCODE.LE_READ_SUPPORTED_STATES]: (r) => ({ status: r.u8(), states: r.read(8) }),
  [OPCODE.LE_READ_MAX_ADV_DATA_LENGTH]: (r) => ({ status: r.u8(), maxAdvDataLen: r.u16() }),
  [OPCODE.LE_READ_NUMBER_OF_SUPPORTED_ADV_SETS]: (r) => ({ status: r.u8(), numSets: r.u8() }),
  [OPCODE.LE_READ_ADV_PHYSICAL_CHANNEL_TX_POWER]: (r) => ({ status: r.u8(), txPower: r.i8() }),
  [OPCODE.LE_RAND]: (r) => ({ status: r.u8(), random: r.read(8) }),
  [OPCODE.LE_TEST_END]: (r) => ({ status: r.u8(), numPackets: r.u16() }),
  [OPCODE.LE_RECEIVER_TEST_V2]: (r) => ({ status: r.u8() }),
  [OPCODE.LE_TRANSMITTER_TEST_V2]: (r) => ({ status: r.u8() }),
  // Some controllers (e.g. Zephyr) return only the status for v4 — read the actual TX power only if present.
  [OPCODE.LE_TRANSMITTER_TEST_V4]: (r) => { const status = r.u8(); return { status, txPower: r.remaining >= 1 ? r.i8() : null }; },
};

/** Decode known Command Complete return params; returns null if no decoder. */
export function decodeReturnParams(opcode, returnParams) {
  const dec = RETURN_DECODERS[opcode];
  if (!dec) return null;
  try {
    return dec(new ByteReader(returnParams));
  } catch {
    return null;
  }
}
