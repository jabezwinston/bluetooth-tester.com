// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Default GATT table seeded on first load. Editable in the GATT panel and exportable as
// JSON. Characteristic value is given as valueText (UTF-8) or valueHex; properties is a
// list of 'read'|'write'|'writeNoResp'|'notify'|'indicate'. CCCDs are added automatically
// for notify/indicate characteristics.

export function defaultGattTable() {
  return {
    services: [
      {
        uuid: '1800', primary: true, name: 'Generic Access',
        characteristics: [
          { uuid: '2A00', name: 'Device Name', properties: ['read'], valueText: 'BT-Tester' },
          { uuid: '2A01', name: 'Appearance', properties: ['read'], valueHex: '0000' },
        ],
      },
      {
        uuid: '1801', primary: true, name: 'Generic Attribute',
        characteristics: [
          { uuid: '2A05', name: 'Service Changed', properties: ['indicate'], valueHex: '' },
        ],
      },
      {
        uuid: '180A', primary: true, name: 'Device Information',
        characteristics: [
          { uuid: '2A29', name: 'Manufacturer Name', properties: ['read'], valueText: 'Espressif' },
          { uuid: '2A24', name: 'Model Number', properties: ['read'], valueText: 'ESP32' },
          { uuid: '2A26', name: 'Firmware Revision', properties: ['read'], valueText: 'zephyr-hci-3.4' },
        ],
      },
      {
        uuid: '180F', primary: true, name: 'Battery',
        characteristics: [
          { uuid: '2A19', name: 'Battery Level', properties: ['read', 'notify'], valueHex: '64' },
        ],
      },
    ],
  };
}
