// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI status/error codes, event codes, and LE Meta sub-event codes. Core v6.0 Vol 4 Part E.

export const HCI_ERROR = {
  0x00: 'Success',
  0x01: 'Unknown HCI Command',
  0x02: 'Unknown Connection Identifier',
  0x03: 'Hardware Failure',
  0x04: 'Page Timeout',
  0x05: 'Authentication Failure',
  0x06: 'PIN or Key Missing',
  0x07: 'Memory Capacity Exceeded',
  0x08: 'Connection Timeout',
  0x09: 'Connection Limit Exceeded',
  0x0a: 'Synchronous Connection Limit Exceeded',
  0x0b: 'Connection Already Exists',
  0x0c: 'Command Disallowed',
  0x0d: 'Connection Rejected: Limited Resources',
  0x0e: 'Connection Rejected: Security Reasons',
  0x0f: 'Connection Rejected: Unacceptable BD_ADDR',
  0x10: 'Connection Accept Timeout Exceeded',
  0x11: 'Unsupported Feature or Parameter Value',
  0x12: 'Invalid HCI Command Parameters',
  0x13: 'Remote User Terminated Connection',
  0x14: 'Remote Terminated: Low Resources',
  0x15: 'Remote Terminated: Power Off',
  0x16: 'Connection Terminated By Local Host',
  0x17: 'Repeated Attempts',
  0x18: 'Pairing Not Allowed',
  0x19: 'Unknown LMP PDU',
  0x1a: 'Unsupported Remote/LMP Feature',
  0x1b: 'SCO Offset Rejected',
  0x1c: 'SCO Interval Rejected',
  0x1d: 'SCO Air Mode Rejected',
  0x1e: 'Invalid LMP/LL Parameters',
  0x1f: 'Unspecified Error',
  0x20: 'Unsupported LMP/LL Parameter Value',
  0x21: 'Role Change Not Allowed',
  0x22: 'LMP/LL Response Timeout',
  0x23: 'LMP Error Transaction Collision / LL Procedure Collision',
  0x24: 'LMP PDU Not Allowed',
  0x25: 'Encryption Mode Not Acceptable',
  0x26: 'Link Key cannot be Changed',
  0x27: 'Requested QoS Not Supported',
  0x28: 'Instant Passed',
  0x29: 'Pairing With Unit Key Not Supported',
  0x2a: 'Different Transaction Collision',
  0x2c: 'QoS Unacceptable Parameter',
  0x2d: 'QoS Rejected',
  0x2e: 'Channel Classification Not Supported',
  0x2f: 'Insufficient Security',
  0x30: 'Parameter Out Of Mandatory Range',
  0x32: 'Role Switch Pending',
  0x34: 'Reserved Slot Violation',
  0x35: 'Role Switch Failed',
  0x36: 'Extended Inquiry Response Too Large',
  0x37: 'Secure Simple Pairing Not Supported By Host',
  0x38: 'Host Busy - Pairing',
  0x39: 'Connection Rejected: No Suitable Channel',
  0x3a: 'Controller Busy',
  0x3b: 'Unacceptable Connection Parameters',
  0x3c: 'Advertising Timeout',
  0x3d: 'Connection Terminated: MIC Failure',
  0x3e: 'Connection Failed to be Established / Sync Timeout',
  0x3f: 'MAC Connection Failed',
  0x40: 'Coarse Clock Adjustment Rejected',
  0x41: 'Type0 Submap Not Defined',
  0x42: 'Unknown Advertising Identifier',
  0x43: 'Limit Reached',
  0x44: 'Operation Cancelled by Host',
  0x45: 'Packet Too Long',
};

export function hciError(code) {
  return HCI_ERROR[code] || `Unknown(0x${code.toString(16).padStart(2, '0')})`;
}

export const EVENT = {
  DISCONNECTION_COMPLETE: 0x05,
  ENCRYPTION_CHANGE: 0x08,
  READ_REMOTE_VERSION_COMPLETE: 0x0c,
  COMMAND_COMPLETE: 0x0e,
  COMMAND_STATUS: 0x0f,
  HARDWARE_ERROR: 0x10,
  NUMBER_OF_COMPLETED_PACKETS: 0x13,
  DATA_BUFFER_OVERFLOW: 0x1a,
  ENCRYPTION_KEY_REFRESH_COMPLETE: 0x30,
  LE_META: 0x3e,
  AUTH_PAYLOAD_TIMEOUT_EXPIRED: 0x57,
};

export const EVENT_NAMES = {
  0x05: 'Disconnection Complete',
  0x08: 'Encryption Change',
  0x0c: 'Read Remote Version Complete',
  0x0e: 'Command Complete',
  0x0f: 'Command Status',
  0x10: 'Hardware Error',
  0x13: 'Number Of Completed Packets',
  0x1a: 'Data Buffer Overflow',
  0x30: 'Encryption Key Refresh Complete',
  0x3e: 'LE Meta',
  0x57: 'Authenticated Payload Timeout Expired',
};

export function eventName(code) {
  return EVENT_NAMES[code] || `Unknown(0x${code.toString(16).padStart(2, '0')})`;
}

export const LE_META = {
  CONNECTION_COMPLETE: 0x01,
  ADVERTISING_REPORT: 0x02,
  CONNECTION_UPDATE_COMPLETE: 0x03,
  READ_REMOTE_FEATURES_COMPLETE: 0x04,
  LONG_TERM_KEY_REQUEST: 0x05,
  REMOTE_CONN_PARAM_REQUEST: 0x06,
  DATA_LENGTH_CHANGE: 0x07,
  READ_LOCAL_P256_COMPLETE: 0x08,
  GENERATE_DHKEY_COMPLETE: 0x09,
  ENHANCED_CONNECTION_COMPLETE: 0x0a,
  DIRECTED_ADVERTISING_REPORT: 0x0b,
  PHY_UPDATE_COMPLETE: 0x0c,
  EXTENDED_ADVERTISING_REPORT: 0x0d,
  PERIODIC_ADV_SYNC_ESTABLISHED: 0x0e,
  PERIODIC_ADV_REPORT: 0x0f,
  PERIODIC_ADV_SYNC_LOST: 0x10,
  SCAN_TIMEOUT: 0x11,
  ADV_SET_TERMINATED: 0x12,
  SCAN_REQUEST_RECEIVED: 0x13,
  CHANNEL_SELECTION_ALGORITHM: 0x14,
};

export const LE_META_NAMES = {
  0x01: 'LE Connection Complete',
  0x02: 'LE Advertising Report',
  0x03: 'LE Connection Update Complete',
  0x04: 'LE Read Remote Features Complete',
  0x05: 'LE Long Term Key Request',
  0x06: 'LE Remote Connection Parameter Request',
  0x07: 'LE Data Length Change',
  0x08: 'LE Read Local P-256 Public Key Complete',
  0x09: 'LE Generate DHKey Complete',
  0x0a: 'LE Enhanced Connection Complete',
  0x0b: 'LE Directed Advertising Report',
  0x0c: 'LE PHY Update Complete',
  0x0d: 'LE Extended Advertising Report',
  0x0e: 'LE Periodic Advertising Sync Established',
  0x0f: 'LE Periodic Advertising Report',
  0x10: 'LE Periodic Advertising Sync Lost',
  0x11: 'LE Scan Timeout',
  0x12: 'LE Advertising Set Terminated',
  0x13: 'LE Scan Request Received',
  0x14: 'LE Channel Selection Algorithm',
};

export function leMetaName(code) {
  return LE_META_NAMES[code] || `Unknown(0x${code.toString(16).padStart(2, '0')})`;
}
