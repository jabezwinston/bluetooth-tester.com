// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Nordic UART Service — serial-over-BLE. From the peripheral's perspective: the client
// WRITES to RX, and the peripheral NOTIFIES on TX.

export const NUS_SERVICE = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
export const NUS_RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E'; // client -> peripheral (write)
export const NUS_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'; // peripheral -> client (notify)

export function nusService() {
  return {
    uuid: NUS_SERVICE, name: 'Nordic UART', primary: true,
    characteristics: [
      { uuid: NUS_RX, name: 'RX (write)', properties: ['write', 'writeNoResp'], valueHex: '' },
      { uuid: NUS_TX, name: 'TX (notify)', properties: ['notify'], valueHex: '' },
    ],
  };
}
