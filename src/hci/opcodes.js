// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI opcode groups (OGF) and named opcodes (OGF<<10 | OCF). Core v6.0, Vol 4 Part E §7.

export const OGF = {
  LINK_CONTROL: 0x01,
  LINK_POLICY: 0x02,
  CONTROLLER_BASEBAND: 0x03,
  INFORMATIONAL: 0x04,
  STATUS: 0x05,
  TESTING: 0x06,
  LE: 0x08,
  VENDOR: 0x3f,
};

export const op = (ogf, ocf) => ((ogf << 10) | ocf) & 0xffff;
export const ogfOf = (opcode) => (opcode >> 10) & 0x3f;
export const ocfOf = (opcode) => opcode & 0x3ff;

export const OPCODE = {
  // Controller & Baseband
  SET_EVENT_MASK: op(0x03, 0x0001),
  RESET: op(0x03, 0x0003),
  READ_TX_POWER_LEVEL: op(0x03, 0x002d),
  SET_EVENT_MASK_PAGE_2: op(0x03, 0x0063),
  // Informational
  READ_LOCAL_VERSION: op(0x04, 0x0001),
  READ_LOCAL_SUPPORTED_COMMANDS: op(0x04, 0x0002),
  READ_LOCAL_SUPPORTED_FEATURES: op(0x04, 0x0003),
  READ_BUFFER_SIZE: op(0x04, 0x0005),
  READ_BD_ADDR: op(0x04, 0x0009),
  // Link Control
  DISCONNECT: op(0x01, 0x0006),
  READ_REMOTE_VERSION: op(0x01, 0x001d),
  // Status
  READ_RSSI: op(0x05, 0x0005),
  // LE
  LE_SET_EVENT_MASK: op(0x08, 0x0001),
  LE_READ_BUFFER_SIZE: op(0x08, 0x0002),
  LE_READ_BUFFER_SIZE_V2: op(0x08, 0x0060),
  LE_READ_LOCAL_SUPPORTED_FEATURES: op(0x08, 0x0003),
  LE_SET_RANDOM_ADDRESS: op(0x08, 0x0005),
  LE_SET_ADV_PARAMETERS: op(0x08, 0x0006),
  LE_READ_ADV_PHYSICAL_CHANNEL_TX_POWER: op(0x08, 0x0007),
  LE_SET_ADV_DATA: op(0x08, 0x0008),
  LE_SET_SCAN_RESPONSE_DATA: op(0x08, 0x0009),
  LE_SET_ADV_ENABLE: op(0x08, 0x000a),
  LE_SET_SCAN_PARAMETERS: op(0x08, 0x000b),
  LE_SET_SCAN_ENABLE: op(0x08, 0x000c),
  LE_RAND: op(0x08, 0x0018),
  LE_ENCRYPT: op(0x08, 0x0017),
  LE_LTK_REQUEST_REPLY: op(0x08, 0x001a),
  LE_LTK_REQUEST_NEG_REPLY: op(0x08, 0x001b),
  LE_READ_SUPPORTED_STATES: op(0x08, 0x001c),
  LE_RECEIVER_TEST: op(0x08, 0x001d),
  LE_TRANSMITTER_TEST: op(0x08, 0x001e),
  LE_TEST_END: op(0x08, 0x001f),
  LE_RECEIVER_TEST_V2: op(0x08, 0x0033),
  LE_TRANSMITTER_TEST_V2: op(0x08, 0x0034),
  LE_TRANSMITTER_TEST_V4: op(0x08, 0x007b),
  LE_SET_DATA_LENGTH: op(0x08, 0x0022),
  LE_READ_MAX_DATA_LENGTH: op(0x08, 0x002f),
  LE_READ_PHY: op(0x08, 0x0030),
  LE_SET_DEFAULT_PHY: op(0x08, 0x0031),
  LE_REMOTE_CONN_PARAM_REQ_REPLY: op(0x08, 0x0020),
  LE_REMOTE_CONN_PARAM_REQ_NEG_REPLY: op(0x08, 0x0021),
  LE_READ_LOCAL_P256_PUBLIC_KEY: op(0x08, 0x0025),
  // LE extended advertising
  LE_SET_ADV_SET_RANDOM_ADDRESS: op(0x08, 0x0035),
  LE_SET_EXT_ADV_PARAMETERS: op(0x08, 0x0036),
  LE_SET_EXT_ADV_DATA: op(0x08, 0x0037),
  LE_SET_EXT_SCAN_RESPONSE_DATA: op(0x08, 0x0038),
  LE_SET_EXT_ADV_ENABLE: op(0x08, 0x0039),
  LE_READ_MAX_ADV_DATA_LENGTH: op(0x08, 0x003a),
  LE_READ_NUMBER_OF_SUPPORTED_ADV_SETS: op(0x08, 0x003b),
  LE_REMOVE_ADV_SET: op(0x08, 0x003c),
  LE_CLEAR_ADV_SETS: op(0x08, 0x003d),
};

// Reverse map for decoding/logging.
export const OPCODE_NAMES = Object.fromEntries(
  Object.entries(OPCODE).map(([name, code]) => [code, name]),
);

export function opcodeName(opcode) {
  if (opcode === 0x0000) return 'NOP';
  return OPCODE_NAMES[opcode] || `Unknown(0x${opcode.toString(16).padStart(4, '0')})`;
}
