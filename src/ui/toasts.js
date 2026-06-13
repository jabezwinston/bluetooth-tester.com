// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Bottom-right disappearing toasts for notices + validation warnings. Each entry added to the
// NoticeFeed pops a toast that auto-dismisses (errors linger longer); hovering pauses the timer and
// the × dismisses immediately. The same entries persist in the Log panel, so toasts are fire-and-forget.

import { el } from './dom.js';

const TTL = { error: 8000, warn: 5000, info: 4000 };
const MAX_VISIBLE = 5;
const TAG = { error: 'ERROR', warn: 'WARN', info: 'INFO' };

export function createToasts(feed) {
  const host = el('div.toast-host');

  function show(entry) {
    let timer;
    const toast = el('div', { class: 'toast ' + entry.level },
      el('span.wtag', { text: TAG[entry.level] || 'WARN' }),
      el('span.toast-msg', { text: entry.msg }),
      el('button.toast-x', { type: 'button', text: '×', attrs: { 'aria-label': 'dismiss' }, on: { click: dismiss } }));

    function dismiss() {
      if (!toast.isConnected) return;
      clearTimeout(timer);
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 200); // let the fade-out transition play
    }
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1500); });

    host.append(toast);
    while (host.childElementCount > MAX_VISIBLE) host.firstElementChild.remove();
    timer = setTimeout(dismiss, TTL[entry.level] || TTL.warn);
  }

  feed.subscribe((entry) => { if (entry) show(entry); });
  return host;
}
