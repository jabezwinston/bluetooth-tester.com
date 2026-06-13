// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Author example scripts as real (never-called) functions, then extract their dedented body text.
// This keeps the example source readable + syntax-checked (no escaped \n / backtick / ${} soup) and
// produces exactly what the user sees in the editor. The function references runtime globals
// (widget, bt, log) that only exist in the sandbox — fine, since it is stringified, never called.

export function program(fn) {
  const src = fn.toString();
  const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).replace(/^\n+/, '').replace(/\s+$/, '');
  const lines = body.split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n') + '\n';
}
