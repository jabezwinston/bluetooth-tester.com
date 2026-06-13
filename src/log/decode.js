// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// One-line human-readable summaries for logged packets (the live log view's left column).

import { bytesToHex } from '../util/bytes.js';
import { H4_NAMES, H4 } from '../transport/h4.js';
import { opcodeName } from '../hci/opcodes.js';
import { eventName, hciError, leMetaName } from '../hci/codes.js';
import { parseEvent } from '../hci/events.js';
import { decodeAcl } from './acl-decode.js';

export function summarize(entry) {
  const { h4, data } = entry;
  try {
    switch (h4) {
      case H4.COMMAND: {
        const opcode = data[0] | (data[1] << 8);
        return `Command · ${opcodeName(opcode)}`;
      }
      case H4.EVENT: {
        const ev = parseEvent(data);
        if (ev.type === 'command_complete')
          return `Command Complete · ${opcodeName(ev.opcode)}${ev.status != null ? ` → ${hciError(ev.status)}` : ''}`;
        if (ev.type === 'command_status')
          return `Command Status · ${opcodeName(ev.opcode)} → ${hciError(ev.status)}`;
        if (ev.type === 'le_meta')
          return `LE Meta · ${ev.subName ? prettySub(ev.subName) : leMetaName(ev.subevent)}`;
        if (ev.type === 'disconnection_complete')
          return `Disconnection Complete · handle ${ev.handle}, ${hciError(ev.reason)}`;
        if (ev.type === 'number_of_completed_packets') return 'Number Of Completed Packets';
        if (ev.type === 'hardware_error') return `Hardware Error · 0x${(ev.hardwareCode ?? 0).toString(16)}`;
        return `Event · ${eventName(ev.code)}`;
      }
      case H4.ACL:
        return decodeAcl(data).summary;
      case H4.ISO: {
        const handle = (data[0] | (data[1] << 8)) & 0x0fff;
        return `ISO · handle ${handle}`;
      }
      default:
        return H4_NAMES[h4] || `0x${h4.toString(16)}`;
    }
  } catch {
    return H4_NAMES[h4] || 'packet';
  }
}

function prettySub(snake) {
  return snake.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const f = (name, value) => ({ name, value: String(value) });
const hex4 = (n) => (n & 0xffff).toString(16).padStart(4, '0').toUpperCase();

/**
 * Wireshark-style protocol tree for the expanded log row: an array of
 * { name, fields:[{name, value}] } groups. ACL is decoded through L2CAP into ATT/SMP; commands
 * and events get a basic HCI group.
 */
export function details(entry) {
  const { h4, data } = entry;
  try {
    if (h4 === H4.ACL) return decodeAcl(data).groups;
    if (h4 === H4.COMMAND) {
      const opcode = data[0] | (data[1] << 8);
      const plen = data[2];
      return [{ name: 'HCI Command', fields: [
        f('Opcode', `0x${hex4(opcode)} (${opcodeName(opcode)})`),
        f('OGF', `0x${(opcode >> 10).toString(16).padStart(2, '0').toUpperCase()}`),
        f('OCF', `0x${hex4(opcode & 0x3ff)}`),
        f('Parameter Length', plen),
        ...(plen ? [f('Parameters', bytesToHex(data.subarray(3, 3 + plen)))] : []),
      ] }];
    }
    if (h4 === H4.EVENT) {
      const ev = parseEvent(data);
      const fields = [f('Event Code', `0x${(ev.code ?? data[0]).toString(16).padStart(2, '0').toUpperCase()} (${eventName(ev.code ?? data[0])})`)];
      if (ev.subevent != null) fields.push(f('LE Subevent', ev.subName ? prettySub(ev.subName) : leMetaName(ev.subevent)));
      if (ev.opcode != null) fields.push(f('Command Opcode', `0x${hex4(ev.opcode)} (${opcodeName(ev.opcode)})`));
      if (ev.status != null) fields.push(f('Status', `0x${(ev.status).toString(16).padStart(2, '0').toUpperCase()} (${hciError(ev.status)})`));
      if (ev.handle != null) fields.push(f('Connection Handle', `0x${hex4(ev.handle)} (${ev.handle})`));
      if (ev.reason != null) fields.push(f('Reason', `0x${(ev.reason).toString(16).padStart(2, '0').toUpperCase()} (${hciError(ev.reason)})`));
      if (ev.returnParams?.length) fields.push(f('Return Parameters', bytesToHex(ev.returnParams)));
      return [{ name: 'HCI Event', fields }];
    }
  } catch { /* fall through to empty tree; hex is always shown */ }
  return [];
}

/** Full hex of the on-wire H4 packet (type byte + payload). */
export function hexOf(entry) {
  return entry.h4.toString(16).padStart(2, '0') + ' ' + bytesToHex(entry.data);
}
