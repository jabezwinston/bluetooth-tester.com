// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Profiles panel: append the Nordic UART Service or a HID keyboard to the GATT table and
// drive them interactively — a serial terminal over NUS, and browser-keystroke → HID report
// redirection. Dynamic areas are persistent nodes so typing/streaming doesn't lose focus.

import { el, clear } from '../dom.js';
import { bytesToHex } from '../../util/bytes.js';
import { normalizeUuid } from '../../util/uuid.js';
import { nusService, NUS_SERVICE, NUS_RX, NUS_TX } from '../../profiles/nus.js';
import { hidKeyboardService, pnpIdService, buildKeyboardReport, decodeLedReport } from '../../profiles/hid.js';

export function createProfilesPanel({ store, conn }) {
  const root = el('div.panel-body');
  const has = (u) => store.state.gatt.services.some((s) => { try { return normalizeUuid(s.uuid) === normalizeUuid(u); } catch { return false; } });

  // ---- persistent dynamic nodes ----
  const term = el('div.term-output');
  const reportHex = el('code.mono', { text: '00 00 00 00 00 00 00 00' });
  const pressedView = el('span.muted', { text: 'none' });
  const ledBox = el('div.leds');
  const ledRaw = el('code.mono.muted', { text: '—' });
  const pressed = new Set();
  let capturing = false;
  let rendering = false; // suppress the capture box's blur handler during a re-render

  const termLine = (dir, text) => {
    term.append(el('div', { class: 'term-line ' + dir }, (dir === 'tx' ? '» ' : '« ') + text));
    while (term.childNodes.length > 300) term.removeChild(term.firstChild);
    term.scrollTop = term.scrollHeight;
  };
  const renderLeds = (leds) => { clear(ledBox); for (const [k, on] of Object.entries(leds)) ledBox.append(el('span', { class: 'led' + (on ? ' on' : ''), text: k.replace('Lock', '') })); };
  renderLeds({ numLock: false, capsLock: false, scrollLock: false });

  // ---- server hooks (registered once) ----
  conn.onCharWrite(NUS_RX, (v) => termLine('rx', new TextDecoder().decode(v)));
  const onLed = (v) => {
    renderLeds(decodeLedReport(v[0] || 0));
    // Show the raw output report so an LED write is visible even when all bits are 0 / the host
    // sends a zero-length report.
    ledRaw.textContent = v.length ? ('0x' + (v[0] & 0xff).toString(16).padStart(2, '0')) : '(empty)';
  };
  conn.onCharWrite('2A4D', onLed); // Output Report (LED)
  conn.onCharWrite('2A32', onLed); // Boot Keyboard Output

  function sendReport() {
    const report = buildKeyboardReport(pressed);
    reportHex.textContent = bytesToHex(report);
    pressedView.textContent = [...pressed].join(' ') || 'none';
    const h = conn.findCharValueHandle('2A4D', true); // input report (notify)
    if (h != null) conn.notify(h, report);
  }
  const LOCK_KEYS = new Set(['CapsLock', 'NumLock', 'ScrollLock']);
  const LOCK_TAP_MS = 100; // hold a lock-key "tap" long enough to land in a later connection event
  const releaseAll = () => { if (!rendering && pressed.size) { pressed.clear(); sendReport(); } };
  const captureBox = el('div.capture-box', { attrs: { tabindex: '0' }, text: 'Click here, then type — each keystroke is sent as a HID input report.' });
  captureBox.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    if (pressed.has(e.code)) return; // ignore auto-repeat
    pressed.add(e.code);
    sendReport();
    // Lock keys (Caps/Num/Scroll) toggle on the host per press+release. Browsers don't emit a
    // reliable keyup for them (it only arrives once the lock is later cleared), so emit the
    // release ourselves — but after a hold, NOT instantly: a 0-ms press lands in the same
    // connection event as the release and the host debounces it as noise (never toggles, so the
    // LED report stays 0x00). Holding ~100 ms makes it a genuine keypress the host acts on.
    if (LOCK_KEYS.has(e.code)) setTimeout(() => { if (pressed.delete(e.code)) sendReport(); }, LOCK_TAP_MS);
  });
  captureBox.addEventListener('keyup', (e) => { if (!capturing) return; e.preventDefault(); if (pressed.delete(e.code)) sendReport(); });
  // Missed keyups (focus change, Alt-Tab, the lock-key quirk) would otherwise leave keys stuck
  // down forever — release everything when the capture box loses focus.
  captureBox.addEventListener('blur', releaseAll);

  // ---- NUS ----
  function nusCard() {
    if (!has(NUS_SERVICE)) {
      return el('div.card', {}, el('h3', { text: 'Nordic UART Service' }),
        el('p.muted', { text: 'Serial-over-BLE: the client writes to RX, the peripheral notifies on TX.' }),
        el('button.btn.primary', { text: '+ Add NUS to GATT', on: { click: () => { store.state.gatt.services = [...store.state.gatt.services, nusService()]; conn.setGattTable(store.state.gatt); } } }));
    }
    const input = el('input', { type: 'text', placeholder: 'type, then Send (TX notify)', style: { flex: '1' } });
    const nl = el('input', { type: 'checkbox', checked: true });
    const send = () => {
      let text = input.value; if (!text) return;
      const bytes = new TextEncoder().encode(nl.checked ? text + '\n' : text);
      const h = conn.findCharValueHandle(NUS_TX, true);
      const n = h != null ? conn.notify(h, bytes) : 0;
      termLine('tx', text + (n ? '' : '  (no subscriber)'));
      input.value = '';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    return el('div.card', {}, el('h3', { text: 'Nordic UART — Terminal' }),
      term,
      el('div.row', {}, input, el('label.inline', {}, nl, ' +LF'), el('button.btn.primary', { text: 'Send', on: { click: send } })));
  }

  // ---- HID keyboard ----
  function hidCard() {
    if (!has('1812')) {
      return el('div.card', {}, el('h3', { text: 'HID Keyboard (HOGP)' }),
        el('p.muted', { text: 'Appends a HID keyboard service (+ Device Information / PnP ID) and advertises as a keyboard. Real hosts require bonding before HID works.' }),
        el('button.btn.primary', { text: '+ Add HID Keyboard', on: { click: addHidKeyboard } }));
    }
    const toggle = el('button', { class: 'btn ' + (capturing ? 'danger' : 'primary'), text: capturing ? '■ Stop capture' : '▶ Start capture',
      on: { click: () => { capturing = !capturing; render(); if (capturing) captureBox.focus(); } } });
    return el('div.card', {}, el('h3', { text: 'HID Keyboard — Input Redirect' }),
      el('div.row', {}, toggle, el('span.muted', { text: capturing ? 'capturing — focus the box below' : 'stopped' })),
      captureBox,
      el('div.card-grid', {}, el('span.k', { text: 'Report' }), reportHex, el('span.k', { text: 'Pressed' }), pressedView,
        el('span.k', { text: 'Host LEDs' }), el('div.row', {}, ledBox, ledRaw)),
      el('p.muted', { text: 'The Input Report is marked encryption-required; pair/bond first on a real host. Notifications here are sent regardless for testing.' }));
  }

  function addHidKeyboard() {
    const svcs = store.state.gatt.services.filter((s) => { try { return normalizeUuid(s.uuid) !== '1812'; } catch { return true; } });
    if (!has('180A')) svcs.push(pnpIdService());
    svcs.push(hidKeyboardService());
    store.state.gatt.services = svcs;
    store.state.advertiser.appearance = 0x03c1; // HID Keyboard
    store.state.advertiser.placement.appearance = 'adv';
    if (!store.state.advertiser.serviceUuids16.includes(0x1812)) store.state.advertiser.serviceUuids16 = [...store.state.advertiser.serviceUuids16, 0x1812];
    store.state.advertiser.placement.uuids16 = 'adv';
    conn.setGattTable(store.state.gatt);
  }

  function render() {
    // A re-render (e.g. the host's LED write triggers a connection _sync) rebuilds the cards and
    // would detach the focused capture box mid-capture — losing focus and forcing a re-click after
    // every Caps Lock. Preserve focus across the rebuild; `rendering` keeps the transient blur from
    // releasing held keys.
    const refocus = document.activeElement === captureBox;
    rendering = true;
    clear(root); root.append(nusCard(), hidCard());
    if (refocus) captureBox.focus();
    rendering = false;
  }
  render();
  store.subscribe(render);
  return { id: 'profiles', title: 'Profiles', el: root };
}
