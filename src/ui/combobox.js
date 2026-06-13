// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Reusable searchable combobox + chip list — vanilla, no framework. comboListbox is a custom popup
// listbox (replacing the native <datalist>, which can't be styled, dumps all options, and is flaky
// across browsers): click-to-browse, live filtering with match highlighting, full keyboard nav, capped
// long lists, and a clear "no match" state. searchSelect is the numeric-value wrapper used by the
// Advertiser (Appearance + 16-bit Service-UUID pickers); the GATT panel reuses comboListbox for UUIDs.

import { el } from './dom.js';

let _seq = 0;
const hex4 = (v) => `0x${v.toString(16).padStart(4, '0').toUpperCase()}`;
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Resolve typed combobox text to a numeric value. Pure (no DOM) so it is unit-testable.
 *  - options: array of [value:number, label:string]
 * Returns: number (matched), null (empty/cleared), or undefined (unresolved → invalid).
 */
export function resolveOption(text, options, allowRaw = true) {
  const t = (text || '').trim();
  if (!t) return null;
  const lc = t.toLowerCase();
  for (const [v, label] of options) {
    if (lc === label.toLowerCase() || lc === `${label} (${hex4(v)})`.toLowerCase()) return v;
  }
  const sfx = t.match(/\(?\s*0x([0-9a-f]+)\s*\)?\s*$/i); // "...(0x180F)" or a trailing 0x..
  if (sfx) return parseInt(sfx[1], 16);
  if (allowRaw) {
    if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (/^[0-9a-f]{1,4}$/i.test(t)) return parseInt(t, 16); // bare hex like "180f"
  }
  return undefined;
}

/**
 * Filter options for a query, matching the label OR the formatted code, case-insensitively. Pure +
 * Node-testable. Returns { items:[{value,label,code,matchStart,matchEnd}], total, truncated }.
 *  - options: [[value, label]]   - format: (value) => code string   - max: cap on returned items
 */
export function filterOptions(query, options, format = hex4, max = 40) {
  const q = (query || '').trim().toLowerCase();
  const out = [];
  let total = 0;
  for (const [value, label] of options) {
    const code = format(value);
    let matchStart = -1;
    if (!q) matchStart = -1;
    else {
      const li = label.toLowerCase().indexOf(q);
      if (li >= 0) matchStart = li;
      else if (code.toLowerCase().includes(q)) matchStart = -1; // matched on code, highlight nothing
      else continue;
    }
    total++;
    if (out.length < max) out.push({ value, label, code, matchStart, matchEnd: matchStart < 0 ? -1 : matchStart + q.length });
  }
  return { items: out, total, truncated: total > out.length };
}

// ---- the shared popup-listbox singleton (one floating <ul> reused by all comboboxes) ----
let pop = null;          // the portal <ul role=listbox>
let active = null;       // the comboListbox instance currently owning the popup
let activeIdx = -1;      // highlighted row index
let rows = [];           // current rendered { value, el }

function ensurePop() {
  if (pop) return pop;
  pop = el('ul.combo-pop', { attrs: { role: 'listbox' } });
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus through the click
  document.body.appendChild(pop);
  return pop;
}

function closePop() {
  if (pop) { pop.classList.remove('show'); pop.replaceChildren(); }
  if (active) active.input.setAttribute('aria-expanded', 'false');
  active = null; activeIdx = -1; rows = [];
}

function positionPop(input) {
  const p = ensurePop();
  const r = input.getBoundingClientRect();
  p.style.width = r.width + 'px';
  p.style.left = r.left + 'px';
  let top = r.bottom + 4;
  // measure after content is set; flip above if it would overflow the viewport bottom
  const ph = p.offsetHeight;
  if (top + ph > window.innerHeight - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4;
  p.style.top = top + 'px';
}

function setActive(i) {
  if (!rows.length) { activeIdx = -1; active.input.removeAttribute('aria-activedescendant'); return; }
  activeIdx = (i + rows.length) % rows.length;
  rows.forEach((row, k) => {
    const on = k === activeIdx;
    row.el.classList.toggle('active', on);
    row.el.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) { active.input.setAttribute('aria-activedescendant', row.el.id); row.el.scrollIntoView({ block: 'nearest' }); }
  });
}

/**
 * comboListbox({ options, value, onChange, placeholder, format, resolve, hint, max })
 *  - onChange(value): value | null (cleared)
 *  - resolve(text): value | null (clear) | undefined (invalid)  — defaults to resolveOption
 *  - format(value)→code string (shown muted per row + in the code badge)
 * Returns { el (span.combobox), input, setValue(value), resolve }.
 */
export function comboListbox({ options, value = null, onChange, placeholder = 'search…', format = hex4,
  resolve, hint = 'type a name or a hex code, e.g. 0x0041', max = 40, display = 'label' } = {}) {
  const id = `cb${++_seq}`;
  const doResolve = resolve || ((t) => resolveOption(t, options));
  const labelOf = (v) => { const hit = options.find(([x]) => x === v); return hit ? hit[1] : (v == null ? '' : format(v)); };
  // 'label' mode shows the friendly name in the input + a code badge (Appearance/UUID16). 'value' mode
  // shows the raw value in the input + no badge (GATT, where the input itself holds the UUID).
  const inputText = (v) => v == null ? '' : (display === 'value' ? format(v) : labelOf(v));

  const input = el('input.combo-input', {
    type: 'text', placeholder, value: inputText(value),
    attrs: { role: 'combobox', autocomplete: 'off', spellcheck: 'false', 'aria-expanded': 'false', 'aria-controls': 'combo-pop', 'aria-autocomplete': 'list' },
  });
  const code = el('span.combo-code', { text: display === 'value' || value == null ? '' : format(value) });
  const hintEl = el('span.combo-hint', { text: '' });
  const wrap = el('span.combobox', { id }, input, code, hintEl);

  const setCode = (v) => { code.textContent = display === 'value' || v == null ? '' : format(v); };
  const setValue = (v) => { input.value = inputText(v); input.classList.remove('invalid'); hintEl.textContent = ''; setCode(v); };

  function render() {
    const p = ensurePop();
    const { items, total, truncated } = filterOptions(input.value, options, format, max);
    rows = [];
    const kids = items.map((it, i) => {
      const rid = `${id}-o${i}`;
      let labelHtml = esc(it.label);
      if (it.matchStart >= 0) {
        labelHtml = esc(it.label.slice(0, it.matchStart)) + '<mark>' + esc(it.label.slice(it.matchStart, it.matchEnd)) + '</mark>' + esc(it.label.slice(it.matchEnd));
      }
      const row = el('li.combo-opt', { id: rid, attrs: { role: 'option' } },
        el('span.combo-opt-label', { html: labelHtml }),
        el('span.combo-opt-code', { text: it.code }));
      row.addEventListener('mouseenter', () => setActive(i));
      row.addEventListener('click', () => commitValue(it.value));
      rows.push({ value: it.value, el: row });
      return row;
    });
    if (!items.length) kids.push(el('li.combo-empty', { text: `No match — ${hint}` }));
    if (truncated) kids.push(el('li.combo-more', { text: `+${total - items.length} more — keep typing` }));
    p.replaceChildren(...kids);
    activeIdx = items.length ? 0 : -1;
    positionPop(input);
    setActive(activeIdx);
  }

  function open() {
    if (active && active !== api) closePop();
    active = api; ensurePop().classList.add('show'); input.setAttribute('aria-expanded', 'true');
    render();
  }
  const isOpen = () => active === api && pop && pop.classList.contains('show');

  function commitValue(v) {
    if (v != null) { input.value = inputText(v); setCode(v); }
    input.classList.remove('invalid'); hintEl.textContent = '';
    closePop();
    onChange(v); // last — so a handler that clears the field (e.g. add-to-list → setValue(null)) wins
  }
  // Commit whatever is typed (Enter/Tab/blur): resolve → value | clear | invalid.
  function commitText() {
    const v = doResolve(input.value);
    if (v === undefined) { input.classList.add('invalid'); hintEl.textContent = hint; return; }
    commitValue(v);
  }

  // Open on click / typing / ArrowDown — but NOT on plain focus, so a modal auto-focusing this field (or
  // tabbing into it) doesn't immediately dump the list over the form. Keyboard users press ↓ to open.
  input.addEventListener('click', open);
  input.addEventListener('input', () => { input.classList.remove('invalid'); hintEl.textContent = ''; if (isOpen()) render(); else open(); });
  // On real focus-out (option clicks don't blur — popup mousedown is prevented): close + commit typed text.
  input.addEventListener('blur', () => setTimeout(() => { if (active === api) closePop(); commitText(); }, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen()) open(); else setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (isOpen()) setActive(activeIdx - 1); }
    else if (e.key === 'Home') { if (isOpen()) { e.preventDefault(); setActive(0); } }
    else if (e.key === 'End') { if (isOpen()) { e.preventDefault(); setActive(rows.length - 1); } }
    else if (e.key === 'Enter') { if (isOpen() && activeIdx >= 0) { e.preventDefault(); commitValue(rows[activeIdx].value); } else commitText(); }
    else if (e.key === 'Tab') { if (isOpen() && activeIdx >= 0) commitValue(rows[activeIdx].value); else if (input.value.trim()) commitText(); }
    else if (e.key === 'Escape') { if (isOpen()) { e.preventDefault(); closePop(); } }
  });

  const api = { el: wrap, input, setValue, resolve: doResolve };
  return api;
}

// Close on outside click / scroll-away (matches the help-tip portal behaviour).
if (typeof window !== 'undefined') {
  window.addEventListener('mousedown', (e) => { if (active && e.target !== active.input && pop && !pop.contains(e.target)) closePop(); }, true);
  window.addEventListener('scroll', () => { if (active) positionPop(active.input); }, true);
  window.addEventListener('resize', () => { if (active) closePop(); });
}

/**
 * searchSelect({ options, value, onChange, allowRaw, placeholder, format }) — numeric-value picker for
 * the Advertiser (Appearance, 16-bit Service UUID). Same wrapper API as before: returns the
 * <span.combobox> with `.setValue(v)`, `.resolve(text)`, `.input`.
 */
export function searchSelect({ options, value = null, onChange, allowRaw = true, placeholder = 'search…', format = hex4 }) {
  const api = comboListbox({ options, value, onChange, placeholder, format,
    resolve: (t) => resolveOption(t, options, allowRaw) });
  // Backwards-compatible shape: the wrapper element IS the returned node, with helpers attached.
  api.el.setValue = api.setValue;
  api.el.resolve = api.resolve;
  api.el.input = api.input;
  return api.el;
}

/**
 * chipList({ items, label, onRemove }) → a row of removable chips.
 *  - label:    (item) => string
 *  - onRemove: (item, index) => void
 */
export function chipList({ items, label, onRemove }) {
  return el('div.chips', {},
    items.length ? null : el('span.muted', { text: 'none' }),
    ...items.map((item, i) => el('span.chip', {},
      el('span', { text: label(item) }),
      el('button.chip-x', { type: 'button', text: '✕', attrs: { title: 'Remove' }, on: { click: () => onRemove(item, i) } }),
    )));
}
