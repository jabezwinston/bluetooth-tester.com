// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Shared helper: restrict a text <input>/<textarea> to space-separated hex bytes ("02 1A FF").
// Used by any field that takes a raw hex byte payload (advertiser data, GATT characteristic/descriptor
// values, GATT client writes). hexToBytes() ignores the spaces, so stored/parsed values are unaffected.

import { hexToBytes, bytesToHex } from '../util/bytes.js';

// Drop "0x" + non-hex, uppercase, regroup into space-separated byte pairs.
export const fmtHexBytes = (raw) =>
  ((raw || '').replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().match(/.{1,2}/g) || []).join(' ');

// Convert between the two representations of the SAME bytes, for a hex/text value-type toggle.
// text → spaced hex (UTF-8 encoded, matching how valueText is stored); hex → UTF-8 text (the raw hex
// is kept if it isn't decodable, so a partial entry isn't lost on switch).
export const textToHexBytes = (text) => fmtHexBytes(bytesToHex(new TextEncoder().encode(text || ''), ''));
export const hexToText = (hex) => { try { return new TextDecoder().decode(hexToBytes(hex)); } catch { return hex; } };

/**
 * Restrict an <input>/<textarea> to space-separated hex bytes while `isActive()` is true: filter out
 * anything but hex, auto-insert a space after each byte, and keep the caret stable while typing.
 * `isActive` lets a dual-purpose field (a hex/text mode toggle) enforce hex only in hex mode — when it
 * returns false the field is left as free text. Returns the element. Register this BEFORE any other
 * 'input' listener (e.g. a live preview) so they read the already-normalized value.
 */
export function restrictHexBytes(input, isActive = () => true) {
  if (isActive()) input.value = fmtHexBytes(input.value);
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    if (!isActive()) return;
    const before = input.value.slice(0, input.selectionStart).replace(/[^0-9a-fA-F]/g, '').length;
    input.value = fmtHexBytes(input.value);
    let pos = 0, seen = 0;
    while (pos < input.value.length && seen < before) { if (input.value[pos] !== ' ') seen++; pos++; }
    if (input.value[pos] === ' ') pos++;
    input.setSelectionRange(pos, pos);
  });
  return input;
}
