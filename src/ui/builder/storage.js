// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder app persistence: localStorage + JSON import/export. The app is a single monolith
// { widgets, script } (no multi-layout). serialize/deserialize/cleanWidget are pure (Node-testable);
// save/load touch localStorage (browser only). deserializeApp also migrates the old v1 multi-layout
// format and accepts a single exported { layout } or bare { widgets, script }.

const KEY = 'bt-tester.builder';

export function serializeApp(app) {
  return JSON.stringify({
    v: 2,
    widgets: (app?.widgets || []).map(cleanWidget),
    script: typeof app?.script === 'string' ? app.script : '',
  });
}

export function deserializeApp(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : (json || {});
  // v1 multi-layout → take the active (or first) layout
  if (Array.isArray(o.layouts)) {
    const l = o.layouts.find((x) => x && x.id === o.activeId) || o.layouts[0] || {};
    return appFrom(l);
  }
  // single exported layout { layout: {...} } or a bare { widgets, script }
  return appFrom(o.layout || o);
}

function appFrom(src) {
  src = src || {};
  return {
    widgets: (src.widgets || []).map(cleanWidget),
    script: typeof src.script === 'string' ? src.script : '',
  };
}

// Coerce an untrusted widget (imported file / old storage) into the canonical shape.
export function cleanWidget(w) {
  w = w || {};
  const out = {
    id: String(w.id ?? ''),
    type: String(w.type ?? ''),
    x: Number(w.x) || 0,
    y: Number(w.y) || 0,
    props: { ...(w.props || {}) },
    binding: w.binding && w.binding.uuid ? { uuid: String(w.binding.uuid) } : null,
  };
  if (typeof w.name === 'string' && w.name) out.name = w.name; // optional script handle
  return out;
}

export function saveBuilder(app) {
  try { localStorage.setItem(KEY, serializeApp(app)); } catch { /* storage full / disabled */ }
}

export function loadBuilder() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? deserializeApp(raw) : null;
  } catch { return null; }
}

// ---- user-created examples (named app snapshots) ----
const EX_KEY = 'bt-tester.builder.examples';

function cleanExample(e) {
  e = e || {};
  return {
    id: String(e.id || ''),
    name: String(e.name || 'Untitled'),
    widgets: (e.widgets || []).map(cleanWidget),
    script: typeof e.script === 'string' ? e.script : '',
  };
}

export function loadUserExamples() {
  try {
    const a = JSON.parse(localStorage.getItem(EX_KEY) || '[]');
    return Array.isArray(a) ? a.map(cleanExample) : [];
  } catch { return []; }
}

function writeUserExamples(list) {
  try { localStorage.setItem(EX_KEY, JSON.stringify(list)); } catch { /* storage full / disabled */ }
}

export function saveUserExample(name, app, makeId = () => 'ex-' + Date.now()) {
  const ex = cleanExample({ id: makeId(), name, widgets: app && app.widgets, script: app && app.script });
  writeUserExamples([...loadUserExamples(), ex]);
  return ex;
}

export function deleteUserExample(id) {
  writeUserExamples(loadUserExamples().filter((e) => e.id !== id));
}

/** Wipe all Prototype data from localStorage: the saved current app and every saved example. */
export function clearBuilderStorage() {
  try { localStorage.removeItem(KEY); localStorage.removeItem(EX_KEY); } catch { /* storage disabled */ }
}
