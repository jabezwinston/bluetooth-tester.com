// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Live HCI packet log with PCAPNG export.

import { el, clear } from '../dom.js';
import { summarize, hexOf, details } from '../../log/decode.js';
import { downloadPcapng, pcapngMetaFromState, shortUserAgent } from '../../log/pcapng.js';
import { downloadSession } from '../../host/session-export.js';
import { H4 } from '../../transport/h4.js';

const MAX_ROWS = 600;

const FILTERS = {
  all: () => true,
  cmd: (e) => e.h4 === H4.COMMAND,
  evt: (e) => e.h4 === H4.EVENT,
  acl: (e) => e.h4 === H4.ACL || e.h4 === H4.ISO,
};

export function createLogPanel({ store, log, notices }) {
  const root = el('div.panel-body.log-panel');
  const list = el('div.log-list');
  let atBottom = true;
  list.addEventListener('scroll', () => {
    atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
  });

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function renderList() {
    if (store.state.log.paused) return;
    const filter = FILTERS[store.state.log.filter] || FILTERS.all;
    const entries = log.entries.filter(filter).slice(-MAX_ROWS);
    clear(list);
    for (const e of entries) {
      const row = el('div', { class: 'log-row ' + (e.dir === 'tx' ? 'tx' : 'rx') },
        el('span.log-seq', { text: e.seq }),
        el('span.log-time', { text: fmtTime(e.ts) }),
        el('span.log-dir', { text: e.dir === 'tx' ? '▶ TX' : '◀ RX' }),
        el('span.log-summary', { text: summarize(e) }),
      );
      const detail = el('div.log-detail', { style: { display: 'none' } });
      let built = false;
      row.addEventListener('click', () => {
        if (!built) { built = true; buildDetail(detail, e); }
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
      });
      list.append(row, detail);
    }
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // Wireshark-style protocol tree + raw hex, built lazily when a row is first expanded.
  function buildDetail(container, e) {
    for (const g of details(e)) {
      container.append(el('div.det-group', {},
        el('div.det-group-name', { text: g.name }),
        ...g.fields.map((fl) => el('div.det-field', {},
          el('span.det-k', { text: fl.name }),
          el('span.det-v', { text: fl.value }))),
      ));
    }
    container.append(el('div.log-hex', { text: hexOf(e) }));
  }

  function renderToolbar() {
    clear(toolbar);
    const lg = store.state.log;
    toolbar.append(
      el('button.btn', { text: lg.paused ? '▶ Resume' : '⏸ Pause', on: { click: () => { store.update((s) => { s.log.paused = !s.log.paused; }); renderList(); } } }),
      el('button.btn', { text: 'Clear', on: { click: () => log.clear() } }),
      el('label.inline', {}, 'Filter ', el('select', {
        on: { change: (e) => { store.update((s) => { s.log.filter = e.target.value; }); renderList(); } },
      },
        ...['all', 'cmd', 'evt', 'acl'].map((f) => el('option', { value: f, selected: lg.filter === f, text: f })))),
      el('span.spacer', {}),
      el('span.muted', { text: `${log.entries.length} packets` }),
      el('button.btn', { text: '⬇ Export session (.zip)', attrs: { title: 'Bundle adv/scan, GATT (client+server), SMP info and the HCI log as a .zip' }, on: { click: () => downloadSession({ store, log }) } }),
      el('button.btn.primary', { text: '⬇ Export PCAPNG', on: { click: () => downloadPcapng(log.entries, undefined, pcapngMetaFromState(store.state, { os: shortUserAgent(navigator.userAgent) })) } }),
    );
  }

  // ---- Notices & warnings record (the permanent home for the bottom-right toasts) ----
  const noticeList = el('div.log-notices-list');
  function renderNotices() {
    clear(noticeList);
    const entries = notices?.entries || [];
    if (!entries.length) { noticeList.append(el('div.muted', { text: 'No notices or warnings.' })); return; }
    for (const e of entries.slice().reverse()) { // newest first
      noticeList.append(el('div', { class: 'warning ' + e.level },
        el('span.log-time', { text: fmtTime(e.ts) }),
        el('span.wtag', { text: e.level === 'error' ? 'ERROR' : e.level === 'info' ? 'INFO' : 'WARN' }),
        el('span', { text: e.msg + (e.source ? `  ·  ${e.source}` : '') })));
    }
  }
  const noticeSection = el('div.log-notices', {},
    el('div.log-notices-head', {},
      el('span', { text: 'Notices & warnings' }),
      el('span.spacer', {}),
      el('button.btn.btn-sm', { text: 'Clear', on: { click: () => notices?.clear() } })),
    noticeList);

  const toolbar = el('div.log-toolbar');
  root.append(toolbar, list, noticeSection);
  renderToolbar();
  renderList();
  renderNotices();
  log.subscribe(() => { renderToolbar(); renderList(); });
  store.subscribe(renderToolbar);
  notices?.subscribe(renderNotices);

  return { id: 'log', title: 'Logs', el: root };
}
