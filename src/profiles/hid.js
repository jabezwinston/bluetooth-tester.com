// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HID-over-GATT (HOGP) keyboard profile: report map, browser-key → HID-usage mapping,
// input-report encoding, LED output decoding, and the GATT service definition (appended to
// the editable table). USB HID Usage Tables + HOGP/HIDS.

import { bytesToHex } from '../util/bytes.js';

// Standard 8-byte boot-compatible keyboard report: [modifiers][reserved][6 key codes];
// 1-byte LED output report. No report ID.
export const KEYBOARD_REPORT_MAP = new Uint8Array([
  0x05, 0x01,       // Usage Page (Generic Desktop)
  0x09, 0x06,       // Usage (Keyboard)
  0xa1, 0x01,       // Collection (Application)
  0x05, 0x07,       //   Usage Page (Keyboard/Keypad)
  0x19, 0xe0,       //   Usage Minimum (Left Control)
  0x29, 0xe7,       //   Usage Maximum (Right GUI)
  0x15, 0x00,       //   Logical Minimum (0)
  0x25, 0x01,       //   Logical Maximum (1)
  0x75, 0x01,       //   Report Size (1)
  0x95, 0x08,       //   Report Count (8)
  0x81, 0x02,       //   Input (Data,Var,Abs) — modifier byte
  0x95, 0x01,       //   Report Count (1)
  0x75, 0x08,       //   Report Size (8)
  0x81, 0x01,       //   Input (Const) — reserved byte
  0x95, 0x05,       //   Report Count (5)
  0x75, 0x01,       //   Report Size (1)
  0x05, 0x08,       //   Usage Page (LEDs)
  0x19, 0x01,       //   Usage Minimum (Num Lock)
  0x29, 0x05,       //   Usage Maximum (Kana)
  0x91, 0x02,       //   Output (Data,Var,Abs) — LED report
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
  0x81, 0x00,       //   Input (Data,Array) — 6 key codes
  0xc0,             // End Collection
]);

// KeyboardEvent.code → modifier bit.
export const CODE_TO_MOD = {
  ControlLeft: 0x01, ShiftLeft: 0x02, AltLeft: 0x04, MetaLeft: 0x08,
  ControlRight: 0x10, ShiftRight: 0x20, AltRight: 0x40, MetaRight: 0x80,
};

// KeyboardEvent.code → HID Keyboard/Keypad usage (page 0x07).
export const CODE_TO_USAGE = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 0x04 + i; // A..Z
  m.Digit1 = 0x1e; m.Digit2 = 0x1f; m.Digit3 = 0x20; m.Digit4 = 0x21; m.Digit5 = 0x22;
  m.Digit6 = 0x23; m.Digit7 = 0x24; m.Digit8 = 0x25; m.Digit9 = 0x26; m.Digit0 = 0x27;
  Object.assign(m, {
    Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
    Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
    CapsLock: 0x39,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    Home: 0x4a, PageUp: 0x4b, Delete: 0x4c, End: 0x4d, PageDown: 0x4e, Insert: 0x49,
  });
  for (let i = 1; i <= 12; i++) m['F' + i] = 0x3a + (i - 1); // F1..F12
  return m;
})();

/** Build an 8-byte keyboard input report from the set of currently-pressed KeyboardEvent.code values. */
export function buildKeyboardReport(pressedCodes) {
  let mod = 0;
  const keys = [];
  for (const code of pressedCodes) {
    if (CODE_TO_MOD[code] != null) mod |= CODE_TO_MOD[code];
    else if (CODE_TO_USAGE[code] != null && keys.length < 6) keys.push(CODE_TO_USAGE[code]);
  }
  const r = new Uint8Array(8);
  r[0] = mod;
  for (let i = 0; i < keys.length; i++) r[2 + i] = keys[i];
  return r;
}

export function decodeLedReport(byte) {
  return { numLock: !!(byte & 0x01), capsLock: !!(byte & 0x02), scrollLock: !!(byte & 0x04), compose: !!(byte & 0x08), kana: !!(byte & 0x10) };
}

/**
 * GATT service definition (editable-table format) for a HID keyboard. Appended to the GATT
 * table; the host should bond before using HID (encryption normally required).
 * @param {object} opts { bcdHID=0x0111, countryCode=0, flags=0x02 }
 */
export function hidKeyboardService({ bcdHID = 0x0111, countryCode = 0, flags = 0x02 } = {}) {
  const info = new Uint8Array([bcdHID & 0xff, (bcdHID >> 8) & 0xff, countryCode, flags]);
  return {
    uuid: '1812', name: 'Human Interface Device', primary: true,
    characteristics: [
      { uuid: '2A4A', name: 'HID Information', properties: ['read'], valueHex: bytesToHex(info, '') },
      { uuid: '2A4B', name: 'Report Map', properties: ['read'], valueHex: bytesToHex(KEYBOARD_REPORT_MAP, '') },
      { uuid: '2A4D', name: 'Input Report', properties: ['read', 'notify'], valueHex: '0000000000000000', security: 'encrypt', descriptors: [{ uuid: '2908', valueHex: '0001' }] },
      { uuid: '2A4D', name: 'Output Report (LED)', properties: ['read', 'write', 'writeNoResp'], valueHex: '00', descriptors: [{ uuid: '2908', valueHex: '0002' }] },
      { uuid: '2A4E', name: 'Protocol Mode', properties: ['read', 'writeNoResp'], valueHex: '01' },
      { uuid: '2A4C', name: 'HID Control Point', properties: ['writeNoResp'], valueHex: '00' },
      { uuid: '2A22', name: 'Boot Keyboard Input', properties: ['read', 'notify'], valueHex: '0000000000000000' },
      { uuid: '2A32', name: 'Boot Keyboard Output', properties: ['read', 'write', 'writeNoResp'], valueHex: '00' },
    ],
  };
}

// PnP ID for the Device Information service (HID hosts expect DIS + PnP ID).
export function pnpIdService() {
  return {
    uuid: '180A', name: 'Device Information', primary: true,
    characteristics: [
      { uuid: '2A50', name: 'PnP ID', properties: ['read'], valueHex: '02E5020001000100' }, // src=USB, vid=0x02E5 (Espressif), pid=1, ver=1
    ],
  };
}
