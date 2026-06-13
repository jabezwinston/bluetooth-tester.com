// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Subset of Bluetooth SIG Assigned Numbers + GAP data-type definitions.
// AD types and Appearance/Company values are from the Core Specification Supplement /
// Assigned Numbers (a separate document from the Core spec). Extend as needed.
//
// Attribution: the values and names below are Bluetooth® SIG Assigned Numbers / Core Specification
// Supplement data (© Bluetooth SIG, Inc.), reproduced here for interoperability. This factual data is
// not covered by the copyright notice above. "Bluetooth" is a trademark of Bluetooth SIG, Inc.

// ---- GAP / EIR / AD data types (CSS Part A, §1) ----
export const AD_TYPE = {
  FLAGS: 0x01,
  INCOMPLETE_UUID16: 0x02,
  COMPLETE_UUID16: 0x03,
  INCOMPLETE_UUID32: 0x04,
  COMPLETE_UUID32: 0x05,
  INCOMPLETE_UUID128: 0x06,
  COMPLETE_UUID128: 0x07,
  SHORT_NAME: 0x08,
  COMPLETE_NAME: 0x09,
  TX_POWER: 0x0a,
  CLASS_OF_DEVICE: 0x0d,
  PERIPHERAL_CONN_INTERVAL: 0x12,
  SOLICIT_UUID16: 0x14,
  SOLICIT_UUID128: 0x15,
  SERVICE_DATA_UUID16: 0x16,
  PUBLIC_TARGET_ADDR: 0x17,
  RANDOM_TARGET_ADDR: 0x18,
  APPEARANCE: 0x19,
  ADV_INTERVAL: 0x1a,
  LE_DEVICE_ADDR: 0x1b,
  LE_ROLE: 0x1c,
  SOLICIT_UUID32: 0x1f,
  SERVICE_DATA_UUID32: 0x20,
  SERVICE_DATA_UUID128: 0x21,
  URI: 0x24,
  LE_SUPPORTED_FEATURES: 0x27,
  BIG_INFO: 0x2c,
  BROADCAST_CODE: 0x2d,
  RSI: 0x2e, // Resolvable Set Identifier
  BROADCAST_NAME: 0x30,
  MANUFACTURER_DATA: 0xff,
};

export const AD_TYPE_NAMES = {
  0x01: 'Flags',
  0x02: 'Incomplete 16-bit Service UUIDs',
  0x03: 'Complete 16-bit Service UUIDs',
  0x04: 'Incomplete 32-bit Service UUIDs',
  0x05: 'Complete 32-bit Service UUIDs',
  0x06: 'Incomplete 128-bit Service UUIDs',
  0x07: 'Complete 128-bit Service UUIDs',
  0x08: 'Shortened Local Name',
  0x09: 'Complete Local Name',
  0x0a: 'Tx Power Level',
  0x0d: 'Class of Device',
  0x12: 'Peripheral Connection Interval Range',
  0x14: '16-bit Service Solicitation UUIDs',
  0x15: '128-bit Service Solicitation UUIDs',
  0x16: 'Service Data - 16-bit UUID',
  0x17: 'Public Target Address',
  0x18: 'Random Target Address',
  0x19: 'Appearance',
  0x1a: 'Advertising Interval',
  0x1b: 'LE Bluetooth Device Address',
  0x1c: 'LE Role',
  0x1f: '32-bit Service Solicitation UUIDs',
  0x20: 'Service Data - 32-bit UUID',
  0x21: 'Service Data - 128-bit UUID',
  0x24: 'URI',
  0x27: 'LE Supported Features',
  0x2c: 'BIGInfo',
  0x2d: 'Broadcast Code',
  0x2e: 'Resolvable Set Identifier',
  0x30: 'Broadcast Name',
  0xff: 'Manufacturer Specific Data',
};

// ---- AD Flags bits ----
export const FLAG = {
  LE_LIMITED_DISC: 0x01,
  LE_GENERAL_DISC: 0x02,
  BR_EDR_NOT_SUPPORTED: 0x04,
  SIMUL_LE_BR_EDR_CONTROLLER: 0x08,
  SIMUL_LE_BR_EDR_HOST: 0x10,
};

export const FLAG_BITS = [
  [0x01, 'LE Limited Discoverable'],
  [0x02, 'LE General Discoverable'],
  [0x04, 'BR/EDR Not Supported'],
  [0x08, 'Simultaneous LE + BR/EDR (Controller)'],
  [0x10, 'Simultaneous LE + BR/EDR (Host)'],
];

// ---- Legacy advertising types → HCI Advertising_Type (LE Set Advertising Parameters) ----
export const ADV_TYPE = {
  ADV_IND: 0x00, // connectable scannable undirected
  ADV_DIRECT_IND_HIGH: 0x01, // connectable high-duty directed
  ADV_SCAN_IND: 0x02, // scannable undirected
  ADV_NONCONN_IND: 0x03, // non-connectable undirected
  ADV_DIRECT_IND_LOW: 0x04, // connectable low-duty directed
};

export const ADV_TYPE_LABELS = {
  ADV_IND: 'ADV_IND — connectable, scannable',
  ADV_DIRECT_IND_HIGH: 'ADV_DIRECT_IND — directed, high duty',
  ADV_SCAN_IND: 'ADV_SCAN_IND — scannable only',
  ADV_NONCONN_IND: 'ADV_NONCONN_IND — non-connectable (beacon)',
  ADV_DIRECT_IND_LOW: 'ADV_DIRECT_IND — directed, low duty',
};

// ---- Appearance — the full SIG list (§2.6) lives in ./appearance.js (generated from Zephyr's
// assigned_numbers.h). Re-exported here so existing import sites stay stable. ----
export { APPEARANCE, APPEARANCE_BY_VALUE, appearanceName } from './appearance.js';

// ---- Company identifiers (subset; full list in Assigned Numbers) ----
// Bluetooth SIG Company Identifiers — a curated subset of the ~3300-entry list. Names/IDs verified
// against the official SIG source (assigned_numbers/company_identifiers/company_identifiers.yaml,
// bitbucket.org/bluetooth-SIG/public). Covers the silicon vendors and consumer brands most likely to
// show up in manufacturer data while testing.
export const COMPANY = {
  0x0000: 'Ericsson AB',
  0x0001: 'Nokia Mobile Phones',
  0x0002: 'Intel Corp.',
  0x0003: 'IBM Corp.',
  0x0004: 'Toshiba Corp.',
  0x0005: '3Com',
  0x0006: 'Microsoft',
  0x0007: 'Lucent',
  0x0008: 'Motorola',
  0x0009: 'Infineon Technologies AG',
  0x000a: 'Qualcomm Technologies International, Ltd. (QTIL)',
  0x000d: 'Texas Instruments Inc.',
  0x000f: 'Broadcom Corporation',
  0x0013: 'Atmel Corporation',
  0x001d: 'Qualcomm',
  0x0025: 'NXP B.V.',
  0x0030: 'ST Microelectronics',
  0x0036: 'Renesas Electronics Corporation',
  0x004c: 'Apple, Inc.',
  0x0059: 'Nordic Semiconductor ASA',
  0x005d: 'Realtek Semiconductor Corporation',
  0x0060: 'RivieraWaves S.A.S',
  0x0067: 'GN Audio A/S (Jabra)',
  0x006b: 'Polar Electro OY',
  0x0075: 'Samsung Electronics Co. Ltd.',
  0x0078: 'Nike, Inc.',
  0x0087: 'Garmin International, Inc.',
  0x009e: 'Bose Corporation',
  0x00c4: 'LG Electronics',
  0x00cd: 'Microchip Technology Inc.',
  0x00d2: 'Dialog Semiconductor B.V.',
  0x00d7: 'Qualcomm Technologies, Inc.',
  0x00e0: 'Google',
  0x012d: 'Sony Corporation',
  0x0131: 'Cypress Semiconductor',
  0x013c: 'Murata Manufacturing Co., Ltd.',
  0x0157: 'Anhui Huami Information Technology Co., Ltd.',
  0x0171: 'Amazon.com Services LLC',
  0x018e: 'Fitbit, Inc.',
  0x01ab: 'Meta Platforms, Inc.',
  0x01da: 'Logitech International SA',
  0x0211: 'Telink Semiconductor Co. Ltd',
  0x027d: 'HUAWEI Technologies Co., Ltd.',
  0x02e5: 'Espressif Systems (Shanghai) Co., Ltd.',
  0x02ff: 'Silicon Laboratories',
  0x038f: 'Xiaomi Inc.',
  0x0499: 'Ruuvi Innovations Ltd.',
  0x04f7: 'Shenzhen Goodix Technology Co., Ltd',
  0x05a7: 'Sonos Inc',
  0x05f1: 'The Linux Foundation', // Zephyr's default controller company ID (CONFIG_BT_COMPANY_ID)
  0x067c: 'Tile, Inc.',
  0xffff: 'Reserved / test',
};

// ---- 16-bit GATT service UUIDs — full SIG list (names from Bumble's gatt.py) ----
export const SERVICE_UUID16 = {
  0x1800: 'Generic Access',
  0x1801: 'Generic Attribute',
  0x1802: 'Immediate Alert',
  0x1803: 'Link Loss',
  0x1804: 'Tx Power',
  0x1805: 'Current Time',
  0x1806: 'Reference Time Update',
  0x1807: 'Next DST Change',
  0x1808: 'Glucose',
  0x1809: 'Health Thermometer',
  0x180a: 'Device Information',
  0x180d: 'Heart Rate',
  0x180e: 'Phone Alert Status',
  0x180f: 'Battery',
  0x1810: 'Blood Pressure',
  0x1811: 'Alert Notification',
  0x1812: 'Human Interface Device',
  0x1813: 'Scan Parameters',
  0x1814: 'Running Speed and Cadence',
  0x1815: 'Automation IO',
  0x1816: 'Cycling Speed and Cadence',
  0x1818: 'Cycling Power',
  0x1819: 'Location and Navigation',
  0x181a: 'Environmental Sensing',
  0x181b: 'Body Composition',
  0x181c: 'User Data',
  0x181d: 'Weight Scale',
  0x181e: 'Bond Management',
  0x181f: 'Continuous Glucose Monitoring',
  0x1820: 'Internet Protocol Support',
  0x1821: 'Indoor Positioning',
  0x1822: 'Pulse Oximeter',
  0x1823: 'HTTP Proxy',
  0x1824: 'Transport Discovery',
  0x1825: 'Object Transfer',
  0x1826: 'Fitness Machine',
  0x1827: 'Mesh Provisioning',
  0x1828: 'Mesh Proxy',
  0x1829: 'Reconnection Configuration',
  0x183a: 'Insulin Delivery',
  0x183b: 'Binary Sensor',
  0x183c: 'Emergency Configuration',
  0x183d: 'Authorization Control',
  0x183e: 'Physical Activity Monitor',
  0x183f: 'Elapsed Time',
  0x1840: 'Generic Health Sensor',
  0x1843: 'Audio Input Control',
  0x1844: 'Volume Control',
  0x1845: 'Volume Offset Control',
  0x1846: 'Coordinated Set Identification',
  0x1847: 'Device Time',
  0x1848: 'Media Control',
  0x1849: 'Generic Media Control',
  0x184a: 'Constant Tone Extension',
  0x184b: 'Telephone Bearer',
  0x184c: 'Generic Telephone Bearer',
  0x184d: 'Microphone Control',
  0x184e: 'Audio Stream Control',
  0x184f: 'Broadcast Audio Scan',
  0x1850: 'Published Audio Capabilities',
  0x1851: 'Basic Audio Announcement',
  0x1852: 'Broadcast Audio Announcement',
  0x1853: 'Common Audio',
  0x1854: 'Hearing Access',
  0x1855: 'Telephony and Media Audio',
  0x1856: 'Public Broadcast Announcement',
  0x1858: 'Gaming Audio',
  0x1859: 'Mesh Audio Solicitation',
  0xfdf0: 'Audio Streaming for Hearing Aid',
};

export function uuid16Name(uuid) {
  return SERVICE_UUID16[uuid] || null;
}

export function companyName(id) {
  return COMPANY[id] || `0x${id.toString(16).padStart(4, '0')}`;
}

// Bluetooth Core specification version number (the LMP/LL VersNr field reported by
// Read Local Version and Read Remote Version Information). Assigned Numbers §2.1.
export const CORE_VERSION = {
  0: '1.0b', 1: '1.1', 2: '1.2', 3: '2.0+EDR', 4: '2.1+EDR', 5: '3.0+HS',
  6: '4.0', 7: '4.1', 8: '4.2', 9: '5.0', 10: '5.1', 11: '5.2', 12: '5.3', 13: '5.4', 14: '6.0',
};

export function coreVersionName(v) {
  return CORE_VERSION[v] || '?';
}

// ---- Microsoft Swift Pair (proximity pairing beacon) ----
// Manufacturer Specific Data with Company = 0x0006 (Microsoft), payload:
//   [Microsoft Beacon ID = 0x03][Sub Scenario][Reserved RSSI Byte = 0x80][optional UTF-8 display name]
// Ref: Microsoft "Swift Pair" docs. `dataHex` here is everything after the company id (what the
// Manufacturer editor stores). 0x80 is the documented reserved RSSI threshold byte.
// NOTE the counter-intuitive Sub Scenario encoding from the spec table — 0x01 is *BR/EDR only*,
// not LE. The BR/EDR-only scenario also requires a 6-byte BR/EDR address appended (which is why
// sending 0x01 with no address makes scanners like nRF Connect fail to parse the 0xFF section), so
// we only expose the two scenarios that need no classic address: LE-only (0x00) and LE+BR/EDR (0x02).
export const SWIFT_PAIR_COMPANY = 0x0006;
export const SWIFT_PAIR_BEACON_ID = 0x03;
export const SWIFT_PAIR_SUB = {
  0x00: 'Pairing over LE only',
  0x01: 'Pairing over BR/EDR only (LE used for discovery)',
  0x02: 'Pairing over LE + BR/EDR (Secure Connections)',
};
export const SWIFT_PAIR_PRESETS = [
  { sub: 0x00, label: 'Pairing over LE only', dataHex: '030080' },
  { sub: 0x02, label: 'LE + BR/EDR (Secure Connections)', dataHex: '030280' },
];
