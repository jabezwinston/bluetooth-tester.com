// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Out-of-box (OOB) setup wizard. Opened when a connected device can't act as an HCI controller and
// controller.needsFirmware is set. Two guided flows, picked by VID:PID:
//  - ESP32 / -C3 / -C6 / -S3 over a USB-UART bridge: Connect ✓ → Detect → Flash → Verify. Auto-detects
//    the chip from its ROM magic and flashes the bundled Zephyr HCI firmware on the SAME connection
//    (one click; live "hold BOOT" fallback).
//  - nRF52840 dongle in Open DFU Bootloader mode (1915:521F): Connect ✓ → Detect → Flash → Reconnect.
//    Flashes over Nordic USB serial DFU; the dongle re-enumerates into the app, so the user reconnects.
// Other no-HCI devices get a short notice that points to the Firmware tab (which carries the full,
// proper-width flash controls + firmware download/command).

import { el, clear } from './dom.js';
import { openModal } from './modal.js';
import { isEspUartBridge, isNrfDfuBootloader, isEspNativeUsb } from '../data/firmware-manifest.js';
import { flashEspKeepConnection, flashNrfDfuConnected } from './flash-core.js';
import { bringUp } from '../host/controller.js';
import { connectController } from './connection-control.js';

const STEPS = [
  { key: 'connect', label: 'Connect' },
  { key: 'detect', label: 'Detect' },
  { key: 'flash', label: 'Flash' },
  { key: 'verify', label: 'Verify' },
];

export function createOobWizard({ store, hci, transport }) {
  let shown = false; // already opened (or dismissed) for the current needsFirmware episode

  const portInfo = () => { try { return transport.port?.getInfo?.() || {}; } catch { return {}; } };

  function open() {
    const info = portInfo();
    if (isNrfDfuBootloader(info)) openNrfDfuWizard({ store, hci, transport });
    else if (isEspUartBridge(info)) openEspWizard({ store, hci, transport, info });
    else openFallback({ store, transport });
  }

  function sync() {
    const need = store.state.controller.needsFirmware;
    if (need && !shown) { shown = true; open(); }
    else if (!need) shown = false; // re-arm for the next episode; don't force-close an open wizard
  }
  store.subscribe(sync);
  sync();
}

// ---- ESP guided wizard ----

function openEspWizard({ store, hci, transport, info }) {
  // phase: 'consent' | 'flashing' | 'verifying' | 'done' | 'failed'
  const w = {
    phase: 'consent',
    detail: '',
    manualBoot: false,   // waiting for the user to hold BOOT
    chipName: null,      // exact chip once its ROM magic is read
    failStep: null,      // 'flash' | 'verify' — drives the rail's ✕ and the Retry routing
    failMsg: '',
    frac: 0,             // flash-write progress 0..1
  };
  let abort = null;      // AbortController while flashing/booting
  const logLines = [];

  const rail = el('div.oob-rail');
  const body = el('div.oob-body');
  const foot = el('div.oob-foot');
  const content = el('div.oob-wizard', {}, rail, body, foot);
  const logBox = el('pre.fw-log', { style: { display: 'none' } });
  const bar = el('div.budget-bar', { style: { width: '0%' } });
  const budget = el('div.budget', { style: { display: 'none' } }, bar);

  const log = (m) => { logLines.push(String(m)); logBox.style.display = 'block'; logBox.textContent = logLines.slice(-12).join('\n'); };

  const modal = openModal({
    title: 'Set up your controller',
    width: '560px',
    content,
    onClose: () => { if (abort) abort.abort(); }, // closing during the BOOT wait stops the retry loop
  });

  function railStatus() {
    const s = { connect: 'done', detect: 'pending', flash: 'pending', verify: 'pending' };
    if (w.phase === 'consent') s.detect = 'active';
    else if (w.phase === 'flashing') { s.detect = w.chipName ? 'done' : 'active'; s.flash = 'active'; }
    else if (w.phase === 'verifying') { s.detect = 'done'; s.flash = 'done'; s.verify = 'active'; }
    else if (w.phase === 'done') { s.detect = s.flash = s.verify = 'done'; }
    else if (w.phase === 'failed') {
      s.detect = 'done';
      s.flash = w.failStep === 'flash' ? 'error' : 'done';
      s.verify = w.failStep === 'verify' ? 'error' : 'pending';
    }
    return s;
  }

  function renderRail() {
    clear(rail);
    const st = railStatus();
    STEPS.forEach((step, i) => {
      const status = st[step.key];
      rail.append(el(`div.oob-step.${status}`, {},
        el('span.oob-num', { text: status === 'done' ? '✓' : status === 'error' ? '✕' : String(i + 1) }),
        el('span.oob-step-label', { text: step.label })));
      if (i < STEPS.length - 1) rail.append(el('span.oob-sep'));
    });
  }

  function detectLine() {
    const v = (info.usbVendorId || 0).toString(16).padStart(4, '0');
    const fam = { '10c4': 'CP210x', '1a86': 'CH34x', '0403': 'FTDI' }[v] || 'USB-UART';
    return `ESP32-family board detected (${fam} bridge) — but it isn’t answering HCI yet.`;
  }

  function renderBody() {
    clear(body);
    if (w.phase === 'consent') {
      body.append(
        el('p.muted', { text: detectLine() }),
        el('p.hint', { text: 'Flash the bundled Zephyr HCI firmware to turn this board into a Bluetooth controller. The connection stays open — no reconnect needed.' }),
      );
    } else if (w.phase === 'flashing') {
      if (w.manualBoot) {
        body.append(el('p.fw-warn', { text: 'Press and hold the BOOT button — keep holding it. We’ll reset the board for you (or, while still holding BOOT, tap RST/EN once). Flashing starts automatically the moment it enters download mode.' }));
      } else {
        body.append(el('p.muted', { text: w.detail || 'Flashing…' }));
      }
      body.append(budget, logBox);
    } else if (w.phase === 'verifying') {
      body.append(el('p.muted', { text: 'Rebooting into the new firmware and checking HCI…' }), budget, logBox);
    } else if (w.phase === 'done') {
      body.append(el('p.oob-ok', { text: `✓ ${w.chipName || 'Controller'} is up and answering HCI — you’re ready to go.` }), logBox);
    } else if (w.phase === 'failed') {
      body.append(el('p.fw-warn', { text: w.failMsg }), logBox);
    }
  }

  function renderFoot() {
    clear(foot);
    const btn = (label, kind, on, disabled = false) => el('button', { class: 'btn ' + (kind || ''), text: label, disabled, on: { click: on } });
    if (w.phase === 'consent') {
      foot.append(btn('Dismiss', '', () => modal.close()), btn('Flash HCI firmware', 'primary', startFlash));
    } else if (w.phase === 'flashing') {
      // Cancel is safe before bytes start flowing (auto-reset / waiting for BOOT). Once writing,
      // interrupting could leave a half-written flash — so show a "don't disconnect" note instead.
      if (w.manualBoot || w.frac === 0) foot.append(btn('Cancel', '', () => abort?.abort()));
      else foot.append(el('span.muted', { text: 'Writing… do not disconnect.' }));
    } else if (w.phase === 'verifying') {
      foot.append(el('span.muted', { text: 'Verifying…' }));
    } else if (w.phase === 'done') {
      foot.append(btn('Done', 'primary', () => modal.close()));
    } else if (w.phase === 'failed') {
      foot.append(btn('Dismiss', '', () => modal.close()), btn('Retry', 'primary', retry));
    }
  }

  function render() { renderRail(); renderBody(); renderFoot(); }

  const onPhase = (name, detail) => {
    if (name === 'auto-reset') { w.manualBoot = false; w.detail = `Entering download mode… (try ${detail?.attempt || 1})`; }
    else if (name === 'manual-boot') { w.manualBoot = true; }
    else if (name === 'detecting') { w.manualBoot = false; w.detail = 'Detecting chip…'; }
    else if (name === 'detected') { w.chipName = detail?.name || null; w.detail = `Detected ${w.chipName}`; }
    else if (name === 'flashing') { w.manualBoot = false; w.detail = `Writing ${detail?.label || ''} firmware…`; }
    else if (name === 'verifying') { w.phase = 'verifying'; w.detail = 'Rebooting & checking HCI…'; }
    render();
  };
  const onProgress = ({ written, total }) => { w.frac = total ? written / total : 0; bar.style.width = Math.round(w.frac * 100) + '%'; renderFoot(); };

  async function startFlash() {
    Object.assign(w, { phase: 'flashing', detail: 'Entering download mode…', manualBoot: false, frac: 0, failStep: null, failMsg: '' });
    bar.style.width = '0%'; budget.style.display = 'block';
    abort = new AbortController();
    render();
    try {
      const { ready } = await flashEspKeepConnection({ transport, hci, store, signal: abort.signal, onPhase, onProgress, log });
      if (ready) { w.phase = 'done'; }
      else { w.phase = 'failed'; w.failStep = 'verify'; w.failMsg = 'Flashed, but the controller still isn’t answering HCI. Try Retry, or Disconnect → Connect.'; }
    } catch (e) {
      if (abort?.signal.aborted) { w.phase = 'consent'; w.manualBoot = false; abort = null; render(); return; }
      w.phase = 'failed'; w.failStep = 'flash';
      w.failMsg = 'Flashing failed: ' + e.message + (w.chipName ? '' : ' — make sure it’s an ESP32 board; hold BOOT and Retry.');
    }
    abort = null;
    render();
  }

  async function retry() {
    if (w.failStep === 'verify') {
      // Firmware is already on the chip — just reboot + bring HCI up again (no reflash).
      w.phase = 'verifying'; render();
      try {
        if (isEspUartBridge(info)) await transport.espRunReset();
        const c = await bringUp(hci, store);
        if (c.ready) { w.phase = 'done'; }
        else { w.phase = 'failed'; w.failStep = 'verify'; w.failMsg = 'Still no HCI. Try Disconnect → Connect.'; }
      } catch (e) { w.phase = 'failed'; w.failStep = 'verify'; w.failMsg = 'Verify failed: ' + e.message; }
      render();
    } else {
      startFlash();
    }
  }

  render();
}

// ---- nRF52840 dongle DFU wizard (connected in Open DFU Bootloader mode, 1915:521F) ----

const NRF_STEPS = [
  { key: 'connect', label: 'Connect' },
  { key: 'detect', label: 'Detect' },
  { key: 'flash', label: 'Flash' },
  { key: 'reconnect', label: 'Reconnect' },
];

function openNrfDfuWizard({ store, hci, transport }) {
  // phase: 'consent' | 'flashing' | 'reconnect' | 'done' | 'failed'
  const w = { phase: 'consent', failStep: null, failMsg: '', connecting: false };
  const logLines = [];

  const rail = el('div.oob-rail');
  const body = el('div.oob-body');
  const foot = el('div.oob-foot');
  const content = el('div.oob-wizard', {}, rail, body, foot);
  const logBox = el('pre.fw-log', { style: { display: 'none' } });
  const bar = el('div.budget-bar', { style: { width: '0%' } });
  const budget = el('div.budget', { style: { display: 'none' } }, bar);
  const log = (m) => { logLines.push(String(m)); logBox.style.display = 'block'; logBox.textContent = logLines.slice(-12).join('\n'); };

  const modal = openModal({ title: 'Set up your controller', width: '560px', content });

  function railStatus() {
    const s = { connect: 'done', detect: 'done', flash: 'pending', reconnect: 'pending' };
    if (w.phase === 'consent' || w.phase === 'flashing') s.flash = 'active';
    else if (w.phase === 'reconnect') { s.flash = 'done'; s.reconnect = 'active'; }
    else if (w.phase === 'done') { s.flash = 'done'; s.reconnect = 'done'; }
    else if (w.phase === 'failed') {
      s.flash = w.failStep === 'flash' ? 'error' : 'done';
      s.reconnect = w.failStep === 'reconnect' ? 'error' : 'pending';
    }
    return s;
  }

  function renderRail() {
    clear(rail);
    const st = railStatus();
    NRF_STEPS.forEach((step, i) => {
      const status = st[step.key];
      rail.append(el(`div.oob-step.${status}`, {},
        el('span.oob-num', { text: status === 'done' ? '✓' : status === 'error' ? '✕' : String(i + 1) }),
        el('span.oob-step-label', { text: step.label })));
      if (i < NRF_STEPS.length - 1) rail.append(el('span.oob-sep'));
    });
  }

  function renderBody() {
    clear(body);
    if (w.phase === 'consent') {
      body.append(
        el('p.muted', { text: 'nRF52840 Dongle detected in Open DFU Bootloader mode (1915:521F).' }),
        el('p.hint', { text: 'Flash the bundled Zephyr HCI firmware over USB DFU. The dongle reboots into the new firmware, then you reconnect to it.' }),
      );
    } else if (w.phase === 'flashing') {
      body.append(el('p.muted', { text: 'Programming over USB DFU — keep the dongle plugged in…' }), budget, logBox);
    } else if (w.phase === 'reconnect') {
      body.append(
        el('p.oob-ok', { text: '✓ Firmware programmed — the dongle restarted into the HCI app.' }),
        el('p.hint', { text: 'It re-enumerated as a new USB device. Click Reconnect and pick the dongle’s port (give it a second to appear).' }),
        logBox,
      );
    } else if (w.phase === 'done') {
      body.append(el('p.oob-ok', { text: '✓ nRF52840 Dongle is up and answering HCI — you’re ready to go.' }), logBox);
    } else if (w.phase === 'failed') {
      body.append(el('p.fw-warn', { text: w.failMsg }), logBox);
    }
  }

  function renderFoot() {
    clear(foot);
    const btn = (label, kind, on, disabled = false) => el('button', { class: 'btn ' + (kind || ''), text: label, disabled, on: { click: on } });
    if (w.phase === 'consent') {
      foot.append(btn('Dismiss', '', () => modal.close()), btn('Flash HCI firmware', 'primary', startFlash));
    } else if (w.phase === 'flashing') {
      foot.append(el('span.muted', { text: 'Programming… do not unplug.' }));
    } else if (w.phase === 'reconnect') {
      if (w.connecting) foot.append(el('span.muted', { text: 'Connecting…' }));
      else foot.append(btn('Reconnect', 'primary', reconnect));
    } else if (w.phase === 'done') {
      foot.append(btn('Done', 'primary', () => modal.close()));
    } else if (w.phase === 'failed') {
      foot.append(btn('Dismiss', '', () => modal.close()), btn('Retry', 'primary', retry));
    }
  }

  function render() { renderRail(); renderBody(); renderFoot(); }
  const onProgress = ({ written, total }) => { bar.style.width = (total ? Math.round((written / total) * 100) : 0) + '%'; };

  async function startFlash() {
    Object.assign(w, { phase: 'flashing', failStep: null, failMsg: '' });
    bar.style.width = '0%'; budget.style.display = 'block';
    render();
    try {
      await flashNrfDfuConnected({ transport, onProgress, log });
      // The dongle re-enumerated into the app; the bootloader connection is gone.
      store.update((st) => { st.serial.connected = false; st.controller.ready = false; });
      w.phase = 'reconnect';
    } catch (e) {
      w.phase = 'failed'; w.failStep = 'flash';
      w.failMsg = 'DFU flashing failed: ' + e.message + ' — is the dongle in bootloader mode (red LED pulsing)?';
    }
    render();
  }

  async function reconnect() {
    // The button click is the user gesture that lets requestPort() prompt for the re-enumerated port.
    w.connecting = true; renderFoot();
    await connectController({ store, hci, transport }); // never throws — errors land in store.serial.error
    w.connecting = false;
    if (store.state.controller.ready) { w.phase = 'done'; }
    else { w.phase = 'failed'; w.failStep = 'reconnect'; w.failMsg = store.state.serial.error || 'Connected, but no HCI yet — try Reconnect again.'; }
    render();
  }

  function retry() {
    if (w.failStep === 'reconnect') { w.phase = 'reconnect'; render(); reconnect(); }
    else startFlash();
  }

  render();
}

// ---- Fallback for non-ESP-bridge devices (ESP native USB / unknown) ----
// A short notice only — the actual flashing UI (chip picker + flash + firmware download/command) lives
// in the Firmware tab, where it has room. Embedding it in this narrow modal overflowed (ugly scrollbar).

function openFallback({ store, transport }) {
  const info = (() => { try { return transport.port?.getInfo?.() || {}; } catch { return {}; } })();
  openModal({
    title: 'Controller didn’t respond to HCI',
    width: '460px',
    content: el('div.modal-form', {},
      el('p.muted', { text: 'This device isn’t speaking HCI (no answer to Reset).' }),
      isEspNativeUsb(info)
        ? el('p.fw-warn', { text: 'Native USB port detected (USB-Serial/JTAG). The HCI firmware runs on UART0, so it’s reachable only over the board’s UART port (CP210x/CH340). Reconnect via that port, then flash.' })
        : el('p.muted', { text: 'Flash the bundled Zephyr HCI firmware from the Firmware tab, then reconnect.' }),
    ),
    actions: [
      { label: 'Dismiss', onClick: (c) => c() },
      { label: 'Open Firmware tab', kind: 'primary', onClick: (c) => { store.state.ui.activePanel = 'firmware'; c(); } },
    ],
  });
}
