// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder widget registry: the four front-panel widgets (LED, emoji Button, Slider, character
// Display). Each entry carries palette metadata, default props, an inspector field spec, and a
// DOM renderer. Renderers are interaction-wired by the panel through the `h` (handlers) arg:
//   h.onPress(widget)            — button clicked
//   h.onChange(widget, value)    — slider moved (live, every input)
//   h.onCommit(widget, value)    — slider released (commit to store)
// Imports the DOM helper, so this module is browser-only (the testable logic lives in bindings.js).

import { el } from '../dom.js';

export const WIDGETS = {
  led: {
    type: 'led', name: 'LED', icon: '🔴',
    size: { w: 80, h: 86 },
    defaults: { color: '#ff3b30', on: false, label: '' },
    fields: [
      { key: 'label', label: 'Label', kind: 'text' },
      { key: 'color', label: 'Colour', kind: 'color' },
      { key: 'on', label: 'On', kind: 'bool' },
    ],
    render(w) {
      const p = w.props;
      return el('div.bw-led', {},
        el('div', {
          class: 'bw-led-dot' + (p.on ? ' on' : ''),
          style: {
            background: p.on ? p.color : 'transparent',
            borderColor: p.color,
            boxShadow: p.on ? `0 0 12px ${p.color}` : 'none',
          },
        }),
        p.label ? el('span.bw-led-label', { text: p.label }) : null);
    },
    // In-place inbound update (no DOM teardown → no flicker).
    update(wrap, w, patch) {
      const dot = wrap.querySelector('.bw-led-dot');
      if (!dot) return;
      const on = !!patch.on, color = w.props.color || '#ff3b30';
      dot.classList.toggle('on', on);
      dot.style.background = on ? color : 'transparent';
      dot.style.borderColor = color;
      dot.style.boxShadow = on ? `0 0 12px ${color}` : 'none';
    },
  },

  button: {
    type: 'button', name: 'Button', icon: '🔘',
    size: { w: 84, h: 92 },
    defaults: { emoji: '⏯️', text: '', sendHex: '01' },
    fields: [
      { key: 'emoji', label: 'Emoji', kind: 'emoji' },
      { key: 'text', label: 'Caption', kind: 'text' },
      { key: 'sendHex', label: 'Send on press (hex)', kind: 'text' },
    ],
    render(w, h) {
      const p = w.props;
      const btn = el('button.bw-btn', {},
        el('span.bw-btn-emoji', { text: p.emoji || '🔘' }),
        p.text ? el('span.bw-btn-text', { text: p.text }) : null);
      btn.addEventListener('click', (e) => { e.stopPropagation(); h?.onPress?.(w); });
      return btn;
    },
  },

  slider: {
    type: 'slider', name: 'Slider', icon: '🎚️',
    size: { w: 200, h: 74 },
    defaults: { min: 0, max: 255, value: 0 },
    fields: [
      { key: 'min', label: 'Min', kind: 'number' },
      { key: 'max', label: 'Max', kind: 'number' },
      { key: 'value', label: 'Value', kind: 'number' },
    ],
    render(w, h) {
      const p = w.props;
      const input = el('input.bw-slider', { type: 'range', min: p.min, max: p.max, value: p.value });
      const out = el('span.bw-slider-val', { text: String(p.value) });
      input.addEventListener('input', (e) => { out.textContent = e.target.value; h?.onChange?.(w, Number(e.target.value)); });
      input.addEventListener('change', (e) => h?.onCommit?.(w, Number(e.target.value)));
      return el('div.bw-slider-wrap', {}, input, out);
    },
  },

  display: {
    type: 'display', name: 'Display', icon: '🟩',
    size: { w: 220, h: 92 },
    defaults: { rows: 2, cols: 16, text: 'Hello' },
    fields: [
      { key: 'rows', label: 'Rows', kind: 'number' },
      { key: 'cols', label: 'Cols', kind: 'number' },
      { key: 'text', label: 'Text', kind: 'text' },
    ],
    render(w) {
      const p = w.props;
      const rows = Math.max(1, Math.min(8, (p.rows | 0) || 1));
      const cols = Math.max(1, Math.min(40, (p.cols | 0) || 1));
      const grid = el('div.bw-display', { style: { gridTemplateColumns: `repeat(${cols}, 1ch)` } });
      const lines = String(p.text ?? '').split('\n');
      for (let r = 0; r < rows; r++) {
        const line = lines[r] || '';
        for (let c = 0; c < cols; c++) grid.append(el('span.bw-cell', { text: line[c] || ' ' }));
      }
      return grid;
    },
    // In-place inbound update — reuse the existing cells when the shape matches (no flicker),
    // otherwise repaint the grid.
    update(wrap, w, patch) {
      const grid = wrap.querySelector('.bw-display');
      if (!grid) return;
      const rows = Math.max(1, Math.min(8, (w.props.rows | 0) || 1));
      const cols = Math.max(1, Math.min(40, (w.props.cols | 0) || 1));
      const lines = String(patch.text ?? '').split('\n');
      const cells = grid.children;
      if (cells.length === rows * cols) {
        for (let r = 0; r < rows; r++) { const line = lines[r] || ''; for (let c = 0; c < cols; c++) cells[r * cols + c].textContent = line[c] || ' '; }
      } else {
        grid.style.gridTemplateColumns = `repeat(${cols}, 1ch)`;
        grid.innerHTML = '';
        for (let r = 0; r < rows; r++) { const line = lines[r] || ''; for (let c = 0; c < cols; c++) grid.append(el('span.bw-cell', { text: line[c] || ' ' })); }
      }
    },
  },
};

export const PALETTE = Object.values(WIDGETS).map((w) => ({ type: w.type, name: w.name, icon: w.icon }));

export function widgetDef(type) { return WIDGETS[type] || null; }

export function makeWidget(type, x, y, id) {
  const def = WIDGETS[type];
  return { id, type, x, y, props: { ...def.defaults }, binding: null };
}
