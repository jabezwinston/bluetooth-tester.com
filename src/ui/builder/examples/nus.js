// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder example — Nordic UART Service (serial-over-BLE). Our emulated peripheral exposes NUS; the
// central WRITES text to RX (0x...0002) and we NOTIFY on TX (0x...0003). Extremely small: echo what
// the central sends and offer a button that pushes a greeting up. Self-contained (no framework imports).

import { program } from './program.js';
import { ensureService } from './gatt.js';

const NUS = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
const NUS_RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
const NUS_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

const nusService = () => ({
  uuid: NUS, name: 'Nordic UART', primary: true,
  characteristics: [
    { uuid: NUS_RX, name: 'RX (write)', properties: ['write', 'writeNoResp'], valueHex: '' },
    { uuid: NUS_TX, name: 'TX (notify)', properties: ['notify'], valueHex: '' },
  ],
});

function nusProgram() {
  // Nordic UART Service — serial over BLE. The central WRITES to RX; we NOTIFY back on TX.
  // Connect with a NUS app (nRF Connect, Serial Bluetooth Terminal…), subscribe to TX, then type.
  const RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';   // central → us
  const TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';   // us → central

  const decode = (b) => new TextDecoder().decode(new Uint8Array(b));
  const encode = (s) => new TextEncoder().encode(s);

  // Show whatever the central sends, and echo it straight back on TX.
  bt.onWrite(RX, (b) => {
    const text = decode(b);
    widget('screen').print(text);
    bt.notify(TX, encode('echo: ' + text));
    log('RX: ' + text);
  });

  // Button pushes a greeting up to the central.
  widget('hello').onPress(() => {
    bt.notify(TX, encode('Hello from BT-Tester!'));
    log('TX: greeting sent');
  });
}

export const nus = {
  id: 'nus', name: 'Nordic UART (NUS)',
  build({ store, conn }) {
    ensureService(store, conn, nusService());
    return {
      name: 'Nordic UART',
      widgets: [
        { type: 'display', name: 'screen', x: 40, y: 40, props: { rows: 2, cols: 18, text: 'waiting for RX…' } },
        { type: 'button', name: 'hello', x: 40, y: 150, props: { emoji: '👋', text: 'Send hello' } },
      ],
      script: program(nusProgram),
    };
  },
};
