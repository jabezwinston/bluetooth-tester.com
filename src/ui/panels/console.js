// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Raw HCI console: send a known or hand-typed command and see the decoded completion.
// All traffic also appears in the Log panel; this panel is just a sender + immediate result.

import { el, clear, field } from '../dom.js';
import { hexToBytes, bytesToHex } from '../../util/bytes.js';
import { restrictHexBytes } from '../hex-input.js';
import * as cmd from '../../hci/commands.js';
import { opcodeName } from '../../hci/opcodes.js';
import { hciError } from '../../hci/codes.js';

const QUICK = [
  ['Reset', cmd.reset],
  ['Read Local Version', cmd.readLocalVersion],
  ['Read BD_ADDR', cmd.readBdAddr],
  ['LE Read Local Features', cmd.leReadLocalSupportedFeatures],
  ['LE Read Supported States', cmd.leReadSupportedStates],
  ['LE Rand', cmd.leRand],
];

export function createConsolePanel({ store, hci }) {
  const root = el('div.panel-body');
  const result = el('div.console-result', { text: 'No command sent yet.' });

  const opcodeInput = el('input', { type: 'text', placeholder: 'opcode e.g. 0x0C03', value: '0x0C03' });
  const paramsInput = restrictHexBytes(el('input', { type: 'text', placeholder: 'parameters hex e.g. 01 0A FF' }));

  async function send(command) {
    if (!store.state.serial.connected) { showError('Not connected.'); return; }
    try {
      const ev = await hci.sendCommand(command);
      showResult(command, ev);
    } catch (e) {
      showError(e.message);
    }
  }

  function sendManual() {
    let opcode;
    try {
      opcode = parseInt(opcodeInput.value.trim(), 16);
      if (Number.isNaN(opcode)) throw new Error('bad opcode');
    } catch {
      showError('Invalid opcode (use hex, e.g. 0x0C03).');
      return;
    }
    let params;
    try { params = hexToBytes(paramsInput.value); } catch (e) { showError('Invalid parameter hex: ' + e.message); return; }
    send(cmd.raw(opcode, params));
  }

  function showResult(command, ev) {
    clear(result);
    const rows = [
      ['Command', `${command.name || opcodeName(command.opcode)} (0x${command.opcode.toString(16).padStart(4, '0')})`],
    ];
    if (ev.type === 'command_complete') {
      if (ev.status != null) rows.push(['Status', `${hciError(ev.status)} (0x${ev.status.toString(16).padStart(2, '0')})`]);
      rows.push(['Return params', ev.returnParams.length ? bytesToHex(ev.returnParams) : '(none)']);
      if (ev.decoded) rows.push(['Decoded', JSON.stringify(ev.decoded, replacer, 1)]);
    } else if (ev.type === 'command_status') {
      rows.push(['Command Status', `${hciError(ev.status)} (0x${ev.status.toString(16).padStart(2, '0')})`]);
    }
    result.classList.remove('is-error');
    for (const [k, v] of rows) result.append(el('div.kv', {}, el('span.k', { text: k }), el('span.v', { text: v })));
  }

  function showError(msg) {
    clear(result);
    result.classList.add('is-error');
    result.append(el('div', { text: '⚠ ' + msg }));
  }

  function render() {
    clear(root);
    const connected = store.state.serial.connected;
    const quick = el('div.btn-grid', {}, ...QUICK.map(([label, factory]) =>
      el('button.btn', { text: label, disabled: !connected, on: { click: () => send(factory()) } })));

    root.append(
      el('h3', { text: 'Quick commands' }),
      quick,
      el('h3', { text: 'Manual command' }),
      el('div.row', {}, field('Opcode (hex)', opcodeInput), field('Parameters (hex)', paramsInput),
        el('button.btn.primary', { text: 'Send', disabled: !connected, on: { click: sendManual } })),
      el('h3', { text: 'Result' }),
      result,
    );
  }

  render();
  store.subscribe(render);
  return { id: 'console', title: 'HCI Console', el: root };
}

function replacer(_k, v) {
  if (v instanceof Uint8Array) return bytesToHex(v);
  return v;
}
