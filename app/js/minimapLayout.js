// The minimap (minimap.js draws it along the right of each editor view): which lines it
// shows, where the box of the visible part is, which line a click lands on, and where whole-file
// marks (problems, Git's changes, search matches) go on its edge. Pure, so the Node tests can
// import it.

/** Its size: CSS pixels wide, per line, per character; views narrower than `minView` get none. */
export const MINIMAP = { width: 92, lineHeight: 2, charWidth: 1, inset: 6, edge: 4, minView: 500 };

/**
 * Whether it shows: the setting (true / false), or by default in the desktop app only (big code
 * is opened there; the web app and phones are mostly notes, and narrow).
 */
export const minimapShown = (setting, { desktop = false } = {}) => (setting === true || setting === false ? setting : desktop);

/**
 * Where it is, for a file of `lines` lines in a minimap `height` px high: as VS Code, when the
 * file is taller than the minimap it scrolls in step with the editor (`scrollTop` of
 * `scrollHeight - clientHeight`). `topLine` / `bottomLine` (1-based) are the lines at the top and
 * bottom of the editor. Returns { total, scroll, first (1-based), offset, rows, last, boxTop,
 * boxHeight, track }.
 */
export function minimapLayout({ lines = 1, height = 0, lineHeight = MINIMAP.lineHeight, topLine = 1, bottomLine = 1, scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const n = Math.max(1, lines);
  const total = n * lineHeight;
  const room = Math.max(0, scrollHeight - clientHeight);
  const ratio = room > 0 ? Math.min(1, Math.max(0, scrollTop / room)) : 0;
  const scroll = total > height ? ratio * (total - height) : 0;
  const first = Math.min(n, Math.floor(scroll / lineHeight) + 1);
  const offset = scroll - (first - 1) * lineHeight;
  const rows = Math.max(0, Math.ceil((height + offset) / lineHeight));
  const last = Math.min(n, first + rows);
  const top = Math.max(1, Math.min(topLine, n));
  const bottom = Math.max(top, Math.min(bottomLine, n));
  const boxTop = (top - 1) * lineHeight - scroll;
  const boxHeight = Math.max(lineHeight * 3, (bottom - top + 1) * lineHeight);
  return { total, scroll, first, offset, rows, last, boxTop, boxHeight, track: Math.min(total, height) };
}

/** The line (1-based) at `y` px from the minimap's top. */
export function lineAtY(layout, y, lines, lineHeight = MINIMAP.lineHeight) {
  return Math.max(1, Math.min(Math.max(1, lines), Math.floor((y + layout.scroll) / lineHeight) + 1));
}

/** Whether `y` is on the box of the visible part (where a press drags it rather than jumps). */
export const onBox = (layout, y) => y >= layout.boxTop && y <= layout.boxTop + layout.boxHeight;

/**
 * Dragging the box `dy` px from where it was pressed: the editor's scrollTop then. Like a
 * scrollbar's thumb, the box follows the pointer over the part of the minimap it moves in.
 */
export function dragScroll({ startScrollTop = 0, dy = 0, scrollHeight = 0, clientHeight = 0, track = 0, box = 0 } = {}) {
  const room = Math.max(1, track - box);
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(max, startScrollTop + (dy * max) / room));
}

// Which mark wins where two land on the same pixel row.
const RANK = { error: 6, warning: 5, deleted: 4, modified: 3, added: 2, info: 1, match: 0 };

/**
 * Whole-file marks as ticks on the minimap's edge (like a scrollbar's overview): each
 * `{ line, kind }` (problems: error/warning/info, Git: added/modified/deleted, search: match) at
 * its place in the file over `height` px, at least `min` px tall; ticks on the same rows merge,
 * the strongest kind kept. Returns [{ y, h, kind }] by y.
 */
export function markTicks(marks = [], { lines = 1, height = 0, min = 2 } = {}) {
  if (!height || !marks.length) return [];
  const per = height / Math.max(1, lines);
  const h = Math.max(min, per);
  const rows = new Map();
  for (const m of marks) {
    if (!m || !(m.kind in RANK)) continue;
    const y = Math.min(height - h, Math.max(0, Math.floor((Math.max(1, m.line) - 1) * per)));
    const at = Math.round(y);
    const was = rows.get(at);
    if (!was || RANK[m.kind] > RANK[was.kind]) rows.set(at, { y: at, h, kind: m.kind });
  }
  return [...rows.values()].sort((a, b) => a.y - b.y);
}

/**
 * A line as the minimap draws it: runs of characters that are not spaces, with their kind
 * ('text', or the syntax's: 'comment', 'string', 'keyword', 'number', 'type', 'tag'), in
 * columns (tabs to `tabSize`), up to `maxCols`. `from` is the line's start in the document
 * and `spans` the syntax's [{ from, to, kind }] around it (outer ones first, inner ones after:
 * an inner span wins). Returns [{ col, len, kind }].
 */
export function lineRuns(text = '', { from = 0, spans = [], tabSize = 4, maxCols = 120 } = {}) {
  const chars = Math.min(text.length, maxCols);
  if (!chars) return [];
  const kinds = new Array(chars).fill('text');
  for (const s of spans) {
    const a = Math.max(0, s.from - from);
    const b = Math.min(chars, s.to - from);
    for (let i = a; i < b; i++) kinds[i] = s.kind;
  }
  const runs = [];
  let col = 0;
  let run = null;
  for (let i = 0; i < chars && col < maxCols; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 9) {
      run = null;
      col += tabSize - (col % tabSize);
      continue;
    }
    if (ch === 32 || ch === 160) {
      run = null;
      col += 1;
      continue;
    }
    if (run && run.kind === kinds[i]) run.len += 1;
    else {
      run = { col, len: 1, kind: kinds[i] };
      runs.push(run);
    }
    col += 1;
  }
  return runs;
}
