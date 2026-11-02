// Next-edit suggestions (setting `nextEdits`): a moment after you edit, the model may propose the
// next related change anywhere in the file (the same rename at the other uses, a parameter added
// at the call sites, the matching change in the next similar block). Pure, so the tests use it:
// the edits made as small diffs, the request, the answer's edits placed in the text, the parts
// each shows, which one comes next and when one is stale. nextEditView.js shows them.
import { codeFences } from './fences.js';
import { applyEdits, wholeChanges } from './fileSteps.js';

/** How long a pause after the last edit before asking (ms). */
export const WAIT_MS = 700;
/** Edits proposed in one answer, and edits made that go with the request. */
export const MAX_EDITS = 3;
export const MAX_HISTORY = 5;
/** The cursor's place in the text sent (taken out of what comes back). */
export const CURSOR = '<|cursor|>';
/** A file up to this many characters goes whole; a longer one as this much around the cursor. */
export const FILE_CHARS = 16000;
export const WINDOW_CHARS = 12000;
/** Within this many lines of the cursor a suggestion shows in place (Tab makes it); farther, a mark there and a hint here (Tab goes to it). */
export const NEAR_LINES = 2;

/**
 * The edits made, kept for the request: `history` is [{ from, to, before, at }], from–to the
 * edited lines in the text as it is now (whole lines), `before` what they said before. A change
 * (a CodeMirror transaction: its `startDoc`, `doc` and `changes`) adds to it: edits on the same
 * lines join (typing a word is one edit; the joined one becomes the latest), the others move with
 * the text, an edit typed back to what it was goes, and only the last `max` stay.
 */
export function recordEdit(history, { startDoc, doc, changes }, { max = MAX_HISTORY, now = Date.now() } = {}) {
  let lo = Infinity;
  let hi = -1;
  changes.iterChangedRanges((fromA, toA) => {
    lo = Math.min(lo, fromA);
    hi = Math.max(hi, toA);
  });
  if (hi < 0) return history;
  const from0 = startDoc.lineAt(lo).from;
  const to0 = startDoc.lineAt(hi).to;
  const joined = history.filter((e) => e.from <= to0 && e.to >= from0).sort((a, b) => a.from - b.from);
  const others = history.filter((e) => !joined.includes(e));
  const from = Math.min(from0, ...joined.map((e) => e.from));
  const to = Math.max(to0, ...joined.map((e) => e.to));
  // What those lines said before any of the joined edits.
  let before = '';
  let at = from;
  for (const e of joined) {
    before += startDoc.sliceString(at, e.from) + e.before;
    at = e.to;
  }
  before += startDoc.sliceString(at, to);
  const nFrom = doc.lineAt(changes.mapPos(from, -1)).from;
  const nTo = doc.lineAt(changes.mapPos(to, 1)).to;
  const entry = { from: nFrom, to: nTo, before, at: now };
  return [...mapHistory(others, { doc, changes }), ...(doc.sliceString(nFrom, nTo) === before ? [] : [entry])].slice(-max);
}

/** The edits made, after a change that is not one of theirs (a reload, a format, an edit on other lines): moved with their lines, what was put at their edges left out. */
export function mapHistory(history, { doc, changes }) {
  return history.map((e) => {
    const from = changes.mapPos(e.from, 1);
    const to = Math.max(from, changes.mapPos(e.to, -1));
    return { ...e, from: doc.lineAt(from).from, to: doc.lineAt(to).to };
  });
}

/**
 * The edits made as the model reads them, oldest first: "@@ line N @@", then the lines as they
 * were (-) and as they are (+), lines the same at both ends left out, long ones cut.
 */
export function editsText(history, doc, { maxLines = 8, maxChars = 240 } = {}) {
  const clip = (line) => (line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
  const side = (lines, mark) => [...lines.slice(0, maxLines).map((l) => `${mark}${clip(l)}`), ...(lines.length > maxLines ? [`${mark}… (${lines.length - maxLines} more lines)`] : [])];
  const out = [];
  for (const e of history) {
    const now = doc.sliceString(e.from, e.to);
    if (now === e.before) continue;
    const b = e.before.split('\n');
    const a = now.split('\n');
    let line = doc.lineAt(e.from).number;
    while (b.length && a.length && b[0] === a[0]) {
      b.shift();
      a.shift();
      line++;
    }
    while (b.length && a.length && b.at(-1) === a.at(-1)) {
      b.pop();
      a.pop();
    }
    out.push([`@@ line ${line} @@`, ...side(b, '-'), ...side(a, '+')].join('\n'));
  }
  return out.join('\n');
}

const SYSTEM = [
  'You suggest the next edit in a file someone is editing. From the edits they just made, work out what they are doing (renaming something, adding or removing a parameter, changing a pattern) and propose the next edits that follow from it elsewhere in the file: the same rename at the other uses, the new argument at the call sites, the matching change in the next similar block.',
  'Reply with only JSON, no prose: {"edits": [{"find": "...", "replace": "...", "why": "..."}]}',
  `- At most ${MAX_EDITS} edits, the most likely first.`,
  `- "find" is text copied exactly from the file as it is now (without ${CURSOR}), long enough to occur only once in the file; "replace" is what that text becomes. Keep both short: the part that changes and a little of the line around it.`,
  '- "why" says in a few words what it does ("rename count to total").',
  '- Never repeat or undo the edits already made, and propose nothing that does not clearly follow from them.',
  '- If nothing follows from them, reply {"edits": []}.',
].join('\n');

/** Line number (1-based) of offset `pos` in `text`. */
const lineOf = (text, pos) => {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

/**
 * The request: the edits made (editsText), the file with the cursor marked (a long one as the
 * lines around the cursor, saying which), asking for JSON { edits: [{ find, replace, why }] }.
 */
export function nextEditMessages({ name = '', language = '', edits = '', text = '', cursor = 0 }) {
  const doc = String(text ?? '');
  const at = Math.max(0, Math.min(cursor, doc.length));
  let from = 0;
  let to = doc.length;
  if (doc.length > FILE_CHARS) {
    const half = WINDOW_CHARS / 2;
    const start = Math.max(0, at - half);
    from = start === 0 ? 0 : doc.lastIndexOf('\n', start) + 1;
    const end = Math.min(doc.length, at + half);
    to = end === doc.length ? end : doc.indexOf('\n', end) === -1 ? doc.length : doc.indexOf('\n', end);
  }
  const where = from === 0 && to === doc.length ? 'the whole file' : `lines ${lineOf(doc, from)}–${lineOf(doc, to)} of ${lineOf(doc, doc.length)}`;
  const shown = `${doc.slice(from, at)}${CURSOR}${doc.slice(at, to)}`;
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `File: ${name || 'untitled'}${language ? ` (${language})` : ''}\n\nThe edits just made, oldest first:\n${edits || '(none)'}\n\nThe file now (${where}; ${CURSOR} marks the cursor):\n<<<\n${shown}\n>>>\n\nReply with the JSON only.`,
    },
  ];
}

const tidy = (s) => String(s).replaceAll(CURSOR, '').replace(/\r\n?/g, '\n');

/** The list of edits in an answer: JSON (fenced or not, prose around it), { edits: [...] } or a bare list. */
function editsIn(reply) {
  const s = String(reply ?? '');
  // Fences as CommonMark reads them: an edit to a Markdown file may hold ``` of its own.
  const fenced = codeFences(s).find((b) => !b.lang || b.lang === 'json');
  const body = fenced ? fenced.body : s;
  const objectAt = body.indexOf('{');
  const listAt = body.indexOf('[');
  const candidates = [body.trim()];
  const object = objectAt !== -1 && body.lastIndexOf('}') > objectAt ? body.slice(objectAt, body.lastIndexOf('}') + 1) : null;
  const list = listAt !== -1 && body.lastIndexOf(']') > listAt ? body.slice(listAt, body.lastIndexOf(']') + 1) : null;
  // Whichever starts first is the answer; the other may sit inside it.
  candidates.push(...(listAt !== -1 && (objectAt === -1 || listAt < objectAt) ? [list, object] : [object, list]));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      const edits = Array.isArray(v) ? v : Array.isArray(v?.edits) ? v.edits : null;
      if (edits) return edits;
    } catch {
      // the next candidate
    }
  }
  return [];
}

/**
 * An edit ({ find, replace, why }) placed in `text` (fileSteps.js applyEdits finds it):
 * { find, replace, why, from, to }, or null when its find is not there exactly once or it
 * changes nothing.
 */
export function placeEdit(text, edit) {
  if (!edit || typeof edit.find !== 'string' || typeof edit.replace !== 'string') return null;
  const find = tidy(edit.find);
  const replace = tidy(edit.replace);
  if (!find.trim() || find === replace) return null;
  const done = applyEdits(text, [{ find, replace }]);
  if (done.error || !done.changes?.length) return null;
  const { from, to } = done.changes[0];
  return { find: text.slice(from, to), replace, why: typeof edit.why === 'string' ? edit.why.trim().slice(0, 160) : '', from, to };
}

/** The model's answer as edits placed in `text` (placeEdit): at most `max`, none overlapping another. */
export function parseNextEdits(reply, text, { max = MAX_EDITS } = {}) {
  const doc = String(text ?? '');
  const out = [];
  for (const item of editsIn(reply)) {
    if (out.length >= max) break;
    const placed = placeEdit(doc, item);
    if (placed && !out.some((o) => placed.from < o.to && o.from < placed.to)) out.push(placed);
  }
  return out;
}

/** Which suggestion comes next for a cursor at `cursor`: the first ending at or after it, else the first (they wrap around). */
export function pickNext(edits, cursor) {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  return sorted.find((e) => e.to >= cursor) ?? sorted[0] ?? null;
}

/** Whether a suggestion on lines fromLine–toLine shows in place for a cursor on `cursorLine`. */
export const isNear = (cursorLine, fromLine, toLine, span = NEAR_LINES) => cursorLine >= fromLine - span && cursorLine <= toLine + span;

const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;

/**
 * How a suggestion shows in place: the parts of the text it takes out (struck through) and what
 * goes in at each (ghost text), [{ from, to, insert }] in the document, word by word (a rename at
 * two places on a line shows as two). Long ones as one part.
 */
export function diffParts(edit) {
  const a = edit.find.match(TOKEN) ?? [];
  const b = edit.replace.match(TOKEN) ?? [];
  if (a.length * b.length > 40000) {
    const [w] = wholeChanges(edit.find, edit.replace);
    return w ? [{ from: edit.from + w.from, to: edit.from + w.to, insert: w.insert }] : [];
  }
  // The longest common run of tokens from each place onward.
  const n = a.length;
  const m = b.length;
  const longest = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) longest[i][j] = a[i] === b[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
  const parts = [];
  let part = null;
  let pos = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (part) parts.push(part);
      part = null;
      pos += a[i].length;
      i++;
      j++;
    } else if (j < m && (i >= n || longest[i][j + 1] >= longest[i + 1][j])) {
      part ??= { from: pos, to: pos, insert: '' };
      part.insert += b[j++];
    } else {
      part ??= { from: pos, to: pos, insert: '' };
      pos += a[i++].length;
      part.to = pos;
    }
  }
  if (part) parts.push(part);
  return parts.map((p) => ({ from: edit.from + p.from, to: edit.from + p.to, insert: p.insert }));
}

/** A suggestion in a few words for its mark ("count → total", "+ , 3"), at most `max` characters. */
export function editSummary(edit, { max = 40 } = {}) {
  const parts = diffParts(edit);
  if (!parts.length) return '';
  const first = parts[0];
  const out = edit.find.slice(first.from - edit.from, first.to - edit.from).trim();
  const put = first.insert.trim();
  const flat = (s) => s.replace(/\s+/g, ' ');
  let text = out && put ? `${flat(out)} → ${flat(put)}` : put ? `+ ${flat(put)}` : `− ${flat(out)}`;
  if (parts.length > 1) text += ' …';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A suggestion after a change to the text: null (stale) when the change is the person's typing
 * (`typed`) or touches its text, else moved with the text around it.
 */
export function afterChange(edit, { typed = false, changes }) {
  if (typed) return null;
  let touched = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= edit.to && toA >= edit.from) touched = true;
  });
  if (touched) return null;
  return { ...edit, from: changes.mapPos(edit.from, 1), to: changes.mapPos(edit.to, -1) };
}

/** Where the cursor goes after a suggestion is made: the end of what it changed. */
export function endAfter(edit) {
  const [w] = wholeChanges(edit.find, edit.replace);
  return edit.from + (w ? w.from + w.insert.length : edit.replace.length);
}
