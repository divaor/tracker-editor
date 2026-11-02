// What the language server knows about the names in the text the model is asked about (setting
// `symbolContext`, on unless false): each name's type or signature and where it is defined, as a
// "Symbols" block in the request. Pure, so the tests use it: which names to look up, what a hover
// says, where a definition is (relative to the project) and the block with its caps. app.js
// asks the server (actions.symbolsFor: hover and definition, SYMBOLS_WAIT in all).

import { codeFences, withoutBlocks } from './fences.js';

/** Names looked up at most, and how long the server has for all of them (ms). */
export const MAX_SYMBOLS = 12;
export const SYMBOLS_WAIT = 2000;
/** Around the cursor (nothing selected): this many lines each way. A selection is read up to SELECTION_CHARS. */
const AROUND_LINES = 10;
const SELECTION_CHARS = 30000;

// Words of the languages themselves (and their constants), never looked up.
const KEYWORDS = new Set(
  (
    'if else elif for while do return function def class const let var import from as in of new this self super true false null undefined None True False ' +
    'and or not is with try except catch finally raise throw throws async await yield lambda pass break continue switch case default void typeof instanceof ' +
    'delete export static public private protected internal readonly abstract final extends implements interface enum type struct impl trait fn pub mut ' +
    'use mod crate where match loop go defer chan select package func range nil map then end begin unless until module require include ' +
    'global nonlocal assert del print echo goto sizeof namespace using template typename virtual override sealed partial get set value ' +
    'int float double bool boolean char string str long short byte unsigned signed object any never unknown number symbol bigint auto'
  ).split(' '),
);

const lower = (s) => String(s ?? '').toLowerCase();
const hashComments = (lang) => /^(python|ruby|shell|bash|sh|zsh|perl|r|yaml|toml|powershell|dockerfile|cmake|julia|nim|elixir|crystal|coffeescript|tcl|nginx|properties|makefile)/.test(lang);
const dashComments = (lang) => /^(sql|mysql|postgres|plsql|sqlite|lua|haskell|elm|ada|vhdl)/.test(lang) || /sql/.test(lang);

/**
 * `text` with what is inside strings and comments blanked (same length, line breaks kept), for
 * the comment syntax of `language` (a CodeMirror language name: Python's #, SQL's --, else //
 * and block comments; Python's triple quotes).
 */
export function codeOnly(text, language = '') {
  const lang = lower(language);
  const python = lang.startsWith('python');
  const php = lang.startsWith('php');
  const lineMarks = php ? ['#', '//'] : hashComments(lang) ? ['#'] : dashComments(lang) ? ['--'] : ['//'];
  const block = python || (hashComments(lang) && !php) ? null : ['/*', '*/'];
  const backticks = !python && !dashComments(lang);
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (block && text.startsWith(block[0], i)) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? n : end + block[1].length;
      blank(i, stop);
      i = stop - 1;
    } else if (lineMarks.some((m) => text.startsWith(m, i))) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop - 1;
    } else if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const end = text.indexOf(text.slice(i, i + 3), i + 3);
      const stop = end === -1 ? n : end + 3;
      blank(i + 3, Math.max(i + 3, stop - 3));
      i = stop - 1;
    } else if (c === '"' || c === "'" || (c === '`' && backticks)) {
      let k = i + 1;
      for (; k < n && text[k] !== c && (c === '`' || text[k] !== '\n'); k++) if (text[k] === '\\') k++;
      blank(i + 1, Math.min(k, n));
      i = Math.min(k, n);
    }
  }
  return out.join('');
}

const NAME = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const WORDISH = /[\p{L}\p{N}_$]/u;

/**
 * The names worth asking the server about, best first: [{ name, pos }] (`pos` inside one place
 * the name is written). With a selection (from < to), the names in it, the most used first;
 * else those within AROUND_LINES lines of `at` (the cursor), the nearest first. Strings,
 * comments, the languages' own words and one-letter names are left out.
 */
export function pickIdentifiers(text, { from = 0, to = from, at = from, language = '', max = MAX_SYMBOLS } = {}) {
  const doc = String(text ?? '');
  const selected = to > from;
  let start;
  let end;
  if (selected) {
    start = Math.max(0, from);
    end = Math.min(doc.length, to, start + SELECTION_CHARS);
  } else {
    const cur = Math.max(0, Math.min(at, doc.length));
    // From the start of the line AROUND_LINES above the cursor's to the end of the one as far below.
    start = cur === 0 ? 0 : doc.lastIndexOf('\n', cur - 1) + 1;
    for (let k = 0; k < AROUND_LINES && start > 0; k++) start = start <= 1 ? 0 : doc.lastIndexOf('\n', start - 2) + 1;
    end = doc.indexOf('\n', cur);
    if (end === -1) end = doc.length;
    for (let k = 0; k < AROUND_LINES && end < doc.length; k++) {
      const next = doc.indexOf('\n', end + 1);
      end = next === -1 ? doc.length : next;
    }
  }
  // Strings and comments blanked from a little before, so one that began above is known.
  const lexFrom = start === 0 ? 0 : Math.max(0, doc.lastIndexOf('\n', Math.max(0, start - 50000)) + 1);
  const code = codeOnly(doc.slice(lexFrom, end), language);
  const found = new Map(); // name → { name, count, first, best, dist }
  NAME.lastIndex = 0;
  for (let m; (m = NAME.exec(code)); ) {
    const s = lexFrom + m.index;
    if (s < start) continue;
    const name = m[0];
    if (name.length < 2 || KEYWORDS.has(name) || (m.index > 0 && WORDISH.test(code[m.index - 1]))) continue;
    const e = s + name.length;
    const dist = at < s ? s - at : at > e ? at - e : 0;
    const pos = s + (name.length >> 1);
    const had = found.get(name);
    if (!had) found.set(name, { name, count: 1, first: s, pos, dist, near: pos });
    else {
      had.count++;
      if (dist < had.dist) Object.assign(had, { dist, near: pos });
    }
  }
  const all = [...found.values()];
  all.sort(selected ? (a, b) => b.count - a.count || a.first - b.first : (a, b) => a.dist - b.dist || a.first - b.first);
  return all.slice(0, max).map((f) => ({ name: f.name, pos: selected ? f.pos : f.near }));
}

/** A hover's text ({ contents: MarkupContent | MarkedString | MarkedString[] }) as { signature, doc }: its first code block on one line, then the first lines of what it says. */
export function hoverParts(hover) {
  const c = hover?.contents;
  if (!c) return { signature: '', doc: '' };
  const pieces = Array.isArray(c) ? c : [c];
  const md = pieces
    .map((p) => (typeof p === 'string' ? p : p?.language ? `\`\`\`${p.language}\n${p.value ?? ''}\n\`\`\`` : String(p?.value ?? '')))
    .join('\n\n')
    .replace(/\r\n?/g, '\n');
  const blocks = codeFences(md);
  let signature = blocks[0]?.body ?? '';
  let rest = withoutBlocks(md, blocks);
  if (!signature) {
    // Plain text: its first line is the type.
    const lines = rest.split('\n');
    const at = lines.findIndex((l) => l.trim());
    signature = at === -1 ? '' : lines[at];
    rest = at === -1 ? '' : lines.slice(at + 1).join('\n');
  }
  signature = signature.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim();
  const paragraph =
    rest
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '').trim())
      .find(Boolean) ?? '';
  const doc = paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { signature, doc };
}

/**
 * Where a definition is for the block: `path` relative to the project's folder `root` (a path on
 * this computer, a server's path for remote://), else its last two folders; with its line.
 */
export function whereLabel(path, line, root = '') {
  if (!path) return '';
  const norm = (p) => String(p).replace(/^remote:\/\/[^/]+/, '').replace(/\\/g, '/');
  const p = norm(path);
  const r = norm(root).replace(/\/+$/, '');
  const windows = /^[A-Za-z]:\//.test(p);
  const inside = r && (windows ? lower(p).startsWith(`${lower(r)}/`) : p.startsWith(`${r}/`));
  const parts = p.split('/').filter(Boolean);
  const rel = inside ? p.slice(r.length + 1) : parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  return line ? `${rel}:${line}` : rel;
}

const HEAD = 'Symbols (from the language server: each name’s type or signature, and where it is defined):';
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const rowLine = (r) => `- ${r.name}${r.signature ? `: ${r.signature}` : ''}${r.where ? ` (defined at ${r.where})` : ''}${r.doc ? ` — ${r.doc}` : ''}`;

/**
 * The block for the request from rows [{ name, signature, doc, where }] (best first): rows
 * with neither a signature nor a place left out, each part cut, at most `max` rows and
 * `maxChars` in all. { text ('' when nothing is left), count, rows, server }.
 */
export function symbolsBlock(rows, { server = '', max = MAX_SYMBOLS, maxChars = 2400, maxSignature = 200, maxDoc = 140 } = {}) {
  const kept = [];
  const seen = new Set();
  let size = HEAD.length;
  for (const r of rows ?? []) {
    if (kept.length >= max) break;
    if (!r?.name || seen.has(r.name) || (!flat(r.signature) && !r.where)) continue;
    const row = { name: r.name, signature: cut(flat(r.signature), maxSignature), doc: cut(flat(r.doc), maxDoc), where: String(r.where ?? '') };
    const line = rowLine(row);
    if (size + 1 + line.length > maxChars) break;
    size += 1 + line.length;
    seen.add(r.name);
    kept.push(row);
  }
  return { text: kept.length ? [HEAD, ...kept.map(rowLine)].join('\n') : '', count: kept.length, rows: kept, server };
}
