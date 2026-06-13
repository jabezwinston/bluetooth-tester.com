// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// A Web Serial-shaped polyfill over WebUSB, for Android Chrome (no Web Serial there) and the ?webusb=1
// dev toggle. `webUsbSerial` mirrors `navigator.serial` (requestPort / getPorts) and WebUsbSerialPort
// mirrors a SerialPort — the exact surface the app already uses (getInfo / open / close / readable /
// writable / setSignals / 'disconnect') — so it's a drop-in via getSerial() (serial.js). The bridge
// chip specifics (baud + DTR/RTS over control transfers, bulk data) live in usb-drivers.js.

import { pickDriver } from './usb-drivers.js';

// WebUSB requestDevice() needs a non-empty filter list (unlike Web Serial's "any port"). Cover the bridges
// the app supports: CDC comm class + the vendor bridges (CP210x/CH34x/FTDI/ESP native/Nordic/J-Link).
const DEFAULT_FILTERS = [
  { classCode: 0x02 },
  { vendorId: 0x10c4 }, { vendorId: 0x1a86 }, { vendorId: 0x0403 },
  { vendorId: 0x303a }, { vendorId: 0x1915 }, { vendorId: 0x2fe3 }, { vendorId: 0x1366 },
];

export class WebUsbSerialPort {
  constructor(device) {
    this.device = device;
    this.driver = null;
    this._open = false;
    this._dtr = false;
    this._rts = false;
    this._disconnectCbs = new Set();
    this._onUsbDisconnect = (e) => {
      if (e.device !== this.device) return;
      this._open = false; this._endRx();           // pump's transferIn also rejects → it exits on its own
      for (const cb of this._disconnectCbs) { try { cb(); } catch {} }
    };
    // RX pump: ONE perpetual transferIn loop bound to the open device, decoupled from readers via a
    // queue. WebUSB has no way to abort a pending transferIn without closing the device, so a reader
    // that read() directly off transferIn could never be cancelled while keeping the port open — which
    // is exactly what detach() (ESP reflash hand-off) needs. The pump instead keeps transferIn running
    // and feeds a queue; read() awaits the queue, so cancel()/releaseLock() can settle a pending read()
    // instantly. detach→adopt→reattach reuse the SAME pump, so there's never two transferIn racing on
    // one endpoint for the ESP's SYNC replies.
    this._rxChunks = [];      // bytes received but not yet read()
    this._rxWaiter = null;    // { resolve, handle } of a pending read()
    this._pumpRunning = false;
    this._activeReader = null; // current reader handle (mimics Web Serial's single-reader lock)
  }

  getInfo() { return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId }; }

  async open({ baudRate = 115200, flowControl = 'none' } = {}) {
    await this.device.open();
    try {
      if (!this.device.configuration) await this.device.selectConfiguration(this.device.configurations[0].configurationValue);
      this.driver = pickDriver(this.device);
      await this.driver.init();
      this.flowControl = flowControl;
      await this.driver.setBaud(baudRate, { dataBits: 8, parity: 'none', stop: 1 });
      this._dtr = false; this._rts = false;
      await this.driver.setSignals(false, false);   // deterministic deasserted start
      this._open = true;
      navigator.usb.addEventListener('disconnect', this._onUsbDisconnect);
      this._startPump();
    } catch (e) {
      try { await this.device.close(); } catch {}    // a failed open must not leave the device claimed/open
      throw e;
    }
  }

  // Both lines change in one chip transfer, so track state and re-apply — matching Web Serial's
  // partial-update semantics (a call with only { requestToSend } leaves DTR unchanged).
  async setSignals({ dataTerminalReady, requestToSend } = {}) {
    if (dataTerminalReady !== undefined) this._dtr = dataTerminalReady;
    if (requestToSend !== undefined) this._rts = requestToSend;
    await this.driver.setSignals(this._dtr, this._rts);
  }

  // Hand a chunk to a waiting read(), or buffer it until one arrives.
  _pushRx(bytes) {
    if (this._rxWaiter) { const w = this._rxWaiter; this._rxWaiter = null; w.resolve({ value: bytes, done: false }); }
    else this._rxChunks.push(bytes);
  }

  // Resolve a pending read() with done — used by cancel/close so a consumer's read loop exits.
  _endRx() {
    if (this._rxWaiter) { const w = this._rxWaiter; this._rxWaiter = null; w.resolve({ value: undefined, done: true }); }
  }

  _startPump() {
    if (this._pumpRunning) return;
    this._pumpRunning = true;
    const { device, driver } = this;
    (async () => {
      while (this._open) {
        let r;
        try { r = await device.transferIn(driver.epIn, driver.packetSize); }
        catch { break; }                            // device closed/disconnected → transferIn rejects → stop
        if (!this._open) break;
        if (r.status === 'stall') { try { await device.clearHalt('in', driver.epIn); continue; } catch { break; } }
        if (r.status === 'ok' && r.data && r.data.byteLength) {
          const raw = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
          const bytes = driver.readFilter(raw);
          if (bytes && bytes.length) this._pushRx(bytes);
        }
        // 'babble' or an ok-but-empty packet: just loop and read again
      }
      this._pumpRunning = false;
      this._endRx();                                // unblock any reader waiting on a now-stopped pump
    })();
  }

  get readable() {
    if (!this._open) return null;
    const port = this;
    return {
      getReader() {
        const handle = {};
        port._activeReader = handle;                // newest reader wins (consumers release before re-acquiring)
        return {
          read() {
            if (port._activeReader !== handle) return Promise.resolve({ value: undefined, done: true });
            if (port._rxChunks.length) return Promise.resolve({ value: port._rxChunks.shift(), done: false });
            if (!port._pumpRunning && !port._open) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => { port._rxWaiter = { resolve, handle }; });
          },
          // cancel() must settle a pending read() WITHOUT needing inbound bytes or closing the port —
          // this is the contract detach()/release() rely on (the pump keeps running for the next reader).
          cancel() {
            if (port._activeReader === handle) port._activeReader = null;
            if (port._rxWaiter && port._rxWaiter.handle === handle) { const w = port._rxWaiter; port._rxWaiter = null; w.resolve({ value: undefined, done: true }); }
            return Promise.resolve();
          },
          releaseLock() { if (port._activeReader === handle) port._activeReader = null; },
        };
      },
    };
  }

  get writable() {
    if (!this._open) return null;
    const { device, driver } = this;
    return {
      getWriter: () => ({
        write: async (bytes) => {
          const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          await device.transferOut(driver.epOut, data); // WebUSB fragments to the endpoint packet size
        },
        releaseLock: () => {},
      }),
    };
  }

  addEventListener(type, cb) { if (type === 'disconnect') this._disconnectCbs.add(cb); }
  removeEventListener(type, cb) { if (type === 'disconnect') this._disconnectCbs.delete(cb); }

  async close() {
    this._open = false;                            // tells the pump to stop after its current transferIn
    this._endRx();                                 // release any reader waiting on the queue right now
    try { navigator.usb.removeEventListener('disconnect', this._onUsbDisconnect); } catch {}
    try { if (this.driver) await this.device.releaseInterface(this.driver.ctrlIface); } catch {}
    try { await this.device.close(); } catch {}    // rejects the pump's pending transferIn → pump exits
  }
}

export const webUsbSerial = {
  async requestPort({ filters } = {}) {
    const usbFilters = (filters && filters.length)
      ? filters.map((f) => { const o = {}; if (f.usbVendorId != null) o.vendorId = f.usbVendorId; if (f.usbProductId != null) o.productId = f.usbProductId; return o; })
      : DEFAULT_FILTERS;
    const device = await navigator.usb.requestDevice({ filters: usbFilters });
    return new WebUsbSerialPort(device);
  },
  async getPorts() {
    const devices = await navigator.usb.getDevices();
    return devices.map((d) => new WebUsbSerialPort(d));
  },
};
