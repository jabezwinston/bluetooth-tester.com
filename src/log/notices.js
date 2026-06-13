// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// In-memory feed of user-facing notices + validation warnings. The same entries are surfaced as
// transient bottom-right toasts (ui/toasts.js) and recorded with timestamps in the Log panel below
// the HCI packet log. A bounded ring buffer; subscribers get the newly added entry (or null on clear).

export class NoticeFeed {
  constructor(capacity = 300) {
    this.capacity = capacity;
    this.entries = [];
    this.seq = 0;
    this._subs = new Set();
  }

  /** item: { level:'error'|'warn', source?, msg, ts? } → stored as { seq, ts, level, source, msg }. */
  add(item) {
    const e = { seq: ++this.seq, ts: item.ts || Date.now(), level: item.level || 'warn', source: item.source || null, msg: item.msg };
    this.entries.push(e);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this._notify(e);
    return e;
  }

  clear() {
    this.entries = [];
    this._notify(null);
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _notify(entry) {
    for (const fn of this._subs) {
      try { fn(entry); } catch (err) { console.error('notice subscriber error', err); }
    }
  }
}
