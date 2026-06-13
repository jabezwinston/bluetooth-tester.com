// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder example — BLE HID keypad + consumer keys (HID-over-GATT). Our peripheral exposes a composite
// HID device: a keyboard (Report ID 1, with Lock-key LED output) and a Consumer Control (Report ID 2 —
// Volume Up/Down + Mute). Pressing a key NOTIFIES its report; when the host toggles a Lock key it WRITES
// its LED state back, lighting the matching LED. The GATT plumbing lives in build() (report descriptor /
// service defs inlined as data, no framework imports); the script stays small.

import { program } from './program.js';
import { ensureService } from './gatt.js';

// HID Report Descriptor — mirrors exactly what keypadProgram() sends (USB HID usage tables):
//   • Report ID 1 (keyboard): 8-byte Input report [modifiers, reserved, 6 key usages] + a 1-byte
//     Output report for the Num/Caps/Scroll Lock LEDs.
//   • Report ID 2 (consumer): 1-byte Input bitmap — bit0 Volume Up, bit1 Volume Down, bit2 Mute.
const REPORT_DESCRIPTOR = [
  0x05, 0x01,       // Usage Page (Generic Desktop)
  0x09, 0x06,       // Usage (Keyboard)
  0xa1, 0x01,       // Collection (Application)
  0x85, 0x01,       //   Report ID (1)
  0x05, 0x07,       //   Usage Page (Keyboard/Keypad)
  0x19, 0xe0,       //   Usage Minimum (Left Control)
  0x29, 0xe7,       //   Usage Maximum (Right GUI)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x08,       //   Report Count (8)
  0x81, 0x02,       //   Input (Data,Var,Abs) — modifier bits (byte 0)
  0x95, 0x01,       //   Report Count (1)
  0x75, 0x08,       //   Report Size (8)
  0x81, 0x01,       //   Input (Const) — reserved (byte 1)
  0x95, 0x05,       //   Report Count (5)
  0x75, 0x01,       //   Report Size (1)
  0x05, 0x08,       //   Usage Page (LEDs)
  0x19, 0x01,       //   Usage Minimum (Num Lock)
  0x29, 0x05,       //   Usage Maximum (Kana)
  0x91, 0x02,       //   Output (Data,Var,Abs) — 5 LED bits
  0x95, 0x01,       //   Report Count (1)
  0x75, 0x03,       //   Report Size (3)
  0x91, 0x01,       //   Output (Const) — LED padding
  0x95, 0x06,       //   Report Count (6)
  0x75, 0x08,       //   Report Size (8)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x65,       //   Logical Maximum (101)
  0x05, 0x07,       //   Usage Page (Keyboard/Keypad)
  0x19, 0x00,       //   Usage Minimum (0)
  0x29, 0x65,       //   Usage Maximum (101)
  0x81, 0x00,       //   Input (Data,Array) — 6 key usages (bytes 2-7)
  0xc0,             // End Collection
  0x05, 0x0c,       // Usage Page (Consumer)
  0x09, 0x01,       // Usage (Consumer Control)
  0xa1, 0x01,       // Collection (Application)
  0x85, 0x02,       //   Report ID (2)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x03,       //   Report Count (3)
  0x09, 0xe9,       //   Usage (Volume Increment)
  0x09, 0xea,       //   Usage (Volume Decrement)
  0x09, 0xe2,       //   Usage (Mute)
  0x81, 0x02,       //   Input (Data,Var,Abs) — Vol+ / Vol- / Mute bits
  0x95, 0x05,       //   Report Count (5)
  0x75, 0x01,       //   Report Size (1)
  0x81, 0x01,       //   Input (Const) — padding to 1 byte
  0xc0,             // End Collection
];
const REPORT_MAP = REPORT_DESCRIPTOR.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');

// HID service (0x1812). Reports share characteristic UUID 0x2A4D and are told apart by their Report
// Reference descriptor (0x2908 = [Report ID, Report Type 1=input/2=output]): keyboard input [1,1],
// keyboard LED output [1,2], consumer input [2,1].
const hidService = () => ({
  uuid: '1812', name: 'Human Interface Device', primary: true,
  characteristics: [
    { uuid: '2A4A', name: 'HID Information', properties: ['read'], valueHex: '11010002' },
    { uuid: '2A4B', name: 'Report Map', properties: ['read'], valueHex: REPORT_MAP },
    { uuid: '2A4D', name: 'Keyboard Input (ID 1)', properties: ['read', 'notify'], valueHex: '0000000000000000', security: 'encrypt', descriptors: [{ uuid: '2908', valueHex: '0101' }] },
    { uuid: '2A4D', name: 'Keyboard LED Output (ID 1)', properties: ['read', 'write', 'writeNoResp'], valueHex: '00', descriptors: [{ uuid: '2908', valueHex: '0102' }] },
    { uuid: '2A4D', name: 'Consumer Input (ID 2)', properties: ['read', 'notify'], valueHex: '00', security: 'encrypt', descriptors: [{ uuid: '2908', valueHex: '0201' }] },
    { uuid: '2A4E', name: 'Protocol Mode', properties: ['read', 'writeNoResp'], valueHex: '01' },
    { uuid: '2A4C', name: 'HID Control Point', properties: ['writeNoResp'], valueHex: '00' },
  ],
});

// Device Information + PnP ID — HID hosts expect this before trusting a HID device.
const disService = () => ({
  uuid: '180A', name: 'Device Information', primary: true,
  characteristics: [
    { uuid: '2A50', name: 'PnP ID', properties: ['read'], valueHex: '02E5020001000100' },
  ],
});

function keypadProgram() {
  // BLE HID keypad + consumer keys. Press a key → we NOTIFY its report (down, then up). When the host
  // toggles Num/Caps/Scroll Lock it WRITES its LED state back to us → we light the matching LED.
  // HID input needs encryption: advertise, connect, then pair from the SMP tab first.

  // All HID reports share characteristic 0x2A4D; the 3rd arg to bt.notify() picks the report by its
  // Report ID (1 = keyboard, 2 = consumer). bt.onWrite() fires when the host writes the LED report.
  const REPORT = '2A4D';

  // Keyboard report (ID 1) — 8 bytes: [modifiers][reserved][6 key usages]. Send the key, then release
  // it a beat later (an instant down+up lands in one connection event and the Lock debounce ignores it).
  function tap(usage) {
    bt.notify(REPORT, [0, 0, usage, 0, 0, 0, 0, 0], 1);
    setTimeout(() => bt.notify(REPORT, [0, 0, 0, 0, 0, 0, 0, 0], 1), 120);
  }

  // Consumer report (ID 2) — 1 byte of bits: 0x01 Volume Up · 0x02 Volume Down · 0x04 Mute.
  function consumer(bits) {
    bt.notify(REPORT, [bits], 2);
    setTimeout(() => bt.notify(REPORT, [0], 2), 120);
  }

  widget('num').onPress(() => tap(0x53));     // Num Lock
  widget('caps').onPress(() => tap(0x39));    // Caps Lock
  widget('scroll').onPress(() => tap(0x47));  // Scroll Lock
  widget('k1').onPress(() => tap(0x59));      // Keypad 1
  widget('k2').onPress(() => tap(0x5a));      // Keypad 2
  widget('k3').onPress(() => tap(0x5b));      // Keypad 3

  widget('volUp').onPress(() => consumer(0x01));    // Volume Up
  widget('volDown').onPress(() => consumer(0x02));  // Volume Down
  widget('mute').onPress(() => consumer(0x04));     // Mute

  // Host LED report (1 byte, written to the keyboard Output report): bit0 Num · bit1 Caps · bit2 Scroll.
  bt.onWrite(REPORT, (b) => {
    const led = b[0] || 0;
    widget('numLed').set(led & 0x01);
    widget('capsLed').set(led & 0x02);
    widget('scrollLed').set(led & 0x04);
    log('host LEDs: 0x' + led.toString(16));
  });
}

// A clean 3-column grid: every row shares the same column x's (40 / 160 / 280) so LEDs, lock keys,
// digits and volume keys line up vertically.
export const keypad = {
  id: 'keypad', name: 'BLE HID Keypad',
  build({ store, conn }) {
    ensureService(store, conn, disService());
    ensureService(store, conn, hidService());
    return {
      name: 'HID Keypad',
      widgets: [
        { type: 'led', name: 'numLed', x: 40, y: 20, props: { color: '#3ecf8e', on: false, label: 'Num' } },
        { type: 'led', name: 'capsLed', x: 160, y: 20, props: { color: '#e0a83e', on: false, label: 'Caps' } },
        { type: 'led', name: 'scrollLed', x: 280, y: 20, props: { color: '#4aa8ff', on: false, label: 'Scroll' } },
        { type: 'button', name: 'num', x: 40, y: 84, props: { emoji: '🔢', text: 'Num Lock' } },
        { type: 'button', name: 'caps', x: 160, y: 84, props: { emoji: '🔠', text: 'Caps Lock' } },
        { type: 'button', name: 'scroll', x: 280, y: 84, props: { emoji: '📜', text: 'Scroll Lock' } },
        { type: 'button', name: 'k1', x: 40, y: 152, props: { emoji: '1️⃣', text: 'KP 1' } },
        { type: 'button', name: 'k2', x: 160, y: 152, props: { emoji: '2️⃣', text: 'KP 2' } },
        { type: 'button', name: 'k3', x: 280, y: 152, props: { emoji: '3️⃣', text: 'KP 3' } },
        { type: 'button', name: 'volUp', x: 40, y: 220, props: { emoji: '🔊', text: 'Vol +' } },
        { type: 'button', name: 'volDown', x: 160, y: 220, props: { emoji: '🔉', text: 'Vol −' } },
        { type: 'button', name: 'mute', x: 280, y: 220, props: { emoji: '🔇', text: 'Mute' } },
      ],
      script: program(keypadProgram),
    };
  },
};
