// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Serial connection control — lives in the app header (app-head). Opens/closes the Web Serial
// port and runs controller bring-up. (Formerly the "Connection" tab.)

import { el, clear } from './dom.js';
import { SerialTransport } from '../transport/webserial.js';
import { bringUp } from '../host/controller.js';
import { isEspUartBridge, isNrfDfuBootloader, serialParamsFor } from '../data/firmware-manifest.js';

/**
 * Open the user-picked serial port (a user gesture) and bring the controller up. The single canonical
 * connect path — used by the header Connect button and by the OOB wizard's post-flash "Reconnect" (after
 * an nRF dongle re-enumerates from its bootloader into the freshly-flashed HCI app, it's a new USB device
 * that needs a fresh port grant). Updates store.serial; never throws (errors land in store.serial.error).
 */
export async function connectController({ store, hci, transport }) {
  const s = store.state.serial;
  store.update((st) => { st.serial.connecting = true; st.serial.error = null; });
  try {
    const label = await transport.open({ baudRate: s.baudRate, flowControl: s.flowControl, paramsFor: serialParamsFor });
    store.update((st) => { st.serial.connected = true; st.serial.connecting = false; st.serial.portLabel = label; });
    const info = transport.port?.getInfo?.() || {};
    // VID:PID detection: the nRF52840 dongle's Open DFU Bootloader (1915:521F) is a DFU device, not an
    // HCI controller. DON'T probe it with HCI Reset (those bytes would corrupt its DFU receive buffer) —
    // flag needsFirmware so the OOB wizard opens its guided DFU-flash flow.
    if (isNrfDfuBootloader(info)) {
      store.update((st) => { st.controller.ready = false; st.controller.needsFirmware = true; });
      return;
    }
    // ESP boards behind a USB-UART bridge: reset into RUN mode so the HCI firmware boots — Web
    // Serial's open/close cycling can otherwise leave the chip in the ROM download loader, so a
    // second connect sees no HCI. Then flush the boot-log burst before bring-up sends Reset.
    if (isEspUartBridge(info)) {
      await transport.espRunReset();
      hci.deframer.flush();
    }
    await bringUp(hci, store);
  } catch (e) {
    store.update((st) => { st.serial.connecting = false; st.serial.error = e.message; });
  }
}

export function createConnectionControl({ store, hci, transport }) {
  const root = el('div.head-conn');

  const connect = () => connectController({ store, hci, transport });

  async function disconnect() {
    try { await transport.close(); } catch {}
    store.update((st) => { st.serial.connected = false; st.controller.ready = false; });
  }

  function render() {
    clear(root);
    const s = store.state.serial;
    if (!SerialTransport.supported) {
      root.append(el('span.head-warn', { text: 'No serial support — use desktop Chrome/Edge (Web Serial) or Android Chrome (WebUSB).' }));
      return;
    }

    root.append(
      el('span', { class: 'dot ' + (s.connected ? 'on' : 'off') }),
      // When connected, show the params the link actually opened at (a J-Link VCOM is auto-bumped to
      // 1M/RTS-CTS regardless of the user's defaults); the inputs below still bind the user's preference.
      el('span.muted', { text: s.connected
        ? `${s.portLabel || 'serial'} @ ${transport.baudRate ?? s.baudRate} (${(transport.flowControl ?? s.flowControl) === 'hardware' ? 'RTS/CTS' : 'none'})`
        : 'disconnected' }),
    );

    if (!s.connected) {
      root.append(
        el('input.head-input', {
          type: 'number', value: s.baudRate, attrs: { min: 1200, step: 100, title: 'Baud rate' }, disabled: s.connecting,
          on: { change: (e) => store.update((st) => { st.serial.baudRate = parseInt(e.target.value, 10) || 115200; }) },
        }),
        el('select.head-input', {
          attrs: { title: 'Flow control' }, disabled: s.connecting,
          on: { change: (e) => store.update((st) => { st.serial.flowControl = e.target.value; }) },
        },
          el('option', { value: 'none', selected: s.flowControl === 'none', text: 'none' }),
          el('option', { value: 'hardware', selected: s.flowControl === 'hardware', text: 'RTS/CTS' }),
        ),
        el('button.btn.primary.btn-sm', { text: s.connecting ? 'Connecting…' : 'Connect', disabled: s.connecting, on: { click: connect } }),
      );
    } else {
      root.append(el('button.btn.danger.btn-sm', { text: 'Disconnect', on: { click: disconnect } }));
    }

    if (s.error) root.append(el('span.head-err', { text: s.error }));
  }

  render();
  store.subscribe(render);
  return root;
}
