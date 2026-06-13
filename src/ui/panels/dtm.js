// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Direct Test Mode (RF test) — LE Transmitter / Receiver Test + Test End. Raw radio test, no
// connection needed. Monopolizes the radio; the panel auto-ends the test when you leave it or the
// link drops. Uses the highest test-command version the controller supports (v1 / v2 PHY / v4 power),
// gated on the reported Supported_Commands + LE features (see host/dtm-caps.js).

import { el, clear, field } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import * as cmd from '../../hci/commands.js';
import { OPCODE } from '../../hci/opcodes.js';
import { dtmCaps, availableTxPhys, availableRxPhys } from '../../host/dtm-caps.js';

// DTM command opcodes — used to recognise when a controller rejects a *test* command (vs. other HCI).
const TEST_OPS = new Set([OPCODE.LE_TRANSMITTER_TEST, OPCODE.LE_RECEIVER_TEST, OPCODE.LE_TEST_END,
  OPCODE.LE_TRANSMITTER_TEST_V2, OPCODE.LE_RECEIVER_TEST_V2, OPCODE.LE_TRANSMITTER_TEST_V4]);

const PAYLOADS = [[0, 'PRBS9'], [1, '11110000'], [2, '10101010'], [3, 'PRBS15'], [4, 'All 1s (0xFF)'], [5, 'All 0s (0x00)'], [6, '00001111'], [7, '01010101']];
const freqOf = (ch) => 2402 + ch * 2; // DTM channel index (0–39) → MHz
const ADV_FREQ = { 0: '2402 adv', 12: '2426 adv', 39: '2480 adv' };
const freqLabel = (ch) => ADV_FREQ[ch] ? `${freqOf(ch)} MHz · adv ch` : `${freqOf(ch)} MHz`;
const clampCh = (v) => Math.max(0, Math.min(39, parseInt(v, 10) || 0));
const clampByte = (v) => Math.max(0, Math.min(255, parseInt(v, 10) || 0));

// On-air duration (µs) of a test packet for a PHY (1=1M, 2=2M, 3=Coded S8, 4=Coded S2) + payload length.
function airTimeUs(phy, len) {
  if (phy === 2) return (11 + len) * 4;                                  // 2M: 2B preamble, 4 µs/byte
  if (phy >= 3) {                                                        // Coded: FEC block1 @S=8, block2 @S
    const S = phy === 4 ? 2 : 8;
    return 80 + (4 * 8 + 2 + 3) * 8 + ((2 + len + 3) * 8 + 3) * S;       // preamble + (AA+CI+TERM1)@S8 + (PDU+CRC+TERM2)@S
  }
  return (10 + len) * 8;                                                  // 1M: 1B preamble, 8 µs/byte
}
// DTM transmitter packet rate (packets/s): the packet interval is the air time + 249 µs rounded up to a
// 625 µs grid (Core v6.0 Vol 6 Part F §4.1.6); rate = 1 / interval.
function packetRateHz(phy, len) {
  const intervalUs = Math.ceil((airTimeUs(phy, len) + 249) / 625) * 625;
  return Math.round(1e6 / intervalUs);
}

export function createDtmPanel({ store, hci }) {
  const root = el('div.panel-body.dtm');
  let mode = null;            // 'tx' | 'rx'
  let rxResult = null;        // last RX packet count
  let lastRxMs = null;        // duration (ms) of the last RX test — for the measured rate
  let lastExpected = null;    // auto-computed expected packet count (TX rate × duration) for PER
  let lastPer = null;         // computed PER % for last RX (or null)
  let lastTxPower = null;     // actual TX power (dBm) reported by v4
  let error = null;
  let startedAt = null;       // ms timestamp the current test started
  let tick = null;            // interval updating the elapsed readout (no full re-render)
  let elapsedNode = null;
  let dtmUnsupported = false;  // set when a test command is rejected with Unknown HCI Command (0x01)

  const tx = { ch: 0, len: 37, payload: 0, phy: 1, power: 'default' /* default|max|min|<dBm> */, powerDbm: 0 };
  // txLen / coding describe the *remote* transmitter (a separate device/browser) — needed to compute
  // the expected packet count for PER, since the receiver can't know what's being sent.
  const rx = { ch: 0, phy: 1, modIndex: 0, txLen: 37, coding: 3 /* 3=Coded S8, 4=Coded S2 */ };

  const caps = () => dtmCaps(store.state.controller);
  const ready = () => !!store.state.controller.ready;
  const advertising = () => !!store.state.advertiser.enabled;
  const txPhy = () => caps().canSelectTxPhy ? tx.phy : 1;

  // ---- running a test ----
  async function send(command, after) {
    error = null;
    try { const ev = await hci.command(command); if (after) after(ev); }
    catch (e) {
      error = e.message; mode = null; stopTick();
      // A test command rejected as Unknown HCI Command (0x01) means the controller firmware has no DTM.
      if (TEST_OPS.has(command.opcode) && /\(0x01\)/.test(e.message)) dtmUnsupported = true;
    }
    render();
  }

  function txCommand(channel) {
    const c = caps();
    const phy = txPhy();
    if (tx.power !== 'default' && c.canSetTxPower) return cmd.leTransmitterTestV4(channel, tx.len, tx.payload, phy, txPowerByte());
    if (phy !== 1 && c.txV2) return cmd.leTransmitterTestV2(channel, tx.len, tx.payload, phy);
    if (phy !== 1 && c.txV4) return cmd.leTransmitterTestV4(channel, tx.len, tx.payload, phy, 0x7f); // PHY needs enhanced; max power
    return cmd.leTransmitterTest(channel, tx.len, tx.payload);
  }
  function rxCommand(channel) {
    const c = caps();
    const phy = c.canSelectRxPhy ? rx.phy : 1;
    const wantV2 = (phy !== 1 || (rx.modIndex && c.canSetModIndex));
    if (wantV2 && c.rxV2) return cmd.leReceiverTestV2(channel, phy, rx.modIndex);
    return cmd.leReceiverTest(channel);
  }
  const txPowerByte = () => tx.power === 'max' ? 0x7f : tx.power === 'min' ? 0x7e : Math.max(-127, Math.min(20, tx.powerDbm | 0));
  const txPowerOf = (ev) => (ev && ev.decoded && ev.decoded.txPower != null) ? ev.decoded.txPower : null;

  function startTx() {
    rxResult = null; lastPer = null; lastTxPower = null; lastExpected = null;
    send(txCommand(tx.ch), (ev) => { mode = 'tx'; lastTxPower = txPowerOf(ev); startTick(); });
  }
  function startRx() {
    rxResult = null; lastPer = null; lastTxPower = null; lastExpected = null;
    send(rxCommand(rx.ch), () => { mode = 'rx'; startTick(); });
  }
  function endTest() {
    const wasRx = mode === 'rx', ms = startedAt ? Date.now() - startedAt : 0;
    stopTick();
    return send(cmd.leTestEnd(), (ev) => {
      if (wasRx) {
        rxResult = ev && ev.decoded ? ev.decoded.numPackets : 0;
        lastRxMs = ms;
        // Expected sent ≈ the remote transmitter's packet rate (RX PHY + the TX length/coding the user
        // entered; for Coded the receiver auto-detects S, so the user picks the transmitter's S) × window.
        lastExpected = Math.round(packetRateHz(rx.phy === 3 ? rx.coding : rx.phy, rx.txLen) * (ms / 1000));
        lastPer = lastExpected > 0 ? Math.max(0, Math.min(100, ((lastExpected - rxResult) / lastExpected) * 100)) : null;
      }
      mode = null;
    });
  }

  // ---- elapsed readout (updates text only, no re-render so inputs keep focus) ----
  function startTick() { startedAt = Date.now(); stopTick(); tick = setInterval(() => { if (elapsedNode) elapsedNode.textContent = elapsedStr(); }, 250); }
  function stopTick() { if (tick) { clearInterval(tick); tick = null; } }
  const elapsedStr = () => startedAt ? `${((Date.now() - startedAt) / 1000).toFixed(1)} s` : '';

  async function stopAdvertising() { await send(cmd.leSetAdvEnable(false), () => { store.state.advertiser.enabled = false; }); }

  // ---- auto-leave test mode when navigating away / disconnecting ----
  store.subscribe(() => {
    if (mode && store.state.ui.activePanel !== 'dtm') endTest();
    if (mode && !store.state.serial.connected) { mode = null; stopTick(); }
    if (!store.state.serial.connected) dtmUnsupported = false; // a fresh controller may differ
  });

  // ---- rendering ----
  function numField(label, get, set, attrs, disabled, helpKey) {
    return field(label, el('input', { type: 'number', value: get(), disabled, attrs, on: { change: (e) => { set(e.target.value); render(); } } }), null, helpKey);
  }
  // Channel selector: a 0–39 slider (ticks at the advertising channels) synced with a number box and a
  // live frequency readout. Updates its own nodes on drag so the panel doesn't re-render mid-slide.
  function chanField(label, get, set, helpKey) {
    const busy = !!mode;
    const num = el('input.ch-num', { type: 'number', value: get(), disabled: busy, attrs: { min: 0, max: 39, maxlength: 2 } });
    const slider = el('input.ch-slider', { type: 'range', value: get(), disabled: busy, attrs: { min: 0, max: 39, step: 1, list: 'dtm-adv-ch' } });
    const hint = el('span.field-hint.ch-hint', { text: freqLabel(get()) });
    const sync = (v) => { v = clampCh(v); set(v); num.value = v; slider.value = v; hint.textContent = freqLabel(v); };
    num.addEventListener('change', () => sync(num.value));
    slider.addEventListener('input', () => sync(slider.value));
    return el('div.ch-field', {}, applyHelp(el('span.field-label', {}, label), helpKey), el('div.ch-row', {}, slider, num), hint);
  }

  function capsLine() {
    const c = caps();
    const chip = (label, on) => el('span', { class: 'cap-chip' + (on ? ' on' : ''), text: (on ? '✓ ' : '· ') + label });
    return el('div.cap-line', {},
      el('span.muted', { text: `Test cmd: TX v${c.txVersion} · RX v${c.rxVersion}` }),
      chip('2M', c.phy2m), chip('Coded', c.phyCoded), chip('TX power', c.canSetTxPower), chip('Mod index', c.canSetModIndex),
      c.known ? null : el('span.muted', { text: '(capabilities unread — assuming basic v1)' }));
  }

  function render() {
    clear(root);
    root.append(el('div.warn-box', { text: 'Direct Test Mode drives the radio directly and monopolizes the controller. Stop advertising / disconnect first. The test auto-ends when you leave this tab; afterwards Reset (HCI Console) or reconnect to fully exit test mode.' }));
    if (!store.state.serial.connected) { root.append(el('div.empty', { text: 'Connect a controller to run RF tests.' })); return; }
    if (!ready()) { root.append(el('div.empty', { text: 'Controller bring-up not complete yet.' })); return; }

    root.append(capsLine());
    if (dtmUnsupported) root.append(el('div.warn-box', { html:
      'This controller’s firmware rejected the test command with <strong>Unknown HCI Command (0x01)</strong> — it doesn’t implement Direct Test Mode, even if its supported-commands list advertises it. '
      + 'Rebuild the controller firmware with DTM enabled (Zephyr: <code>CONFIG_BT_CTLR_DTM_HCI=y</code>).' }));
    root.append(el('datalist', { id: 'dtm-adv-ch' }, ...[0, 12, 39].map((c) => el('option', { value: String(c) })))); // ticks at adv channels
    if (advertising()) root.append(el('div.warn-box', {}, 'Advertising is enabled — it will conflict with the radio test. ',
      el('button.btn.btn-sm', { text: 'Stop advertising', on: { click: stopAdvertising } })));

    if (mode) {
      const ch = mode === 'rx' ? rx.ch : tx.ch;
      elapsedNode = el('span.mono', { text: elapsedStr() });
      root.append(el('div.status-line', {}, el('span.dot.on'),
        el('span', { text: `Running ${mode.toUpperCase()} — RF ch ${ch} (${freqOf(ch)} MHz)${mode === 'tx' && lastTxPower != null ? ` · ${lastTxPower} dBm` : ''} · ` }), elapsedNode,
        el('button.btn.danger', { text: 'End test', on: { click: () => endTest() } })));
    }

    root.append(el('div.cards', {}, txCard(), rxCard()));
    if (error) root.append(el('div.error-box', { text: error }));
  }

  function txCard() {
    const c = caps();
    const busy = !!mode;
    const rate = packetRateHz(txPhy(), tx.len);
    const row = el('div.row', {},
      numField('Length (0–255)', () => tx.len, (v) => { tx.len = clampByte(v); }, { min: 0, max: 255 }, busy, 'dtm.length'),
      field('Payload', el('select', { disabled: busy, on: { change: (e) => { tx.payload = parseInt(e.target.value, 10); } } }, ...PAYLOADS.map(([v, l]) => el('option', { value: v, selected: tx.payload === v, text: l }))), null, 'dtm.pattern'));
    if (c.canSelectTxPhy) row.append(field('PHY', el('select', { disabled: busy, style: { width: 'fit-content' }, on: { change: (e) => { tx.phy = parseInt(e.target.value, 10); render(); } } },
      ...availableTxPhys(c).map(([v, l]) => el('option', { value: v, selected: tx.phy === v, text: l }))), null, 'dtm.phy'));
    if (c.canSetTxPower) {
      const sel = el('select', { disabled: busy, style: { width: 'fit-content' }, on: { change: (e) => { tx.power = e.target.value === 'dbm' ? 'dbm' : e.target.value; render(); } } },
        ...[['default', 'Controller default'], ['max', 'Maximum'], ['min', 'Minimum'], ['dbm', 'Custom dBm…']].map(([v, l]) => el('option', { value: v, selected: tx.power === v, text: l })));
      row.append(field('TX power', sel, null, 'dtm.txPower'));
      if (tx.power === 'dbm') {
        // A dBm slider with a live readout (most BLE controllers cover roughly −40…+8 dBm; the
        // controller clamps to its real grid and reports the achieved value back on the v4 test).
        const out = el('span.field-hint.pwr-out', { text: `${tx.powerDbm} dBm` });
        const sl = el('input.ch-slider', { type: 'range', value: tx.powerDbm, disabled: busy, attrs: { min: -40, max: 8, step: 1 } });
        sl.addEventListener('input', () => { tx.powerDbm = parseInt(sl.value, 10); out.textContent = `${tx.powerDbm} dBm`; });
        row.append(el('div.field.pwr-field', {}, el('span.field-label', { text: 'TX power (dBm)' }), el('div.ch-row', {}, sl, out)));
      }
    }
    row.append(el('button.btn.primary', { text: 'Start TX', disabled: busy, on: { click: startTx } }));
    return el('div.card', {}, el('h3', { text: 'Transmitter test' }), chanField('RF Channel (0–39)', () => tx.ch, (v) => { tx.ch = v; }, 'dtm.channel'), row,
      el('div.kv-row', {}, el('div.kv', {}, el('span.k', { text: 'Packet rate' }), el('span.v.mono', { text: `≈ ${rate.toLocaleString()} pkt/s` }))),
      el('p.field-hint', { text: 'Theoretical continuous-test rate, from PHY + length (Core Vol 6 Part F). On the receiving device, enter this length as the RX “TX pkt length” for PER.' }));
  }

  function rxCard() {
    const c = caps();
    const busy = !!mode;
    const row = el('div.row', {});
    if (c.canSelectRxPhy) row.append(field('PHY', el('select', { disabled: busy, style: { width: 'fit-content' }, on: { change: (e) => { rx.phy = parseInt(e.target.value, 10); render(); } } },
      ...availableRxPhys(c).map(([v, l]) => el('option', { value: v, selected: rx.phy === v, text: l }))), null, 'dtm.phy'));
    if (c.canSetModIndex) row.append(field('Modulation index', el('select', { disabled: busy, style: { width: 'fit-content' }, on: { change: (e) => { rx.modIndex = parseInt(e.target.value, 10); } } },
      ...[[0, 'Standard'], [1, 'Stable']].map(([v, l]) => el('option', { value: v, selected: rx.modIndex === v, text: l }))), null, 'dtm.modIndex'));
    // Remote-transmitter parameters for the PER expected-count (the TX runs in a separate browser/device).
    row.append(numField('TX pkt length', () => rx.txLen, (v) => { rx.txLen = clampByte(v); }, { min: 0, max: 255 }, busy));
    if (c.canSelectRxPhy && rx.phy === 3) row.append(field('TX coding', el('select', { disabled: busy, style: { width: 'fit-content' }, on: { change: (e) => { rx.coding = parseInt(e.target.value, 10); } } },
      ...[[3, 'S=8'], [4, 'S=2']].map(([v, l]) => el('option', { value: v, selected: rx.coding === v, text: l })))));
    row.append(el('button.btn.primary', { text: 'Start RX', disabled: busy, on: { click: startRx } }));

    let result = null;
    if (rxResult != null) {
      const rateHz = lastRxMs ? Math.round(rxResult / (lastRxMs / 1000)) : null;
      result = el('div', {},
        el('div.kv-row', {},
          el('div.kv', {}, el('span.k', { text: 'Received' }), el('span.v.mono', { text: rxResult.toLocaleString() })),
          lastExpected != null ? el('div.kv', {}, el('span.k', { text: 'Expected' }), el('span.v.mono', { text: `≈ ${lastExpected.toLocaleString()}` })) : null,
          rateHz != null ? el('div.kv', {}, el('span.k', { text: 'Rate' }), el('span.v.mono', { text: `${rateHz.toLocaleString()} pkt/s` })) : null,
          lastPer != null ? el('div.kv', {}, el('span.k', { text: 'PER' }), el('span.v.mono', { text: `${lastPer.toFixed(2)} %` })) : null),
        lastExpected != null && lastExpected < 1500
          ? el('p.field-hint', { text: 'Low count — run longer (≥1500 packets) on a fixed channel for a reliable PER.' })
          : null);
    }
    return el('div.card', {}, el('h3', { text: 'Receiver test' }), chanField('RF Channel (0–39)', () => rx.ch, (v) => { rx.ch = v; }, 'dtm.channel'), row,
      el('p.field-hint', { text: 'PER is auto-computed: expected = packet rate (from this RX PHY + the remote transmitter’s “TX pkt length”) × test duration. Set the same PHY on both ends; for Coded, the receiver auto-detects S — pick the transmitter’s S=8/S=2 here for the rate.' }),
      result);
  }

  render();
  store.subscribe(render);
  return { id: 'dtm', title: 'RF Test', el: root };
}
