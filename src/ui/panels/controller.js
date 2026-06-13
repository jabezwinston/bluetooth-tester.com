// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Controller Info panel: decoded version, addresses, buffers, capabilities and LE features.

import { el, clear } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import { bitSet } from '../../util/bytes.js';
import { companyName, CORE_VERSION } from '../../data/assigned.js';
import { bringUp } from '../../host/controller.js';

const LE_FEATURE_NAMES = [
  'LE Encryption', 'Connection Parameters Request', 'Extended Reject Indication',
  'Peripheral-initiated Features Exchange', 'LE Ping', 'LE Data Packet Length Extension',
  'LL Privacy', 'Extended Scanner Filter Policies', 'LE 2M PHY', 'Stable Modulation Index - Tx',
  'Stable Modulation Index - Rx', 'LE Coded PHY', 'LE Extended Advertising', 'LE Periodic Advertising',
  'Channel Selection Algorithm #2', 'LE Power Class 1', 'Minimum Number of Used Channels',
  'Connection CTE Request', 'Connection CTE Response', 'Connectionless CTE Tx', 'Connectionless CTE Rx',
  'Antenna Switching During CTE Tx (AoD)', 'Antenna Switching During CTE Rx (AoA)', 'Receiving CTE',
  'Periodic Adv Sync Transfer - Sender', 'Periodic Adv Sync Transfer - Recipient',
  'Sleep Clock Accuracy Updates', 'Remote Public Key Validation', 'CIS - Central', 'CIS - Peripheral',
  'Isochronous Broadcaster', 'Synchronized Receiver',
];

const CAP_LABELS = {
  extendedAdvertising: 'Extended Advertising',
  periodicAdvertising: 'Periodic Advertising',
  le2mPhy: '2M PHY',
  leCodedPhy: 'Coded PHY',
  leDataLengthExtension: 'Data Length Ext.',
  channelSelection2: 'Channel Sel. #2',
};

// Capability chips are the same concepts as LE feature bits — reuse the feature help text.
const CAP_HELP = {
  extendedAdvertising: 'ctrl.feat.12', periodicAdvertising: 'ctrl.feat.13', le2mPhy: 'ctrl.feat.8',
  leCodedPhy: 'ctrl.feat.11', leDataLengthExtension: 'ctrl.feat.5', channelSelection2: 'ctrl.feat.14',
};

// Colour a card value by role so Version/Buffers read like the advertiser preview: a human-readable
// name is green, a trailing "(0x..)" or unit is muted, a bare hex code/address is cyan, and a leading
// number is amber. Falls back to plain text for anything that doesn't fit a known shape.
function roleValue(v) {
  if (v == null || v === '') return el('span.v', { text: '—' });
  const s = String(v);
  let m;
  if ((m = s.match(/^(.+?)\s*(\(0x[0-9a-fA-F]+\))$/)))            // "Name (0x..)"
    return el('span.v', {}, el('span.v-name', { text: m[1] }), ' ', el('span.muted', { text: m[2] }));
  if (/^0x[0-9a-fA-F]+$/.test(s) || /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})+$/.test(s)) // hex / address
    return el('span.v', {}, el('span.v-hex', { text: s }));
  if ((m = s.match(/^(-?\d+)\s+(\S.*)$/)))                        // "N unit" (e.g. 251 bytes)
    return el('span.v', {}, el('span.v-num', { text: m[1] }), ' ', el('span.muted', { text: m[2] }));
  if (/^-?\d+$/.test(s)) return el('span.v', {}, el('span.v-num', { text: s })); // bare number
  return el('span.v', { text: s });
}

export function createControllerPanel({ store, hci }) {
  const root = el('div.panel-body');

  // Prominent call-to-action shown until a controller is connected over Web Serial.
  function connectHint() {
    const openFirmwareTab = () => { store.state.ui.activePanel = 'firmware'; };
    // `action` is an optional element (e.g. a button) shown under the firmware note.
    const dev = (name, desc, fw, action) => el('div.ch-dev', {},
      el('b', { text: name }),
      el('span.ch-desc', { text: desc }),
      el('span.ch-fw', { text: fw }),
      action || null);
    return el('div.connect-hint', {},
      el('div.ch-title', { text: 'No controller connected ❗' }),
      el('div.ch-sub', { text: 'Any UART HCI controller works. Plug one in and hit Connect — no firmware needed first.' }),
      el('div.ch-devs', {},
        dev('ESP32', 'Any ESP32 / S3 / C3 / C6 dev board.',
          'No HCI firmware? Connect anyway — this app can flash Zephyr HCI UART over the same port.'),
        dev('Nordic USB Dongle', 'nRF52840 dongle.',
          'No HCI firmware? Put it in bootloader mode (hold RESET while plugging in) — this app flashes it over USB DFU.'),
        dev('Nordic DK board', 'nRF52840 / nRF52833 / nRF52 (nRF52832) / nRF5340 / nRF54L15 DK.',
          'Runs HCI over the onboard J-Link at 1 Mbaud. A browser can’t flash J-Link boards, so download the firmware and flash it with west / nrfjprog first, then connect.',
          el('button.btn.btn-sm.ch-fwbtn', { text: '↓ Download firmware', on: { click: openFirmwareTab } })),
        dev('UART HCI controller', 'Any controller exposing a standard H4 UART HCI over serial.',
          'Already running HCI firmware? Just connect — no flashing needed.')),
      el('div.ch-step', {}, 'Click ', el('b', { text: 'Connect' }), ' in the top bar and pick its serial port.'),
    );
  }

  // Each row is [label, value, helpKey?]; helpKey adds an ⓘ tooltip next to the label.
  function card(title, rows) {
    return el('div.card', {},
      el('h3', { text: title }),
      el('div.card-grid', {}, ...rows.flatMap(([k, v, help]) =>
        [applyHelp(el('span.k', {}, k), help), roleValue(v)])),
    );
  }

  function render() {
    clear(root);
    const c = store.state.controller;

    if (!store.state.serial.connected) {
      root.append(connectHint());
      return;
    }
    if (!c.ready) {
      root.append(el('div.empty', { text: 'Reading controller information…' }));
      return;
    }

    const v = c.version || {};
    const ver = card('Version', [
      ['HCI Version', v.hciVersion != null ? `${CORE_VERSION[v.hciVersion] || '?'} (0x${v.hciVersion.toString(16)})` : null, 'ctrl.hciVersion'],
      ['HCI Subversion', v.hciSubversion != null ? `0x${v.hciSubversion.toString(16)}` : null, 'ctrl.hciSubversion'],
      ['LMP Version', v.lmpVersion != null ? `${CORE_VERSION[v.lmpVersion] || '?'} (0x${v.lmpVersion.toString(16)})` : null, 'ctrl.lmpVersion'],
      ['Manufacturer', v.manufacturer != null ? `${companyName(v.manufacturer)} (0x${v.manufacturer.toString(16)})` : null, 'ctrl.manufacturer'],
      ['BD_ADDR', c.bdAddr, 'ctrl.bdAddr'],
      ['Adv Tx Power', c.txPower != null ? `${c.txPower} dBm` : null, 'ctrl.txPower'],
    ]);

    const buffers = card('Buffers', [
      ['ACL data length', c.bufferSize ? `${c.bufferSize.aclLen} bytes` : null, 'ctrl.aclLen'],
      ['ACL packets', c.bufferSize ? `${c.bufferSize.numAcl}` : null, 'ctrl.aclPackets'],
      ['LE ACL data length', c.leBufferSize ? `${c.leBufferSize.aclLen} bytes` : null, 'ctrl.leAclLen'],
      ['LE ACL packets', c.leBufferSize ? `${c.leBufferSize.numAcl}` : null, 'ctrl.leAclPackets'],
      ['Max adv data', c.maxAdvDataLen != null ? `${c.maxAdvDataLen} bytes` : null, 'ctrl.maxAdvData'],
      ['Adv sets', c.numAdvSets != null ? `${c.numAdvSets}` : null, 'ctrl.advSets'],
    ]);

    const caps = el('div.card', {}, el('h3', { text: 'Capabilities' }),
      el('div.badges', {}, ...Object.entries(CAP_LABELS).map(([k, label]) =>
        applyHelp(el('span', { class: 'badge ' + (c.caps?.[k] ? 'yes' : 'no') }, label), CAP_HELP[k]))));

    const cmds = c.supportedCommands ? countBits(c.supportedCommands) : null;
    const feats = el('div.card', {}, el('h3', { text: 'LE Features' }),
      c.leFeatures
        ? el('ul.feature-list', {}, ...featureList(c.leFeatures))
        : el('span.muted', { text: 'unavailable' }),
      cmds != null ? applyHelp(el('p.muted', {}, `Supported HCI commands: ${cmds} set`), 'ctrl.supportedCommands') : null);

    root.append(
      el('div.toolbar', {}, el('button.btn.btn-icon', { text: '↻', attrs: { title: 'Re-read controller info', 'aria-label': 'Re-read controller info' }, on: { click: () => bringUp(hci, store) } })),
      el('div.cards', {}, ver, buffers, caps, feats),
    );
  }

  function featureList(features) {
    const items = [];
    for (let bit = 0; bit < 64; bit++) {
      if (bitSet(features, bit)) {
        const name = LE_FEATURE_NAMES[bit] || `Bit ${bit}`;
        items.push(applyHelp(el('li', {}, name), 'ctrl.feat.' + bit));
      }
    }
    if (!items.length) items.push(el('li.muted', { text: 'none reported' }));
    return items;
  }

  render();
  store.subscribe(render);
  return { id: 'controller', title: 'Controller', el: root };
}

function countBits(bytes) {
  let n = 0;
  for (const b of bytes) for (let i = 0; i < 8; i++) if (b & (1 << i)) n++;
  return n;
}
