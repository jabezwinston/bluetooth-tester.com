// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Bootstrap: build the store + transport + HCI engine + packet log, wire validation,
// instantiate panels, and render the shell (header, nav, warnings strip, panel area).

import { createStore, initialState } from './src/store.js';
import { validate } from './src/validate.js';
import { PacketLog } from './src/log/logger.js';
import { NoticeFeed } from './src/log/notices.js';
import { createToasts } from './src/ui/toasts.js';
import { SerialTransport } from './src/transport/webserial.js';
import { HCI } from './src/hci/hci.js';
import { ConnectionManager } from './src/host/conn.js';
import { el, clear } from './src/ui/dom.js';
import { createAboutButton } from './src/ui/about.js';

import { createConnectionControl } from './src/ui/connection-control.js';
import { createAdvControl } from './src/ui/adv-control.js';
import { createSmpPrompt } from './src/ui/smp-prompt.js';
import { createOobWizard } from './src/ui/oob-wizard.js';
import { createControllerPanel } from './src/ui/panels/controller.js';
import { createAdvertiserPanel } from './src/ui/panels/advertiser.js';
import { createConnectionsPanel } from './src/ui/panels/connections.js';
import { createGattPanel } from './src/ui/panels/gatt.js';
import { createClientPanel } from './src/ui/panels/client.js';
import { createProfilesPanel } from './src/ui/panels/profiles.js';
import { createBuilderPanel } from './src/ui/panels/builder.js';
import { createSmpPanel } from './src/ui/panels/smp.js';
import { createConsolePanel } from './src/ui/panels/console.js';
import { createDtmPanel } from './src/ui/panels/dtm.js';
import { createFirmwarePanel } from './src/ui/panels/firmware.js';
import { createLogPanel } from './src/ui/panels/log.js';

function main() {
  const store = createStore(initialState());
  const log = new PacketLog();
  const notices = new NoticeFeed();
  const toastHost = createToasts(notices);
  const transport = new SerialTransport();
  const hci = new HCI(transport, { log: (entry) => log.add(entry) });
  const conn = new ConnectionManager(store, hci, notices);
  conn.setGattTable(store.state.gatt);

  store.state.ui.activePanel = 'controller';

  transport.onClose = (reason) => {
    store.update((s) => {
      s.serial.connected = false;
      s.serial.connecting = false;
      s.controller.ready = false;
      s.advertiser.enabled = false;
      s.serial.error = reason ? `Disconnected: ${reason}` : null;
    });
  };

  hci.on('error', (msg) => console.warn('HCI:', msg));

  // Validation: recompute warnings on any change; only write back when they differ.
  let lastWarn = '[]';
  store.subscribe(() => {
    const w = validate(store.state);
    const key = JSON.stringify(w);
    if (key !== lastWarn) {
      lastWarn = key;
      store.state.warnings = w;
    }
  });

  // Surface notices + validation warnings as bottom-right toasts and a Log-panel record. Runs after
  // the validate subscriber (registration order) so it sees fresh warnings. Diff against what's
  // already shown so each distinct message fires once — and again only if it clears then recurs.
  let shownNotices = new Set();
  store.subscribe(() => {
    const next = new Set();
    for (const item of [...store.state.notices, ...store.state.warnings]) {
      const key = `${item.level}|${item.source || ''}|${item.msg}`;
      next.add(key);
      if (!shownNotices.has(key)) notices.add(item);
    }
    shownNotices = next;
  });

  const ctx = { store, hci, transport, log, notices, conn };
  const connControl = createConnectionControl(ctx);
  const advControl = createAdvControl(ctx);
  createSmpPrompt(ctx); // auto-popup when pairing needs the user (numeric comparison / passkey)
  createOobWizard(ctx); // guided auto-popup: detect → flash HCI firmware → verify when a board doesn't answer HCI
  const panels = [
    createControllerPanel(ctx),
    createLogPanel(ctx),
    createAdvertiserPanel(ctx),
    createConnectionsPanel(ctx),
    createGattPanel(ctx),
    createClientPanel(ctx),
    createProfilesPanel(ctx),
    createSmpPanel(ctx),
    createConsolePanel(ctx),
    createDtmPanel(ctx),
    createFirmwarePanel(ctx),
    createBuilderPanel(ctx), // "Prototype" tab
  ];

  renderShell(store, panels, connControl, advControl, toastHost);
}

function renderShell(store, panels, connControl, advControl, toastHost) {
  const appRoot = document.getElementById('app');
  clear(appRoot);

  const nav = el('nav.nav');
  const panelArea = el('main.panel-area');

  // Mount panels (all present; toggle visibility).
  const wrappers = new Map();
  for (const p of panels) {
    const wrap = el('section.panel', { dataset: { id: p.id } },
      el('header.panel-head', {}, el('h2', { text: p.title })),
      p.el);
    wrappers.set(p.id, wrap);
    panelArea.append(wrap);
  }

  function renderNav() {
    clear(nav);
    const active = store.state.ui.activePanel;
    for (const p of panels) {
      nav.append(el('button', {
        class: 'nav-item' + (p.id === active ? ' active' : ''),
        text: p.title,
        on: { click: () => { store.state.ui.activePanel = p.id; appRoot.classList.remove('drawer-open'); } },
      }));
    }
    for (const [id, wrap] of wrappers) wrap.classList.toggle('hidden', id !== active);
  }

  const header = el('header.app-head', {},
    // Hamburger — hidden on desktop (CSS); on mobile it toggles the off-canvas nav drawer.
    el('button.nav-toggle', { type: 'button', attrs: { 'aria-label': 'Toggle menu' }, text: '☰', on: { click: () => appRoot.classList.toggle('drawer-open') } }),
    el('div.brand', {},
      el('span.brand-name', {},
        el('img.brand-logo', { attrs: { src: './favicon.svg', alt: '', width: 22, height: 22 } }),
        el('strong', { text: 'Bluetooth Tester' })),
      connControl),
    el('div.head-right', {}, advControl, createAboutButton()),
  );
  // Backdrop behind the open drawer (mobile); tapping it closes the drawer.
  const navBackdrop = el('div.nav-backdrop', { on: { click: () => appRoot.classList.remove('drawer-open') } });

  // toastHost is fixed-positioned (bottom-right); notices + warnings now live there transiently and
  // in the Log panel permanently — no strip below the nav.
  appRoot.append(header, nav, navBackdrop, panelArea, toastHost);
  renderNav();
  store.subscribe(renderNav);
}

main();
