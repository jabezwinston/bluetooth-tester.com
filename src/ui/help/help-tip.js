// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Field help: hovering (or focusing) a label/term shows a styled tooltip with a plain-English
// explanation (from help-text.js) plus an optional clickable "Spec ↗" link. applyHelp(el, key) wires
// an existing element as the trigger — no separate icon. Self-contained — uses raw DOM (no import from
// ../dom.js) so dom.js can import applyHelp without a circular dependency.

import { HELP } from './help-text.js';

let tip = null;            // singleton tooltip element (lazily created, lives on document.body)
let hideTimer = null;
let activeEl = null;       // the trigger element the tooltip currently belongs to

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'help-tip';
  tip.setAttribute('role', 'tooltip');
  // Keep the tooltip open while the pointer is over it (so its "Spec ↗" link is clickable).
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tip.addEventListener('mouseleave', scheduleHide);
  document.body.appendChild(tip);
  return tip;
}

// Place the tooltip just above (and to the right of) the mouse cursor — "right top of the cursor".
// Flips below the cursor when there isn't room above; clamps to the viewport.
function positionAtCursor(mx, my) {
  const t = ensureTip();
  const tw = t.offsetWidth, th = t.offsetHeight;
  let left = mx + 4;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  left = Math.max(8, left);
  let top = my - th - 10;
  if (top < 8) top = my + 18;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

// Fallback used for keyboard focus (no cursor): anchor above/below the element.
function positionAtElement(anchor) {
  const t = ensureTip();
  const r = anchor.getBoundingClientRect();
  const tw = t.offsetWidth, th = t.offsetHeight;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
  let top = r.top - th - 6;
  if (top < 8) top = r.bottom + 6;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function show(anchor, mx, my) {
  const entry = HELP[anchor.dataset.help];
  if (!entry) return;
  clearTimeout(hideTimer);
  const t = ensureTip();
  t.textContent = '';
  t.appendChild(document.createTextNode(entry.text));
  if (entry.spec && entry.spec.url) {
    // Just a small ↗ at the end of the text — a clickable jump to the spec (citation on hover).
    const a = document.createElement('a');
    a.className = 'help-spec';
    a.href = entry.spec.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '↗';
    if (entry.spec.cite) a.title = entry.spec.cite;
    t.appendChild(a);
  }
  activeEl = anchor;
  // measure + place while still hidden (visibility:hidden keeps layout), then reveal — no flash at (0,0)
  if (mx != null) positionAtCursor(mx, my); else positionAtElement(anchor);
  t.classList.add('show');
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 120);
}

function hide() {
  clearTimeout(hideTimer);
  if (tip) tip.classList.remove('show');
  activeEl = null;
}

// Reposition/dismiss on scroll + resize so the tooltip never floats away from its anchor. Guarded so
// the module stays importable in Node (smoke tests import panels → dom.js → here; no window there).
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => { if (activeEl) hide(); }, true);
  window.addEventListener('resize', () => { if (activeEl) hide(); });
}

/**
 * Wire an existing element (a label, term, chip, list item…) as a help trigger: hovering or focusing it
 * shows the tooltip for `key`. Adds a `.has-help` cue (dotted underline + help cursor). No-op (returns
 * the element unchanged) when `key` is missing or has no entry, so call sites can pass keys freely.
 * @param {HTMLElement} element  the trigger element (returned, so it can be used inline)
 * @param {string} key  a key into HELP (e.g. 'adv.appearance')
 */
export function applyHelp(element, key) {
  if (!element || !key || !HELP[key]) return element;
  element.classList.add('has-help');
  element.dataset.help = key;
  element.tabIndex = 0;
  element.addEventListener('mouseenter', (e) => show(element, e.clientX, e.clientY));
  element.addEventListener('mouseleave', scheduleHide);
  element.addEventListener('focus', () => show(element));
  element.addEventListener('blur', hide);
  element.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide(); element.blur(); } });
  return element;
}
