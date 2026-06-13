// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// "About" dialog — software information for the tester, opened from the header button (top-right).
// A small modal: identity + version, what it targets / how it talks to hardware, live browser-capability
// checks (genuinely useful for a Web Serial tool), and links to the source. All static metadata lives in
// APP so there's one place to bump the version.

import { el } from './dom.js';
import { openModal } from './modal.js';
import { APP_NAME, APP_VERSION, APP_REPO } from '../app-meta.js';

const APP = {
  name: APP_NAME,
  tagline: 'Browser-based Bluetooth Host stack over raw HCI (Web Serial).',
  version: APP_VERSION,
  transport: 'HCI H4 over UART (Web Serial)',
  author: 'Jabez Winston',
  repo: APP_REPO,
};

// A green/red capability badge from a boolean feature-detect.
const cap = (ok) => el('span', { class: ok ? 'about-ok' : 'about-no', text: ok ? '✓ available' : '✕ unavailable' });

// One <dt>/<dd> pair for the definition-list grids.
const row = (k, v) => [el('dt', { text: k }), el('dd', {}, v)];

export function openAbout() {
  const info = el('dl.about-grid', {},
    ...row('Version', APP.version),
    ...row('Transport', APP.transport),
    ...row('Author', APP.author),
  );

  // Feature-detect what the current browser offers — the tool needs Web Serial (desktop) OR WebUSB
  // (Android Chrome, via the WebUSB serial shim).
  const support = el('dl.about-grid', {},
    ...row('Web Serial API', cap('serial' in navigator)),
    ...row('WebUSB API', cap('usb' in navigator)),
    ...row('Web Bluetooth API', cap('bluetooth' in navigator)),
  );

  const content = el('div.about', {},
    el('div.about-head', {},
      el('img.about-logo', { attrs: { src: './favicon.svg', alt: 'BT', width: '48', height: '48' } }),
      el('div', {},
        el('strong', { text: APP.name }),
        el('p.muted', { text: APP.tagline }))),
    info,
    el('h4.about-sub', { text: 'Browser capabilities' }),
    support,
    el('p.about-links', {},
      el('a', { href: APP.repo, attrs: { target: '_blank', rel: 'noopener' }, text: 'Source ↗' }),
      el('a', { href: APP.repo + '/issues', attrs: { target: '_blank', rel: 'noopener' }, text: 'Report an issue ↗' })),
    el('p.about-disclaimer', {
      text: 'The Bluetooth® word mark and logos are registered trademarks owned by Bluetooth SIG, Inc. '
        + 'This is an independent tool and is not affiliated with, endorsed by, or sponsored by Bluetooth SIG, Inc.',
    }),
  );

  const modal = openModal({
    title: 'About',
    width: '460px',
    content,
    actions: [],            // no footer Close button — close via the ✕, Esc, or backdrop
  });
  modal.dialog.classList.add('modal-about'); // centers the title (see .modal-about in app.css)
  return modal;
}

// The header button (top-right). Returns the element; click opens the modal.
export function createAboutButton() {
  return el('button.about-btn', { text: 'About', attrs: { title: 'About this tool' }, on: { click: () => openAbout() } });
}
