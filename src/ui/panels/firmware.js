// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Firmware panel: flash the Zephyr HCI controller firmware. The user never picks files — the
// firmware is bundled (firmware/<chip>/, built by scripts/build-firmware.sh) and the app auto-
// prompts this when a connected device doesn't answer HCI. ESP32 boards flash over Web Serial;
// the nRF52840 dongle uses USB DFU (press RESET first); DK boards download a .hex for J-Link.

import { el, clear } from '../dom.js';
import { FlashSerial } from '../../esp/flash-serial.js';
import { chipHint } from '../../data/firmware-manifest.js';
import { flashControls } from '../flash-ui.js';

export function createFirmwarePanel({ store, hci, transport }) {
  const root = el('div.panel-body');

  function render() {
    clear(root);
    if (!FlashSerial.supported) { root.append(el('div.warn-box', { text: 'No serial support — use desktop Chrome/Edge (Web Serial) or Android Chrome (WebUSB).' })); return; }
    root.append(el('p.hint', { text: 'Flash the Zephyr HCI controller firmware. This pops up automatically when a connected device doesn’t answer HCI. ESP32 boards flash over Web Serial (held BOOT if needed); the nRF52840 dongle uses USB DFU (press RESET); DK boards download a .hex for J-Link.' }));
    let hint = null;
    try { hint = chipHint(transport.port?.getInfo?.() || {}); } catch { /* no port */ }
    root.append(flashControls({ store, hci, transport, defaultChip: hint }));
  }

  render();
  store.subscribe(render);
  return { id: 'firmware', title: 'Firmware', el: root };
}
