// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder example — Simple Watch. Our emulated peripheral exposes Current Time (0x2A2B) + Battery
// (0x2A19) as a GATT *server*; the script ticks once a second — printing the time to the display,
// notifying the exact-time bytes, blinking a "tick" LED — while a slider drives the battery level.
// The GATT plumbing lives in build() (service defs inlined as data, no framework imports); the script,
// authored as a real function and extracted by program(), stays small and reads cleanly.

import { program } from './program.js';
import { ensureService } from './gatt.js';

// The two services the watch advertises: Current Time (read/write/notify) + Battery Level (read/notify).
const ctsService = () => ({
  uuid: '1805', name: 'Current Time', primary: true,
  characteristics: [{ uuid: '2A2B', name: 'Current Time', properties: ['read', 'write', 'notify'], valueHex: '' }],
});
const batteryService = () => ({
  uuid: '180F', name: 'Battery', primary: true,
  characteristics: [{ uuid: '2A19', name: 'Battery Level', properties: ['read', 'notify'], valueHex: '64' }],
});

function watchProgram() {
  // Simple Watch — exposes Current Time (0x2A2B) + Battery (0x2A19).
  // Press Run; a central (or the Web Bluetooth tester) can read / subscribe the time and battery.

  const TIME = '2A2B', BATTERY = '2A19';
  const pad = (n) => String(n).padStart(2, '0');

  // Current Time (0x2A2B) bytes: year(LE), month, day, hours, minutes, seconds, day-of-week, frac, reason.
  const exactTime = (d) => {
    const y = d.getFullYear();
    return [y & 0xff, (y >> 8) & 0xff, d.getMonth() + 1, d.getDate(),
      d.getHours(), d.getMinutes(), d.getSeconds(), ((d.getDay() + 6) % 7) + 1, 0, 0];
  };

  // Once a second: paint HH:MM:SS + date, push the exact time to subscribers, and blink the tick LED.
  let beat = false;
  function tick() {
    const d = new Date();
    widget('screen').print(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\n`
      + `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`);
    const t = exactTime(d);
    bt.setValue(TIME, t);
    bt.notify(TIME, t);
    beat = !beat;
    widget('beat').set(beat);
  }
  setInterval(tick, 1000);
  tick();

  // The slider drives the Battery Level characteristic (0-100%).
  widget('batt').onChange((v) => {
    bt.setValue(BATTERY, [v]);
    bt.notify(BATTERY, [v]);
    log(`battery ${v}%`);
  });
}

// A simple watch face: the time/date display with a blinking "tick" LED beside it, and a battery slider below.
export const watch = {
  id: 'watch', name: 'Simple Watch',
  build({ store, conn }) {
    ensureService(store, conn, ctsService());
    ensureService(store, conn, batteryService());
    return {
      name: 'Simple Watch',
      widgets: [
        { type: 'display', name: 'screen', x: 40, y: 40, props: { rows: 2, cols: 16, text: '--:--:--' } },
        { type: 'led', name: 'beat', x: 300, y: 48, props: { color: '#3ecf8e', on: false, label: 'tick' } },
        { type: 'slider', name: 'batt', x: 40, y: 150, props: { min: 0, max: 100, value: 80 } },
      ],
      script: program(watchProgram),
    };
  },
};
