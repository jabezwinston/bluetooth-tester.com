// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder run-mode runtime: builds the sandboxed iframe document that hosts the live widgets and
// the user's script. The iframe runs with sandbox="allow-scripts" (opaque origin — no access to
// the parent, store, or transport) and a CSP of default-src 'none' (so user code can't reach the
// network). All BLE is proxied to the parent over postMessage (see bridge.js). This module is
// pure (no DOM access at import time — `shimMain` is only stringified, never called here), so the
// srcdoc/codegen helpers are unit-testable in Node.

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'";

const RUN_CSS = `
  body { margin: 0; background: #0f1419; color: #d7dde5; font: 14px system-ui, sans-serif; }
  #stage { position: relative; width: 100%; height: 100vh; }
  .rw { position: absolute; }
  .rw-led { width: 34px; height: 34px; border-radius: 50%; border: 2px solid #8b97a7; background: transparent; transition: box-shadow .1s, background .1s; }
  .rw-cap { font-size: 12px; color: #8b97a7; text-align: center; margin-top: 4px; }
  .rw-btn { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 10px; background: #1d2530; color: #d7dde5; border: 1px solid #2a333f; border-radius: 8px; cursor: pointer; }
  .rw-btn:active { background: #2d7dd2; }
  .rw-emoji { font-size: 23px; line-height: 1; }
  .rw-slider { width: 150px; vertical-align: middle; }
  .rw-val { font: 12px monospace; color: #4aa8ff; margin-left: 8px; }
  .rw-disp { display: inline-grid; gap: 1px; background: #0a1f0a; border: 2px solid #143a14; border-radius: 4px; padding: 4px; }
  .rw-cell { font: 16px/1.15 monospace; color: #7CFC00; text-align: center; width: 1ch; white-space: pre; text-shadow: 0 0 4px rgba(124,252,0,.6); }
`;

// Runs INSIDE the sandboxed iframe. Self-contained (no imports/closures) so it survives
// Function#toString → inline <script>. Builds widgets from window.__BTDATA, exposes widget()/bt()/
// log(), captures console + errors, and bridges to the parent via postMessage.
function shimMain() {
  var D = window.__BTDATA || { widgets: [] };
  var stage = document.getElementById('stage');
  var reg = {}, byName = {};
  var pendReq = {}, seq = 1, writeCbs = {}, peerCbs = {}, connCbs = [], discCbs = [];
  function req(op, extra) {
    return new Promise(function (res, rej) {
      var id = seq++; pendReq[id] = { res: res, rej: rej };
      var msg = { type: 'bt', op: op, id: id }; if (extra) { for (var k in extra) msg[k] = extra[k]; }
      post(msg);
    });
  }

  function post(m) { try { m.__bt = 1; parent.postMessage(m, '*'); } catch (e) { /* parent gone */ } }
  function err(e) { post({ type: 'console', level: 'error', args: [String((e && e.message) || e)] }); }
  function norm(u) { return String(u).toUpperCase(); }
  function toArr(b) { return b && b.length != null ? [].slice.call(b) : []; }
  function mk(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function build(w) {
    var p = w.props || {};
    var box = mk('div', 'rw'); box.style.left = (w.x || 0) + 'px'; box.style.top = (w.y || 0) + 'px';
    var api = { id: w.id, name: w.name || w.id, type: w.type, el: box };
    if (w.type === 'led') {
      var dot = mk('div', 'rw-led'), color = p.color || '#ff3b30', on = !!p.on;
      dot.style.borderColor = color;
      var paint = function () { dot.style.background = on ? color : 'transparent'; dot.style.boxShadow = on ? '0 0 12px ' + color : 'none'; };
      paint(); box.appendChild(dot); if (p.label) box.appendChild(mk('div', 'rw-cap', p.label));
      api.on = function () { on = true; paint(); }; api.off = function () { on = false; paint(); };
      api.set = function (v) { on = !!v; paint(); }; api.toggle = function () { on = !on; paint(); };
      api.color = function (c) { color = c; paint(); };
    } else if (w.type === 'button') {
      var b = mk('button', 'rw-btn'); b.appendChild(mk('span', 'rw-emoji', p.emoji || '🔘'));
      if (p.text) b.appendChild(mk('span', 'rw-cap', p.text));
      var pcbs = []; b.addEventListener('click', function () { for (var i = 0; i < pcbs.length; i++) { try { pcbs[i](); } catch (e) { err(e); } } });
      box.appendChild(b);
      api.onPress = function (f) { pcbs.push(f); }; api.press = function () { b.click(); };
      api.label = function (x) { b.firstChild.textContent = x; };
    } else if (w.type === 'slider') {
      var i = document.createElement('input'); i.type = 'range'; i.className = 'rw-slider';
      i.min = p.min != null ? p.min : 0; i.max = p.max != null ? p.max : 255; i.value = p.value != null ? p.value : 0;
      var out = mk('span', 'rw-val', String(i.value)), scbs = [];
      i.addEventListener('input', function () { out.textContent = i.value; var v = Number(i.value); for (var k = 0; k < scbs.length; k++) { try { scbs[k](v); } catch (e) { err(e); } } });
      box.appendChild(i); box.appendChild(out);
      api.value = function () { return Number(i.value); }; api.set = function (v) { i.value = v; out.textContent = String(v); };
      api.onChange = function (f) { scbs.push(f); };
    } else if (w.type === 'display') {
      var g = mk('div', 'rw-disp');
      var rows = Math.max(1, Math.min(8, (p.rows | 0) || 1)), cols = Math.max(1, Math.min(40, (p.cols | 0) || 1));
      g.style.gridTemplateColumns = 'repeat(' + cols + ', 1ch)';
      var paintText = function (t) {
        g.innerHTML = ''; var lines = String(t == null ? '' : t).split('\n');
        for (var r = 0; r < rows; r++) { var line = lines[r] || ''; for (var c = 0; c < cols; c++) g.appendChild(mk('span', 'rw-cell', line[c] || ' ')); }
      };
      paintText(p.text || ''); box.appendChild(g);
      api.print = function (t) { paintText(t); }; api.text = function (t) { paintText(t); }; api.clear = function () { paintText(''); };
    }
    reg[w.id] = api; if (w.name) byName[w.name] = api;
    stage.appendChild(box);
  }

  (D.widgets || []).forEach(build);

  window.widget = function (k) { return byName[k] || reg[k] || null; };
  window.log = function () { post({ type: 'console', level: 'log', args: [].slice.call(arguments).map(String) }); };
  ['log', 'warn', 'error'].forEach(function (lvl) {
    var orig = console[lvl];
    console[lvl] = function () { post({ type: 'console', level: lvl, args: [].slice.call(arguments).map(String) }); try { orig.apply(console, arguments); } catch (e) { /* noop */ } };
  });
  window.addEventListener('error', function (ev) { post({ type: 'console', level: 'error', args: ['Uncaught: ' + (ev.message || ev.error)] }); });

  window.bt = {
    // our GATT server (the central reads/writes us)
    notify: function (uuid, bytes, reportId) { var m = { type: 'bt', op: 'notify', uuid: uuid, bytes: toArr(bytes) }; if (reportId != null) m.reportId = reportId; post(m); },
    setValue: function (uuid, bytes) { post({ type: 'bt', op: 'setValue', uuid: uuid, bytes: toArr(bytes) }); },
    read: function (uuid) { return req('read', { uuid: uuid }).then(function (r) { return new Uint8Array(r.bytes || []); }); },
    onWrite: function (uuid, cb) { (writeCbs[norm(uuid)] = writeCbs[norm(uuid)] || []).push(cb); post({ type: 'bt', op: 'subscribeWrite', uuid: uuid }); },
    onConnect: function (cb) { connCbs.push(cb); }, onDisconnect: function (cb) { discCbs.push(cb); },
    // the connected central's GATT server (we are the client — e.g. Windows 11's media service)
    peer: {
      discover: function () { return req('peerDiscover'); },
      read: function (uuid) { return req('peerRead', { uuid: uuid }).then(function (r) { return new Uint8Array(r.bytes || []); }); },
      write: function (uuid, bytes, withResponse) { return req('peerWrite', { uuid: uuid, bytes: toArr(bytes), withResponse: withResponse !== false }); },
      subscribe: function (uuid, cb) { (peerCbs[norm(uuid)] = peerCbs[norm(uuid)] || []).push(cb); return req('peerSubscribe', { uuid: uuid }); },
    },
  };

  window.addEventListener('message', function (ev) {
    var m = ev.data; if (!m || !m.__bt) return;
    if (m.type === 'reply' && pendReq[m.id]) { var pr = pendReq[m.id]; delete pendReq[m.id]; if (m.error) pr.rej(new Error(m.error)); else pr.res(m); }
    else if (m.type === 'peerNotify') { var pcbs = peerCbs[norm(m.uuid)] || []; for (var z = 0; z < pcbs.length; z++) { try { pcbs[z]((m.bytes || []).slice()); } catch (e) { err(e); } } }
    else if (m.type === 'charWrite') { var cbs = writeCbs[norm(m.uuid)] || []; for (var i = 0; i < cbs.length; i++) { try { cbs[i]((m.bytes || []).slice()); } catch (e) { err(e); } } }
    else if (m.type === 'connect') { for (var j = 0; j < connCbs.length; j++) { try { connCbs[j](m.info || {}); } catch (e) { err(e); } } }
    else if (m.type === 'disconnect') { for (var k = 0; k < discCbs.length; k++) { try { discCbs[k](m.info || {}); } catch (e) { err(e); } } }
  });

  post({ type: 'ready' });
}

const SHIM = '(' + shimMain.toString() + ')();';

/** Build the full sandboxed-iframe HTML document for a layout + user script. Pure. */
export function buildSrcdoc(layout, script) {
  const data = JSON.stringify({ widgets: (layout && layout.widgets) || [] }).replace(/</g, '\\u003c');
  const user = String(script || '').replace(/<\/(script)/gi, '<\\/$1'); // never let user code close our <script>
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${RUN_CSS}</style></head><body><div id="stage"></div>`,
    `<script>window.__BTDATA=${data};</script>`,
    `<script>${SHIM}</script>`,
    `<script>\n${user}\n</script>`,
    '</body></html>',
  ].join('\n');
}

/** Generate a starter script wiring the layout's declarative bindings into live API calls. Pure. */
export function starterScript(layout) {
  const lines = [
    '// Starter script — generated from your widget bindings. Edit freely, then Run.',
    '// API: widget(id) → LED .on()/.off()/.set(v)/.color(c); button .onPress(fn);',
    '//      slider .onChange(fn)/.value(); display .print(text)/.clear().',
    '//      bt.notify(uuid,bytes) · bt.read(uuid)→Promise · bt.setValue(uuid,bytes)',
    '//      bt.onWrite(uuid,fn) · bt.onConnect(fn) · bt.onDisconnect(fn) · log(...)',
    '',
  ];
  const ref = (w) => JSON.stringify(w.name || w.id);
  let any = false;
  for (const w of (layout && layout.widgets) || []) {
    if (!w.binding || !w.binding.uuid) continue;
    any = true;
    const u = JSON.stringify(w.binding.uuid);
    if (w.type === 'button') {
      const clean = (String((w.props && w.props.sendHex) || '01').replace(/[^0-9a-fA-F]/g, '') || '01').toLowerCase();
      const even = clean.length % 2 ? '0' + clean : clean;
      const bytes = even.match(/.{1,2}/g).map((h) => '0x' + h).join(', ');
      lines.push(`widget(${ref(w)}).onPress(() => bt.notify(${u}, [${bytes}]));`);
    } else if (w.type === 'slider') {
      lines.push(`widget(${ref(w)}).onChange((v) => bt.notify(${u}, [v & 0xff]));`);
    } else if (w.type === 'led') {
      lines.push(`bt.onWrite(${u}, (b) => widget(${ref(w)}).set(b.some((x) => x !== 0)));`);
    } else if (w.type === 'display') {
      lines.push(`bt.onWrite(${u}, (b) => widget(${ref(w)}).print(new TextDecoder().decode(new Uint8Array(b))));`);
    }
  }
  if (!any) lines.push('// No bound widgets yet — bind some in Design mode, or write your own logic here.');
  return lines.join('\n') + '\n';
}
