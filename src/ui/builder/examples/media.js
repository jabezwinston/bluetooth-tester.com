// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Builder example — Windows 11 Media Player. Windows 11 exposes its media transport as a GATT *server*
// (Generic Media Control Service, GMCS 0x1849), so our script is the GATT *client* (bt.peer.*): the
// buttons write the Media Control Point (0x2BA4) and the display subscribes Player Name / Track Title /
// Position / Duration / State, rendering a scrubber + times. We add no services of our own (we drive the
// host's); the script — authored as a real function, extracted by program() — stays small and readable.

import { program } from './program.js';

function mediaProgram() {
  // Windows 11 Media Player — control the host's media over its GATT Media Control Service.
  //   1) Advertise (top bar) and connect from Windows.  2) Press Run.  3) Use the buttons.
  // Windows exposes GMCS (0x1849) as a GATT server; we are the client, so everything is bt.peer.*.

  const NAME = '2B93', TITLE = '2B97', DUR = '2B98', POS = '2B99', STATE = '2BA3', MCP = '2BA4';
  const STATES = ['Inactive', 'Playing', 'Paused', 'Seeking'];

  let name = '', title = '', state = '';
  let dur = 0, pos = 0;                                          // centiseconds (MCS units)

  // ---- decoders ----
  const text = (b) => new TextDecoder().decode(new Uint8Array(b));
  const int32 = (b) => b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);   // signed LE; -1 = unknown
  const read = (uuid) => bt.peer.read(uuid).catch(() => []);              // never throws → []

  // ---- rendering ----
  // mm:ss from centiseconds (-- for unknown / out-of-range).
  function clock(cs) {
    if (cs < 0 || cs > 1e9) return '--:--';
    const s = Math.floor(cs / 100);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // A (----|----) progress bar `width` chars wide, the cursor at the current position.
  function scrubber(width) {
    const at = dur > 0 ? Math.round((pos / dur) * (width - 1)) : 0;
    let bar = '';
    for (let i = 0; i < width; i++) bar += (i === at ? '|' : '-');
    return `(${bar})`;
  }

  // Repaint the 4-line display: player, track, scrubber, elapsed / total.
  function draw() {
    widget('track').print([
      name || '(player)',
      title || '(no track)',
      scrubber(22),
      `${clock(pos)} / ${clock(dur)}`,
    ].join('\n'));
  }

  // ---- live data ----
  // On connect: discover the host's GMCS, read the current state, then subscribe to live updates.
  async function start() {
    log('Discovering host media service…');
    try {
      await bt.peer.discover();
      name = text(await read(NAME));
      title = text(await read(TITLE));
      state = STATES[(await read(STATE))[0]] || '';
      dur = int32(await read(DUR));
      pos = int32(await read(POS));
      draw();

      bt.peer.subscribe(NAME, (b) => { name = text(b); draw(); });
      bt.peer.subscribe(TITLE, (b) => { title = text(b); draw(); });
      bt.peer.subscribe(POS, (b) => { pos = int32(b); draw(); });
      bt.peer.subscribe(STATE, (b) => { state = STATES[b[0]] || ''; draw(); });
      log('Ready — use the buttons.');
    } catch (e) {
      log('No media service on host: ' + e.message);
      widget('track').print('no GMCS on host');
    }
  }
  bt.onConnect(start);

  // Advance the scrubber locally between Position notifications while playing.
  setInterval(() => { if (state === 'Playing' && dur > 0) { pos = Math.min(dur, pos + 100); draw(); } }, 1000);

  // ---- controls: each transport button writes one Media Control Point opcode ----
  const control = (op) => bt.peer.write(MCP, [op]).catch((e) => log(e.message));
  widget('prev').onPress(() => control(0x30));                              // Previous Track
  widget('next').onPress(() => control(0x31));                              // Next Track
  widget('play').onPress(() => control(state === 'Playing' ? 0x02 : 0x01)); // Pause if playing, else Play
}

// A media-player face: Prev / Play-Pause / Next transport buttons across the top, then a wide display
// showing player name, track title, a scrubber and elapsed / total time.
export const media = {
  id: 'media', name: 'Win11 Media Player',
  build() {
    return {
      name: 'Media Player',
      widgets: [
        { type: 'button', name: 'prev', x: 40, y: 28, props: { emoji: '⏮️', text: 'Prev' } },
        { type: 'button', name: 'play', x: 160, y: 28, props: { emoji: '⏯️', text: 'Play / Pause' } },
        { type: 'button', name: 'next', x: 280, y: 28, props: { emoji: '⏭️', text: 'Next' } },
        { type: 'display', name: 'track', x: 40, y: 110, props: { rows: 5, cols: 24, text: 'connect a host…' } },
      ],
      script: program(mediaProgram),
    };
  },
};
