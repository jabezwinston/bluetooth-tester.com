// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder bindings: translate between a widget and the bytes exchanged with its bound GATT
// characteristic. Outbound widgets (button/slider) produce bytes to notify subscribers;
// inbound widgets (led/display) consume bytes a central wrote and return a props patch.
// Pure — no DOM, no BLE — so it is unit-testable in Node.

import { hexToBytes } from '../../util/bytes.js';

// Widget → BLE direction. Outbound = the UI drives the characteristic; inbound = the
// characteristic (written by a connected central) drives the UI.
export const OUTBOUND = new Set(['button', 'slider']);
export const INBOUND = new Set(['led', 'display']);

/** Bytes to send when an outbound widget fires. `value` overrides the slider position. */
export function outboundBytes(widget, value) {
  const props = widget.props || {};
  if (widget.type === 'slider') {
    const raw = value == null ? (props.value ?? 0) : value;
    return new Uint8Array([clampByte(raw)]);
  }
  // button: send the configured hex payload (default a single 0x01).
  const clean = String(props.sendHex || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return new Uint8Array([0x01]);
  const even = clean.length % 2 ? '0' + clean : clean;
  try { return hexToBytes(even); } catch { return new Uint8Array([0x01]); }
}

/** Props patch for an inbound widget when the bound characteristic is written. */
export function applyInbound(widget, bytes) {
  const b = bytes || new Uint8Array(0);
  if (widget.type === 'led') return { on: Array.from(b).some((x) => x !== 0) };
  if (widget.type === 'display') return { text: decodeText(b) };
  return {};
}

function clampByte(n) {
  const v = Math.round(Number(n) || 0);
  return Math.max(0, Math.min(255, v)) & 0xff;
}

// Render bytes as text when they look like printable UTF-8, otherwise as spaced hex.
function decodeText(bytes) {
  const printable = bytes.length > 0 && Array.from(bytes).every(
    (c) => c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c < 0x7f));
  if (printable) return new TextDecoder().decode(bytes);
  return Array.from(bytes).map((x) => x.toString(16).padStart(2, '0')).join(' ');
}
