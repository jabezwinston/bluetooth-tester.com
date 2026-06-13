// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Attribute Protocol (ATT) constants and small PDU builders. Core v6.0 Vol 3 Part F.
// The request-handling logic lives in gatt-server.js (it needs the DB + per-connection
// state); this module is the shared vocabulary + a few encoders.

import { ByteWriter } from '../util/bytes.js';

export const ATT_CID = 0x0004;
export const DEFAULT_MTU = 23;

export const ATT_OP = {
  ERROR_RSP: 0x01,
  EXCHANGE_MTU_REQ: 0x02,
  EXCHANGE_MTU_RSP: 0x03,
  FIND_INFORMATION_REQ: 0x04,
  FIND_INFORMATION_RSP: 0x05,
  FIND_BY_TYPE_VALUE_REQ: 0x06,
  FIND_BY_TYPE_VALUE_RSP: 0x07,
  READ_BY_TYPE_REQ: 0x08,
  READ_BY_TYPE_RSP: 0x09,
  READ_REQ: 0x0a,
  READ_RSP: 0x0b,
  READ_BLOB_REQ: 0x0c,
  READ_BLOB_RSP: 0x0d,
  READ_MULTIPLE_REQ: 0x0e,
  READ_MULTIPLE_RSP: 0x0f,
  READ_BY_GROUP_TYPE_REQ: 0x10,
  READ_BY_GROUP_TYPE_RSP: 0x11,
  WRITE_REQ: 0x12,
  WRITE_RSP: 0x13,
  WRITE_CMD: 0x52,
  SIGNED_WRITE_CMD: 0xd2,
  PREPARE_WRITE_REQ: 0x16,
  PREPARE_WRITE_RSP: 0x17,
  EXECUTE_WRITE_REQ: 0x18,
  EXECUTE_WRITE_RSP: 0x19,
  HANDLE_VALUE_NTF: 0x1b,
  HANDLE_VALUE_IND: 0x1d,
  HANDLE_VALUE_CFM: 0x1e,
};

export const ATT_ERR = {
  INVALID_HANDLE: 0x01,
  READ_NOT_PERMITTED: 0x02,
  WRITE_NOT_PERMITTED: 0x03,
  INVALID_PDU: 0x04,
  INSUFFICIENT_AUTHENTICATION: 0x05,
  REQUEST_NOT_SUPPORTED: 0x06,
  INVALID_OFFSET: 0x07,
  INSUFFICIENT_AUTHORIZATION: 0x08,
  PREPARE_QUEUE_FULL: 0x09,
  ATTRIBUTE_NOT_FOUND: 0x0a,
  ATTRIBUTE_NOT_LONG: 0x0b,
  INSUFFICIENT_ENCRYPTION_KEY_SIZE: 0x0c,
  INVALID_ATTRIBUTE_VALUE_LENGTH: 0x0d,
  UNLIKELY_ERROR: 0x0e,
  INSUFFICIENT_ENCRYPTION: 0x0f,
  UNSUPPORTED_GROUP_TYPE: 0x10,
  INSUFFICIENT_RESOURCES: 0x11,
  DATABASE_OUT_OF_SYNC: 0x12,
  VALUE_NOT_ALLOWED: 0x13,
};

export const ATT_ERR_NAMES = Object.fromEntries(Object.entries(ATT_ERR).map(([k, v]) => [v, pretty(k)]));
export const ATT_OP_NAMES = Object.fromEntries(Object.entries(ATT_OP).map(([k, v]) => [v, pretty(k)]));

function pretty(k) {
  return k.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function errorRsp(requestOpcode, handle, errorCode) {
  return new ByteWriter().u8(ATT_OP.ERROR_RSP).u8(requestOpcode).u16(handle || 0).u8(errorCode).build();
}

/**
 * Split a characteristic value into the slices a single ATT notification / write-command can carry:
 * each at most ATT_MTU-3 bytes (1 opcode + 2 handle of overhead). Always returns at least one slice
 * (an empty value → one empty slice) so a zero-length notification still goes out. A value longer
 * than the MTU must be sent as several PDUs — one oversized PDU is illegal and the peer drops it.
 */
export function attChunks(value, mtu) {
  const max = Math.max(1, (mtu || DEFAULT_MTU) - 3);
  if (value.length <= max) return [value];
  const out = [];
  for (let off = 0; off < value.length; off += max) out.push(value.subarray(off, off + max));
  return out;
}

export function handleValueNotification(handle, value) {
  return new ByteWriter().u8(ATT_OP.HANDLE_VALUE_NTF).u16(handle).bytes(value).build();
}

export function handleValueIndication(handle, value) {
  return new ByteWriter().u8(ATT_OP.HANDLE_VALUE_IND).u16(handle).bytes(value).build();
}
