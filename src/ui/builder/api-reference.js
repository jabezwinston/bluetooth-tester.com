// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// API reference for the Builder's Run-mode script. A two-pane modal opened from the Script toolbar
// (next to Run): left = the list of APIs grouped by surface, right = the selected API's signature,
// description and a runnable example. The catalog below mirrors exactly what runtime.js exposes
// inside the sandboxed iframe — widget(id) handles, the bt.* GATT-server API, the bt.peer.* GATT-
// client API, and the globals. Keep this in sync with shimMain() in runtime.js.

import { el, clear } from '../dom.js';
import { openModal } from '../modal.js';
import { highlight } from './highlight.js';

// Each section groups related calls; each item documents one call (signature + summary + example).
const SECTIONS = [
  {
    title: 'Widgets',
    intro: 'widget(id) returns a handle for a widget on the canvas, looked up by its name or id. The methods depend on the widget type.',
    items: [
      {
        name: 'LED',
        sig: 'const led = widget("led1");\nled.on() · led.off() · led.set(v) · led.toggle() · led.color(c)',
        desc: 'Drive an LED widget. on()/off() force state, set(v) takes a truthy value, toggle() flips it, and color("#rrggbb") recolours the glow.',
        example: '// mirror a characteristic write onto an LED\nbt.onWrite("2A57", (b) => {\n  const on = b.some((x) => x !== 0);\n  widget("led1").set(on);\n  widget("led1").color(on ? "#28d76f" : "#ff3b30");\n});',
      },
      {
        name: 'Button',
        sig: 'const btn = widget("play");\nbtn.onPress(fn) · btn.press() · btn.label(text)',
        desc: 'Wire a button. onPress(fn) registers a click handler, press() triggers it programmatically, and label(text) changes the caption.',
        example: '// notify the central each time the button is pressed\nwidget("play").onPress(() => {\n  bt.notify("2A4D", [0x01]);\n  log("play pressed");\n});',
      },
      {
        name: 'Slider',
        sig: 'const s = widget("level");\ns.value() · s.set(v) · s.onChange(fn)',
        desc: 'Read or drive a slider. value() returns the current number, set(v) moves it, and onChange(fn) fires with the new value as the user drags.',
        example: '// send the slider value as a single byte on every change\nwidget("level").onChange((v) => bt.notify("2A19", [v & 0xff]));\n\n// reflect a remote value back onto the slider\nbt.onWrite("2A19", (b) => widget("level").set(b[0] || 0));',
      },
      {
        name: 'Display',
        sig: 'const d = widget("screen");\nd.print(text) · d.text(text) · d.clear()',
        desc: 'Write to a character display. print(text) / text(text) render text (newlines split rows, clipped to the grid); clear() blanks it.',
        example: '// show whatever the central writes as UTF-8 text\nbt.onWrite("2A3D", (b) => {\n  const s = new TextDecoder().decode(new Uint8Array(b));\n  widget("screen").print(s);\n});',
      },
    ],
  },
  {
    title: 'GATT server — bt.*',
    intro: 'Your app IS a GATT server; the connected central reads, writes and subscribes to its characteristics. Address them by UUID (16- or 128-bit).',
    items: [
      {
        name: 'bt.notify(uuid, bytes, reportId?)',
        sig: 'bt.notify(uuid, bytes, reportId?) → void',
        desc: 'Send a notification on a characteristic. bytes is an array or Uint8Array. reportId (optional) picks a specific HID Report (0x2A4D) characteristic when several share the UUID.',
        example: 'bt.notify("2A4D", [0x01, 0x00]);          // HID consumer report\nbt.notify("2A4D", [0x02], 1);             // report id 1',
      },
      {
        name: 'bt.setValue(uuid, bytes)',
        sig: 'bt.setValue(uuid, bytes) → void',
        desc: "Set a characteristic's stored value without notifying. The next central Read returns these bytes.",
        example: 'bt.setValue("2A19", [85]);   // battery level = 85%',
      },
      {
        name: 'bt.read(uuid)',
        sig: 'await bt.read(uuid) → Uint8Array',
        desc: "Read a characteristic's current value from your own GATT server. Returns a Promise of the bytes.",
        example: 'const v = await bt.read("2A19");\nlog("battery", v[0]);',
      },
      {
        name: 'bt.onWrite(uuid, fn)',
        sig: 'bt.onWrite(uuid, (bytes) => { ... })',
        desc: 'Register a handler that fires whenever the central writes the characteristic. bytes is a plain array.',
        example: 'bt.onWrite("2A57", (bytes) => {\n  log("central wrote", bytes);\n  widget("led1").set(bytes[0]);\n});',
      },
      {
        name: 'bt.onConnect(fn) / bt.onDisconnect(fn)',
        sig: 'bt.onConnect((info) => { ... })\nbt.onDisconnect((info) => { ... })',
        desc: 'Connection-lifecycle hooks. info = { handle, peer, name }. onConnect also fires once for any already-connected central when the script starts.',
        example: 'bt.onConnect((c) => log("connected to", c.name || c.peer));\nbt.onDisconnect(() => widget("led1").off());',
      },
    ],
  },
  {
    title: 'GATT client — bt.peer.*',
    intro: "The flip side: your app acts as a GATT client against the connected central's own services (e.g. Windows 11's Media Control Service). Discover first, then read/write/subscribe.",
    items: [
      {
        name: 'bt.peer.discover()',
        sig: 'await bt.peer.discover() → { services }',
        desc: "Discover the central's services and characteristics. Returns { services: [{ uuid, characteristics: [uuid…] }] }. Run once before peer read/write/subscribe.",
        example: 'const { services } = await bt.peer.discover();\nfor (const s of services) log(s.uuid, s.characteristics);',
      },
      {
        name: 'bt.peer.read(uuid)',
        sig: 'await bt.peer.read(uuid) → Uint8Array',
        desc: "Read a characteristic on the central's server. Discover first.",
        example: 'const name = await bt.peer.read("2A00");\nlog("device name", new TextDecoder().decode(name));',
      },
      {
        name: 'bt.peer.write(uuid, bytes, withResponse?)',
        sig: 'await bt.peer.write(uuid, bytes, withResponse = true)',
        desc: "Write a characteristic on the central's server. Pass withResponse = false for a Write Without Response.",
        example: '// press "next track" on a Media Control Service\nawait bt.peer.write("2BA1", [0x01]);',
      },
      {
        name: 'bt.peer.subscribe(uuid, fn)',
        sig: 'await bt.peer.subscribe(uuid, (bytes) => { ... })',
        desc: "Enable notifications on the central's characteristic and receive them via fn. Returns a Promise that resolves once subscribed.",
        example: 'await bt.peer.subscribe("2BA3", (bytes) => {\n  log("track changed", bytes);\n});',
      },
    ],
  },
  {
    title: 'Globals',
    intro: 'Helpers available at the top level of the script.',
    items: [
      {
        name: 'widget(id)',
        sig: 'widget(id) → handle | null',
        desc: 'Look up a widget by its name (set in Design mode) or its generated id. Returns null if no widget matches.',
        example: 'const led = widget("status");\nif (led) led.on();',
      },
      {
        name: 'log(...args)',
        sig: 'log(...args) → void',
        desc: 'Print to the Console pane below the editor. console.log/warn/error are also captured.',
        example: 'log("ready", Date.now());\nconsole.warn("low battery");',
      },
    ],
  },
];

const FLAT = SECTIONS.flatMap((s) => s.items.map((it) => ({ ...it, section: s.title })));

function copyCode(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }, () => {});
}

export function openApiReference() {
  const detail = el('div.apiref-detail');

  function show(item) {
    clear(detail);
    detail.append(
      el('div.apiref-secname', { text: item.section }),
      el('h4.apiref-name', { text: item.name }),
      el('pre.apiref-sig', {}, el('code', { html: highlight(item.sig) })),
      el('p.apiref-desc', { text: item.desc }),
      el('div.apiref-exhead', {},
        el('span', { text: 'Example' }),
        el('button.apiref-copy', { text: '⧉ Copy', attrs: { title: 'Copy example' }, on: { click: (e) => copyCode(e.currentTarget, item.example) } })),
      el('pre.apiref-example', {}, el('code', { html: highlight(item.example) })),
    );
  }

  const buttons = [];
  function select(idx) {
    buttons.forEach((b, i) => b.classList.toggle('active', i === idx));
    show(FLAT[idx]);
  }

  const list = el('div.apiref-list');
  let flatIdx = 0;
  for (const sec of SECTIONS) {
    list.append(el('div.apiref-sec', { text: sec.title }));
    for (const it of sec.items) {
      const idx = flatIdx++;
      const b = el('button.apiref-item', { html: highlight(it.name), on: { click: () => select(idx) } });
      buttons.push(b);
      list.append(b);
    }
  }

  const content = el('div.apiref', {}, list, detail);
  const modal = openModal({
    title: 'Script API reference',
    width: '860px',
    content,
    actions: [{ label: 'Close', kind: 'primary', onClick: (c) => c() }],
  });
  select(0);
  return modal;
}
