// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Advertising start/stop control — lives in the app header (app-head). Mirrors the connection
// control; extracted from the Advertiser panel so Start/Stop Advertising is reachable from any
// tab. (Formerly the "adv-actions" block inside the Advertiser panel.)

import { el, clear } from './dom.js';
import { startAdvertising, stopAdvertising } from '../host/gap.js';

export function createAdvControl({ store, hci }) {
  const root = el('div.head-adv');
  let lastError = null;

  async function start() { lastError = null; try { await startAdvertising(hci, store); } catch (e) { lastError = e.message; } render(); }
  async function stop() { lastError = null; try { await stopAdvertising(hci, store); } catch (e) { lastError = e.message; } render(); }

  function render() {
    clear(root);
    const connected = store.state.serial.connected && store.state.controller.ready;
    const enabled = store.state.advertiser.enabled;
    const hasError = store.state.warnings.some((w) => w.level === 'error');
    root.append(
      el('span', { class: 'dot ' + (enabled ? 'on' : 'off') }),
      el('span.muted', { text: enabled ? 'Advertising' : connected ? 'Idle' : 'No controller' }),
      enabled
        ? el('button.btn.danger.btn-sm', { text: 'Stop Advertising', disabled: !connected, on: { click: stop } })
        : el('button.btn.primary.btn-sm', { text: 'Start Advertising', disabled: !connected || hasError, attrs: hasError ? { title: 'Resolve the errors below to start' } : {}, on: { click: start } }),
    );
    if (lastError) root.append(el('span.head-err', { text: lastError, attrs: { title: lastError } }));
  }

  render();
  store.subscribe(render);
  return root;
}
