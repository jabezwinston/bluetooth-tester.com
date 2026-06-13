// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// SMP cryptographic toolbox (Core v6.0 Vol 3 Part H §2.2). All functions operate on
// big-endian byte arrays exactly as the spec defines (most-significant octet = byte[0]);
// the SMP layer handles the little-endian wire conversion. Backed by WebCrypto
// (AES-128 + ECDH P-256). Verified against the spec/RFC4493 sample data in test/smoke-crypto.

import { concatBytes, hexToBytes } from '../util/bytes.js';

const subtle = globalThis.crypto.subtle;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function xor(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Security function e: AES-128 single-block ECB (via CBC with a zero IV). */
export async function e(key, plaintext) {
  const k = await subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, k, plaintext));
  return ct.slice(0, 16);
}

// ---- AES-CMAC (RFC 4493) ----
function leftShift1(b) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = ((b[i] << 1) & 0xff) | (i < 15 ? b[i + 1] >> 7 : 0);
  return out;
}
function subkey(inB) {
  const out = leftShift1(inB);
  if (inB[0] & 0x80) out[15] ^= 0x87;
  return out;
}

export async function aesCmac(key, msg) {
  const L = await e(key, new Uint8Array(16));
  const K1 = subkey(L);
  const K2 = subkey(K1);

  const n = Math.max(1, Math.ceil(msg.length / 16));
  const lastComplete = msg.length > 0 && msg.length % 16 === 0;

  let mLast;
  if (lastComplete) {
    mLast = xor(msg.subarray((n - 1) * 16, n * 16), K1);
  } else {
    const rem = msg.subarray((n - 1) * 16);
    const padded = new Uint8Array(16);
    padded.set(rem);
    padded[rem.length] = 0x80;
    mLast = xor(padded, K2);
  }

  let x = new Uint8Array(16);
  for (let i = 0; i < n - 1; i++) x = await e(key, xor(x, msg.subarray(i * 16, i * 16 + 16)));
  return e(key, xor(x, mLast));
}

// ---- LE legacy ----
/** c1(k, r, preq, pres, iat, ia, rat, ra): preq/pres 7 octets, ia/ra 6 octets, iat/rat 1 bit. */
export async function c1(k, r, preq, pres, iat, ia, rat, ra) {
  const p1 = concatBytes(pres, preq, new Uint8Array([rat & 1]), new Uint8Array([iat & 1]));
  const p2 = concatBytes(new Uint8Array(4), ia, ra);
  return e(k, xor(await e(k, xor(r, p1)), p2));
}

/** s1(k, r1, r2): STK generation; uses the least-significant 64 bits of each random. */
export async function s1(k, r1, r2) {
  return e(k, concatBytes(r1.subarray(8), r2.subarray(8)));
}

// ---- LE Secure Connections ----
export async function f4(U, V, X, Z) {
  return aesCmac(X, concatBytes(U, V, new Uint8Array([Z])));
}

const F5_SALT = hexToBytes('6C888391AAF5A53860370BDB5A6083BE');
const F5_KEYID = hexToBytes('62746C65'); // "btle"
/** f5(W, N1, N2, A1, A2) -> { macKey, ltk } (each 16 bytes). A1/A2 are 7 octets (type||addr). */
export async function f5(W, N1, N2, A1, A2) {
  const T = await aesCmac(F5_SALT, W);
  const len = new Uint8Array([0x01, 0x00]); // 256
  const mac = (counter) => aesCmac(T, concatBytes(new Uint8Array([counter]), F5_KEYID, N1, N2, A1, A2, len));
  return { macKey: await mac(0), ltk: await mac(1) };
}

export async function f6(W, N1, N2, R, IOcap, A1, A2) {
  return aesCmac(W, concatBytes(N1, N2, R, IOcap, A1, A2));
}

/** g2(U, V, X, Y) -> 32-bit number; numeric-comparison value is (result mod 1_000_000). */
export async function g2(U, V, X, Y) {
  const mac = await aesCmac(X, concatBytes(U, V, Y));
  return ((mac[12] << 24) | (mac[13] << 16) | (mac[14] << 8) | mac[15]) >>> 0;
}

export async function h6(W, keyID) { return aesCmac(W, keyID); }
export async function h7(salt, W) { return aesCmac(salt, W); }

// ---- Privacy (RPA) ----
/** ah(irk, r): r is the 3-octet (24-bit) prand; returns the 3-octet hash. */
export async function ah(irk, r3) {
  const rp = new Uint8Array(16);
  rp.set(r3, 13); // padding (13 zero octets) || r (3 octets)
  return (await e(irk, rp)).slice(13);
}

/** Generate a Resolvable Private Address (6 octets, little-endian wire order) from an IRK. */
export async function generateRpa(irk) {
  const prand = randomBytes(3);
  prand[0] = (prand[0] & 0x3f) | 0x40; // top two bits: 0b01 (resolvable)
  const hash = await ah(irk, prand); // big-endian 3 octets
  // Wire (LE): hash[2..0] then prand[2..0]
  return new Uint8Array([hash[2], hash[1], hash[0], prand[2], prand[1], prand[0]]);
}

/** Resolve an RPA (6 octets LE wire order) against an IRK. */
export async function resolveRpa(irk, addrLE) {
  const prand = new Uint8Array([addrLE[5], addrLE[4], addrLE[3]]); // big-endian
  if ((prand[0] & 0xc0) !== 0x40) return false; // not a resolvable address
  const hash = await ah(irk, prand);
  return hash[0] === addrLE[2] && hash[1] === addrLE[1] && hash[2] === addrLE[0];
}

// ---- ECDH P-256 ----
/** Generate a P-256 key pair. publicKey is 64 bytes (X||Y, big-endian). */
export async function generateKeyPair() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 0x04 || X || Y
  return { keyPair: kp, publicKey: raw.slice(1) };
}

/** DHKey = P256(localPriv, peerPub). peerPublicKey is 64 bytes (X||Y, big-endian). */
export async function computeDhKey(keyPair, peerPublicKey) {
  const peer = await subtle.importKey('raw', concatBytes(new Uint8Array([0x04]), peerPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, keyPair.privateKey, 256);
  return new Uint8Array(bits); // 32-byte X coordinate (big-endian) = DHKey
}

export function reverse(bytes) {
  return Uint8Array.from(bytes).reverse();
}
