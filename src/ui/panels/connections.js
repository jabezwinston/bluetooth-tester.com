// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Connections panel: live LE connections, parameters, subscriptions, disconnect, and
// peripheral-initiated connection-parameter-update requests.

import { el, clear, field } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import { companyName, coreVersionName } from '../../data/assigned.js';

export function createConnectionsPanel({ store, conn }) {
  const root = el('div.panel-body');

  function paramUpdateRow(c) {
    const min = el('input', { type: 'number', value: 30, attrs: { min: 8, step: 5 }, style: { width: '5rem' } });
    const max = el('input', { type: 'number', value: 50, attrs: { min: 8, step: 5 }, style: { width: '5rem' } });
    const lat = el('input', { type: 'number', value: 0, attrs: { min: 0 }, style: { width: '4rem' } });
    const sup = el('input', { type: 'number', value: 2000, attrs: { min: 100, step: 100 }, style: { width: '5.5rem' } });
    const go = el('button.btn', {
      text: 'Request update',
      on: { click: () => conn.requestConnParamUpdate(c.handle, {
        intervalMin: Math.round(parseFloat(min.value) / 1.25),
        intervalMax: Math.round(parseFloat(max.value) / 1.25),
        latency: parseInt(lat.value, 10) || 0,
        timeout: Math.round(parseFloat(sup.value) / 10),
      }) },
    });
    return el('div.subrow', {}, field('Min (ms)', min, null, 'conn.intervalMin'), field('Max (ms)', max, null, 'conn.intervalMax'), field('Latency', lat, null, 'conn.latency'), field('Timeout (ms)', sup, null, 'conn.timeout'), go);
  }

  function render() {
    clear(root);
    const conns = store.state.connections;
    if (!conns.length) {
      root.append(el('div.empty', { text: store.state.serial.connected ? 'No active connections. Advertise (connectable), then connect from a phone/central.' : 'Connect to a controller first.' }));
      return;
    }
    for (const c of conns) {
      const card = el('div.card', {},
        el('div.row', { style: { justifyContent: 'space-between' } },
          el('h3', { text: `Handle 0x${c.handle.toString(16).padStart(4, '0')} — ${c.peerName ? `${c.peerName} (${c.peerAddr})` : c.peerAddr}` }),
          el('button.btn.danger', { text: 'Disconnect', on: { click: () => conn.disconnect(c.handle) } })),
        el('div.card-grid', {},
          kv('Local role', c.role === 1 ? 'Peripheral' : 'Central', 'conn.localRole'),
          kv('Interval', `${(c.interval * 1.25).toFixed(2)} ms`, 'conn.interval'),
          kv('Latency', `${c.latency}`, 'conn.latency'),
          kv('Supervision timeout', `${c.timeout * 10} ms`, 'conn.timeout'),
          kv('ATT MTU', `${c.mtu}`, 'conn.attMtu'),
          kv('Subscriptions', c.subscriptions.length ? c.subscriptions.map((s) => `0x${s.handle.toString(16)}=${s.value}`).join(', ') : 'none', 'conn.subscriptions'),
          ...remoteVersionRows(c.remoteVersion),
        ),
        paramUpdateRow(c),
      );
      root.append(card);
    }
  }

  function kv(k, v, help) { return [applyHelp(el('span.k', {}, k), help), el('span.v', { text: v })]; }

  // Remote controller version (from HCI Read Remote Version Information). Pending until the event
  // arrives; the LMP/LL version uses the Bluetooth Core version numbering, same as the local side.
  function remoteVersionRows(rv) {
    if (!rv) return kv('Remote version', 'reading…');
    return [
      ...kv('Remote LMP version', `${coreVersionName(rv.version)} (0x${rv.version.toString(16)})`, 'conn.remoteLmpVersion'),
      ...kv('Remote manufacturer', `${companyName(rv.manufacturer)} (0x${rv.manufacturer.toString(16).padStart(4, '0')})`, 'conn.remoteManufacturer'),
      ...kv('Remote subversion', `0x${rv.subversion.toString(16).padStart(4, '0')}`, 'conn.remoteSubversion'),
    ];
  }

  render();
  store.subscribe(render);
  return { id: 'connections', title: 'Connections', el: root };
}
