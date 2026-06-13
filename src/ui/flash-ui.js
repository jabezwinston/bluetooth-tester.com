// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Shared flash UI block: a controller picker + method-specific action (esptool / nRF DFU / J-Link
// download), a progress bar and a log. Used by the Firmware panel and as the OOB wizard's fallback for
// non-ESP devices. ESP boards keep the live connection (flashEspKeepConnection); nRF DFU closes it first.

import { el, clear, field } from './dom.js';
import { CHIPS, CHIP_IDS, flashCommand, firmwareFileName, isEspNativeUsb } from '../data/firmware-manifest.js';
import { flash, flashEspKeepConnection, nrfDfuPackage } from './flash-core.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A full-width, horizontally-scrollable command line with a copy-icon button (the ⧉ glyph the
// Prototype panel uses; flips to ✓ on copy).
function commandBox(text) {
  const copy = el('button.fw-copy', { attrs: { type: 'button', title: 'Copy command' }, text: '⧉', on: { click: async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = '✓'; }
    catch { copy.textContent = '✕'; }
    setTimeout(() => { copy.textContent = '⧉'; }, 1200);
  } } });
  return el('div.fw-cmd-box', {}, el('pre.fw-cmd', { text }), copy);
}

export function flashControls({ store, hci, transport, defaultChip }) {
  let chipId = defaultChip && CHIPS[defaultChip] ? defaultChip : 'esp32';
  let busy = false;
  const logLines = [];
  const logBox = el('pre.fw-log', { style: { display: 'none' } });
  const bar = el('div.budget-bar', { style: { width: '0%' } });
  const budget = el('div.budget', { style: { display: 'none' } }, bar, el('span.budget-label', {}));
  const body = el('div.fw-body', {});
  const note = (m) => { logLines.push(String(m)); logBox.style.display = 'block'; logBox.textContent = logLines.slice(-14).join('\n'); };

  const select = el('select', { on: { change: (e) => { chipId = e.target.value; renderBody(); } } },
    ...CHIP_IDS.map((id) => el('option', { value: id, selected: id === chipId, text: CHIPS[id].label + (id === defaultChip ? ' — detected' : '') })));

  async function doFlash() {
    const method = CHIPS[chipId].method;
    const onProgress = ({ written, total }) => { bar.style.width = (total ? Math.round((written / total) * 100) : 0) + '%'; };

    if (method === 'esptool') {
      // ESP keeps the SAME WebSerial connection. The connection is only ever made via the Connect
      // button, so flashing requires it already open. flashEspKeepConnection borrows the live port,
      // flashes (auto-detect + manual-BOOT fallback), and brings HCI back up — all without a reconnect.
      if (!store.state.serial.connected) { note('Connect first (header) — flashing reuses the open connection.'); return; }
      busy = true; renderBody();
      budget.style.display = 'block';
      note('borrowing the open connection for flashing (kept open)…');
      try {
        const { ready } = await flashEspKeepConnection({ transport, hci, store, onProgress, log: note });
        bar.style.width = '100%';
        note(ready ? '✓ HCI is up — controller ready.' : '✗ still no HCI — use Disconnect/Connect.');
      } catch (e) { note('✗ ' + e.message); }
      busy = false; renderBody();
      return;
    }

    // nRF DFU: the dongle re-enumerates as a separate bootloader device on RESET — the HCI connection
    // can't survive, so this genuinely disconnects and re-picks the bootloader port.
    busy = true; renderBody();
    note('disconnecting HCI session…');
    try { await transport.close(); } catch {}
    store.update((s) => { s.serial.connected = false; s.controller.ready = false; });
    budget.style.display = 'block';
    try {
      await flash(chipId, { log: note, onProgress });
      bar.style.width = '100%';
    } catch (e) { note('✗ ' + e.message); }
    busy = false; renderBody();
  }

  // Download + CLI flash command for the bundled firmware — offered for EVERY board. J-Link boards can
  // only be flashed this way; ESP / nRF-dongle also support the in-app Flash button above.
  function cliSection(c) {
    const file = firmwareFileName(chipId);
    const wrap = el('div.fw-cli', {},
      el('p.muted', { text: c.method === 'jlink'
        ? `${c.label} has onboard J-Link — a browser can’t flash it. Download the firmware and run:`
        : 'Prefer the command line? Download the firmware and run:' }),
      commandBox(flashCommand(chipId)));
    if (c.method === 'nrf-dfu') {
      // The DFU package (.zip) is assembled in-browser from the bundled init.dat + app.bin.
      const dl = el('button.btn', { text: `⬇ Download ${file}`, on: { click: async () => {
        const label = dl.textContent; dl.disabled = true; dl.textContent = 'Packaging…';
        try { downloadBlob(await nrfDfuPackage(), file); } catch (e) { note('✗ ' + e.message); }
        dl.disabled = false; dl.textContent = label;
      } } });
      wrap.append(dl);
    } else {
      const url = c.method === 'jlink' ? c.hex : c.images[0].file;
      wrap.append(el('a.btn', { attrs: { href: url, download: file }, text: `⬇ Download ${file}` }));
    }
    return wrap;
  }

  function renderBody() {
    clear(body);
    const c = CHIPS[chipId];
    // In-app flashing over Web Serial (esptool / nRF-DFU). J-Link boards can't be browser-flashed.
    if (c.method === 'esptool' && isEspNativeUsb(transport.port?.getInfo?.() || {})) {
      // Connected over the integrated USB-Serial/JTAG: flashing would work but the HCI firmware lives
      // on UART0, so HCI would never appear. Steer the user to the UART-bridge port instead of letting
      // them flash into a dead end.
      body.append(el('p.fw-warn', { text: 'Native USB port detected (USB-Serial/JTAG). The HCI firmware runs on UART0, so it’s reachable only over the board’s UART port (CP210x/CH340). Reconnect via that port, then flash.' }));
      body.append(el('button.btn.primary', { text: `Flash ${c.label}`, disabled: true }));
    } else if (c.method === 'esptool' || c.method === 'nrf-dfu') {
      body.append(el('p.muted', { text: c.method === 'nrf-dfu' ? c.reset : 'If it can’t enter download mode, hold the board’s BOOT button while flashing.' }));
      body.append(el('button.btn.primary', { text: busy ? 'Flashing…' : `Flash ${c.label}`, disabled: busy, on: { click: doFlash } }));
    }
    body.append(cliSection(c));
  }
  renderBody();
  return el('div.flash-controls', {}, field('Controller', select), body, budget, logBox);
}
