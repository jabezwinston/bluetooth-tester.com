// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// In-memory packet log: a bounded ring buffer of HCI packets with direction +
// timestamp. UI subscribes for live updates; PCAPNG export reads the same entries.

export class PacketLog {
  constructor(capacity = 5000) {
    this.capacity = capacity;
    this.entries = [];
    this.seq = 0;
    this._subs = new Set();
    this._scheduled = false;
  }

  /** entry: { dir:'tx'|'rx', h4:number, data:Uint8Array, ts:number(ms) } */
  add(entry) {
    const e = { seq: ++this.seq, ...entry };
    this.entries.push(e);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this._notify();
    return e;
  }

  clear() {
    this.entries = [];
    this._notify();
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _notify() {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      for (const fn of this._subs) {
        try { fn(this.entries); } catch (e) { console.error('log subscriber error', e); }
      }
    });
  }
}
