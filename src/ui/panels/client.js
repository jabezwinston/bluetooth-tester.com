// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// GATT Client panel: discover the connected central's GATT server, then read / write /
// subscribe to its characteristics, and watch inbound notifications. Styled to match the
// GATT Server panel — a collapsible service/characteristic tree with expandable detail —
// and decodes standard SIG values (DIS, PnP ID, HID, Battery, sensors…) for readability.

import { el, clear, field } from '../dom.js';
import { hexToBytes, bytesToHex } from '../../util/bytes.js';
import { normalizeUuid } from '../../util/uuid.js';
import { gattName, decodeValue, summarizeValue, decodeByPresentationFormat } from '../../profiles/gatt-decode.js';
import { restrictHexBytes, textToHexBytes, hexToText } from '../hex-input.js';
import { openModal } from '../modal.js';

// Structured editors for common writable characteristics (value → hex bytes to write).
const WRITE_ENUMS = {
  '2A06': ['Alert Level', [['00', 'No Alert'], ['01', 'Mild Alert'], ['02', 'High Alert']]],
  '2A4E': ['Protocol Mode', [['00', 'Boot'], ['01', 'Report']]],
  '2A4C': ['HID Control Point', [['00', 'Suspend'], ['01', 'Exit Suspend']]],
};

const hx = (n) => '0x' + n.toString(16).padStart(4, '0');
const SHORT = { read: 'R', write: 'W', writeNoResp: 'Wnr', notify: 'N', indicate: 'I', broadcast: 'B', signed: 'S' };

export function createClientPanel({ store, conn }) {
  const root = el('div.panel-body');
  const collapsedSvcs = new Set();  // services default expanded
  const expandedChars = new Set();  // characteristics default collapsed

  function render() {
    clear(root);
    const conns = store.state.connections;
    if (!conns.length) { root.append(el('div.empty', { text: 'No connections. Once a central connects, discover its GATT server here.' })); return; }
    for (const c of conns) root.append(connectionSection(c));
  }

  function connectionSection(c) {
    const cl = store.state.client[c.handle] || {};
    const card = el('div.card', {});
    const discovered = !!cl.services;
    card.append(el('div.toolbar', {},
      el('strong', { text: `${hx(c.handle)} · ${c.peerAddr}${c.encrypted ? ' 🔒' : ''}` }),
      el('button.btn.primary', { text: cl.discovering ? 'Discovering…' : (discovered ? 'Re-discover' : 'Discover services'), disabled: cl.discovering, on: { click: () => conn.discoverPeer(c.handle) } }),
      discovered ? el('button.btn', { text: 'Read all', attrs: { title: 'Read every readable characteristic' }, on: { click: () => readAll(c.handle, cl) } }) : null,
      discovered ? el('button.btn', { text: allCollapsed(c.handle, cl) ? 'Expand all' : 'Collapse all', on: { click: () => toggleAll(c.handle, cl) } }) : null,
      discovered ? el('span.muted', { text: `${cl.services.length} services · ${charCount(cl)} chars` }) : null,
      cl.error ? el('span.muted', { text: cl.error }) : null));

    if (discovered) {
      const tree = el('div.tree', {});
      for (const svc of cl.services) tree.append(serviceNode(c.handle, svc));
      if (!cl.services.length) tree.append(el('div.empty', { text: 'No services found.' }));
      card.append(tree);
    } else if (!cl.discovering) {
      card.append(el('p.muted', { text: 'Not discovered yet.' }));
    }
    if (cl.notifications && cl.notifications.length) card.append(notificationsCard(c.handle, cl));
    return card;
  }

  function serviceNode(handle, svc) {
    const key = handle + ':' + svc.startHandle;
    const open = !collapsedSvcs.has(key);
    const node = el('div.tree-node', {});
    node.append(el('div.tree-row.service', {},
      el('span.tree-toggle', { text: open ? '▼' : '▶', on: { click: () => { open ? collapsedSvcs.add(key) : collapsedSvcs.delete(key); render(); } } }),
      el('span.tree-label', { html: `<strong>${normalizeUuid(svc.uuid)}</strong> ${nameOf(svc.uuid)}` }),
      el('span.tree-meta', { text: `${svc.characteristics.length} chars · ${hx(svc.startHandle)}–${hx(svc.endHandle)}` })));
    if (open) {
      const kids = el('div.tree-children', {});
      for (const ch of svc.characteristics) kids.append(charNode(handle, ch));
      if (!svc.characteristics.length) kids.append(el('div.tree-empty', { text: 'no characteristics' }));
      node.append(kids);
    }
    return node;
  }

  function charNode(handle, ch) {
    const key = handle + ':' + ch.valueHandle;
    const open = expandedChars.has(key);
    const props = ch.properties || [];
    const node = el('div.tree-node', {});
    const bytes = valueBytes(ch);
    const summary = bytes ? summarizeValue(ch.uuid, bytes) : null;

    const actions = el('span.tree-actions', {});
    if (props.includes('read')) actions.append(iconBtn('Read', 'Read value', () => readChar(handle, ch)));
    if (props.includes('write') || props.includes('writeNoResp')) actions.append(iconBtn('Write', 'Write value', () => writeModal(handle, ch)));
    if ((props.includes('notify') || props.includes('indicate')) && ch.cccdHandle) {
      actions.append(iconBtn(ch.cccd ? 'Unsub' : 'Sub', ch.cccd ? 'Unsubscribe' : 'Subscribe', () => conn.subscribePeer(handle, ch.cccdHandle, ch.cccd ? 0 : (props.includes('notify') ? 1 : 2))));
    }

    node.append(el('div.tree-row.char', {},
      el('span.tree-toggle', { text: open ? '▼' : '▶', on: { click: () => { open ? expandedChars.delete(key) : expandedChars.add(key); render(); } } }),
      el('span.tree-label', { html: `<strong>${normalizeUuid(ch.uuid)}</strong> ${nameOf(ch.uuid)}` }),
      el('span.chips', {}, ...props.map((p) => el('span', { class: 'chip ' + p, text: SHORT[p] || p, attrs: { title: p } }))),
      ch.cccd ? el('span.chip.sub', { text: '▲', attrs: { title: 'subscribed' } }) : null,
      summary ? el('span.tree-val', { text: summary }) : el('span.tree-meta', { text: `val ${hx(ch.valueHandle)}` }),
      actions));

    if (open) node.append(charDetail(handle, ch, bytes));
    return node;
  }

  function charDetail(handle, ch, bytes) {
    const props = ch.properties || [];
    const detail = el('div.tree-children.char-detail', {});
    if (bytes) {
      let decoded = decodeValue(ch.uuid, bytes);
      let via = null;
      if (!decoded) { const cpf = cpfValue(ch); if (cpf) { decoded = decodeByPresentationFormat(cpf, bytes); via = true; } }
      if (decoded) {
        const g = el('div.decoded', {});
        if (via) g.append(el('div.muted', { style: { fontSize: '.72rem' }, text: 'decoded via Presentation Format (0x2904)' }));
        for (const r of decoded) g.append(detailRow(r.k, el('span.mono', { text: r.v })));
        detail.append(g);
      }
      detail.append(detailRow('Value', el('code.mono', { text: ch.value || '(empty)' })));
      detail.append(detailRow('ASCII', el('span.mono', { text: ascii(ch.value) })));
    } else {
      detail.append(detailRow('Value', el('span.muted', { text: props.includes('read') ? 'not read yet' : 'not readable' })));
    }
    detail.append(detailRow('Handles', el('span.mono', { text: `val ${hx(ch.valueHandle)}${ch.cccdHandle ? ` · cccd ${hx(ch.cccdHandle)}` : ''}` })));
    if (ch.descriptors && ch.descriptors.length) detail.append(detailRow('Descriptors', descriptorList(handle, ch)));

    const buttons = el('div.subrow', {});
    if (props.includes('read')) buttons.append(el('button.btn', { text: 'Read', on: { click: () => readChar(handle, ch) } }));
    if (props.includes('write') || props.includes('writeNoResp')) buttons.append(el('button.btn', { text: 'Write…', on: { click: () => writeModal(handle, ch) } }));
    if ((props.includes('notify') || props.includes('indicate')) && ch.cccdHandle) {
      buttons.append(el('button.btn', { text: ch.cccd ? 'Unsubscribe' : 'Subscribe', on: { click: () => conn.subscribePeer(handle, ch.cccdHandle, ch.cccd ? 0 : (props.includes('notify') ? 1 : 2)) } }));
    }
    if (buttons.childNodes.length) detail.append(buttons);
    return detail;
  }

  function descriptorList(handle, ch) {
    const wrap = el('span.desc-list', {});
    for (const d of ch.descriptors) {
      const name = nameOf(d.uuid);
      const bytes = d.value != null ? hexToBytes(d.value) : null;
      const decoded = bytes ? decodeValue(d.uuid, bytes) : null;
      const shown = decoded ? decoded.map((r) => `${r.k}: ${r.v}`).join(' · ') : (d.value != null ? (d.value || '(empty)') : null);
      const pill = el('span.desc-pill', { attrs: { title: `${name || normalizeUuid(d.uuid)}${shown != null ? ' — ' + shown : ' — hover or Read to fetch'}` } },
        el('span', { text: `${normalizeUuid(d.uuid)}${name ? ' ' + name : ''} · ${hx(d.handle)}` }),
        shown != null ? el('span.desc-val.mono', { text: '= ' + shown }) : null,
        iconBtn('Read', 'Read descriptor value', () => conn.readDescriptor(handle, d.handle)),
        iconBtn('✎', 'Write descriptor value', () => descriptorWriteModal(handle, d)));
      // Hovering an unread descriptor fetches its value once (re-render then shows it inline + in tooltip).
      if (d.value == null) pill.addEventListener('mouseenter', () => conn.readDescriptor(handle, d.handle), { once: true });
      wrap.append(pill);
    }
    return wrap;
  }

  function descriptorWriteModal(handle, d) {
    const u = normalizeUuid(d.uuid);
    const mode = el('select', {}, el('option', { value: 'hex', text: 'hex' }), el('option', { value: 'text', text: 'text' }));
    const val = restrictHexBytes(el('input', { type: 'text', placeholder: 'value', value: d.value || '' }), () => mode.value === 'hex');
    const bytesOf = () => { try { return mode.value === 'text' ? new TextEncoder().encode(val.value) : hexToBytes(val.value); } catch { return null; } };
    let prev = mode.value;
    mode.addEventListener('change', () => {
      if (prev === 'text' && mode.value === 'hex') val.value = textToHexBytes(val.value);
      else if (prev === 'hex' && mode.value === 'text') val.value = hexToText(val.value);
      prev = mode.value;
    });
    openModal({ title: `Write descriptor ${u} (${hx(d.handle)})`,
      content: el('div.modal-form', {}, el('div.row', {}, field('Type', mode), field('Value', val))),
      actions: [{ label: 'Cancel', onClick: (c) => c() },
        { label: 'Write', kind: 'primary', onClick: (c) => { const b = bytesOf(); if (!b) return; conn.writeDescriptor(handle, d.handle, b, true); c(); } }] });
  }

  function writeModal(handle, ch) {
    const u = safeUuid(ch.uuid) || normalizeUuid(ch.uuid);
    const withResponse = ch.properties.includes('write');
    const enumDef = WRITE_ENUMS[u];

    const mode = el('select', {},
      ...(enumDef ? [el('option', { value: 'enum', text: enumDef[0] })] : []),
      el('option', { value: 'hex', text: 'hex' }), el('option', { value: 'text', text: 'text' }));
    const val = restrictHexBytes(el('input', { type: 'text', placeholder: 'value' }), () => mode.value === 'hex');
    const enumSel = el('select', {}, ...(enumDef ? enumDef[1].map(([v, lbl]) => el('option', { value: v, text: `${lbl} (0x${v})` })) : []));
    const enumField = enumDef ? field('Choice', enumSel) : null;
    const valField = field('Value', val, null, 'client.write');
    const preview = el('div.value-preview', {});

    const currentBytes = () => {
      try {
        if (mode.value === 'enum') return hexToBytes(enumSel.value);
        if (mode.value === 'text') return new TextEncoder().encode(val.value);
        return hexToBytes(val.value);
      } catch { return null; }
    };
    const refresh = () => {
      if (enumField) enumField.style.display = mode.value === 'enum' ? '' : 'none';
      valField.style.display = mode.value === 'enum' ? 'none' : '';
      clear(preview);
      const b = currentBytes();
      if (!b) { preview.append(el('span.muted', { text: 'invalid input' })); return; }
      const decoded = decodeValue(u, b) || (cpfValue(ch) && decodeByPresentationFormat(cpfValue(ch), b));
      if (decoded) for (const r of decoded) preview.append(el('div.kv', {}, el('span.k', { text: r.k }), el('span.v.mono', { text: r.v })));
      preview.append(el('div.kv', {}, el('span.k', { text: 'Bytes' }), el('span.v.mono', { text: bytesToHex(b) || '(empty)' })));
    };
    // Convert the value between representations on a hex↔text toggle (no conversion to/from enum).
    let prevMode = mode.value;
    mode.addEventListener('change', () => {
      if (prevMode === 'text' && mode.value === 'hex') val.value = textToHexBytes(val.value);
      else if (prevMode === 'hex' && mode.value === 'text') val.value = hexToText(val.value);
      prevMode = mode.value;
      refresh();
    });
    val.addEventListener('input', refresh); enumSel.addEventListener('change', refresh);
    if (enumDef) mode.value = 'enum';
    prevMode = mode.value;
    refresh();

    openModal({
      title: `Write ${u} (${hx(ch.valueHandle)})`,
      content: el('div.modal-form', {},
        el('div.row', {}, field('Type', mode), enumField, valField),
        el('h4', { text: 'Preview' }), preview,
        el('p.muted', { text: withResponse ? 'Write Request (with response)' : 'Write Command (no response)' })),
      actions: [
        { label: 'Cancel', onClick: (c) => c() },
        { label: 'Write', kind: 'primary', onClick: (c) => { const b = currentBytes(); if (!b) return; conn.writePeer(handle, ch.valueHandle, b, withResponse); c(); } },
      ],
    });
  }

  function notificationsCard(handle, cl) {
    return el('div.notif-box', {}, el('h3', { text: 'Notifications' }),
      ...cl.notifications.slice(0, 15).map((n) => {
        const uuid = uuidForHandle(cl, n.handle);
        const bytes = n.value ? hexToBytes(n.value) : null;
        const summary = uuid && bytes ? summarizeValue(uuid, bytes) : null;
        return el('div.kv', {},
          el('span.k.mono', { text: hx(n.handle) }),
          el('span.v.mono', { text: summary ? `${summary}   ${n.value}` : `${n.value}  ${ascii(n.value)}` }));
      }));
  }

  // ---- helpers ----
  // Read a characteristic value, and (so CPF-driven decoding lights up) its 0x2904 descriptor.
  function readChar(handle, ch) {
    conn.readPeer(handle, ch.valueHandle);
    const cpf = (ch.descriptors || []).find((d) => safeUuid(d.uuid) === '2904');
    if (cpf && cpf.value == null) conn.readDescriptor(handle, cpf.handle);
  }
  function readAll(handle, cl) {
    for (const svc of cl.services) for (const ch of svc.characteristics) {
      if ((ch.properties || []).includes('read')) conn.readPeer(handle, ch.valueHandle);
      // also pull descriptors we can decode (Presentation Format, Report Reference, User Description)
      for (const d of (ch.descriptors || [])) if (['2904', '2908', '2901'].includes(safeUuid(d.uuid))) conn.readDescriptor(handle, d.handle);
    }
  }
  function allCollapsed(handle, cl) { return cl.services.every((svc) => collapsedSvcs.has(handle + ':' + svc.startHandle)); }
  function toggleAll(handle, cl) {
    const collapse = !allCollapsed(handle, cl);
    for (const svc of cl.services) { const k = handle + ':' + svc.startHandle; collapse ? collapsedSvcs.add(k) : collapsedSvcs.delete(k); }
    render();
  }

  render();
  store.subscribe(render);
  return { id: 'client', title: 'GATT Client', el: root };
}

// ---- small helpers ----
function iconBtn(text, title, onClick) { return el('button.icon-btn', { text, attrs: { title }, on: { click: onClick } }); }
function detailRow(k, v) { return el('div.kv', {}, el('span.k', { text: k }), el('span.v', {}, v)); }
function nameOf(uuid) { return gattName(uuid) || ''; }
function safeUuid(u) { try { return normalizeUuid(u); } catch { return null; } }
// The read 0x2904 (Characteristic Presentation Format) descriptor value bytes, or null.
function cpfValue(ch) {
  const d = (ch.descriptors || []).find((x) => safeUuid(x.uuid) === '2904' && x.value != null);
  return d ? hexToBytes(d.value) : null;
}
function charCount(cl) { return cl.services.reduce((n, s) => n + s.characteristics.length, 0); }
function valueBytes(ch) { return ch.value != null ? hexToBytes(ch.value) : null; }
function uuidForHandle(cl, handle) {
  for (const svc of cl.services || []) for (const ch of svc.characteristics) if (ch.valueHandle === handle) return ch.uuid;
  return null;
}
function ascii(hex) {
  if (!hex) return '';
  const b = hex.split(' ').filter(Boolean).map((h) => parseInt(h, 16));
  return '"' + b.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join('') + '"';
}
