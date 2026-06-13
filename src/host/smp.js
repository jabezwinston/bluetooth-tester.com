// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Security Manager Protocol — responder (peripheral) role. Drives LE legacy and LE Secure
// Connections pairing over L2CAP CID 0x0006. Crypto via host/crypto.js (spec-verified).
// Wire values are little-endian; we convert to the toolbox's big-endian form at the boundary.
// Core v6.0 Vol 3 Part H.

import * as C from './crypto.js';
import { ByteReader, ByteWriter, concatBytes, bytesEqual } from '../util/bytes.js';

export const SMP_OP = {
  PAIRING_REQUEST: 0x01, PAIRING_RESPONSE: 0x02, PAIRING_CONFIRM: 0x03, PAIRING_RANDOM: 0x04,
  PAIRING_FAILED: 0x05, ENCRYPTION_INFORMATION: 0x06, CENTRAL_IDENTIFICATION: 0x07,
  IDENTITY_INFORMATION: 0x08, IDENTITY_ADDRESS_INFORMATION: 0x09, SIGNING_INFORMATION: 0x0a,
  SECURITY_REQUEST: 0x0b, PAIRING_PUBLIC_KEY: 0x0c, PAIRING_DHKEY_CHECK: 0x0d, KEYPRESS: 0x0e,
};

export const SMP_FAIL = {
  PASSKEY_ENTRY_FAILED: 0x01, OOB_NOT_AVAILABLE: 0x02, AUTH_REQUIREMENTS: 0x03,
  CONFIRM_VALUE_FAILED: 0x04, PAIRING_NOT_SUPPORTED: 0x05, ENCRYPTION_KEY_SIZE: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07, UNSPECIFIED: 0x08, REPEATED_ATTEMPTS: 0x09,
  INVALID_PARAMETERS: 0x0a, DHKEY_CHECK_FAILED: 0x0b, NUMERIC_COMPARISON_FAILED: 0x0c,
};
export const SMP_FAIL_NAMES = Object.fromEntries(Object.entries(SMP_FAIL).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')]));

export const IO_CAP = { DISPLAY_ONLY: 0, DISPLAY_YES_NO: 1, KEYBOARD_ONLY: 2, NO_INPUT_NO_OUTPUT: 3, KEYBOARD_DISPLAY: 4 };

const AUTH = { BONDING: 0x01, MITM: 0x04, SC: 0x08, KEYPRESS: 0x10, CT2: 0x20 };
const KD = { ENC: 0x01, ID: 0x02, SIGN: 0x04, LINK: 0x08 };

// Core v6.0 Vol 3 Part H Table 2.8 — key generation method by IO capability, indexed
// [responder][initiator] (responder = us). Each cell: { sc, legacy } method, and for
// passkey, dir = 'D' (responder displays) or 'I' (responder inputs). Numeric Comparison is
// SC-only; the legacy entry says whether that cell degrades to Just Works (no keyboard) or
// becomes Passkey Entry (a keyboard is present).
const JW_CELL = { sc: 'jw', legacy: 'jw' };
const IO_TABLE = {
  0: { 0: JW_CELL, 1: JW_CELL, 2: { sc: 'pk', legacy: 'pk', dir: 'D' }, 3: JW_CELL, 4: { sc: 'pk', legacy: 'pk', dir: 'D' } },
  1: { 0: JW_CELL, 1: { sc: 'nc', legacy: 'jw' }, 2: { sc: 'pk', legacy: 'pk', dir: 'D' }, 3: JW_CELL, 4: { sc: 'nc', legacy: 'pk', dir: 'D' } },
  2: { 0: { sc: 'pk', legacy: 'pk', dir: 'I' }, 1: { sc: 'pk', legacy: 'pk', dir: 'I' }, 2: { sc: 'pk', legacy: 'pk', dir: 'I' }, 3: JW_CELL, 4: { sc: 'pk', legacy: 'pk', dir: 'I' } },
  3: { 0: JW_CELL, 1: JW_CELL, 2: JW_CELL, 3: JW_CELL, 4: JW_CELL },
  4: { 0: { sc: 'pk', legacy: 'pk', dir: 'I' }, 1: { sc: 'nc', legacy: 'pk', dir: 'I' }, 2: { sc: 'pk', legacy: 'pk', dir: 'D' }, 3: JW_CELL, 4: { sc: 'nc', legacy: 'pk', dir: 'I' } },
};

function selectMethod(initIo, respIo, sc) {
  const cell = (IO_TABLE[respIo] && IO_TABLE[respIo][initIo]) || JW_CELL;
  const m = sc ? cell.sc : cell.legacy;
  if (m === 'pk') return { method: 'pk', weDisplay: cell.dir === 'D', weInput: cell.dir === 'I' };
  return { method: m };
}

export class SMP {
  constructor() {
    this.local = { io: IO_CAP.NO_INPUT_NO_OUTPUT, oob: false, bonding: true, mitm: false, sc: true, keypress: false, maxKey: 16, initKeyDist: KD.ID, respKeyDist: KD.ID | KD.SIGN, passkey: null, acceptPairing: true };
    this.send = null;       // (conn, pdu:Uint8Array) => void
    this.onEvent = null;    // (conn, {type, ...}) => void
    this.getLocalAddr = null; // (conn) => { type:0|1, bytesBE:Uint8Array(6) }
  }

  configure(cfg) { Object.assign(this.local, cfg); }
  _emit(conn, ev) { if (this.onEvent) this.onEvent(conn, ev); }
  _send(conn, pdu) { if (this.send) this.send(conn, pdu); }

  fail(conn, reason) {
    if (conn.pairing) conn.pairing.state = 'failed';
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_FAILED, reason]));
    this._emit(conn, { type: 'failed', reason, reasonName: SMP_FAIL_NAMES[reason] || `0x${reason.toString(16)}` });
  }

  authReqByte() {
    let b = 0;
    if (this.local.bonding) b |= AUTH.BONDING;
    if (this.local.mitm) b |= AUTH.MITM;
    if (this.local.sc) b |= AUTH.SC;
    if (this.local.keypress) b |= AUTH.KEYPRESS;
    return b;
  }

  async handlePdu(conn, data) {
    const op = data[0];
    try {
      switch (op) {
        case SMP_OP.PAIRING_REQUEST: return this.onPairingRequest(conn, data);
        case SMP_OP.PAIRING_PUBLIC_KEY: return this.onPublicKey(conn, data);
        case SMP_OP.PAIRING_CONFIRM: return this.onConfirm(conn, data);
        case SMP_OP.PAIRING_RANDOM: return this.onRandom(conn, data);
        case SMP_OP.PAIRING_DHKEY_CHECK: return this.onDhKeyCheck(conn, data);
        case SMP_OP.ENCRYPTION_INFORMATION: return this.onKeyDist(conn, data);
        case SMP_OP.CENTRAL_IDENTIFICATION: return this.onKeyDist(conn, data);
        case SMP_OP.IDENTITY_INFORMATION: return this.onKeyDist(conn, data);
        case SMP_OP.IDENTITY_ADDRESS_INFORMATION: return this.onKeyDist(conn, data);
        case SMP_OP.SIGNING_INFORMATION: return this.onKeyDist(conn, data);
        case SMP_OP.PAIRING_FAILED: this._emit(conn, { type: 'failed', reason: data[1], reasonName: SMP_FAIL_NAMES[data[1]] }); return;
        default: return this.fail(conn, SMP_FAIL.COMMAND_NOT_SUPPORTED);
      }
    } catch (e) {
      this.fail(conn, SMP_FAIL.UNSPECIFIED);
    }
  }

  // Phase 1 — feature exchange + method selection.
  onPairingRequest(conn, data) {
    // Refuse pairing if configured to: reply Pairing Failed (Pairing Not Supported, 0x05). Per the
    // Security Manager spec this aborts only the pairing procedure — the LE connection stays up,
    // unencrypted and unbonded (a "transparent" connection). Only open GATT attributes are accessible.
    if (!this.local.acceptPairing) return this.fail(conn, SMP_FAIL.PAIRING_NOT_SUPPORTED);

    const preq = data.subarray(0, 7);
    const r = new ByteReader(data); r.u8();
    const initIo = r.u8(), initOob = r.u8(), initAuth = r.u8(), initMaxKey = r.u8(), initIkd = r.u8(), initRkd = r.u8();

    const pres = new ByteWriter().u8(SMP_OP.PAIRING_RESPONSE).u8(this.local.io).u8(this.local.oob ? 1 : 0)
      .u8(this.authReqByte()).u8(this.local.maxKey)
      .u8(initIkd & this.local.initKeyDist).u8(initRkd & this.local.respKeyDist).build();

    const sc = !!(initAuth & AUTH.SC) && this.local.sc;
    const mitm = !!(initAuth & AUTH.MITM) || this.local.mitm;
    const sel = (!mitm) ? { method: 'jw' } : selectMethod(initIo, this.local.io, sc);

    const local = this.getLocalAddr ? this.getLocalAddr(conn) : { type: 0, bytesBE: new Uint8Array(6) };
    conn.pairing = {
      state: 'phase2', sc, sel, preq: Uint8Array.from(preq), pres: Uint8Array.from(pres),
      initIo, initOob, initAuth, initIkd: initIkd & this.local.initKeyDist, initRkd: initRkd & this.local.respKeyDist,
      keySize: Math.min(initMaxKey, this.local.maxKey),
      ia: cryptoAddr(conn.peerAddrType, conn.peerAddr), ib: cryptoAddr(local.type, local.bytesBE, true),
      iaRaw: conn.peerAddrType, bonding: !!(initAuth & AUTH.BONDING) && this.local.bonding,
      keys: {}, peerKeys: {}, distRemaining: 0,
    };
    this._emit(conn, { type: 'start', sc, method: sel.method });
    this._send(conn, pres);
    if (this.local.maxKey < 7 || conn.pairing.keySize < 7) return this.fail(conn, SMP_FAIL.ENCRYPTION_KEY_SIZE);

    // For SC the initiator sends its public key next. For legacy it sends Pairing Confirm, so
    // establish TK now (Just Works = 0; passkey = display ours, or wait for the user to enter the peer's).
    if (!sc) {
      const p = conn.pairing;
      if (sel.method === 'pk' && sel.weDisplay) {
        p.passkey = this.local.passkey ?? randomPasskey();
        p.tk = passkeyTo128(p.passkey);
        this._emit(conn, { type: 'passkey-display', passkey: p.passkey });
      } else if (sel.method === 'pk') {
        p.tk = null;
        this._emit(conn, { type: 'passkey-request' });
      } else {
        p.tk = new Uint8Array(16);
      }
    }
  }

  // ---- LE Secure Connections ----
  async onPublicKey(conn, data) {
    const p = conn.pairing; if (!p || !p.sc) return this.fail(conn, SMP_FAIL.UNSPECIFIED);
    const x = C.reverse(data.subarray(1, 33)), y = C.reverse(data.subarray(33, 65));
    p.peerPub = concatBytes(x, y); // big-endian X||Y
    const kp = await C.generateKeyPair();
    p.keyPair = kp.keyPair; p.localPub = kp.publicKey; // big-endian X||Y
    // send our public key (little-endian coordinates)
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_PUBLIC_KEY, ...C.reverse(p.localPub.subarray(0, 32)), ...C.reverse(p.localPub.subarray(32, 64))]));
    p.dhKey = await C.computeDhKey(p.keyPair, p.peerPub);
    p.PKax = p.peerPub.subarray(0, 32); // initiator x
    p.PKbx = p.localPub.subarray(0, 32); // responder x
    p.Nb = C.randomBytes(16);
    p.passkeyBits = 0;
    if (p.sel.method === 'pk') {
      // Passkey: obtain the 6-digit passkey (display ours or wait for input).
      if (p.sel.weDisplay) { p.passkey = this.local.passkey ?? randomPasskey(); this._emit(conn, { type: 'passkey-display', passkey: p.passkey }); p.ra = passkeyTo128(p.passkey); this._pkRoundResponder(conn); }
      else { this._emit(conn, { type: 'passkey-request' }); /* waits for inputPasskey() */ }
    } else {
      // Just Works / Numeric Comparison: responder commits first with Cb = f4(PKbx, PKax, Nb, 0).
      p.Cb = await C.f4(p.PKbx, p.PKax, p.Nb, 0);
      this._send(conn, new Uint8Array([SMP_OP.PAIRING_CONFIRM, ...C.reverse(p.Cb)]));
    }
  }

  /** User entered the passkey shown on the peer (Passkey Entry, we input). */
  async inputPasskey(conn, passkey) {
    const p = conn.pairing; if (!p) return;
    p.passkey = passkey;
    if (!p.sc) { // legacy
      p.tk = passkeyTo128(passkey);
      if (p.pendingLegacyConfirm) { p.pendingLegacyConfirm = false; await this._legacyResponderConfirm(conn); }
      return;
    }
    p.ra = passkeyTo128(passkey);
    this._pkRoundResponder(conn);
  }

  async _pkRoundResponder(conn) {
    const p = conn.pairing;
    const bit = (p.ra[15 - (p.passkeyBits >> 3)] >> (p.passkeyBits & 7)) & 1; // LSB-first over 20 bits
    p.rbi = new Uint8Array([0x80 | bit]);
    p.Nbi = C.randomBytes(16);
    p.Cbi = await C.f4(p.PKbx, p.PKax, p.Nbi, p.rbi[0]);
    this._maybeSendCbi(conn); // per spec, send Cbi only after the initiator's Cai arrives
  }

  // Send our round confirm once both it is computed and the initiator's confirm has arrived
  // (handles either message ordering: passkey-display vs passkey-input).
  _maybeSendCbi(conn) {
    const p = conn.pairing;
    if (p.Cbi && p.CaiReceived && !p.CbiSent) {
      p.CbiSent = true;
      this._send(conn, new Uint8Array([SMP_OP.PAIRING_CONFIRM, ...C.reverse(p.Cbi)]));
    }
  }

  async onConfirm(conn, data) {
    const p = conn.pairing; if (!p) return this.fail(conn, SMP_FAIL.UNSPECIFIED);
    const confirm = C.reverse(data.subarray(1, 17));
    if (p.sc && p.sel.method === 'pk') {
      p.Cai = confirm; p.CaiReceived = true;
      this._maybeSendCbi(conn);
      return;
    }
    if (!p.sc) { // legacy: store initiator confirm, respond with ours (waiting for a passkey if we input)
      p.Mconfirm = confirm;
      if (p.tk == null) { p.pendingLegacyConfirm = true; return; }
      return this._legacyResponderConfirm(conn);
    }
    // SC JW/NC: initiator doesn't send a confirm — ignore.
  }

  async onRandom(conn, data) {
    const p = conn.pairing; if (!p) return this.fail(conn, SMP_FAIL.UNSPECIFIED);
    const rand = C.reverse(data.subarray(1, 17));
    if (p.sc && p.sel.method === 'pk') return this._pkOnRandom(conn, rand);
    if (p.sc) { // JW / NC
      p.Na = rand;
      this._send(conn, new Uint8Array([SMP_OP.PAIRING_RANDOM, ...C.reverse(p.Nb)]));
      if (p.sel.method === 'nc') {
        const v = (await C.g2(p.PKax, p.PKbx, p.Na, p.Nb)) % 1000000;
        p.ncValue = String(v).padStart(6, '0');
        this._emit(conn, { type: 'numeric-comparison', value: p.ncValue }); // wait for confirmNumeric()
      } else {
        await this._scStage2(conn);
      }
      return;
    }
    // legacy
    return this._legacyOnRandom(conn, rand);
  }

  async _pkOnRandom(conn, Nai) {
    const p = conn.pairing;
    // verify initiator confirm Cai = f4(PKax, PKbx, Nai, rbi)
    const check = await C.f4(p.PKax, p.PKbx, Nai, p.rbi[0]);
    if (!bytesEqual(check, p.Cai)) return this.fail(conn, SMP_FAIL.CONFIRM_VALUE_FAILED);
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_RANDOM, ...C.reverse(p.Nbi)]));
    p.Na = Nai; p.Nb = p.Nbi; // last round's nonces are used in stage 2
    p.passkeyBits++;
    p.CaiReceived = false; p.CbiSent = false; p.Cbi = null;
    if (p.passkeyBits < 20) { await this._pkRoundResponder(conn); return; }
    await this._scStage2(conn);
  }

  /** User accepted/rejected the numeric comparison. */
  async confirmNumeric(conn, yes) {
    if (!yes) return this.fail(conn, SMP_FAIL.NUMERIC_COMPARISON_FAILED);
    await this._scStage2(conn);
  }

  async _scStage2(conn) {
    const p = conn.pairing;
    const { macKey, ltk } = await C.f5(p.dhKey, p.Na, p.Nb, p.ia, p.ib);
    p.macKey = macKey; p.ltk = maskKey(ltk, p.keySize);
    p.iocapA = new Uint8Array([p.initAuth, p.initOob, p.initIo]);
    p.iocapB = new Uint8Array([this.authReqByte(), this.local.oob ? 1 : 0, this.local.io]);
    p.R = (p.sel.method === 'pk') ? p.ra : new Uint8Array(16);
    p.state = 'dhkey-check';
    // The initiator often sends its DHKey Check (Ea) before we reach this point — e.g. while we
    // were waiting for the user to confirm the numeric comparison. Process any buffered one now.
    if (p.pendingEa) { const Ea = p.pendingEa; p.pendingEa = null; await this._processDhKeyCheck(conn, Ea); }
  }

  async onDhKeyCheck(conn, data) {
    const p = conn.pairing; if (!p) return this.fail(conn, SMP_FAIL.UNSPECIFIED);
    const Ea = C.reverse(data.subarray(1, 17));
    // Stage 2 (macKey/R/iocap) may not be ready yet if the user hasn't confirmed the numeric
    // comparison. Buffer Ea until _scStage2 runs, rather than computing f6 with undefined inputs.
    if (p.state !== 'dhkey-check' || !p.macKey) { p.pendingEa = Ea; return; }
    return this._processDhKeyCheck(conn, Ea);
  }

  async _processDhKeyCheck(conn, Ea) {
    const p = conn.pairing;
    const expect = await C.f6(p.macKey, p.Na, p.Nb, p.R, p.iocapA, p.ia, p.ib);
    if (!bytesEqual(Ea, expect)) return this.fail(conn, SMP_FAIL.DHKEY_CHECK_FAILED);
    const Eb = await C.f6(p.macKey, p.Nb, p.Na, p.R, p.iocapB, p.ib, p.ia);
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_DHKEY_CHECK, ...C.reverse(Eb)]));
    p.keys.ltk = p.ltk; p.keys.sc = true;
    p.state = 'await-encrypt';
    this._emit(conn, { type: 'ltk-ready', ltk: p.ltk, ediv: 0, rand: new Uint8Array(8) });
  }

  // ---- LE legacy ----
  async _legacyResponderConfirm(conn) {
    const p = conn.pairing; // TK already established in onPairingRequest / inputPasskey
    p.Srand = C.randomBytes(16);
    p.Sconfirm = await this._c1(conn, p.tk, p.Srand);
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_CONFIRM, ...C.reverse(p.Sconfirm)]));
  }

  async _legacyOnRandom(conn, Mrand) {
    const p = conn.pairing;
    const check = await this._c1(conn, p.tk, Mrand);
    if (!bytesEqual(check, p.Mconfirm)) return this.fail(conn, SMP_FAIL.CONFIRM_VALUE_FAILED);
    this._send(conn, new Uint8Array([SMP_OP.PAIRING_RANDOM, ...C.reverse(p.Srand)]));
    const stk = await C.s1(p.tk, p.Srand, Mrand); // STK = s1(TK, LP_RAND_R, LP_RAND_I)
    p.ltk = maskKey(stk, p.keySize); p.keys.stk = p.ltk;
    p.state = 'await-encrypt';
    this._emit(conn, { type: 'ltk-ready', ltk: p.ltk, ediv: 0, rand: new Uint8Array(8), legacy: true });
  }

  async _c1(conn, tk, rand) {
    const p = conn.pairing;
    // c1(k, r, preq, pres, iat, ia, rat, ra). The toolbox works big-endian (MSO first), but the
    // Pairing Request/Response PDUs are transmission order (code octet first = least significant in
    // the 56-bit value), so reverse them. Addresses are already MSO-first (display order).
    return C.c1(tk, rand, C.reverse(p.preq), C.reverse(p.pres), p.iaRaw & 1, addr6(p.ia), conn.localAddrType || 0, addr6(p.ib));
  }

  // ---- Phase 3 key distribution (after encryption) ----
  /** Called by the connection manager once the link is encrypted. */
  async startKeyDistribution(conn) {
    const p = conn.pairing; if (!p) return;
    // Send our (responder) keys per the negotiated respKeyDist, in spec order (Core v6.0
    // Vol 3 Part H 3.6.1): Encryption Info -> Central Id -> Identity -> Identity Addr -> Signing.
    if (!p.sc && (p.initRkd & KD.ENC)) {
      // LE legacy bonding: distribute a fresh long-term key for reconnection — the STK only
      // protects this session. EDIV/Rand tag the LTK; the peer hands them back in a later LE
      // Long Term Key Request. (SC derives the LTK on both ends via f5 and never transmits one,
      // so this whole step is skipped for Secure Connections.)
      const ltk = maskKey(C.randomBytes(16), p.keySize);
      const rand = C.randomBytes(8);
      const edivB = C.randomBytes(2);
      const ediv = edivB[0] | (edivB[1] << 8);
      p.keys.ltk = ltk; p.keys.ediv = ediv; p.keys.rand = rand;
      this._send(conn, new Uint8Array([SMP_OP.ENCRYPTION_INFORMATION, ...C.reverse(ltk)]));
      this._send(conn, new Uint8Array([SMP_OP.CENTRAL_IDENTIFICATION, edivB[0], edivB[1], ...rand]));
    }
    if (p.initRkd & KD.ID) {
      const irk = this.local.irk || C.randomBytes(16);
      this.local.irk = irk; p.keys.irk = irk;
      this._send(conn, new Uint8Array([SMP_OP.IDENTITY_INFORMATION, ...C.reverse(irk)]));
      const la = this.getLocalAddr ? this.getLocalAddr(conn) : { type: 0, bytesBE: new Uint8Array(6) };
      this._send(conn, new Uint8Array([SMP_OP.IDENTITY_ADDRESS_INFORMATION, la.type, ...C.reverse(la.bytesBE)]));
    }
    if (p.initRkd & KD.SIGN) {
      const csrk = C.randomBytes(16); p.keys.csrk = csrk;
      this._send(conn, new Uint8Array([SMP_OP.SIGNING_INFORMATION, ...C.reverse(csrk)]));
    }
    // Now expect the initiator's keys (initIkd). ENC and ID are two PDUs each, SIGN is one; SC
    // never sends the LTK, so its ENC bit carries no Encryption Info / Central Id PDUs.
    const rxEnc = (!p.sc && (p.initIkd & KD.ENC)) ? 2 : 0;
    const rxId = (p.initIkd & KD.ID) ? 2 : 0;
    const rxSign = (p.initIkd & KD.SIGN) ? 1 : 0;
    p.distRemaining = rxEnc + rxId + rxSign;
    if (p.distRemaining === 0) this._complete(conn);
  }

  onKeyDist(conn, data) {
    const p = conn.pairing; if (!p) return;
    const r = new ByteReader(data); const op = r.u8();
    if (op === SMP_OP.ENCRYPTION_INFORMATION) p.peerKeys.ltk = C.reverse(r.read(16));
    else if (op === SMP_OP.CENTRAL_IDENTIFICATION) { p.peerKeys.ediv = r.u16(); p.peerKeys.rand = r.read(8); }
    else if (op === SMP_OP.IDENTITY_INFORMATION) p.peerKeys.irk = C.reverse(r.read(16));
    else if (op === SMP_OP.IDENTITY_ADDRESS_INFORMATION) { p.peerKeys.idAddrType = r.u8(); p.peerKeys.idAddr = C.reverse(r.read(6)); }
    else if (op === SMP_OP.SIGNING_INFORMATION) p.peerKeys.csrk = C.reverse(r.read(16));
    if (p.distRemaining > 0 && --p.distRemaining === 0) this._complete(conn);
  }

  _complete(conn) {
    const p = conn.pairing; p.state = 'done';
    this._emit(conn, { type: 'complete', bonding: p.bonding, sc: p.sc, method: p.sel.method, keys: p.keys, peerKeys: p.peerKeys, keySize: p.keySize });
  }
}

// ---- helpers ----
function maskKey(ltk16, keySize) {
  if (keySize >= 16) return ltk16;
  const out = Uint8Array.from(ltk16);
  for (let i = keySize; i < 16; i++) out[15 - i] = 0; // zero the most-significant (16-keySize) octets
  return out;
}
function randomPasskey() { return C.randomBytes(3).reduce((a, b) => a * 256 + b, 0) % 1000000; }
function passkeyTo128(passkey) {
  const out = new Uint8Array(16);
  out[15] = passkey & 0xff; out[14] = (passkey >> 8) & 0xff; out[13] = (passkey >> 16) & 0xff;
  return out;
}
/** Build the 7-octet crypto address (type || big-endian addr) for f5/f6. */
function cryptoAddr(typeNum, addr, isLocalBytes = false) {
  const be = isLocalBytes ? Uint8Array.from(addr) : displayToBE(addr);
  return concatBytes(new Uint8Array([typeNum & 1]), be);
}
function addr6(sevenByte) { return sevenByte.subarray(1); }
function displayToBE(str) {
  return new Uint8Array(String(str).split(/[:\-\s]/).filter(Boolean).map((h) => parseInt(h, 16)));
}
