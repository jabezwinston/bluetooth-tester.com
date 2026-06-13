// Copyright (c) 2026 Jabez Winston
// Developed with assistance from Anthropic Claude Code
// SPDX-License-Identifier: Apache-2.0

// Tiny, dependency-free JavaScript syntax highlighter for the Builder's code editor. highlight()
// turns source into HTML with <span class="tok-*"> wrappers (comments, strings, numbers, keywords,
// function-call names). Pure (no DOM) → unit-testable. Used behind a transparent <textarea> (the
// overlay technique), so it only needs to be correct, not a full parser.

const KEYWORDS = new Set((
  'await break case catch class const continue debugger default delete do else export extends ' +
  'finally for function if import in instanceof let new of return super switch this throw try ' +
  'typeof var void while with yield async true false null undefined'
).split(' '));

// One token: comment | string (', ", `) | number | identifier. Anything else is plain text.
const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;

export function highlight(code) {
  const s = String(code == null ? '' : code);
  let out = '', last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(s))) {
    out += esc(s.slice(last, m.index));
    if (m[1]) out += span('com', m[1]);
    else if (m[2]) out += span('str', m[2]);
    else if (m[3]) out += span('num', m[3]);
    else {
      const w = m[4];
      if (KEYWORDS.has(w)) out += span('kw', w);
      else if (/^\s*\(/.test(s.slice(TOKEN.lastIndex))) out += span('fn', w); // identifier followed by '(' → call
      else out += esc(w);
    }
    last = TOKEN.lastIndex;
  }
  out += esc(s.slice(last));
  return out;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(t) { return t.replace(/[&<>]/g, (c) => ESC[c]); }
function span(cls, t) { return `<span class="tok-${cls}">${esc(t)}</span>`; }
