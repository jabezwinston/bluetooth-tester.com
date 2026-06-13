// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Minimal DOM helpers — enough to build panels without a framework.

import { applyHelp } from './help/help-tip.js';

/**
 * Create an element.
 * @param {string} tag - e.g. 'div', 'button', 'input.myclass#myid'
 * @param {object} [props] - { class, text, html, on:{event:fn}, attrs:{}, style:{}, ...domProps }
 * @param {...(Node|string|null)} children
 */
export function el(tag, props = {}, ...children) {
  let tagName = tag;
  const classes = [];
  let id = null;
  // Allow 'button.primary#go' shorthand.
  tagName = tag.replace(/[.#][^.#]+/g, (m) => {
    if (m[0] === '.') classes.push(m.slice(1));
    else id = m.slice(1);
    return '';
  });
  const node = document.createElement(tagName || 'div');
  if (id) node.id = id;
  if (classes.length) node.classList.add(...classes);

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class' || k === 'className') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null) node.setAttribute(a, av); }
    else if (k === 'dataset') for (const [a, av] of Object.entries(v)) node.dataset[a] = av;
    else if (k === 'style') Object.assign(node.style, v);
    else node[k] = v; // value, checked, disabled, type, placeholder, ...
  }

  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, ...nodes) {
  for (const n of nodes) if (n) parent.append(n);
  return parent;
}

/**
 * Labeled form row helper. Pass an optional `helpKey` (into HELP, see help-text.js) to make the label
 * a hover help trigger explaining the field in plain English (applyHelp is a no-op without a key).
 */
export function field(labelText, control, hint, helpKey) {
  return el('label.field', {},
    applyHelp(el('span.field-label', {}, labelText), helpKey),
    control,
    hint ? el('span.field-hint', { text: hint }) : null,
  );
}
