// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Serial backend selection. Desktop Chrome/Edge have Web Serial with USB-serial support. Android Chrome
// either lacks Web Serial OR exposes it ONLY for Bluetooth RFCOMM ports (newer Chrome) — neither can see
// our USB bridges — but it does have WebUSB, so on Android we use the WebUSB shim (webusb-serial.js),
// which exposes the same API. `?webusb=1` forces the shim on desktop for development. Everything else in
// the app calls getSerial()/serialSupported() instead of navigator.serial, so the backends are swappable.

import { webUsbSerial } from './webusb-serial.js';

const hasSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;
const hasUsb = () => typeof navigator !== 'undefined' && 'usb' in navigator;
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

function forceWebUsb() {
  try { return typeof location !== 'undefined' && new URLSearchParams(location.search).has('webusb'); } catch { return false; }
}

/** The active serial backend: navigator.serial, the WebUSB shim, or null when neither is available. */
export function getSerial() {
  if (forceWebUsb() && hasUsb()) return webUsbSerial;
  // Android: Web Serial is absent or Bluetooth-RFCOMM-only and can't enumerate USB serial bridges, so use
  // the WebUSB shim for our USB devices. (Desktop Web Serial handles USB fine, so it stays the default there.)
  if (isAndroid() && hasUsb()) return webUsbSerial;
  if (hasSerial()) return navigator.serial;
  if (hasUsb()) return webUsbSerial;
  return null;
}

export function serialSupported() { return !!getSerial(); }

/** True when the active backend is the WebUSB shim (used for UI copy / About). */
export function usingWebUsb() { return getSerial() === webUsbSerial; }
