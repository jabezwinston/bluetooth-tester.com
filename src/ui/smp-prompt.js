// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// SMP user-intervention popup. Pairing periodically needs the user: confirm a Numeric
// Comparison, read a passkey to type on the central, or enter the passkey the central shows.
// This watches store.state.smp and auto-opens a modal for those moments so they can be
// serviced from any tab — or dismissed (✕ / Esc / click-outside), which just hides the popup
// (the same controls remain in the SMP panel).

import { el } from './dom.js';
import { openModal } from './modal.js';

const INTERVENTION = new Set(['numeric-comparison', 'passkey-display', 'passkey-input']);

export function createSmpPrompt({ store, conn }) {
  let modal = null;
  let shownFor = null; // the smp.status we currently have (or have dismissed) a popup for

  const close = () => { if (modal) { const m = modal; modal = null; m.close(); } };

  function open(status, cur) {
    close();
    const built = build(status, cur);
    modal = openModal({ title: built.title, width: '420px', content: built.content, actions: built.actions, onClose: () => { modal = null; } });
    // Enter-to-submit for the passkey-input field.
    if (status === 'passkey-input') {
      const input = modal.dialog.querySelector('input[type=number]');
      if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); conn.inputPasskey(cur.handle, parseInt(input.value, 10) || 0); close(); } });
    }
  }

  function build(status, cur) {
    const who = cur.peerAddr ? ` on ${cur.peerAddr}` : '';
    if (status === 'numeric-comparison') {
      return {
        title: 'Confirm pairing — Numeric Comparison',
        content: el('div', {},
          el('p.muted', { text: `Does this number match the one shown${who}?` }),
          el('div.passkey-box', { text: cur.ncValue || '------' }),
          el('p.muted', { text: 'Dismiss (Esc) to decide later in the SMP tab.' })),
        actions: [
          { label: '✗ Don’t match', kind: 'danger', onClick: (c) => { conn.confirmNumeric(cur.handle, false); c(); } },
          { label: '✓ Numbers match', kind: 'primary', onClick: (c) => { conn.confirmNumeric(cur.handle, true); c(); } },
        ],
      };
    }
    if (status === 'passkey-display') {
      return {
        title: 'Pairing — Passkey',
        content: el('div', {},
          el('p.muted', { text: `Enter this passkey${who}:` }),
          el('div.passkey-box', { text: String(cur.passkey ?? 0).padStart(6, '0') })),
        actions: [{ label: 'Done', kind: 'primary', onClick: (c) => c() }],
      };
    }
    // passkey-input
    const input = el('input', { type: 'number', placeholder: 'passkey from central', attrs: { min: 0, max: 999999 }, style: { width: '100%' } });
    return {
      title: 'Pairing — Enter Passkey',
      content: el('div', {}, el('p.muted', { text: `Enter the passkey shown${who}.` }), input),
      actions: [{ label: 'Submit', kind: 'primary', onClick: (c) => { conn.inputPasskey(cur.handle, parseInt(input.value, 10) || 0); c(); } }],
    };
  }

  function sync() {
    const s = store.state.smp;
    if (INTERVENTION.has(s.status)) {
      if (s.status !== shownFor) { open(s.status, s.current || {}); shownFor = s.status; }
    } else {
      close();
      shownFor = null;
    }
  }

  store.subscribe(sync);
  sync();
}
