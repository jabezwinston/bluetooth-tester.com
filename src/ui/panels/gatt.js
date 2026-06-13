// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GATT server editor — collapsible tree of services / characteristics / descriptors with
// live handles. Rich per-characteristic actions open modals: Edit, Value & Notify,
// Add descriptor, and a read-only Details breakdown. Edits auto-apply to the live server.

import { el, clear, field } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import { hexToBytes, bytesToHex } from '../../util/bytes.js';
import { normalizeUuid } from '../../util/uuid.js';
import { buildDb } from '../../host/gatt-db.js';
import { defaultGattTable } from '../../data/gatt-defaults.js';
import { decodeValue, summarizeValue, decodeByPresentationFormat, gattName, CHAR_NAMES } from '../../profiles/gatt-decode.js';
import { SERVICE_UUID16 } from '../../data/assigned.js';
import { stampExport } from '../../app-meta.js';
import { restrictHexBytes, textToHexBytes, hexToText } from '../hex-input.js';
import { openModal, confirmModal } from '../modal.js';
import { comboListbox } from '../combobox.js';

const PROP_KEYS = ['read', 'write', 'writeNoResp', 'notify', 'indicate', 'broadcast'];
// Searchable UUID option lists ([hex4, name]) for the service / characteristic pickers.
const SERVICE_OPTS = Object.entries(SERVICE_UUID16).map(([k, n]) => [Number(k).toString(16).padStart(4, '0').toUpperCase(), n]);
// CHAR_NAMES is a combined name map (it also names descriptors when decoding values), so restrict the
// characteristic UUID picker to the characteristic range (≥ 0x2A00). Per GATT, 0x28xx are declarations
// and 0x29xx are descriptors — not characteristics; descriptors get their own "Add descriptor" flow.
const CHAR_OPTS = Object.entries(CHAR_NAMES).filter(([k]) => parseInt(k, 16) >= 0x2a00).map(([k, n]) => [k.toUpperCase(), n]);

/**
 * UUID text field that searches the SIG name list via the custom combobox (comboListbox in 'value'
 * mode — the input itself holds the UUID). Type a name and pick a suggestion → the field is set to the
 * bare UUID and `nameInput` is populated with the SIG name. Raw 16-bit hex / 128-bit UUIDs are accepted
 * too (lenient — unknown text is kept as-is and validated on Save). Returns { el (wrapper), input }.
 *  - options: [[hex, name]] where hex is the bare 16-bit value (e.g. '180F').
 */
function uuidPicker(initialUuid, nameInput, options, placeholder) {
  const byLabel = new Map(options.map(([hex, name]) => [name.toLowerCase(), hex]));
  const setName = (u) => { const n = gattName(u); if (n && nameInput) nameInput.value = n; };
  const resolve = (text) => {
    const t = (text || '').trim();
    if (!t) return null;
    let hex = byLabel.get(t.toLowerCase());
    if (!hex) { const m = t.match(/0x([0-9a-f]{1,4})\s*\)?\s*$/i); if (m) hex = m[1].toUpperCase().padStart(4, '0'); }
    if (hex) return hex;
    try { return normalizeUuid(t); } catch { return t; } // lenient: keep raw text, validated on Save
  };
  const cb = comboListbox({
    options, value: initialUuid || null, placeholder, display: 'value', format: (v) => String(v), resolve,
    onChange: (v) => { if (v != null) setName(v); },
  });
  return { el: cb.el, input: cb.input };
}
const PROP_SHORT = { read: 'R', write: 'W', writeNoResp: 'Wnr', notify: 'N', indicate: 'I', broadcast: 'B' };
const DESC_PRESETS = [
  ['2901', 'Characteristic User Description'],
  ['2904', 'Characteristic Presentation Format'],
  ['2902', 'Client Characteristic Configuration (CCCD)'],
];
const hx = (n) => '0x' + n.toString(16).padStart(4, '0');

export function createGattPanel({ store, conn }) {
  const root = el('div.panel-body');
  const gatt = () => store.state.gatt;
  const collapsedServices = new Set(); // services default expanded
  const expandedChars = new Set();      // characteristics default collapsed
  let flashMsg = null;
  let dragItem = null; // { kind:'service'|'char', si, ci }

  const flash = (m) => { flashMsg = m; render(); setTimeout(() => { flashMsg = null; render(); }, 1600); };
  const commit = (msg) => { conn.setGattTable(store.state.gatt); flash(msg || 'Applied'); };

  // ---- store mutators ----
  const setChar = (si, ci, obj) => { const l = [...gatt().services[si].characteristics]; l[ci] = obj; store.state.gatt.services[si].characteristics = l; };
  const delChar = (si, ci) => { store.state.gatt.services[si].characteristics = gatt().services[si].characteristics.filter((_, i) => i !== ci); };
  const addChar = (si, obj) => { store.state.gatt.services[si].characteristics = [...(gatt().services[si].characteristics || []), obj]; };
  const setService = (si, patch) => { const l = [...gatt().services]; l[si] = { ...l[si], ...patch }; store.state.gatt.services = l; };
  const delService = (si) => { store.state.gatt.services = gatt().services.filter((_, i) => i !== si); };
  const addService = (obj) => { store.state.gatt.services = [...gatt().services, obj]; };

  const charValueBytes = (ch) => {
    if (ch.valueHex) { try { return hexToBytes(ch.valueHex); } catch { return new Uint8Array(0); } }
    if (ch.valueText) return new TextEncoder().encode(ch.valueText);
    return new Uint8Array(0);
  };
  const subscriberCount = (valueHandle) =>
    store.state.connections.filter((c) => c.subscriptions.some((s) => s.handle === valueHandle && s.value)).length;
  // True for ~2s after a client writes the attribute at `handle` (drives the flash highlight).
  const recent = (handle) => { const ts = (store.state.serverWrites || {})[handle]; return ts != null && Date.now() - ts < 2000; };

  // ---- drag to reorder (re-allocates handles via buildDb on the new order) ----
  function dragHandle(kind, si, ci) {
    return el('span.drag-handle', {
      text: '⠿', draggable: true, attrs: { title: 'Drag to reorder' },
      on: {
        dragstart: (e) => { dragItem = { kind, si, ci }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ''); } catch {} },
        dragend: () => { dragItem = null; document.querySelectorAll('.tree-row.drag-over').forEach((n) => n.classList.remove('drag-over')); },
      },
    });
  }

  function onDropOnService(tsi) {
    if (!dragItem) return;
    if (dragItem.kind === 'service' && dragItem.si !== tsi) { moveService(dragItem.si, tsi); commit('Service reordered'); }
    else if (dragItem.kind === 'char') { moveChar(dragItem.si, dragItem.ci, tsi, 'end'); commit('Characteristic moved'); }
    dragItem = null;
  }

  function onDropOnChar(tsi, tci) {
    if (!dragItem || dragItem.kind !== 'char') return;
    if (dragItem.si === tsi && dragItem.ci === tci) return;
    moveChar(dragItem.si, dragItem.ci, tsi, tci);
    commit('Characteristic reordered');
    dragItem = null;
  }

  function moveService(from, to) {
    const arr = [...gatt().services];
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
    store.state.gatt.services = arr;
  }

  function moveChar(fsi, fci, tsi, tci) {
    const services = gatt().services.map((s) => ({ ...s, characteristics: [...(s.characteristics || [])] }));
    const [x] = services[fsi].characteristics.splice(fci, 1);
    if (tci === 'end') services[tsi].characteristics.push(x);
    else { let i = tci; if (fsi === tsi && fci < tci) i -= 1; services[tsi].characteristics.splice(i, 0, x); }
    store.state.gatt.services = services;
  }

  // ---- render ----
  function render() {
    clear(root);
    const table = gatt();
    let db;
    try { db = buildDb(table); } catch (e) { root.append(el('div.error-box', { text: 'GATT table error: ' + e.message })); return; }

    const allCollapsed = collapsedServices.size >= table.services.length && table.services.length > 0;
    root.append(el('div.toolbar', {},
      el('button.btn.primary', { text: '+ Service', on: { click: addServiceModal } }),
      el('button.btn', { text: allCollapsed ? 'Expand all' : 'Collapse all', on: { click: () => toggleAll(table, allCollapsed) } }),
      el('button.btn', { text: 'Set defaults', on: { click: async () => { if (await confirmModal('Replace the current GATT table with the defaults?')) { store.state.gatt = defaultGattTable(); commit('Defaults loaded'); } } } }),
      el('button.btn', { text: 'Export', on: { click: exportJson } }),
      importBtn(),
      flashMsg ? el('span.muted', { text: '✓ ' + flashMsg }) : el('span.muted', { text: `${table.services.length} services · ${db.maxHandle} handles` }),
    ));

    const tree = el('div.tree');
    table.services.forEach((svc, si) => tree.append(serviceNode(svc, si, db.layout[si])));
    if (!table.services.length) tree.append(el('div.empty', { text: 'No services. Click “+ Service”.' }));
    root.append(tree);
  }

  function toggleAll(table, allCollapsed) {
    collapsedServices.clear();
    if (!allCollapsed) table.services.forEach((_, i) => collapsedServices.add(i));
    render();
  }

  function serviceNode(svc, si, layout) {
    const open = !collapsedServices.has(si);
    const node = el('div.tree-node', {});
    const row = el('div.tree-row.service', {
      on: {
        dragover: (e) => { if (dragItem) { e.preventDefault(); row.classList.add('drag-over'); } },
        dragleave: () => row.classList.remove('drag-over'),
        drop: (e) => { e.preventDefault(); row.classList.remove('drag-over'); onDropOnService(si); },
      },
    },
      dragHandle('service', si),
      el('span.tree-toggle', { text: open ? '▼' : '▶', on: { click: () => { open ? collapsedServices.add(si) : collapsedServices.delete(si); render(); } } }),
      el('span.tree-label', { html: `<strong>${normalizeUuid(svc.uuid)}</strong> ${svc.name || ''}` }),
      el('span.tree-meta', { text: `${(svc.characteristics || []).length} chars · ${hx(layout.startHandle)}–${hx(layout.endHandle)}` }),
      el('span.tree-actions', {},
        iconBtn('+ char', 'Add characteristic', () => addCharModal(si)),
        iconBtn('✎', 'Edit service', () => editServiceModal(svc, si)),
        iconBtn('🗑', 'Delete service', async () => { if (await confirmModal(`Delete service ${normalizeUuid(svc.uuid)} and its characteristics?`)) { delService(si); commit('Service deleted'); } }, 'danger'),
      ),
    );
    node.append(row);
    if (open) {
      const kids = el('div.tree-children', {});
      (svc.characteristics || []).forEach((ch, ci) => kids.append(charNode(svc, si, ch, ci, layout.chars[ci])));
      if (!(svc.characteristics || []).length) kids.append(el('div.tree-empty', {}, 'No characteristics. ', el('button.link', { text: 'Add one', on: { click: () => addCharModal(si) } })));
      node.append(kids);
    }
    return node;
  }

  function charNode(svc, si, ch, ci, chL) {
    const key = si + '.' + ci;
    const open = expandedChars.has(key);
    const subN = subscriberCount(chL.valueHandle);
    const warns = charWarnings(ch, svc);
    // Inline value — decoded summary when there's a SIG decoder, else the raw text/hex (like the client).
    const vbytes = charValueBytes(ch);
    const rawVal = vbytes.length ? (ch.valueText != null && !ch.valueHex ? `"${ch.valueText}"` : bytesToHex(vbytes)) : '(empty)';
    const valLabel = (vbytes.length && summarizeValue(ch.uuid, vbytes)) || rawVal;
    const written = recent(chL.valueHandle) || (chL.descriptors || []).some((d) => recent(d.handle));
    const node = el('div.tree-node', {});
    const row = el('div.tree-row.char', {
      on: {
        dragover: (e) => { if (dragItem) { e.preventDefault(); row.classList.add('drag-over'); } },
        dragleave: () => row.classList.remove('drag-over'),
        drop: (e) => { e.preventDefault(); row.classList.remove('drag-over'); onDropOnChar(si, ci); },
      },
    },
      dragHandle('char', si, ci),
      el('span.tree-toggle', { text: open ? '▼' : '▶', on: { click: () => { open ? expandedChars.delete(key) : expandedChars.add(key); render(); } } }),
      el('span.tree-label', { html: `<strong>${normalizeUuid(ch.uuid)}</strong> ${ch.name || ''}` }),
      el('span.chips', {}, ...(ch.properties || []).map((p) => el('span', { class: 'chip ' + p, text: PROP_SHORT[p] || p, attrs: { title: p } }))),
      subN ? el('span.chip.sub', { text: `▲ ${subN}`, attrs: { title: `${subN} subscriber(s)` } }) : null,
      warns.length ? el('span.chip.warn', { text: '⚠', attrs: { title: warns.join('\n') } }) : null,
      el('span.tree-val', { text: valLabel, attrs: { title: valLabel === rawVal ? rawVal : `${valLabel}  ·  ${rawVal}` } }),
      el('span.tree-meta', { text: `val ${hx(chL.valueHandle)}` }),
      el('span.tree-actions', {},
        iconBtn('✎', 'Edit', () => editCharModal(svc, si, ch, ci)),
        iconBtn('⤴', 'Value & notify', () => valueModal(si, ci, ch, chL)),
        iconBtn('ⓘ', 'Details', () => detailsModal(svc, si, ch, ci, chL)),
        iconBtn('🗑', 'Delete', async () => { if (await confirmModal(`Delete characteristic ${normalizeUuid(ch.uuid)}?`)) { delChar(si, ci); commit('Characteristic deleted'); } }, 'danger'),
      ),
    );
    if (written) row.classList.add('write-flash');
    node.append(row);
    if (open) {
      const detail = el('div.tree-children.char-detail', {});
      // Decoded breakdown — same style as the GATT Client: a SIG decoder, else via the
      // Presentation Format (0x2904) descriptor when one is present.
      if (vbytes.length) {
        let decoded = decodeValue(ch.uuid, vbytes);
        let via = false;
        if (!decoded) { const cpf = cpf2904(ch); if (cpf) { decoded = decodeByPresentationFormat(cpf, vbytes); via = true; } }
        if (decoded) {
          const g = el('div.decoded', {});
          if (via) g.append(el('div.muted', { style: { fontSize: '.72rem' }, text: 'decoded via Presentation Format (0x2904)' }));
          for (const r of decoded) g.append(detailRow(r.k, el('span.mono', { text: r.v })));
          detail.append(g);
        }
      }
      detail.append(detailRow('Value', el('code.mono', { text: bytesToHex(vbytes) || '(empty)' })));
      detail.append(detailRow('ASCII', el('span.mono', { text: vbytes.length ? ascii(vbytes) : '—' })));
      detail.append(detailRow('Descriptors', descriptorList(si, ci, ch, chL)));
      detail.append(el('div.subrow', {},
        el('button.btn', { text: 'Edit…', on: { click: () => editCharModal(svc, si, ch, ci) } }),
        el('button.btn', { text: 'Value & Notify…', on: { click: () => valueModal(si, ci, ch, chL) } }),
        el('button.btn', { text: '+ Descriptor…', on: { click: () => addDescriptorModal(si, ci, ch) } }),
        el('button.btn', { text: 'Details…', on: { click: () => detailsModal(svc, si, ch, ci, chL) } }),
      ));
      node.append(detail);
    }
    return node;
  }

  function descriptorList(si, ci, ch, chL) {
    const wrap = el('span.desc-list', {});
    const descs = chL.descriptors || [];
    if (!descs.length) return el('span.muted', { text: 'none' });
    for (const d of descs) {
      const name = gattName(d.uuid);
      // CCCD value is per-connection: show the LIVE state (a central enabling/disabling notify/indicate
      // updates store.connections[].subscriptions, keyed by the characteristic's value handle).
      let bytes;
      if (d.isCCCD) {
        const v = (store.state.connections || []).reduce((acc, c) =>
          acc | (((c.subscriptions || []).find((s) => s.handle === chL.valueHandle) || {}).value || 0), 0);
        bytes = new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
      } else {
        bytes = d.value && d.value.length ? d.value : null;
      }
      const decoded = bytes ? decodeValue(d.uuid, bytes) : null;
      const shown = decoded ? decoded.map((r) => `${r.k}: ${r.v}`).join(' · ') : (bytes ? bytesToHex(bytes) : '(empty)');
      const managed = d.isCCCD; // CCCD value is per-connection — managed, not edited here
      wrap.append(el('span.desc-pill' + (recent(d.handle) ? '.write-flash' : ''),
        { attrs: { title: `${name ? name + ' — ' : ''}${bytes ? bytesToHex(bytes) : 'empty'}${d.writable ? ' (writable)' : ''}` } },
        el('span', { text: `${normalizeUuid(d.uuid)}${name ? ' ' + name : ''}${d.isCCCD ? ' (CCCD)' : ''} · ${hx(d.handle)}` }),
        el('span.desc-val.mono', { text: '= ' + shown }),
        managed ? null : el('button.pill-x', { text: '✎', attrs: { title: 'Edit descriptor' }, on: { click: () => editDescriptorModal(si, ci, ch, d) } }),
        managed ? null : el('button.pill-x', { text: '✕', attrs: { title: 'Remove descriptor' }, on: { click: () => removeDescriptor(si, ci, ch, d.uuid) } })));
    }
    return wrap;
  }

  function removeDescriptor(si, ci, ch, uuid) {
    const list = (ch.descriptors || []).filter((d) => normalizeUuid(d.uuid) !== uuid);
    setChar(si, ci, { ...ch, descriptors: list });
    commit('Descriptor removed');
  }

  // ---- modals ----
  function editCharModal(svc, si, ch, ci) { charForm({ title: `Edit ${normalizeUuid(ch.uuid)}`, ch, onSave: (obj) => { setChar(si, ci, obj); commit('Characteristic updated'); } }); }
  function addCharModal(si) { charForm({ title: 'Add characteristic', ch: { uuid: '', properties: ['read'], valueHex: '' }, onSave: (obj) => { addChar(si, obj); if (collapsedServices.has(si)) collapsedServices.delete(si); commit('Characteristic added'); } }); }

  function charForm({ title, ch, onSave }) {
    const name = textInput(ch.name || '', 'optional name');
    const { el: uuidEl, input: uuid } = uuidPicker(ch.uuid, name, CHAR_OPTS, 'search name, 0x2A37, or 128-bit UUID');
    const boxes = {};
    const propRow = el('div.subrow', {}, ...PROP_KEYS.map((p) => { const cb = el('input', { type: 'checkbox', checked: (ch.properties || []).includes(p) }); boxes[p] = cb; return el('label.inline', {}, cb, ' ' + p); }));
    const sec = selectInput(['open', 'encrypt', 'authenticate'], ch.security || 'open');
    const usingText = ch.valueText != null && !ch.valueHex;
    const mode = selectInput(['hex', 'text'], usingText ? 'text' : 'hex');
    const value = restrictHexBytes(textInput(usingText ? ch.valueText : (ch.valueHex || ''), 'value'), () => mode.value === 'hex');
    // Convert the value between representations when the type toggles (UTF-8 text ↔ hex bytes).
    mode.addEventListener('change', () => { value.value = mode.value === 'hex' ? textToHexBytes(value.value) : hexToText(value.value); });
    const err = el('div.err-text', { style: { display: 'none' } });
    const content = el('div.modal-form', {},
      field('UUID', uuidEl, null, 'gatt.uuid'), field('Name', name),
      el('div.modal-field', {}, applyHelp(el('span.field-label', {}, 'Properties'), 'gatt.properties'), propRow),
      el('div.row', {}, field('Security', sec, null, 'gatt.security'), field('Value type', mode, null, 'gatt.valueType'), field('Value', value, null, 'gatt.value')),
      err,
    );
    openModal({ title, content, actions: [
      { label: 'Cancel', onClick: (c) => c() },
      { label: 'Save', kind: 'primary', onClick: (c) => {
        let u; try { u = uuid.value.trim(); normalizeUuid(u); } catch { return showErr(err, 'Invalid UUID'); }
        if (mode.value === 'hex' && value.value.trim()) { try { hexToBytes(value.value); } catch { return showErr(err, 'Invalid hex value'); } }
        const obj = { uuid: u, properties: PROP_KEYS.filter((p) => boxes[p].checked), security: sec.value };
        if (name.value.trim()) obj.name = name.value.trim();
        if (mode.value === 'text') obj.valueText = value.value; else obj.valueHex = value.value.trim();
        if (ch.descriptors) obj.descriptors = ch.descriptors;
        onSave(obj); c();
      } },
    ] });
  }

  function valueModal(si, ci, ch, chL) {
    const usingText = ch.valueText != null && !ch.valueHex;
    const mode = selectInput(['hex', 'text'], usingText ? 'text' : 'hex');
    const value = restrictHexBytes(textInput(usingText ? ch.valueText : (ch.valueHex || ''), 'value'), () => mode.value === 'hex');
    const preview = el('div.value-preview', {});
    const bytesNow = () => { try { return mode.value === 'text' ? new TextEncoder().encode(value.value) : hexToBytes(value.value); } catch { return null; } };
    const refresh = () => {
      clear(preview);
      const bytes = bytesNow();
      if (!bytes) { preview.append(el('div.err-text', { style: { gridColumn: '1 / -1' }, text: 'invalid input' })); return; }
      for (const fld of previewFields(bytes, ch.uuid)) {
        preview.append(
          el('span', { class: 'pv-k' + (fld.decoded ? ' decoded' : ''), text: fld.k }),
          el('span.pv-v', { text: String(fld.v) }),
        );
      }
    };
    value.addEventListener('input', refresh);
    mode.addEventListener('change', () => { value.value = mode.value === 'hex' ? textToHexBytes(value.value) : hexToText(value.value); refresh(); });
    refresh();
    const subN = subscriberCount(chL.valueHandle);
    const writeBack = () => { const o = { ...ch }; if (mode.value === 'text') { o.valueText = value.value; o.valueHex = ''; } else { o.valueHex = value.value.trim(); o.valueText = null; } setChar(si, ci, o); };

    const content = el('div.modal-form', {},
      el('div.row', {}, field('Value type', mode, null, 'gatt.valueType'), field('Value', value, null, 'gatt.value')),
      el('h4', { text: 'Decoded' }), preview,
      el('h4', { text: 'Notify' }),
      el('p.muted', { text: subN ? `${subN} subscriber(s) — Notify/Indicate will be delivered.` : 'No subscribers yet (clients enable notifications via the CCCD).' }),
    );
    openModal({ title: `Value — ${normalizeUuid(ch.uuid)} ${hx(chL.valueHandle)}`, content, actions: [
      { label: 'Close', onClick: (c) => c() },
      { label: 'Save value', onClick: (c) => { if (!bytesNow()) return; writeBack(); commit('Value saved'); c(); } },
      { label: 'Save & Notify', kind: 'primary', onClick: (c) => { const b = bytesNow(); if (!b) return; writeBack(); commit('Value saved'); const n = conn.notify(chL.valueHandle, b); flash(n ? `Notified ${n} subscriber(s)` : 'Saved — no subscribers'); c(); } },
    ] });
  }

  function detailsModal(svc, si, ch, ci, chL) {
    const db = buildDb(gatt());
    const decl = db.byHandle.get(chL.declHandle);
    const val = db.byHandle.get(chL.valueHandle);
    const subs = store.state.connections.filter((c) => c.subscriptions.some((s) => s.handle === chL.valueHandle && s.value));
    const decoded = val && val.value.length ? decodeValue(ch.uuid, val.value) : null;
    const grid = el('div.card-grid', {},
      ...kv('Characteristic', `${normalizeUuid(ch.uuid)} ${ch.name || ''}`),
      ...kv('In service', `${normalizeUuid(svc.uuid)} ${svc.name || ''}`),
      ...kv('Declaration handle', hx(chL.declHandle)),
      ...kv('Value handle', hx(chL.valueHandle)),
      ...kv('CCCD handle', chL.cccdHandle ? hx(chL.cccdHandle) : '—'),
      ...kv('Properties', (ch.properties || []).join(', ') || 'none'),
      ...kv('Declaration bytes', decl ? bytesToHex(decl.value) : '—'),
      ...kv('Permissions', permText(val)),
      ...kv('Current value', val && val.value.length ? `${bytesToHex(val.value)}  “${ascii(val.value)}”` : '(empty)'),
      ...(decoded ? kv('Decoded', decoded.map((r) => `${r.k}: ${r.v}`).join(' · ')) : []),
      ...kv('Subscribers', subs.length ? subs.map((c) => `${c.peerAddr} (${c.subscriptions.find((s) => s.handle === chL.valueHandle).value === 2 ? 'indicate' : 'notify'})`).join(', ') : 'none'),
    );
    openModal({ title: `Details — ${normalizeUuid(ch.uuid)}`, width: '620px', content: grid, actions: [{ label: 'Close', kind: 'primary', onClick: (c) => c() }] });
  }

  // Add/Edit descriptor. `edit` = { idx } into ch.descriptors when editing, else null.
  function descriptorModal(si, ci, ch, edit) {
    const cur = edit ? ch.descriptors[edit.idx] : null;
    const initUuid = cur ? normalizeUuid(cur.uuid) : '2901';
    const isPreset = DESC_PRESETS.some(([u]) => u === initUuid);
    const type = el('select', {},
      ...DESC_PRESETS.map(([u, n]) => el('option', { value: u, text: `${u} — ${n}`, selected: u === initUuid })),
      el('option', { value: 'custom', text: 'Custom UUID…', selected: cur && !isPreset }));
    const custom = textInput(cur && !isPreset ? initUuid : '', '128-bit or 16-bit UUID');
    const customRow = field('Custom UUID', custom); customRow.style.display = (cur && !isPreset) ? '' : 'none';
    // Descriptor value is hex bytes for everything except User Description (0x2901), which is UTF-8 text.
    const isHexDesc = () => { try { return normalizeUuid(type.value === 'custom' ? custom.value.trim() : type.value) !== '2901'; } catch { return true; } };
    const initVal = cur ? (cur.valueText != null ? cur.valueText : (cur.valueHex || '')) : '';
    const value = restrictHexBytes(textInput(initVal, 'UTF-8 text (User Description) or hex'), isHexDesc);
    const writable = el('input', { type: 'checkbox', checked: !!(cur && cur.writable) });
    type.addEventListener('change', () => { customRow.style.display = type.value === 'custom' ? '' : 'none'; });
    const content = el('div.modal-form', {}, field('Type', type), customRow, field('Value', value),
      el('label.inline', {}, writable, ' Writable by client'));
    openModal({ title: edit ? 'Edit descriptor' : 'Add descriptor', content, actions: [
      { label: 'Cancel', onClick: (c) => c() },
      { label: edit ? 'Save' : 'Add', kind: 'primary', onClick: (c) => {
        let u = type.value === 'custom' ? custom.value.trim() : type.value;
        try { u = normalizeUuid(u); } catch { return; }
        const d = { uuid: u };
        if (u === '2901') d.valueText = value.value; else if (value.value.trim()) d.valueHex = value.value.trim();
        if (writable.checked) d.writable = true;
        const list = [...(ch.descriptors || [])];
        if (edit) list[edit.idx] = d; else list.push(d);
        setChar(si, ci, { ...ch, descriptors: list });
        commit(edit ? 'Descriptor updated' : 'Descriptor added'); c();
      } },
    ] });
  }
  function addDescriptorModal(si, ci, ch) { descriptorModal(si, ci, ch, null); }
  function editDescriptorModal(si, ci, ch, builtD) {
    const idx = (ch.descriptors || []).findIndex((td) => normalizeUuid(td.uuid) === builtD.uuid);
    if (idx >= 0) descriptorModal(si, ci, ch, { idx }); // auto-CCCD isn't in the table → nothing to edit
  }

  function addServiceModal() { serviceForm({ title: 'Add service', svc: { uuid: '', primary: true }, onSave: (o) => { addService({ ...o, characteristics: [] }); commit('Service added'); } }); }
  function editServiceModal(svc, si) { serviceForm({ title: `Edit ${normalizeUuid(svc.uuid)}`, svc, onSave: (o) => { setService(si, o); commit('Service updated'); } }); }

  function serviceForm({ title, svc, onSave }) {
    const name = textInput(svc.name || '', 'optional name');
    const { el: uuidEl, input: uuid } = uuidPicker(svc.uuid, name, SERVICE_OPTS, 'search name, 0x180F, or 128-bit UUID');
    const primary = el('input', { type: 'checkbox', checked: svc.primary !== false });
    const err = el('div.err-text', { style: { display: 'none' } });
    const content = el('div.modal-form', {}, field('UUID', uuidEl, null, 'gatt.uuid'), field('Name', name), el('label.inline', {}, primary, ' Primary service'), err);
    openModal({ title, content, actions: [
      { label: 'Cancel', onClick: (c) => c() },
      { label: 'Save', kind: 'primary', onClick: (c) => { let u; try { u = uuid.value.trim(); normalizeUuid(u); } catch { return showErr(err, 'Invalid UUID'); } onSave({ uuid: u, name: name.value.trim() || undefined, primary: primary.checked }); c(); } },
    ] });
  }


  // ---- json ----
  function exportJson() {
    const blob = new Blob([JSON.stringify(stampExport(store.state.gatt), null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'gatt-table.json' });
    document.body.append(a); a.click(); a.remove();
  }
  function importBtn() {
    const input = el('input', { type: 'file', attrs: { accept: '.json' }, style: { display: 'none' }, on: { change: async (e) => { const f = e.target.files[0]; if (!f) return; try { const doc = JSON.parse(await f.text()); delete doc.site; delete doc.version; store.state.gatt = doc; commit('Imported'); } catch (err) { flash('Import failed: ' + err.message); } } } });
    return el('span', {}, el('button.btn', { text: 'Import', on: { click: () => input.click() } }), input);
  }

  render();
  store.subscribe(render);
  return { id: 'gatt', title: 'GATT Server', el: root };
}

// ---- small helpers ----
function iconBtn(text, title, onClick, kind = '') { return el('button', { class: 'icon-btn ' + kind, text, attrs: { title }, on: { click: onClick } }); }
function textInput(value, placeholder) { return el('input', { type: 'text', value: value ?? '', placeholder }); }
function selectInput(options, selected) { return el('select', {}, ...options.map((o) => el('option', { value: o, selected: o === selected, text: o }))); }
function detailRow(k, v) { return el('div.kv', {}, el('span.k', { text: k }), el('span.v', {}, v)); }
function kv(k, v) { return [el('span.k', { text: k }), el('span.v', { text: v })]; }
function showErr(node, msg) { node.textContent = msg; node.style.display = ''; }
function ascii(b) { return Array.from(b).map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join(''); }
// Bytes of a characteristic's Presentation Format (0x2904) descriptor, or null — drives value decoding.
function cpf2904(ch) {
  const d = (ch.descriptors || []).find((x) => { try { return normalizeUuid(x.uuid) === '2904'; } catch { return false; } });
  return d && d.valueHex ? hexToBytes(d.valueHex) : null;
}
function permText(attr) { if (!attr) return '—'; const p = attr.perms; const parts = []; if (p.read) parts.push(p.readEnc ? 'read(enc)' : 'read'); if (p.write) parts.push(p.writeEnc ? 'write(enc)' : 'write'); return parts.join(', ') || 'none'; }
// Known SIG characteristics with a fixed value length (subset) — used for inline checks.
const SIG_FIXED_LEN = { '2A19': 1, '2A01': 2, '2A38': 1, '2A1D': 1, '2A6E': 2, '2A23': 8, '2A2B': 10 };

export function charWarnings(ch, svc) {
  const w = [];
  const props = ch.properties || [];
  let uuid = null;
  try { uuid = normalizeUuid(ch.uuid); } catch { w.push('Invalid UUID.'); }

  if (!props.length) w.push('No properties set — a characteristic needs at least one.');
  if (props.includes('notify') && props.includes('indicate')) w.push('Both Notify and Indicate are set — clients usually expect only one.');
  if ((props.includes('notify') || props.includes('indicate')) && props.includes('read') === false && props.length === 1) {
    // notify/indicate-only is valid; nothing to warn.
  }

  let len = null;
  if (ch.valueHex) { try { len = hexToBytes(ch.valueHex).length; } catch { w.push('Value is not valid hex.'); } }
  else if (ch.valueText != null) len = new TextEncoder().encode(ch.valueText).length;

  if (uuid && SIG_FIXED_LEN[uuid] != null && len != null && len > 0 && len !== SIG_FIXED_LEN[uuid]) {
    w.push(`${uuid} is normally ${SIG_FIXED_LEN[uuid]} byte(s); value is ${len}.`);
  }

  if (uuid && svc) {
    const dupes = (svc.characteristics || []).filter((c) => { try { return normalizeUuid(c.uuid) === uuid; } catch { return false; } }).length;
    if (dupes > 1) w.push('Duplicate UUID within this service.');
  }
  return w;
}
// Key/value fields for the Value modal's "Decoded" panel: SIG-decoded fields (flagged `decoded`)
// first, then the raw hex / length / ASCII and small-integer interpretations.
function previewFields(bytes, uuid) {
  const fields = [];
  const decoded = uuid && decodeValue(uuid, bytes);
  if (decoded) for (const r of decoded) fields.push({ k: r.k, v: r.v, decoded: true });
  fields.push({ k: 'Hex', v: bytesToHex(bytes) || '(empty)' });
  fields.push({ k: 'Length', v: `${bytes.length} bytes` });
  fields.push({ k: 'ASCII', v: ascii(bytes) || '—' });
  if (bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length === 1) fields.push({ k: 'uint8', v: dv.getUint8(0) }, { k: 'int8', v: dv.getInt8(0) });
    if (bytes.length === 2) fields.push({ k: 'uint16 LE', v: dv.getUint16(0, true) }, { k: 'int16 LE', v: dv.getInt16(0, true) });
    if (bytes.length === 4) fields.push({ k: 'uint32 LE', v: dv.getUint32(0, true) });
  }
  return fields;
}
