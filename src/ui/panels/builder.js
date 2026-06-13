// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Prototype panel (internally "builder"): a drag-and-drop front panel for the emulated peripheral,
// with a side code editor.
// One monolithic app (no multi-layout): drop LED / emoji-button / slider / character-display widgets
// on the (left) canvas, customize each via right-click / double-click, and drive them with a live
// sandboxed script in the (right) editor.
//
//  Design — outbound widgets (button/slider) set + notify the bound characteristic; inbound widgets
//    (led/display) reflect its current value (declarative bindings).
//  Run    — the app + script run in a sandboxed <iframe> (opaque origin, no network); the script
//    drives widgets via widget(id) and BLE via a `bt` proxy (incl. bt.peer.* GATT client).
//
// The app (widgets + script) persists to localStorage; JSON import/export. Examples live separately
// in builder/examples/ and seed/reset the single app.

import { el, clear, field } from '../dom.js';
import { normalizeUuid } from '../../util/uuid.js';
import { PALETTE, widgetDef, makeWidget } from '../builder/widgets.js';
import { OUTBOUND, INBOUND, outboundBytes, applyInbound } from '../builder/bindings.js';
import { loadBuilder, saveBuilder, cleanWidget, deserializeApp, loadUserExamples, saveUserExample, deleteUserExample, clearBuilderStorage } from '../builder/storage.js';
import { buildSrcdoc } from '../builder/runtime.js';
import { createRunSession } from '../builder/bridge.js';
import { highlight } from '../builder/highlight.js';
import { EXAMPLES, DEFAULT_EXAMPLE } from '../builder/examples/index.js';
import { EMOJIS, resolveEmoji } from '../builder/emoji.js';
import { openModal } from '../modal.js';
import { openApiReference } from '../builder/api-reference.js';

export function createBuilderPanel({ store, conn }) {
  const root = el('div.panel-body');

  // Persistent nodes — survive re-renders so drag state, the syntax editor, iframe and console persist.
  const canvas = el('div.bw-canvas');
  const hlCode = el('code');
  const hlPre = el('pre.bw-hl', { attrs: { 'aria-hidden': 'true' } }, hlCode);
  const gutter = el('div.bw-gutter', { attrs: { 'aria-hidden': 'true' } });
  const editor = el('textarea.bw-editor', { attrs: { spellcheck: 'false', wrap: 'off', placeholder: '// Run-mode script — use widget(id) and bt.* (try “Starter”).' } });
  const copyBtn = el('button.bw-copy', { text: '⧉', attrs: { title: 'Copy script' }, on: { click: copyScript } });
  const editorWrap = el('div.bw-editor-wrap', {}, gutter, hlPre, editor, copyBtn);
  const consoleList = el('div.bw-console');
  const runIframe = el('iframe.bw-iframe', { attrs: { sandbox: 'allow-scripts', title: 'Run sandbox' } });
  const runHost = el('div.bw-run', {}, runIframe);
  const widgetBodies = new Map(); // widget id → its .bw wrapper, for in-place inbound updates
  const nameInput = el('input.bw-ex-name', { type: 'text', attrs: { placeholder: 'Example Name', spellcheck: 'false' } });
  const exSelect = el('select.bw-ex-select', { attrs: { title: 'Load an example' }, on: { change: onExSelect } });

  let dragging = false;     // a widget is being grip-dragged — suppress re-render churn
  let runSession = null;    // active bridge session (run mode)
  let ctxMenu = null;       // open right-click menu, if any

  // ---- char-write router: one stable conn.onCharWrite trampoline per UUID (last-wins per UUID),
  // shared by design bindings and the run script. ----
  const charRegistered = new Set();
  const charRouter = new Map();
  function routeCharWrite(uuid, handler) {
    const u = safeUuid(uuid); if (!u) return;
    if (!charRegistered.has(u)) {
      charRegistered.add(u);
      conn.onCharWrite(u, (bytes, attr) => { const h = charRouter.get(u); if (h) h(bytes, attr); });
    }
    charRouter.set(u, handler);
  }
  function unrouteCharWrite(uuid) { const u = safeUuid(uuid); if (u) charRouter.delete(u); }

  // ---- app state ----
  const app = () => store.state.builder;
  const persist = () => saveBuilder(app());
  function commitWidgets(widgets) { app().widgets = widgets; persist(); }
  function updateWidget(id, patch) { commitWidgets(app().widgets.map((w) => (w.id === id ? { ...w, ...patch } : w))); }
  function curWidget(id) { return app().widgets.find((w) => w.id === id) || null; }

  function addWidget(type, x, y) {
    const def = widgetDef(type); if (!def) return;
    const id = nextWidgetId(app().widgets);
    let nx, ny;
    if (x == null) { const n = app().widgets.length % 8; nx = 24 + n * 26; ny = 24 + n * 26; }
    else { nx = Math.max(0, Math.round(x - def.size.w / 2)); ny = Math.max(0, Math.round(y - 12)); }
    commitWidgets([...app().widgets, makeWidget(type, nx, ny, id)]);
    app().selectedId = id;
  }
  function removeWidget(id) {
    closeCtx();
    commitWidgets(app().widgets.filter((w) => w.id !== id));
    if (app().selectedId === id) app().selectedId = null;
  }
  function selectWidget(id) { app().selectedId = id; }
  function nextWidgetId(widgets) {
    let max = 0;
    for (const w of widgets) { const m = /^w(\d+)$/.exec(w.id); if (m) max = Math.max(max, +m[1]); }
    return 'w' + (max + 1);
  }
  const seedWidgets = (built) => built.widgets.map((w, i) => ({ id: 'w' + (i + 1), x: 0, y: 0, props: {}, binding: null, ...w }));

  function loadApp(widgets, script, addServices) {
    stopRun(false);
    if (addServices) addServices();        // a built-in example may add the GATT services it needs
    app().widgets = widgets;
    app().script = script || '';
    app().selectedId = null;
    setEditor(app().script);
    persist();
  }
  function loadBuiltin(ex) {
    if (!confirm(`Load “${ex.name}”? Replaces the current app.`)) return;
    const built = ex.build({ store, conn });
    loadApp(seedWidgets(built), built.script);
  }
  function loadUserApp(ex) {
    if (!confirm(`Load “${ex.name}”? Replaces the current app.`)) return;
    loadApp(ex.widgets.map((w) => ({ ...w })), ex.script);
  }
  // The Examples dropdown (built-in + saved). Rebuilt when the saved list changes.
  function refreshExamples() {
    clear(exSelect);
    exSelect.append(el('option', { value: '', text: 'Examples…' }));
    exSelect.append(el('optgroup', { attrs: { label: 'Built-in' } }, ...EXAMPLES.map((x) => el('option', { value: 'b:' + x.id, text: x.name }))));
    const users = loadUserExamples();
    if (users.length) exSelect.append(el('optgroup', { attrs: { label: 'Saved' } }, ...users.map((u) => el('option', { value: 'u:' + u.id, text: u.name }))));
  }
  function onExSelect(e) {
    const v = e.target.value; e.target.value = '';   // act as a load menu; snap back to the label
    if (v.startsWith('b:')) { const ex = EXAMPLES.find((x) => x.id === v.slice(2)); if (ex) loadBuiltin(ex); }
    else if (v.startsWith('u:')) { const ex = loadUserExamples().find((x) => x.id === v.slice(2)); if (ex) { nameInput.value = ex.name; loadUserApp(ex); } }
  }
  function saveCurrent() {
    const n = nameInput.value.trim(); if (!n) return;
    commitScript();
    const dup = loadUserExamples().find((e) => e.name === n);
    if (dup) deleteUserExample(dup.id);              // overwrite a saved example with the same name
    saveUserExample(n, { widgets: app().widgets, script: app().script });
    refreshExamples();
  }
  function deleteNamed() {
    const n = nameInput.value.trim(); if (!n) return;
    const ex = loadUserExamples().find((e) => e.name === n);
    if (!ex || !confirm(`Delete saved example “${n}”?`)) return;
    deleteUserExample(ex.id);
    nameInput.value = '';
    refreshExamples();
  }
  // Wipe everything this panel keeps in localStorage (saved examples + the stored current app) and
  // reset to the default example — a clean slate. Destructive, so confirm first.
  function clearStorage() {
    if (!confirm('Clear all Prototype data from local storage?\n\nThis removes every saved example and resets the current app. This cannot be undone.')) return;
    clearBuilderStorage();
    nameInput.value = '';
    const built = DEFAULT_EXAMPLE.build({ store, conn });
    loadApp(seedWidgets(built), built.script);   // fresh slate (re-persists the default app)
    refreshExamples();
  }

  function exportApp() {
    commitScript();
    download('bt-app.json', JSON.stringify({ v: 2, widgets: app().widgets.map(cleanWidget), script: app().script }, null, 2));
  }
  function importApp() {
    const inp = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const a = deserializeApp(await f.text());
        stopRun(false);
        app().widgets = a.widgets; app().script = a.script; app().selectedId = null;
        setEditor(a.script); persist();
      } catch (e) { alert('Import failed: ' + e.message); }
      inp.remove();
    });
    document.body.append(inp); inp.click();
  }

  // ---- design-mode BLE wiring ----
  // Outbound (button/slider): set the characteristic's value (so a central's Read returns it) AND
  // notify subscribers, then refresh any inbound widget on the same char.
  function onPress(w) { selectWidget(w.id); fireOutbound(w); commitToStore(w); }
  function onSlide(w, value) { fireOutbound(w, value); }                 // live during drag (no store churn)
  function onSlideCommit(w, value) { fireOutbound(w, value); commitToStore(w, value); }
  function fireOutbound(w, value) {
    if (!w.binding) return;
    const h = conn.findCharValueHandle(w.binding.uuid, false);
    if (h == null) return;
    const bytes = outboundBytes(w, value);
    const attr = conn.gatt.db.byHandle.get(h);
    if (attr) attr.value = bytes;   // Reads now return this; structure unchanged so handles are stable
    conn.notify(h, bytes);          // and subscribers get notified
    syncLive();                     // reflect into any inbound widget bound to the same characteristic
  }
  function commitToStore(w, value) { if (w.binding) mirrorCharValue(w.binding.uuid, outboundBytes(w, value)); }

  // Inbound (led/display): pull the bound characteristic's CURRENT value from the live DB and apply
  // it to the widget DOM in place (no store round-trip → no flicker).
  function currentCharBytes(uuid) {
    const h = conn.findCharValueHandle(uuid, false);
    if (h == null) return new Uint8Array(0);
    const attr = conn.gatt.db.byHandle.get(h);
    return attr ? attr.value : new Uint8Array(0);
  }
  function syncLive() {
    if (app().mode === 'run') return;
    for (const w of app().widgets) {
      if (!w.binding || !INBOUND.has(w.type)) continue;
      const wrap = widgetBodies.get(w.id); const def = widgetDef(w.type);
      if (wrap && def.update) def.update(wrap, w, applyInbound(w, currentCharBytes(w.binding.uuid)));
    }
  }
  function mirrorCharValue(uuid, bytes) {
    const u = safeUuid(uuid); const hex = bytesToHexLocal(bytes);
    for (const s of store.state.gatt.services || []) for (const c of s.characteristics || []) {
      if (safeUuid(c.uuid) === u) { c.valueHex = hex; c.valueText = null; return; }
    }
  }

  // ---- run mode ----
  function commitScript() { if (app().script !== editor.value) { app().script = editor.value; persist(); } }
  function appendConsole(level, args) {
    consoleList.append(el('div', { class: 'bw-con-line ' + (level || 'log') }, (args || []).join(' ')));
    while (consoleList.childNodes.length > 200) consoleList.removeChild(consoleList.firstChild);
    consoleList.scrollTop = consoleList.scrollHeight;
  }
  function clearConsole() { clear(consoleList); }

  function startRun() {
    commitScript();
    if (runSession) { runSession.stop(); runSession = null; }
    clearConsole();
    runSession = createRunSession({ iframe: runIframe, conn, store, routeCharWrite, unrouteCharWrite, onConsole: appendConsole });
    runIframe.srcdoc = buildSrcdoc(app(), app().script || '');
    app().mode = 'run';
  }
  function stopRun(toDesign = true) {
    if (runSession) { runSession.stop(); runSession = null; }
    runIframe.srcdoc = '';
    if (toDesign) app().mode = 'design';
  }
  function reloadRun() { startRun(); }

  // ---- syntax editor (textarea over a highlighted <pre>, with a line-number gutter) ----
  function paintGutter() {
    const n = editor.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    gutter.textContent = s;
  }
  function paintHL() { hlCode.innerHTML = highlight(editor.value) + '\n'; paintGutter(); } // trailing NL so the last line can scroll
  function setEditor(v) { editor.value = v || ''; paintHL(); }
  function copyScript() {
    navigator.clipboard.writeText(editor.value).then(() => {
      copyBtn.textContent = '✓';
      setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200);
    }, () => {});
  }
  editor.addEventListener('input', paintHL);
  editor.addEventListener('scroll', () => { hlPre.scrollTop = gutter.scrollTop = editor.scrollTop; hlPre.scrollLeft = editor.scrollLeft; });
  editor.addEventListener('blur', commitScript);

  // Delete / Backspace removes the selected widget — only on the Builder tab, in Design mode, when
  // not typing in a field/editor and no dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (store.state.ui.activePanel !== 'builder' || app().mode === 'run' || !app().selectedId) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-overlay')) return;
    e.preventDefault();
    removeWidget(app().selectedId);
  });

  // ---- canvas interaction ----
  canvas.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types).includes('text/bt-widget')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; canvas.classList.add('drag-over'); }
  });
  canvas.addEventListener('dragleave', (e) => { if (e.target === canvas) canvas.classList.remove('drag-over'); });
  canvas.addEventListener('drop', (e) => {
    const type = e.dataTransfer.getData('text/bt-widget');
    canvas.classList.remove('drag-over');
    if (!type) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    addWidget(type, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('click', (e) => { if (e.target === canvas) selectWidget(null); });

  function renderWidget(w) {
    const def = widgetDef(w.type);
    if (!def) return el('div');
    const sel = w.id === app().selectedId;
    const wrap = el('div', { class: 'bw' + (sel ? ' sel' : ''), style: { left: w.x + 'px', top: w.y + 'px' } });
    const grip = el('div.bw-grip', {},
      el('span.bw-grip-icon', { text: def.icon }),
      el('span.bw-grip-name', { text: w.name || def.name }),
      w.binding ? el('span.bw-bind', { text: '↔', attrs: { title: 'bound to ' + w.binding.uuid } }) : null);
    attachGripDrag(grip, wrap, w);
    wrap.append(grip, el('div.bw-body', {}, def.render(w, { onPress, onChange: onSlide, onCommit: onSlideCommit })));
    wrap.addEventListener('click', () => selectWidget(w.id));
    wrap.addEventListener('dblclick', (e) => { e.preventDefault(); openCustomize(w.id); });
    wrap.addEventListener('contextmenu', (e) => openContextMenu(e, w.id));
    widgetBodies.set(w.id, wrap);
    return wrap;
  }

  function attachGripDrag(grip, wrap, w) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      selectWidget(w.id);
      dragging = true;
      try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
      let nx = ox, ny = oy;
      const move = (ev) => { nx = Math.max(0, ox + (ev.clientX - sx)); ny = Math.max(0, oy + (ev.clientY - sy)); wrap.style.left = nx + 'px'; wrap.style.top = ny + 'px'; };
      const endDrag = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', endDrag);
        grip.removeEventListener('pointercancel', endDrag);
        dragging = false;
        updateWidget(w.id, { x: nx, y: ny });
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', endDrag);
      grip.addEventListener('pointercancel', endDrag);
    });
  }

  // ---- right-click menu + customize dialog ----
  function closeCtx() {
    if (!ctxMenu) return;
    ctxMenu.remove(); ctxMenu = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onCtxKey);
  }
  function onDocDown(e) { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtx(); }
  function onCtxKey(e) { if (e.key === 'Escape') closeCtx(); }
  function openContextMenu(e, id) {
    e.preventDefault();
    closeCtx();
    selectWidget(id);
    ctxMenu = el('div.bw-ctxmenu', { style: { left: e.clientX + 'px', top: e.clientY + 'px' } },
      el('button.bw-ctx-item', { text: '⚙  Customize', on: { click: () => { closeCtx(); openCustomize(id); } } }),
      el('button.bw-ctx-item.danger', { text: '🗑  Delete', on: { click: () => removeWidget(id) } }));
    document.body.append(ctxMenu);
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onCtxKey);
  }

  function openCustomize(id) {
    const w = curWidget(id); if (!w) return;
    const def = widgetDef(w.type);
    const form = el('div.modal-form', {},
      field('Name (script handle)', el('input', { type: 'text', value: w.name || '', attrs: { placeholder: w.id }, on: { change: (e) => updateWidget(id, { name: e.target.value.trim() || undefined }) } })),
      ...def.fields.map((f) => fieldRow(id, f)),
      bindingRow(id));
    openModal({
      title: `${def.icon} Customize ${def.name}`, content: form, width: '460px',
      actions: [
        { label: 'Delete', kind: 'danger', onClick: (c) => { c(); removeWidget(id); } },
        { label: 'Done', kind: 'primary', onClick: (c) => c() },
      ],
    });
  }

  function fieldRow(id, f) {
    const w = curWidget(id); const val = w ? w.props[f.key] : undefined;
    const set = (value) => { const cur = curWidget(id); if (cur) updateWidget(id, { props: { ...cur.props, [f.key]: value } }); };
    let ctrl;
    if (f.kind === 'bool') ctrl = el('input', { type: 'checkbox', checked: !!val, on: { change: (e) => set(e.target.checked) } });
    else if (f.kind === 'number') ctrl = el('input', { type: 'number', value: val ?? 0, on: { change: (e) => set(Number(e.target.value)) } });
    else if (f.kind === 'color') ctrl = el('input', { type: 'color', value: val || '#ff3b30', on: { change: (e) => set(e.target.value) } });
    else if (f.kind === 'emoji') ctrl = emojiPicker(val, set);
    else ctrl = el('input', { type: 'text', value: val ?? '', on: { change: (e) => set(e.target.value) } });
    return field(f.label, ctrl);
  }

  let emojiSeq = 0;
  function emojiPicker(val, set) {
    const listId = 'bw-emoji-' + (++emojiSeq);
    const datalist = el('datalist', { id: listId }, ...EMOJIS.map((e) => el('option', { value: `${e.c}  ${e.k}` })));
    const input = el('input.bw-emoji-input', { type: 'text', value: val ?? '', attrs: { list: listId, placeholder: 'emoji or name…', autocomplete: 'off' } });
    input.addEventListener('change', () => { const c = resolveEmoji(input.value); input.value = c; set(c); });
    return el('span.bw-emoji-wrap', {}, input, datalist);
  }

  function bindingRow(id) {
    const w = curWidget(id);
    const cur = w && w.binding ? safeUuid(w.binding.uuid) : '';
    const sel = el('select', { on: { change: (e) => updateWidget(id, { binding: e.target.value ? { uuid: e.target.value } : null }) } },
      el('option', { value: '', text: '— none —', selected: !cur }),
      ...charOptions().map((c) => el('option', { value: c.uuid, text: c.label, selected: c.uuid === cur })));
    const dir = w && OUTBOUND.has(w.type) ? 'sets + notifies this characteristic on press/change →' : "← reflects this characteristic's current value";
    return el('div.bw-bind-row', {}, field('Bound characteristic', sel), el('span.muted', { text: dir }));
  }

  function charOptions() {
    const out = [];
    for (const s of store.state.gatt.services || []) {
      for (const c of s.characteristics || []) {
        const u = safeUuid(c.uuid);
        if (u) out.push({ uuid: u, label: `${s.name || s.uuid} ▸ ${c.name || c.uuid} (${c.uuid})` });
      }
    }
    return out;
  }

  // ---- chrome ----
  function segBtn(label, active, onClick) { return el('button', { class: 'bw-seg-btn' + (active ? ' active' : ''), text: label, on: { click: onClick } }); }

  function toolbar() {
    const running = app().mode === 'run';
    return el('div.bw-toolbar', {},
      exSelect, nameInput,
      el('button.btn', { text: '💾 Save', attrs: { title: 'Save the current app as an example' }, on: { click: saveCurrent } }),
      el('button.btn.danger', { text: '🗑', attrs: { title: 'Delete the saved example named in the box' }, on: { click: deleteNamed } }),
      el('button.btn.danger', { text: '🧹 Clear storage', attrs: { title: 'Wipe all saved examples + the stored app from local storage, and reset to the default' }, on: { click: clearStorage } }),
      el('span.spacer'),
      el('div.bw-seg', {}, segBtn('Design', !running, () => stopRun(true)), segBtn('Run', running, startRun)),
      el('button.btn', { text: '⤓ Export', on: { click: exportApp } }),
      el('button.btn', { text: '⤒ Import', on: { click: importApp } }));
  }

  function palette() {
    return el('div.bw-palette', {}, el('span.k', { text: 'Drag onto the canvas:' }),
      ...PALETTE.map((p) => {
        const item = el('button.bw-pal-item', { draggable: true, attrs: { title: `Add ${p.name}` }, on: { click: () => addWidget(p.type) } },
          el('span.bw-pal-icon', { text: p.icon }), el('span', { text: p.name }));
        item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/bt-widget', p.type); e.dataTransfer.effectAllowed = 'copy'; });
        return item;
      }));
  }

  function editorHead() {
    const running = app().mode === 'run';
    const controls = running
      ? [el('button.btn', { text: '■ Stop', on: { click: () => stopRun(true) } }), el('button.btn', { text: '↻ Reload', on: { click: reloadRun } })]
      : [el('button.btn.primary', { text: '▶ Run', on: { click: startRun } })];
    const apiBtn = el('button.btn', { text: '❔ API reference', attrs: { title: 'Run-mode script API' }, on: { click: () => openApiReference() } });
    return el('div.bw-editor-head', {}, el('h3', { text: 'Script' }), el('span.spacer'), ...controls, apiBtn);
  }

  function noteLine() {
    if (app().mode === 'run') {
      return el('p.bw-note.muted', { text: 'Sandboxed: the script runs in an isolated iframe (no network); BLE is bridged to the live server. Right-click a widget to customize; Stop to edit the design.' });
    }
    return el('p.bw-note.muted', {
      text: (store.state.serial.connected
        ? 'Bindings are live: button/slider set + notify their characteristic; LED/display reflect its value. '
        : 'Offline preview: button/slider update the local value; notifications need a connected central. ')
        + 'Right-click (or double-click) a widget to Customize / Delete.',
    });
  }

  // Rebuild chrome only on a structural change — a signature that EXCLUDES characteristic values, so
  // the stream of central writes / notifications never tears down the canvas (that was the flicker).
  let lastSig = null;
  function chromeSig() {
    return JSON.stringify({
      mode: app().mode, selectedId: app().selectedId,
      widgets: app().widgets.map((w) => [w.id, w.type, w.x, w.y, w.name || '', w.binding ? w.binding.uuid : '', w.props]),
      chars: (store.state.gatt.services || []).map((s) => [s.uuid, s.name, (s.characteristics || []).map((c) => [c.uuid, c.name])]),
      conn: store.state.serial.connected,
    });
  }
  function renderChrome() {
    clear(root);
    if (document.activeElement !== editor) setEditor(app().script);
    const left = el('div.bw-left', {});
    if (app().mode === 'run') {
      left.append(runHost);
    } else {
      left.append(palette());
      clear(canvas); widgetBodies.clear();
      for (const w of app().widgets) canvas.append(renderWidget(w));
      if (!app().widgets.length) canvas.append(el('div.bw-canvas-empty.muted', { text: 'Empty — drag a widget from the palette.' }));
      left.append(canvas);
    }
    const right = el('div.bw-right', {}, editorHead(), editorWrap,
      el('div.bw-console-wrap', {}, el('div.bw-con-head', {}, el('h3', { text: 'Console' }), el('button.btn', { text: 'Clear', on: { click: clearConsole } })), consoleList));
    root.append(toolbar(), el('div.bw-main', {}, left, right), noteLine());
  }
  function render() {
    if (dragging) return;                                     // never rebuild mid grip-drag
    const sig = chromeSig();
    if (sig !== lastSig) { lastSig = sig; renderChrome(); }    // structural change → rebuild chrome+canvas
    syncLive();                                               // always: refresh inbound widgets in place
  }

  // ---- init: restore the saved app, or seed from the default example (media player) ----
  (function init() {
    const loaded = loadBuilder();
    if (loaded && (loaded.widgets.length || loaded.script)) { app().widgets = loaded.widgets; app().script = loaded.script; }
    else { const built = DEFAULT_EXAMPLE.build({ store, conn }); app().widgets = seedWidgets(built); app().script = built.script || ''; }
    app().mode = 'design';
  })();

  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); } });
  refreshExamples();
  render();
  store.subscribe(render);
  // Display name is "Prototype"; the internal id stays 'builder' (localStorage keys + state subtree).
  return { id: 'builder', title: 'Prototype', el: root };
}

// ---- small helpers ----
function safeUuid(u) { try { return normalizeUuid(u); } catch { return ''; } }
function bytesToHexLocal(b) { return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''); }
function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
