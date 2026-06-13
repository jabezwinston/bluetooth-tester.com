// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Advertiser panel. Each AD field has a *placement* (Adv / Scan / Both / Off); you assign it with a
// segmented control. The two PDUs (advertising data + scan response) carry the same AD types but have
// separate 31-byte budgets, so the panel shows them side-by-side with a combined 62-byte budget and
// cross-PDU warnings.
// Friendly for exploration: searchable Appearance + Service-UUID pickers, Swift Pair, device presets.

import { el, clear, field } from '../dom.js';
import { applyHelp } from '../help/help-tip.js';
import { optHelp } from '../help/help-text.js';
import { bytesToHex } from '../../util/bytes.js';
import { ADV_TYPE_LABELS, APPEARANCE, FLAG, SERVICE_UUID16, uuid16Name, SWIFT_PAIR_PRESETS, SWIFT_PAIR_COMPANY } from '../../data/assigned.js';
import { computeAdv } from '../../host/gap.js';
import { buildAdExport, parseAdImport } from '../../host/ad-io.js';
import { iBeaconData, eddystoneUrlData, eddystoneUidData, APPLE_COMPANY, EDDYSTONE_UUID } from '../../data/beacons.js';
import { initialState } from '../../store.js';
import { stampExport } from '../../app-meta.js';
import { restrictHexBytes } from '../hex-input.js';
import { openModal } from '../modal.js';
import { searchSelect, chipList } from '../combobox.js';

const CONNECTABLE_ADV = ['ADV_IND', 'ADV_DIRECT_IND_HIGH', 'ADV_DIRECT_IND_LOW'];

// Customizable beacon presets. Clicking one opens a modal of its `fields`; Apply runs `build(values)`
// → a store mutation. iBeacon rides Manufacturer Specific Data (Apple); Eddystone rides Service Data
// on 0xFEAA. All are non-connectable beacons. Exported (with defaults) for the unit tests.
export const BEACON_PRESETS = [
  {
    label: 'iBeacon',
    fields: [
      { key: 'uuid', label: 'Proximity UUID', default: 'E2C56DB5DFFB48D2B060D0F5A71096E0', hint: '128-bit' },
      { key: 'major', label: 'Major', type: 'number', default: 1 },
      { key: 'minor', label: 'Minor', type: 'number', default: 1 },
      { key: 'power', label: 'Measured power', type: 'number', default: -59, hint: 'dBm @ 1 m' },
    ],
    build: (v) => (s) => {
      s.advertiser.manufacturer = { company: APPLE_COMPANY, dataHex: iBeaconData({ uuid: v.uuid, major: +v.major, minor: +v.minor, power: +v.power }) };
      s.advertiser.serviceData = [];
      s.advertiser.advType = 'ADV_NONCONN_IND';
      s.advertiser.placement = P('flags', 'manufacturer');
    },
  },
  {
    label: 'Eddystone-URL',
    fields: [
      { key: 'url', label: 'URL', default: 'https://bluetooth-tester.com/', hint: 'http(s)://[www.]…' },
      { key: 'power', label: 'Tx power', type: 'number', default: -20, hint: 'dBm @ 0 m' },
    ],
    build: (v) => (s) => {
      s.advertiser.serviceData = [{ uuid: EDDYSTONE_UUID, dataHex: eddystoneUrlData({ url: v.url, power: +v.power }) }];
      s.advertiser.serviceUuids16 = [0xfeaa];
      s.advertiser.advType = 'ADV_NONCONN_IND';
      s.advertiser.placement = P('flags', 'uuids16', 'serviceData');
    },
  },
  {
    label: 'Eddystone-UID',
    fields: [
      { key: 'namespace', label: 'Namespace', default: '00010203040506070809', hint: '10 bytes' },
      { key: 'instance', label: 'Instance', default: '0a0b0c0d0e0f', hint: '6 bytes' },
      { key: 'power', label: 'Tx power', type: 'number', default: -20, hint: 'dBm @ 0 m' },
    ],
    build: (v) => (s) => {
      s.advertiser.serviceData = [{ uuid: EDDYSTONE_UUID, dataHex: eddystoneUidData({ namespace: v.namespace, instance: v.instance, power: +v.power }) }];
      s.advertiser.serviceUuids16 = [0xfeaa];
      s.advertiser.advType = 'ADV_NONCONN_IND';
      s.advertiser.placement = P('flags', 'uuids16', 'serviceData');
    },
  },
];

// Build a full placement map with the named fields in 'adv' and the rest 'off'.
const P = (...inAdv) => {
  const base = { flags: 'off', name: 'off', appearance: 'off', uuids16: 'off', uuids128: 'off', txPower: 'off', manufacturer: 'off', serviceData: 'off' };
  for (const k of inAdv) base[k] = 'adv';
  return base;
};

// One-click device quick-fills: values + a full placement map (the user tweaks afterwards).
// LE-Audio kept to 3 services so the default payload stays under the 31-byte legacy budget.
export const ADV_PRESETS = [
  { label: 'HID Keyboard', set: { name: 'BT Keyboard', appearance: 0x03c1, serviceUuids16: [0x1812, 0x180a, 0x180f], flags: 0x06, advType: 'ADV_IND', placement: P('flags', 'name', 'appearance', 'uuids16') } },
  { label: 'Heart Rate', set: { name: 'BT HRM', appearance: 0x0340, serviceUuids16: [0x180d, 0x180a, 0x180f], flags: 0x06, advType: 'ADV_IND', placement: P('flags', 'name', 'appearance', 'uuids16') } },
  { label: 'Beacon', set: { name: 'BT Beacon', serviceUuids16: [], flags: 0x06, advType: 'ADV_NONCONN_IND', placement: P('flags', 'name', 'txPower') } },
  { label: 'LE Audio Headset', set: { name: 'BT Earbuds', appearance: 0x0941, serviceUuids16: [0x1850, 0x184e, 0x1853], flags: 0x06, advType: 'ADV_IND', placement: P('flags', 'name', 'appearance', 'uuids16') } },
];

const PLACEMENTS = [['off', 'Off'], ['adv', 'Adv'], ['scanrsp', 'Scan'], ['both', 'Both']];
// Completeness modes. 'auto' = follow the spec split (Incomplete/Shortened in adv, Complete in scan
// response when a field is in both PDUs; Complete for a single-PDU field). See host/ad.js.
const UUID_MODES = [['auto', 'Auto'], ['complete', 'Complete'], ['incomplete', 'Incomplete']];
const NAME_MODES = [['auto', 'Auto'], ['complete', 'Complete'], ['shortened', 'Shortened']];

// Apply a preset's `set` onto an advertiser config: scalar fields overwrite, `placement` merges
// (so a preset's placement map updates only the keys it names). Pure — shared with the unit tests.
export function applyPresetTo(advertiser, setObj) {
  const { placement, ...rest } = setObj;
  Object.assign(advertiser, rest);
  if (placement) Object.assign(advertiser.placement, placement);
}

export function createAdvertiserPanel({ store, conn }) {
  const root = el('div.panel-body.advertiser');
  const adv = () => store.state.advertiser;

  // ---- tiny bound-control factories (they mutate the store) ----
  const set = (fn) => (e) => { fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value, e); };
  const text = (get, put, placeholder) => el('input', { type: 'text', value: get() ?? '', placeholder, on: { change: set(put) } });
  const check = (label, get, put) => el('label.inline', {}, el('input', { type: 'checkbox', checked: get(), on: { change: set(put) } }), ' ' + label);
  function flagBit(label, bit) {
    return check(label, () => (adv().flags & bit) !== 0, (v) => { adv().flags = v ? adv().flags | bit : adv().flags & ~bit; });
  }
  function msField(label, key, helpKey) {
    const input = el('input', {
      type: 'number', value: Math.round(adv()[key] * 0.625), attrs: { min: 20, step: 5 },
      on: { change: set((v) => { adv()[key] = clampInterval(Math.round((parseFloat(v) || 100) / 0.625)); }) },
    });
    return field(label, input, 'ms', helpKey);
  }

  // ---- placement changes & preset appliers: mutate the store, then rebuild the form so the segmented
  // highlights reflect the new state (the preview is reactive on its own). Button clicks blur any
  // focused editor first, committing its 'change', so a rebuild here never loses typed input. ----
  function setPlacement(fieldKey, val) { store.update((s) => { s.advertiser.placement[fieldKey] = val; }); rebuildForm(); }
  function applyDevicePreset(setObj) {
    store.update((s) => applyPresetTo(s.advertiser, setObj));
    rebuildForm();
  }
  function applySwiftPair(preset) {
    store.update((s) => {
      s.advertiser.manufacturer = { company: SWIFT_PAIR_COMPANY, dataHex: preset.dataHex };
      s.advertiser.placement.manufacturer = 'adv';
      s.advertiser.placement.name = 'adv'; // Windows needs the name in adv data (it doesn't active-scan)
      s.advertiser.nameMode = 'complete'; // …and the full name, so it shows on the toast
      if (!CONNECTABLE_ADV.includes(s.advertiser.advType)) s.advertiser.advType = 'ADV_IND';
    });
    rebuildForm();
  }

  // ---- per-field content editors (value-only; placement is separate). Preview updates reactively. ----
  function modeSelect(get, put, opts) {
    return el('select.mode-sel', { attrs: { title: 'completeness — Auto follows the Adv/Scan split' },
      on: { change: set((v) => put(v)) } },
      ...opts.map(([val, lbl]) => el('option', { value: val, selected: get() === val, text: lbl })));
  }
  function nameEditor(slot) {
    const scan = slot === 'scan';
    const key = scan ? 'nameScan' : 'name';
    return el('div.inline-editor', {},
      text(() => adv()[key], (v) => { adv()[key] = v; }, scan ? 'scan name (defaults to adv)' : 'device name'),
      scan ? null : modeSelect(() => adv().nameMode, (v) => { adv().nameMode = v; }, NAME_MODES));
  }
  function flagsEditor() {
    return el('div.inline-editor', {},
      flagBit('LE General', FLAG.LE_GENERAL_DISC),
      flagBit('LE Limited', FLAG.LE_LIMITED_DISC),
      flagBit('BR/EDR Not Supp.', FLAG.BR_EDR_NOT_SUPPORTED));
  }
  function appearanceEditor() {
    return searchSelect({
      options: APPEARANCE, value: adv().appearance, placeholder: 'search appearance or 0x….',
      onChange: (v) => { store.update((s) => { s.advertiser.appearance = v ?? 0; }); },
    });
  }
  function uuid16Editor(slot) {
    const key = slot === 'scan' ? 'serviceUuids16Scan' : 'serviceUuids16';
    const chipsHost = el('div.uuid-chips');
    const renderChips = () => {
      clear(chipsHost);
      chipsHost.append(chipList({
        items: adv()[key] || [],
        label: (u) => `${uuid16Name(u) ? uuid16Name(u) + ' · ' : ''}${hex16(u)}`,
        onRemove: (u) => { store.update((s) => { s.advertiser[key] = s.advertiser[key].filter((x) => x !== u); }); renderChips(); },
      }));
    };
    const addUuid16 = (v) => {
      if (v == null || (adv()[key] || []).includes(v)) { combo.setValue(null); return; }
      store.update((s) => { s.advertiser[key] = [...(s.advertiser[key] || []), v]; });
      combo.setValue(null); renderChips();
    };
    const combo = searchSelect({
      options: Object.entries(SERVICE_UUID16).map(([k, n]) => [Number(k), n]), // object keys are base-10 strings
      value: null, placeholder: 'search service or 0x180F', onChange: (v) => addUuid16(v),
    });
    const addBtn = el('button.btn.btn-sm', { type: 'button', text: '+ Add',
      on: { click: () => { const v = combo.resolve(combo.input.value); if (typeof v === 'number') addUuid16(v); else if (v === undefined) combo.input.classList.add('invalid'); } } });
    combo.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
    renderChips();
    return el('div.inline-editor.col', {},
      el('div.uuid-add', {}, combo, addBtn,
        slot === 'scan' ? null : el('span.mode-wrap', {}, el('span.mode-label', { text: 'list' }), modeSelect(() => adv().uuids16Mode, (v) => { adv().uuids16Mode = v; }, UUID_MODES))),
      chipsHost);
  }
  function uuid128Editor(slot) {
    const key = slot === 'scan' ? 'serviceUuids128Scan' : 'serviceUuids128';
    return el('div.inline-editor.col', {},
      el('textarea', {
        rows: 2, value: (adv()[key] || []).join('\n'), placeholder: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
        on: { change: set((v) => { adv()[key] = v.split(/\n+/).map((s) => s.trim()).filter(Boolean); }) },
      }),
      slot === 'scan' ? null : el('div.uuid-add', {}, el('span.mode-label', { text: 'list' }), modeSelect(() => adv().uuids128Mode, (v) => { adv().uuids128Mode = v; }, UUID_MODES)));
  }
  function txPowerEditor() { return el('span.muted', { text: 'uses the controller advertising Tx power' }); }
  function manufacturerEditor() {
    const cur = adv().manufacturer;
    const companyInput = el('input.mfr-company', { type: 'text', value: cur ? cur.company.toString(16).padStart(4, '0') : '02e5', placeholder: '02E5' });
    const dataInput = restrictHexBytes(el('input', { type: 'text', value: cur ? cur.dataHex : '', placeholder: 'hex bytes e.g. 02 1A FF' }));
    const sync = () => { store.update((s) => { s.advertiser.manufacturer = { company: parseInt(companyInput.value, 16) || 0, dataHex: dataInput.value.trim() }; }); };
    companyInput.addEventListener('change', sync);
    dataInput.addEventListener('change', sync);
    const sel = el('select.swift-sel', {}, ...SWIFT_PAIR_PRESETS.map((p, i) => el('option', { value: String(i), text: p.label })));
    const apply = el('button.btn.btn-sm', { type: 'button', text: 'Swift Pair', on: { click: () => applySwiftPair(SWIFT_PAIR_PRESETS[parseInt(sel.value, 10) || 0]) } });
    return el('div.inline-editor.col', {},
      el('div.uuid-add', {}, field('Company', companyInput), field('Data (hex)', dataInput)),
      el('div.uuid-add', {}, el('span.field-label', { text: 'Swift Pair:' }), sel, apply));
  }

  // Service Data: a list of { uuid, dataHex } blocks; the AD type (0x16/0x20/0x21) follows the UUID
  // width (4/8/32 hex). The host builder validates the width, so we just collect text here.
  function serviceDataEditor() {
    const host = el('div.inline-editor.col');
    const renderRows = () => {
      clear(host);
      const list = adv().serviceData || [];
      list.forEach((sd, i) => {
        const uuid = el('input.sd-uuid', { type: 'text', value: sd.uuid || '', placeholder: 'FEAA / 128-bit' });
        const data = restrictHexBytes(el('input', { type: 'text', value: sd.dataHex || '', placeholder: 'hex bytes e.g. 02 1A' }));
        const sync = () => { store.update((s) => { s.advertiser.serviceData[i] = { uuid: uuid.value.trim(), dataHex: data.value.trim() }; }); };
        uuid.addEventListener('change', sync); data.addEventListener('change', sync);
        const rm = el('button.btn.btn-sm', { type: 'button', text: '✕', on: { click: () => { store.update((s) => { s.advertiser.serviceData = s.advertiser.serviceData.filter((_, j) => j !== i); }); renderRows(); } } });
        host.append(el('div.uuid-add', {}, field('UUID', uuid), field('Data (hex)', data), rm));
      });
      host.append(el('button.btn.btn-sm', { type: 'button', text: '+ Add service data',
        on: { click: () => { store.update((s) => { s.advertiser.serviceData = [...(s.advertiser.serviceData || []), { uuid: '', dataHex: '' }]; }); renderRows(); } } }));
    };
    renderRows();
    return host;
  }

  // ordered field list (flags first, name last in the emitted payload — see buildStructures).
  // `dual` fields can carry a distinct value per PDU (a second editor appears when placed in Both).
  const FIELDS = [
    { key: 'flags', label: 'Flags', editor: flagsEditor },
    { key: 'uuids16', label: '16-bit Service UUIDs', editor: uuid16Editor, dual: true },
    { key: 'uuids128', label: '128-bit Service UUIDs', editor: uuid128Editor, dual: true },
    { key: 'appearance', label: 'Appearance', editor: appearanceEditor },
    { key: 'txPower', label: 'Tx Power Level', editor: txPowerEditor },
    { key: 'manufacturer', label: 'Manufacturer Data', editor: manufacturerEditor },
    { key: 'serviceData', label: 'Service Data', editor: serviceDataEditor },
    { key: 'name', label: 'Local Name', editor: nameEditor, dual: true },
  ];

  function placementControl(key) {
    const cur = adv().placement[key] || 'off';
    return el('div.seg-group', { attrs: { role: 'group', 'aria-label': 'placement' } },
      ...PLACEMENTS.map(([val, lbl]) => el('button', {
        type: 'button', text: lbl, class: 'seg' + (cur === val ? ' active' : ''),
        on: { click: () => setPlacement(key, val) },
      })));
  }

  function fieldRow(f) {
    // A dual field placed in Both shows separate adv + scan-response value editors.
    const body = (f.dual && adv().placement[f.key] === 'both')
      ? el('div.dual-editor', {},
        el('div.slot', {}, el('span.slot-tag', { text: 'Adv' }), f.editor('adv')),
        el('div.slot', {}, el('span.slot-tag', { text: 'Scan' }), f.editor('scan')))
      : f.editor('adv');
    return el('div.field-row', { dataset: { field: f.key } },
      el('div.field-main', {}, applyHelp(el('span.field-name', {}, f.label), 'adv.' + f.key), body),
      placementControl(f.key));
  }

  function advTypeSelect() {
    return el('select', { on: { change: set((v) => { adv().advType = v; }) } },
      ...Object.entries(ADV_TYPE_LABELS).map(([val, label]) => el('option', { value: val, selected: adv().advType === val, text: label, attrs: { title: optHelp('advType.' + val) } })));
  }
  function ownAddrSelect() {
    return el('select', { on: { change: set((v) => { adv().ownAddressType = v; }) } },
      el('option', { value: 'public', selected: adv().ownAddressType === 'public', text: 'Public', attrs: { title: optHelp('ownAddr.public') } }),
      el('option', { value: 'random', selected: adv().ownAddressType === 'random', text: 'Random (static)', attrs: { title: optHelp('ownAddr.random') } }));
  }
  function chanCheck(label, bit) {
    return check('ch ' + label, () => (adv().channelMap & bit) !== 0, (v) => { adv().channelMap = v ? adv().channelMap | bit : adv().channelMap & ~bit; });
  }

  // Reset the advertising data + scan response (payload content + placement) to defaults, leaving the
  // advertising parameters (type, interval, address, mode) untouched.
  function resetAdvData() {
    const def = initialState().advertiser;
    const KEYS = ['flags', 'name', 'nameScan', 'nameMode', 'appearance', 'serviceUuids16', 'serviceUuids16Scan',
      'uuids16Mode', 'serviceUuids128', 'serviceUuids128Scan', 'uuids128Mode', 'manufacturer', 'serviceData',
      'extraAdHex', 'scanRespExtraHex'];
    store.update((s) => {
      for (const k of KEYS) s.advertiser[k] = structuredClone(def[k]);
      s.advertiser.placement = { ...def.placement };
    });
    rebuildForm();
  }

  // A beacon button opens a modal of its editable fields; Apply runs build(values) (the encoders
  // throw on bad input, surfaced inline) then applies the resulting config.
  function openBeaconModal(preset) {
    const inputs = {};
    const errLine = el('div.io-status.io-err', { style: { display: 'none' } });
    const rows = preset.fields.map((f) => {
      const input = el('input', { type: f.type || 'text', value: String(f.default) });
      inputs[f.key] = input;
      return field(f.label, input, f.hint);
    });
    openModal({
      title: `Customize ${preset.label}`,
      width: '460px',
      content: el('div.modal-form', {}, ...rows, errLine),
      actions: [
        { label: 'Cancel', onClick: (c) => c() },
        { label: 'Apply', kind: 'primary', onClick: (c) => {
          const values = {};
          for (const f of preset.fields) values[f.key] = inputs[f.key].value.trim();
          try { store.update(preset.build(values)); rebuildForm(); c(); }
          catch (e) { errLine.textContent = '✗ ' + e.message; errLine.style.display = 'block'; }
        } },
      ],
    });
  }

  // Extended-advertising controls (mode + PHY/SID/duration). Gated on the connected controller's
  // reported capabilities; PHY options that aren't supported are hidden.
  function extendedCard() {
    const caps = store.state.controller.caps || {};
    const ready = store.state.controller.ready;
    const supported = caps.extendedAdvertising;
    const modeSel = el('select', { disabled: !supported, on: { change: (e) => { store.update((s) => { s.advertiser.mode = e.target.value; }); rebuildForm(); } } },
      el('option', { value: 'legacy', selected: adv().mode === 'legacy', text: 'Legacy (≤31 B)' }),
      el('option', { value: 'extended', selected: adv().mode === 'extended', text: 'Extended' }));
    const head = el('div.row', {}, field('Mode', modeSel, null, 'adv.mode'),
      !ready ? el('span.field-hint', { text: 'connect a controller to detect extended support' })
        : !supported ? el('span.field-hint', { text: 'controller is BLE 4.2-class — extended not supported' }) : null);
    if (adv().mode !== 'extended' || !supported) {
      return el('div.card', {}, el('h3', { text: 'Extended Advertising' }), head);
    }
    const primPhy = el('select', { on: { change: set((v) => { adv().primaryPhy = v; }) } },
      el('option', { value: '1M', selected: adv().primaryPhy === '1M', text: '1M' }),
      caps.leCodedPhy ? el('option', { value: 'Coded', selected: adv().primaryPhy === 'Coded', text: 'Coded' }) : null);
    const secPhy = el('select', { on: { change: set((v) => { adv().secondaryPhy = v; }) } },
      el('option', { value: '1M', selected: adv().secondaryPhy === '1M', text: '1M' }),
      caps.le2mPhy ? el('option', { value: '2M', selected: adv().secondaryPhy === '2M', text: '2M' }) : null,
      caps.leCodedPhy ? el('option', { value: 'Coded', selected: adv().secondaryPhy === 'Coded', text: 'Coded' }) : null);
    const sid = el('input', { type: 'number', value: adv().advSid, attrs: { min: 0, max: 15 }, style: { width: '4rem' },
      on: { change: set((v) => { adv().advSid = Math.max(0, Math.min(15, parseInt(v, 10) || 0)); }) } });
    const dur = el('input', { type: 'number', value: adv().advDuration, attrs: { min: 0, step: 10 }, style: { width: '6rem' },
      on: { change: set((v) => { adv().advDuration = Math.max(0, parseInt(v, 10) || 0); }) } });
    const maxEv = el('input', { type: 'number', value: adv().advMaxEvents, attrs: { min: 0, max: 255 }, style: { width: '5rem' },
      on: { change: set((v) => { adv().advMaxEvents = Math.max(0, Math.min(255, parseInt(v, 10) || 0)); }) } });
    return el('div.card', {}, el('h3', { text: 'Extended Advertising' }), head,
      el('div.row', {}, field('Primary PHY', primPhy, null, 'adv.primaryPhy'), field('Secondary PHY', secPhy, null, 'adv.secondaryPhy'), field('SID', sid, null, 'adv.sid')),
      el('div.row', {}, field('Duration', dur, 'ms (0 = ∞)', 'adv.duration'), field('Max events', maxEv, '0 = ∞', 'adv.maxEvents')),
      el('span.field-hint', { text: 'extended lifts the 31-byte cap to the controller’s max and enables PHY selection.' }));
  }

  // Raw AD structures appended verbatim per PDU (advanced) — covers AD types without a dedicated
  // editor (URI, 32-bit UUIDs, solicitation, LE Role, target address…). Bytes are full [len][type][value].
  function rawCard() {
    const mk = (key) => restrictHexBytes(el('textarea.raw-ad', { rows: 2, value: adv()[key] || '', placeholder: '02 01 06 …',
      on: { change: set((v) => { adv()[key] = v.trim(); }) } }));
    return el('div.card', {}, el('h3', { text: 'Raw / advanced AD' }),
      el('span.field-hint', { text: 'raw AD structures (hex, full [length][type][value]) appended to each PDU verbatim.' }),
      field('Advertising data', mk('extraAdHex'), null, 'adv.rawAdv'),
      field('Scan response', mk('scanRespExtraHex'), null, 'adv.rawScan'));
  }

  // ---- form (rebuilt on placement/preset changes so the segmented controls reflect the store) ----
  function buildForm() {
    const presets = el('div.card.adv-presets', {}, el('h3', { text: 'Quick fill' }),
      el('div.preset-row', {},
        el('button.btn.btn-sm', { type: 'button', text: 'Default', attrs: { title: 'Reset advertising data + scan response to defaults' }, on: { click: resetAdvData } }),
        ...ADV_PRESETS.map((p) => el('button.btn.btn-sm', { type: 'button', text: p.label, on: { click: () => applyDevicePreset(p.set) } }))),
      el('div.preset-row', {}, el('span.field-label', { text: 'Beacons:' }), ...BEACON_PRESETS.map((p) => el('button.btn.btn-sm', { type: 'button', text: p.label + '…', on: { click: () => openBeaconModal(p) } }))),
      el('span.field-hint', { text: 'sets name, appearance, services & flags for a typical device — tweak afterwards' }));

    const fields = el('div.card.fields-card', {}, el('h3', { text: 'Payload Fields' }),
      el('span.field-hint', { text: 'set each field to Off / Adv (advertising data) / Scan (scan response) / Both' }),
      el('div.field-list', {}, ...FIELDS.map(fieldRow)));

    const randAddr = addrInput(() => adv().randomAddress, (v) => { adv().randomAddress = v; }, 'C0:DE:CA:FE:00:01');
    const setAddr = (a) => { randAddr.value = a; store.update((s) => { s.advertiser.ownAddressType = 'random'; s.advertiser.randomAddress = a; }); };
    const randRefresh = el('button.btn.btn-sm', { type: 'button', text: '⟳', attrs: { title: 'New random static address' }, on: { click: () => setAddr(randomStaticAddr()) } });
    const nrpaBtn = el('button.btn.btn-sm', { type: 'button', text: 'NRPA', attrs: { title: 'Non-resolvable private address' }, on: { click: () => setAddr(randomNrpaAddr()) } });
    const rpaBtn = el('button.btn.btn-sm', { type: 'button', text: 'RPA', attrs: { title: 'Resolvable private address (privacy, from a local IRK)' },
      on: { click: async () => { try { const { rpa } = await conn.enablePrivacy(); randAddr.value = rpa; rebuildForm(); } catch (e) { console.error(e); } } } });
    const params = el('div.card', {}, el('h3', { text: 'Advertising Parameters' }),
      field('Type', advTypeSelect(), null, 'adv.type'),
      el('div.row', {}, msField('Interval min', 'intervalMin', 'adv.intervalMin'), msField('Interval max', 'intervalMax', 'adv.intervalMax')),
      el('div.row', {}, field('Own address type', ownAddrSelect(), null, 'adv.ownAddress'),
        field('Random address', el('span.addr-field', {}, randAddr, randRefresh, nrpaBtn, conn ? rpaBtn : null), null, 'adv.randomAddress')),
      el('div.subrow', {}, applyHelp(el('span.field-label', {}, 'Channels'), 'adv.channels'), chanCheck('37', 0x01), chanCheck('38', 0x02), chanCheck('39', 0x04)),
      el('div.subrow', {}, check('Re-advertise after disconnect', () => adv().autoReadvertise, (v) => { adv().autoReadvertise = v; })),
      el('div.row', {}, field('Peer address (directed)', addrInput(() => adv().peerAddress, (v) => { adv().peerAddress = v; }, '00:00:00:00:00:00'), null, 'adv.peerAddress')));

    return el('div.adv-form', {}, presets, fields, params, extendedCard(), rawCard());
  }

  const formHost = el('div.adv-form-host');
  function rebuildForm() { clear(formHost); formHost.append(buildForm()); }

  // ---- Import / Export: advertising + scan-response data as one JSON (Len/Type/Value, hex). ----
  function setIoStatus(node, msg, isErr) { node.textContent = msg; node.classList.toggle('io-err', !!isErr); }

  function applyImport(doc, status) {
    const { advBytes, scanBytes } = parseAdImport(doc);
    // The imported file is authoritative: emit its raw AD structures verbatim and switch every
    // structured field off, so the on-air payload is exactly what was imported (a perfect round-trip).
    store.update((s) => {
      for (const k of Object.keys(s.advertiser.placement)) s.advertiser.placement[k] = 'off';
      s.advertiser.extraAdHex = bytesToHex(advBytes, '');
      s.advertiser.scanRespExtraHex = bytesToHex(scanBytes, '');
    });
    rebuildForm(); // reflect placements→Off in the segmented controls (preview updates via subscribe)
    setIoStatus(status, `✓ imported ${advBytes.length}-byte adv + ${scanBytes.length}-byte scan-rsp payload`, false);
  }

  function buildIoBar() {
    const status = el('span.io-status.muted', {});
    const fileInput = el('input', { type: 'file', attrs: { accept: '.json,application/json' }, style: { display: 'none' } });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // allow re-importing the same file
      if (!f) return;
      try { applyImport(JSON.parse(await f.text()), status); }
      catch (e) { setIoStatus(status, '✗ ' + e.message, true); }
    });
    const exportBtn = el('button.btn.btn-sm', { type: 'button', text: '⬇ Export JSON', on: { click: () => {
      try {
        const a = computeAdv(store.state);
        downloadJson(buildAdExport(a.advBytes, a.scanBytes), 'advertising.json');
        setIoStatus(status, `exported ${a.advParsed.length} adv + ${a.scanParsed.length} scan-rsp structures`, false);
      } catch (e) { setIoStatus(status, '✗ ' + e.message, true); }
    } } });
    const importBtn = el('button.btn.btn-sm', { type: 'button', text: '⬆ Import JSON', on: { click: () => fileInput.click() } });
    return el('div.card.adv-io', {},
      el('h3', { text: 'Import / Export' }),
      el('span.field-hint', { text: 'Advertising + scan-response data as one JSON (Length/Type/Value, hex, with comments). Import replaces the payload with the file’s raw AD structures.' }),
      el('div.io-row', {}, exportBtn, importBtn, fileInput, status));
  }

  // ---- live preview: two PDU columns + combined budget + advertiser warnings. ----
  const preview = el('div.adv-preview');

  function renderPreview() {
    clear(preview);
    let a;
    try { a = computeAdv(store.state); } catch (e) { preview.append(el('div.error-box', { text: e.message })); return; }
    const max = a.perPduMax;
    const total = a.advBytes.length + a.scanBytes.length;
    const over = a.advBytes.length > max || a.scanBytes.length > max;
    preview.append(
      el('div.pdu-cols', {},
        payloadView('Advertising Data', a.advBytes, a.advParsed, null, max),
        payloadView('Scan Response', a.scanBytes, a.scanParsed, a.scannable ? null : 'Not sent — this advertising type is not scannable.', max)),
      el('div.combined-budget' + (over ? '.over' : ''), {}, el('span', { text: `${a.extended ? 'Extended' : 'Legacy'} · ${max} B/PDU · combined ${total} bytes` })),
      warningsView());
  }

  function warningsView() {
    const ws = (store.state.warnings || []).filter((x) => x.source === 'advertiser');
    return el('div.adv-warnings', {}, ...ws.map((x) => el('div', { class: 'adv-warn ' + x.level },
      el('span.wtag', { text: x.level === 'error' ? 'ERROR' : 'WARN' }), el('span', { text: x.msg }))));
  }

  // Colored hex dump: per AD structure (TLV), the length byte is green, the type byte orange, and the
  // value bytes keep the default accent color. Trailing bytes not covered by a structure (e.g. padding)
  // render plain.
  function hexDumpEl(bytes, parsed) {
    if (!bytes.length) return el('div.hexdump', { text: '(empty)' });
    const hx = (b) => b.toString(16).padStart(2, '0');
    const dump = el('div.hexdump');
    const sp = () => document.createTextNode(' ');
    let consumed = 0;
    parsed.forEach((s, i) => {
      if (i) dump.append(sp());
      dump.append(el('span.hb-len', { text: hx(s.data.length + 1) }), sp(), el('span.hb-type', { text: hx(s.type) }));
      if (s.data.length) dump.append(sp(), document.createTextNode(bytesToHex(s.data)));
      consumed += s.data.length + 2;
    });
    if (consumed < bytes.length) dump.append(sp(), document.createTextNode(bytesToHex(bytes.slice(consumed))));
    return dump;
  }

  function payloadView(title, bytes, parsed, note, max = 31) {
    const over = bytes.length > max;
    const pct = Math.min(100, (bytes.length / max) * 100);
    return el('div.card', {},
      el('h3', { text: title }),
      el('div.budget', {}, el('div', { class: 'budget-bar ' + (over ? 'over' : ''), style: { width: pct + '%' } }),
        el('span.budget-label', { text: `${bytes.length} / ${max} bytes` })),
      note ? el('div.pdu-note', { text: note }) : null,
      hexDumpEl(bytes, parsed),
      el('table.ad-table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Len' }), el('th', { text: 'Type' }), el('th', { text: 'Value' }))),
        el('tbody', {}, ...parsed.map((s) => el('tr', {},
          el('td', { text: s.data.length + 1 }),
          el('td', { text: `${s.typeName} (0x${s.type.toString(16).padStart(2, '0')})` }),
          el('td', { text: String(s.decoded) }))))));
  }

  root.append(el('div.adv-layout', {}, formHost, el('div.adv-right', {}, buildIoBar(), preview)));
  rebuildForm();
  renderPreview();
  // The form's extended-advertising / PHY controls are gated on controller capabilities, which arrive
  // asynchronously (bring-up on connect). renderPreview alone wouldn't refresh them, so also rebuild the
  // form when the capability signature changes — a discrete connect/disconnect event, not while typing.
  const capSig = () => {
    const c = store.state.controller, caps = c.caps || {};
    return JSON.stringify([c.ready, caps.extendedAdvertising, caps.le2mPhy, caps.leCodedPhy, c.maxAdvDataLen]);
  };
  let lastCapSig = capSig();
  store.subscribe(() => {
    renderPreview();
    const sig = capSig();
    if (sig !== lastCapSig) { lastCapSig = sig; rebuildForm(); }
  });
  return { id: 'advertiser', title: 'Advertiser', el: root };
}

// ---- helpers ----
/** Trigger a browser download of `obj` (stamped with site + version) as pretty-printed JSON. */
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(stampExport(obj), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const clampInterval = (u) => Math.max(0x20, Math.min(0x4000, u));
const hex16 = (u) => `0x${u.toString(16).padStart(4, '0').toUpperCase()}`;

// "AA:BB:CC:DD:EE:FF" formatter — hex only, ":" auto-inserted every 2 digits, max 6 octets.
const fmtAddr = (raw) => ((raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 12).match(/.{1,2}/g) || []).join(':');

/** BT address text field: hex-restricted, auto-colons, caret-preserving. get()/put() bind the store. */
function addrInput(get, put, placeholder) {
  const input = el('input.addr-input', { type: 'text', value: fmtAddr(get()), placeholder, attrs: { maxlength: 17, spellcheck: 'false', autocomplete: 'off' } });
  input.addEventListener('input', () => {
    const before = input.value.slice(0, input.selectionStart).replace(/[^0-9a-fA-F]/g, '').length;
    input.value = fmtAddr(input.value);
    let pos = 0, seen = 0;
    while (pos < input.value.length && seen < before) { if (input.value[pos] !== ':') seen++; pos++; }
    if (input.value[pos] === ':') pos++;
    input.setSelectionRange(pos, pos);
  });
  input.addEventListener('change', () => { input.value = fmtAddr(input.value); put(input.value); });
  return input;
}

/** A random *static* address (two MSBs of the most-significant octet = 0b11). */
function randomStaticAddr() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  b[0] |= 0xc0;
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

/** A non-resolvable private address (two MSBs of the most-significant octet = 0b00). */
function randomNrpaAddr() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  b[0] &= 0x3f;
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
