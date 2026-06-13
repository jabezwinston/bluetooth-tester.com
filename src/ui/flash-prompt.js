// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Auto flash-prompt. When a connected controller doesn't answer HCI, bringUp() sets
// controller.needsFirmware; this opens a modal offering to flash the bundled Zephyr HCI firmware
// for the detected chip (USB VID/PID pre-selects it). Dismissable; reopens on the next failed
// connect. Mirrors the lifecycle of smp-prompt.js.

import { el } from './dom.js';
import { openModal } from './modal.js';
import { chipHint } from '../data/firmware-manifest.js';
import { flashControls } from './flash-ui.js';

export function createFlashPrompt({ store, hci, transport }) {
  let modal = null;
  let shown = false; // already opened (or dismissed) for the current needsFirmware episode

  const portInfo = () => { try { return transport.port?.getInfo?.() || {}; } catch { return {}; } };

  function open() {
    const controls = flashControls({ store, hci, transport, defaultChip: chipHint(portInfo()) });
    modal = openModal({
      title: 'Controller didn’t respond to HCI',
      width: '520px',
      content: el('div.modal-form', {},
        el('p.muted', { text: 'The connected device isn’t speaking HCI (no answer to Reset). Pick your controller and flash the bundled Zephyr HCI firmware, then reconnect.' }),
        controls),
      actions: [{ label: 'Dismiss', onClick: (c) => c() }],
      onClose: () => { modal = null; },
    });
  }

  function sync() {
    const need = store.state.controller.needsFirmware;
    if (need && !shown) { shown = true; open(); }
    else if (!need) shown = false; // re-arm for the next episode; don't force-close an open flash
  }

  store.subscribe(sync);
  sync();
}
