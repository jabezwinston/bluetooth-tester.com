// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// HCI engine: serializes commands with Num_HCI_Command_Packets flow control, matches
// completions to pending commands, dispatches events, and logs every packet.

import { ByteWriter } from '../util/bytes.js';
import { H4, H4Deframer, frame } from '../transport/h4.js';
import { parseEvent, decodeReturnParams } from './events.js';
import { opcodeName } from './opcodes.js';
import { hciError } from './codes.js';

class Emitter {
  constructor() { this._h = new Map(); }
  on(name, fn) {
    if (!this._h.has(name)) this._h.set(name, new Set());
    this._h.get(name).add(fn);
    return () => this._h.get(name)?.delete(fn);
  }
  emit(name, ...args) {
    for (const fn of this._h.get(name) || []) {
      try { fn(...args); } catch (e) { console.error(`listener for ${name} failed`, e); }
    }
  }
}

export class HCI extends Emitter {
  constructor(transport, { log = null, commandTimeoutMs = 5000 } = {}) {
    super();
    this.transport = transport;
    this._log = log;
    this.commandTimeoutMs = commandTimeoutMs;

    this.cmdCredits = 1;
    this.queue = [];
    this.pending = new Map(); // opcode -> [{resolve, reject, timer, name}]

    // ACL TX: fragmentation + controller buffer credits (Number Of Completed Packets).
    this.aclMaxLen = 27;
    this.aclCredits = 1;
    this.aclQueue = [];

    this.deframer = new H4Deframer();
    this.deframer.onPacket = (type, packet) => this._onPacket(type, packet);
    this.deframer.onError = (msg) => this.emit('error', msg);
    transport.onData = (bytes) => this.deframer.feed(bytes);
  }

  // ---- sending ----

  /**
   * Send a command object {opcode, params}. Resolves with the parsed completion event.
   * `opts.timeoutMs` overrides the engine-wide timeout for this one command — used by the bring-up
   * Reset probe to fail fast (~4s total across retries) instead of waiting the full 5s default.
   */
  sendCommand(command, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject, timeoutMs });
      this._pump();
    });
  }

  /**
   * Recover the H4 link after a desync: drop any buffered bytes (e.g. an ESP boot-banner burst that
   * misaligns the deframer) and restore one command credit. A Command Complete eaten by a mid-boot
   * desync never refills `cmdCredits`, leaving it stuck at 0 so every subsequent command silently waits
   * out its timeout; resetting it to 1 here lets the next (post-flush) command actually go out. Used by
   * the bring-up Reset probe so a freshly-flashed controller comes up cleanly.
   */
  resync() {
    this.deframer.flush();
    this.cmdCredits = 1;
  }

  _pump() {
    while (this.cmdCredits > 0 && this.queue.length) {
      const item = this.queue.shift();
      const { command } = item;
      const timeoutMs = item.timeoutMs ?? this.commandTimeoutMs;
      const packet = new ByteWriter().u16(command.opcode).u8(command.params.length).bytes(command.params).build();
      const list = this.pending.get(command.opcode) || [];
      const entry = {
        resolve: item.resolve,
        reject: item.reject,
        name: command.name || opcodeName(command.opcode),
      };
      entry.timer = setTimeout(() => {
        this._removePending(command.opcode, entry);
        item.reject(new Error(`HCI command ${entry.name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      list.push(entry);
      this.pending.set(command.opcode, list);

      this.cmdCredits -= 1;
      this._logPacket('tx', H4.COMMAND, packet);
      this.transport.write(frame(H4.COMMAND, packet)).catch((e) => {
        this._removePending(command.opcode, entry);
        clearTimeout(entry.timer);
        item.reject(e);
      });
    }
  }

  _removePending(opcode, entry) {
    const list = this.pending.get(opcode);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.pending.delete(opcode);
  }

  _resolvePending(opcode, value, isError, errMsg) {
    const list = this.pending.get(opcode);
    if (!list || !list.length) return false;
    const entry = list.shift();
    if (!list.length) this.pending.delete(opcode);
    clearTimeout(entry.timer);
    if (isError) entry.reject(new Error(errMsg));
    else entry.resolve(value);
    return true;
  }

  // ---- ACL data (host -> controller) ----

  /** Set the LE ACL fragment size + available buffer credits (from controller bring-up). */
  configureAcl(maxLen, credits) {
    this.aclMaxLen = maxLen || 27;
    this.aclCredits = credits || 1;
    this._pumpAcl();
  }

  /** Send an L2CAP PDU on a connection, fragmenting to the ACL buffer size. */
  sendAcl(handle, payload) {
    const max = this.aclMaxLen || 27;
    if (payload.length === 0) {
      this.aclQueue.push({ handle, pb: 0x00, data: new Uint8Array(0) });
    }
    let off = 0;
    let first = true;
    while (off < payload.length) {
      const data = payload.subarray(off, off + max);
      this.aclQueue.push({ handle, pb: first ? 0x00 : 0x01, data });
      off += data.length;
      first = false;
    }
    this._pumpAcl();
  }

  _pumpAcl() {
    while (this.aclCredits > 0 && this.aclQueue.length) {
      const frag = this.aclQueue.shift();
      this.aclCredits -= 1;
      const hdr = (frag.handle & 0x0fff) | ((frag.pb & 0x3) << 12);
      const pkt = new ByteWriter().u16(hdr).u16(frag.data.length).bytes(frag.data).build();
      this._logPacket('tx', H4.ACL, pkt);
      this.transport.write(frame(H4.ACL, pkt)).catch((e) => this.emit('error', `ACL write failed: ${e.message}`));
    }
  }

  // ---- receiving ----

  _onPacket(type, packet) {
    this._logPacket('rx', type, packet);
    if (type === H4.EVENT) this._onEvent(packet);
    else if (type === H4.ACL) this.emit('acl', packet);
    else if (type === H4.ISO) this.emit('iso', packet);
    else if (type === H4.SCO) this.emit('sco', packet);
  }

  _onEvent(packet) {
    const ev = parseEvent(packet);

    if (ev.type === 'command_complete') {
      this.cmdCredits = ev.numHciCommandPackets;
      if (ev.opcode !== 0x0000) {
        ev.decoded = decodeReturnParams(ev.opcode, ev.returnParams);
        this._resolvePending(ev.opcode, ev);
      }
      this._pump();
    } else if (ev.type === 'command_status') {
      this.cmdCredits = ev.numHciCommandPackets;
      if (ev.opcode !== 0x0000) {
        if (ev.status !== 0x00) {
          this._resolvePending(ev.opcode, null, true, `${opcodeName(ev.opcode)}: ${hciError(ev.status)} (0x${ev.status.toString(16)})`);
        } else {
          // Accepted; completion (if any) arrives via a later event. Resolve with status.
          this._resolvePending(ev.opcode, ev);
        }
      }
      this._pump();
    }

    if (ev.type === 'number_of_completed_packets') {
      let total = 0;
      for (const h of ev.handles) total += h.count;
      this.aclCredits += total;
      this._pumpAcl();
    }

    this.emit('event', ev);
    if (ev.type) this.emit(ev.type, ev);
    if (ev.type === 'le_meta' && ev.subName) this.emit(ev.subName, ev);
  }

  _logPacket(dir, type, data) {
    if (this._log) this._log({ dir, h4: type, data, ts: Date.now() });
  }

  /** Convenience: send a command and throw if the controller returns a non-zero status. */
  async command(command, opts) {
    const ev = await this.sendCommand(command, opts);
    if (ev && ev.status != null && ev.status !== 0x00) {
      throw new Error(`${command.name}: ${hciError(ev.status)} (0x${ev.status.toString(16).padStart(2, '0')})`);
    }
    return ev;
  }
}
