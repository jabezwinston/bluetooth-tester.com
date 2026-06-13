// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Web Serial transport for the Nordic serial DFU (nrf-dfu.js). The dongle's bootloader is a
// separate USB device from the running firmware (1915:521F after RESET), so we requestPort()
// fresh. Inbound bytes are de-framed on the SLIP END marker (0xC0) and decoded; each request()
// resolves with the next response frame.

import { slipEncode, slipDecode } from './nrf-dfu.js';
import { getSerial, serialSupported } from '../transport/serial.js';

const END = 0xc0;

export class DfuSerial {
  constructor() {
    this.port = null; this.writer = null; this.reader = null;
    this._keep = false; this._loop = null; this._frame = []; this._waiters = [];
  }
  static get supported() { return serialSupported(); }

  /** Prompt for the bootloader serial port (user gesture). */
  async acquire(filters) { this.port = await getSerial().requestPort(filters ? { filters } : {}); return this.port; }

  async open({ baudRate = 115200 } = {}) {
    await this.port.open({ baudRate, bufferSize: 4096, flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    await this._signalPortOpen();
    this._keep = true;
    this._loop = this._pump();
  }

  /**
   * Take over an already-open port handed off from the HCI transport (transport.detach), instead of
   * re-prompting — used by the OOB wizard when the dongle is connected in bootloader mode. No open():
   * the port is already open at the session baud (USB CDC ignores baud anyway). Grab a writer, assert the
   * CDC "port open" signal, and start the read pump. Because we detected the bootloader by VID:PID and
   * never sent it HCI, its DFU receive buffer is clean, so the first command (SetPRN) frames correctly.
   */
  async adopt(port) {
    this.port = port;
    this.writer = this.port.writable.getWriter();
    await this._signalPortOpen();
    this._keep = true;
    this._loop = this._pump();
  }

  /**
   * Assert DTR (and RTS) — the CDC "port open" signal. Nordic's USB CDC bootloader only arms its receiver
   * on this event (APP_USBD_CDC_ACM_USER_EVT_PORT_OPEN → its first cdc_acm_read), so without it the dongle
   * never reads our first command and DFU times out. The HCI transport opened this port with DTR deasserted
   * (the clean state ESP GPIO0 needs), and the WebUSB shim doesn't auto-assert it the way a desktop OS
   * cdc-acm driver does — so we assert it here, right before the first DFU exchange.
   */
  async _signalPortOpen() {
    try { if (this.port?.setSignals) await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch {}
  }

  async _pump() {
    while (this.port && this.port.readable && this._keep) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (value) this._feed(value); }
      } catch { break; } finally { try { this.reader.releaseLock(); } catch {} this.reader = null; }
    }
  }

  _feed(bytes) {
    for (const b of bytes) {
      if (b === END) { if (this._frame.length) { this._deliver(slipDecode(Uint8Array.from(this._frame))); this._frame = []; } }
      else this._frame.push(b);
    }
  }
  _deliver(frame) { const w = this._waiters.shift(); if (w) { clearTimeout(w.timer); w.resolve(frame); } }

  /** Send a SLIP-framed packet, no response expected (used for Write objects with PRN=0). */
  async send(bytes) { await this.writer.write(slipEncode(bytes)); }

  /** Send a packet and resolve with the next response frame. */
  request(bytes, timeoutMs = 5000) {
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._waiters.findIndex((x) => x.timer === timer);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('DFU response timeout — is the dongle in bootloader mode (red LED pulsing)?'));
      }, timeoutMs);
      this._waiters.push({ resolve, timer });
    });
    this.send(bytes);
    return p;
  }

  async close() {
    this._keep = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = this.writer = this.reader = null;
  }

  /**
   * Release the reader/writer locks WITHOUT closing the port (mirrors FlashSerial.release / the HCI
   * transport's detach), returning the still-open port. Used when a DFU flash fails: the dongle is
   * usually still in bootloader mode, so handing the open port back to the HCI transport keeps the
   * connection alive for a retry instead of forcing a reconnect.
   */
  async release() {
    this._keep = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    this.writer = this.reader = null;
    const port = this.port;
    this.port = null;
    return port;
  }
}
