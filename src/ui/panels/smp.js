// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// SMP panel: pairing parameters, live pairing status (passkey display / numeric comparison
// / passkey input), key viewer, bond list, and RPA privacy.

import { el, clear, field } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import { optHelp } from '../help/help-text.js';

const IO_LABELS = [[3, 'NoInputNoOutput'], [0, 'DisplayOnly'], [1, 'DisplayYesNo'], [2, 'KeyboardOnly'], [4, 'KeyboardDisplay']];

export function createSmpPanel({ store, conn }) {
  const root = el('div.panel-body');
  const apply = () => conn.applySmpConfig();

  function paramsCard() {
    const s = store.state.smp;
    const accept = s.acceptPairing !== false; // ON = accept incoming pairing; OFF = refuse (transparent only)
    const dis = !accept;                       // when refusing, the rest of the parameters don't apply

    // Horizontal master switch — ON accepts pairing, OFF refuses it (Pairing Not Supported, 0x05).
    const sw = el('label.switch', {},
      el('input', { type: 'checkbox', checked: accept, on: { change: (e) => { store.state.smp.acceptPairing = e.target.checked; apply(); } } }),
      el('span.track', {}, el('span.thumb')),
      applyHelp(el('span', {}, accept ? 'Accept pairing' : 'Refuse pairing (transparent only)'), 'smp.acceptPairing'));

    const io = el('select', { disabled: dis, style: { width: 'fit-content' }, on: { change: (e) => { store.state.smp.io = parseInt(e.target.value, 10); apply(); } } },
      ...IO_LABELS.map(([v, l]) => el('option', { value: v, selected: s.io === v, text: l, attrs: { title: optHelp('io.' + v) } })));
    const chk = (label, key, helpKey) => applyHelp(el('label.inline' + (dis ? '.disabled' : ''), {}, el('input', { type: 'checkbox', checked: s[key], disabled: dis, on: { change: (e) => { store.state.smp[key] = e.target.checked; apply(); } } }), ' ' + label), helpKey);
    const maxKey = el('input', { type: 'number', value: s.maxKey, disabled: dis, attrs: { min: 7, max: 16 }, style: { width: '4rem' }, on: { change: (e) => { store.state.smp.maxKey = Math.max(7, Math.min(16, parseInt(e.target.value, 10) || 16)); apply(); } } });
    const passkey = el('input', { type: 'number', value: s.passkey ?? '', placeholder: 'random', disabled: dis, attrs: { min: 0, max: 999999 }, style: { width: '7rem' }, on: { change: (e) => { const v = e.target.value.trim(); store.state.smp.passkey = v === '' ? null : parseInt(v, 10); apply(); } } });

    return el('div.card', {}, el('h3', { text: 'Pairing parameters' }),
      el('div.subrow', {}, sw),
      field('IO capability', io, null, 'smp.io'),
      el('div.subrow', {}, chk('LE Secure Connections', 'sc', 'smp.sc'), chk('MITM protection', 'mitm', 'smp.mitm'), chk('Bonding', 'bonding', 'smp.bonding')),
      el('div.subrow', {}, field('Max key size', maxKey, null, 'smp.maxKey'), field('Fixed passkey', passkey, null, 'smp.passkey')),
      dis ? el('p.hint', { text: 'Incoming pairing is rejected with “Pairing Not Supported” (0x05); the connection stays up but unencrypted — only attributes without a security requirement are accessible. The parameters above don’t apply.' }) : null);
  }

  function statusCard() {
    const s = store.state.smp;
    const cur = s.current || {};
    const body = el('div', {});
    body.append(el('div.status-line', {}, el('span', { class: 'dot ' + (s.status === 'paired' ? 'on' : 'off') }),
      el('span', { text: `Status: ${s.status}${cur.method ? ` · ${cur.method}${cur.sc ? ' (SC)' : ''}` : ''}${cur.peerAddr ? ` · ${cur.peerAddr}` : ''}` })));
    if (s.status === 'passkey-display') body.append(el('div.passkey-box', { text: String(cur.passkey ?? 0).padStart(6, '0') }), el('p.muted', { text: 'Enter this passkey on the central.' }));
    if (s.status === 'numeric-comparison') body.append(el('div.passkey-box', { text: cur.ncValue }),
      el('div.subrow', {}, el('button.btn.primary', { text: '✓ Match', on: { click: () => conn.confirmNumeric(cur.handle, true) } }), el('button.btn.danger', { text: '✗ No', on: { click: () => conn.confirmNumeric(cur.handle, false) } })));
    if (s.status === 'passkey-input') {
      const inp = el('input', { type: 'number', placeholder: 'passkey from central', attrs: { min: 0, max: 999999 } });
      body.append(el('div.subrow', {}, inp, el('button.btn.primary', { text: 'Submit', on: { click: () => conn.inputPasskey(cur.handle, parseInt(inp.value, 10) || 0) } })));
    }
    const conns = store.state.connections;
    if (conns.length) body.append(el('div.subrow', {}, ...conns.map((c) => el('button.btn', { text: `Request pairing · 0x${c.handle.toString(16)}${c.encrypted ? ' 🔒' : ''}`, on: { click: () => conn.sendSecurityRequest(c.handle) } }))));
    else body.append(el('p.muted', { text: 'No connections. Pairing starts when a connected central requests it (or use Request pairing).' }));
    return el('div.card', {}, el('h3', { text: 'Pairing status' }), body);
  }

  function keysCard() {
    const k = store.state.smp.lastKeys;
    if (!k) return el('div.card', {}, el('h3', { text: 'Keys' }), el('span.muted', { text: 'No keys yet — pair with a central.' }));
    const row = (label, val) => (val ? [el('span.k', { text: label }), el('span.v.mono', { text: val })] : []);
    return el('div.card', {}, el('h3', { text: `Keys — ${k.sc ? 'LE Secure Connections' : 'LE legacy'} · ${k.method} · ${k.keySize}-byte` }),
      el('div.card-grid', {}, ...row('LTK', k.ltk), ...row('Our IRK', k.irk), ...row('Our CSRK', k.csrk), ...row('Peer IRK', k.peerIrk)));
  }

  function bondsCard() {
    const bonds = store.state.bonds;
    const list = el('div.bond-list', {});
    if (!bonds.length) list.append(el('span.muted', { text: 'No bonds stored.' }));
    for (const b of bonds) list.append(el('div.bond', {},
      el('div', {}, el('strong', { text: b.idAddr || b.peerAddr }), el('span.muted', { text: ` · ${b.sc ? 'SC' : 'legacy'} · ${b.keySize}B` })),
      el('div.card-grid', {}, el('span.k', { text: 'LTK' }), el('span.v.mono', { text: b.ltkHex }),
        ...(b.irkHex ? [el('span.k', { text: 'IRK' }), el('span.v.mono', { text: b.irkHex })] : [])),
      el('button.btn.danger', { text: 'Delete', on: { click: () => conn.deleteBond(b.id) } })));
    return el('div.card', {}, el('h3', { text: `Bonds (${bonds.length})` }), list);
  }

  function privacyCard() {
    const adv = store.state.advertiser;
    const irk = conn.localIrkHex ? conn.localIrkHex() : null;
    const usingRpa = adv.ownAddressType === 'random';
    return el('div.card', {}, el('h3', { text: 'Privacy (RPA)' }),
      el('p.muted', { text: 'Generate a Resolvable Private Address from a local IRK and use it for advertising (own address type → random).' }),
      el('div.subrow', {}, el('button.btn', { text: 'Generate RPA', on: { click: async () => { await conn.enablePrivacy(); } } }),
        usingRpa ? el('span.mono', { text: adv.randomAddress }) : null),
      irk ? el('p.muted', { text: 'Local IRK: ' + irk }) : null);
  }

  function render() {
    clear(root);
    root.append(paramsCard(), statusCard(), keysCard(), bondsCard(), privacyCard());
  }

  render();
  store.subscribe(render);
  return { id: 'smp', title: 'SMP', el: root };
}
