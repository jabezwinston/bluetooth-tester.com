// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Minimal modal/dialog component (vanilla). openModal returns { close }. confirmModal and
// promptModal return promises for simple flows.

import { el } from './dom.js';

export function openModal({ title, content, actions = [], width = '560px', onClose = null }) {
  const overlay = el('div.modal-overlay');
  const dialog = el('div.modal', { style: { maxWidth: width } });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  dialog.append(
    el('div.modal-head', {},
      el('h3', { text: title }),
      el('button.modal-x', { text: '✕', attrs: { title: 'Close (Esc)' }, on: { click: close } })),
    el('div.modal-body', {}, content),
  );
  // Native Node.append() turns a null arg into a "null" text node, so only append the footer if present.
  if (actions.length) {
    dialog.append(el('div.modal-foot', {}, ...actions.map((a) =>
      el('button', { class: 'btn ' + (a.kind || ''), text: a.label, on: { click: () => a.onClick(close) } }))));
  }

  overlay.append(dialog);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);

  const first = dialog.querySelector('input, select, textarea, button.btn');
  if (first) first.focus();
  return { close, dialog };
}

export function confirmModal(message, { title = 'Confirm', confirmLabel = 'Confirm', danger = true } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      width: '420px',
      content: el('p', { text: message }),
      actions: [
        { label: 'Cancel', onClick: (c) => { c(); resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (c) => { c(); resolve(true); } },
      ],
    });
  });
}
