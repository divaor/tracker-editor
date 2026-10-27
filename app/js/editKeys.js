// The edit bar on touch screens and the line-number menu: what they insert, what Copy takes,
// which lines a tap selects, and whether the on-screen keyboard is up. Pure, so the Node tests
// can import it (states are CodeMirror's, but nothing here imports it).

/** The symbols row: characters that are a long press or a page away on phone keyboards. */
export const EDIT_SYMBOLS = ['(', ')', '{', '}', '[', ']', '<', '>', '=', ';', ':', '"', "'", '`', '/', '\\', '|', '&', '!', '?', '-', '_', '+', '*', '#', '$', '%', '@', '~', '^'];

/** Holding an arrow: the first repeat after REPEAT_DELAY ms, then one every REPEAT_EVERY ms. */
export const REPEAT_DELAY = 380;
export const REPEAT_EVERY = 60;

/** How much shorter the visible page must be than its full height to mean the keyboard is up. */
export const KEYBOARD_MIN = 150;

/**
 * Whether the on-screen keyboard is up, from the visible page's size (`visualViewport`, zoom
 * taken out). The full height is learned per width (turning the phone changes it); until a
 * width's is known, the answer stays what it was.
 */
export function keyboardState(prev, { width, height }) {
  const w = Math.round(width);
  const h = Math.round(height);
  const full = { ...(prev?.full ?? {}) };
  if (!full[w]) {
    full[w] = h;
    return { full, open: prev?.open ?? false };
  }
  if (h > full[w]) full[w] = h;
  return { full, open: h < full[w] - KEYBOARD_MIN };
}

/** The range of lines `first` to `last` (1-based), with the line break after the last one. */
export function linesRange(doc, first, last = first) {
  const a = doc.line(Math.max(1, Math.min(first, last)));
  const b = doc.line(Math.min(doc.lines, Math.max(first, last)));
  return { from: a.from, to: b.number < doc.lines ? b.to + 1 : b.to };
}

/**
 * A tap on a line number: that line (all of a folded block), or with `extend` from the selection
 * to it. Returns { anchor, head }; a line above the selection is selected upwards.
 */
export function lineTapSelection(state, from, to = from, { extend = false } = {}) {
  const { doc } = state;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  if (!extend) {
    const r = linesRange(doc, first, last);
    return { anchor: r.from, head: r.to };
  }
  const sel = state.selection.main;
  const selFirst = doc.lineAt(sel.from).number;
  // A selection that ends at a line start ends with the line before.
  const selLast = sel.to > sel.from && doc.lineAt(sel.to).from === sel.to ? doc.lineAt(sel.to).number - 1 : doc.lineAt(sel.to).number;
  if (first < selFirst) {
    const r = linesRange(doc, first, selLast);
    return { anchor: r.to, head: r.from };
  }
  const r = linesRange(doc, selFirst, Math.max(last, selLast));
  return { anchor: r.from, head: r.to };
}

/**
 * Select line: the lines the selection touches, whole; when they already are, one more below.
 * Returns ranges ({ anchor, head }) for each selection range.
 */
export function selectLineRanges(state) {
  const { doc } = state;
  return state.selection.ranges.map((range) => {
    const first = doc.lineAt(range.from).number;
    const endLine = doc.lineAt(range.to);
    const last = range.to > range.from && endLine.from === range.to ? endLine.number - 1 : endLine.number;
    const whole = linesRange(doc, first, last);
    if (range.from === whole.from && range.to === whole.to && last < doc.lines) {
      const more = linesRange(doc, first, last + 1);
      return { anchor: more.from, head: more.to };
    }
    return { anchor: whole.from, head: whole.to };
  });
}

/**
 * What Copy and Cut take: the selected text of each range (joined by line breaks), or, when
 * nothing is selected, the cursors' whole lines with their breaks, like a computer editor does.
 * Returns { text, ranges: [{ from, to }] } (the ranges Cut removes, merged).
 */
export function clipRanges(state) {
  const { doc } = state;
  const lineWise = state.selection.ranges.every((r) => r.empty);
  const parts = [];
  const ranges = [];
  const seen = new Set(); // two cursors on one line copy it once
  for (const range of state.selection.ranges) {
    if (!lineWise) {
      if (range.empty) continue;
      parts.push(doc.sliceString(range.from, range.to));
      ranges.push({ from: range.from, to: range.to });
      continue;
    }
    const line = doc.lineAt(range.head);
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    const r = linesRange(doc, line.number);
    // The last line has no break after it: Cut takes the one before, Copy still ends with one.
    parts.push(`${line.text}\n`);
    ranges.push(r.to === line.to && line.number > 1 ? { from: line.from - 1, to: line.to } : r);
  }
  const merged = [];
  for (const r of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return { text: parts.join(lineWise ? '' : '\n'), ranges: merged };
}

/** A key for a synthetic keydown: its `code`, as a keyboard reports it (CodeMirror falls back to it). */
export function codeOfKey(key) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return { ' ': 'Space', '/': 'Slash', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '-': 'Minus', '=': 'Equal', '`': 'Backquote' }[key] ?? (key.length > 1 ? key : '');
}
