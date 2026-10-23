// Column (box) selection from the keyboard, as in Notepad++ and VS Code: Shift+Alt+arrows
// grow or shrink a rectangle from the cursor, one range per line, so typing edits every line
// at once; Ctrl+Alt+↑/↓ add a cursor above or below. The box is kept in columns (a tab counts
// to its stop), so it keeps its width across short lines; those get a cursor at their end,
// as with Alt+drag. Imports the CodeMirror bundle, which loads in Node too (tested there).
import { EditorSelection, StateEffect, StateField } from '../vendor/cm/codemirror.js';

const MARK = /[\p{M}‍]/u;
const size = (text, i) => (text.codePointAt(i) > 0xffff ? 2 : 1);
// Combining marks (and joiners) belong to the character before them: no column of their own.
const skipMarks = (text, i) => {
  while (i < text.length && MARK.test(String.fromCodePoint(text.codePointAt(i)))) i += size(text, i);
  return i;
};
const width = (text, i, col, tabSize) => (text.charCodeAt(i) === 9 ? tabSize - (col % tabSize) : 1);

/** The column an offset in a line is at. */
export function columnAt(text, offset, tabSize) {
  let col = 0;
  for (let i = skipMarks(text, 0); i < offset && i < text.length; i = skipMarks(text, i + size(text, i))) col += width(text, i, col, tabSize);
  return col;
}

/** The offset where a column starts (one inside a tab: after it); past the end, the end. */
export function offsetAt(text, col, tabSize) {
  let n = 0;
  let i = skipMarks(text, 0);
  while (n < col && i < text.length) {
    n += width(text, i, n, tabSize);
    i = skipMarks(text, i + size(text, i));
  }
  return i;
}

/** One step left or right from a column: to the next character's edge; past the end, a column at a time. */
export function stepColumn(text, col, dir, tabSize) {
  let n = 0;
  let before = 0;
  for (let i = skipMarks(text, 0); i < text.length; ) {
    n += width(text, i, n, tabSize);
    i = skipMarks(text, i + size(text, i));
    if (n > col) return dir > 0 ? n : before;
    if (n < col) before = n;
  }
  return Math.max(0, dir > 0 ? col + 1 : n === col ? before : col - 1);
}

const setBox = StateEffect.define();

/** The box the keys are drawing ({ anchor, head }: { line, col }), until the text or selection changes otherwise. */
export const columnBox = StateField.define({
  create: () => null,
  update(box, tr) {
    for (const e of tr.effects) if (e.is(setBox)) return e.value;
    return tr.docChanged || tr.selection ? null : box;
  },
});

const pointOf = (state, pos) => {
  const line = state.doc.lineAt(pos);
  return { line: line.number, col: columnAt(line.text, pos - line.from, state.tabSize) };
};

// The box being drawn, else one made from the selection: a range's ends, or for several
// ranges (Alt+drag, or after typing in a box) their first and last lines, grown the way
// the key points and as wide as the widest of them.
function boxOf(state, dir) {
  const box = state.field(columnBox, false);
  if (box) return box;
  const { ranges, main } = state.selection;
  if (ranges.length === 1) return { anchor: pointOf(state, main.anchor), head: pointOf(state, main.head) };
  let widest = null;
  for (const r of ranges) {
    const a = pointOf(state, r.anchor);
    const h = pointOf(state, r.head);
    if (!widest || Math.max(a.col, h.col) > Math.max(widest.a.col, widest.h.col)) widest = { a, h };
  }
  const top = state.doc.lineAt(ranges[0].from).number;
  const bottom = state.doc.lineAt(ranges[ranges.length - 1].to).number;
  const [from, to] = dir < 0 ? [bottom, top] : [top, bottom];
  return { anchor: { line: from, col: widest.a.col }, head: { line: to, col: widest.h.col } };
}

/** The selection for a box: a range on each line, the head line's the main one. */
export function boxSelection(state, { anchor, head }) {
  const ranges = [];
  let main = 0;
  const step = head.line >= anchor.line ? 1 : -1;
  for (let n = anchor.line; ; n += step) {
    const line = state.doc.line(n);
    if (n === head.line) main = ranges.length;
    ranges.push(EditorSelection.range(line.from + offsetAt(line.text, anchor.col, state.tabSize), line.from + offsetAt(line.text, head.col, state.tabSize)));
    if (n === head.line) break;
  }
  return EditorSelection.create(ranges, main);
}

function draw(view, box) {
  view.dispatch({ selection: boxSelection(view.state, box), effects: setBox.of(box), scrollIntoView: true, userEvent: 'select' });
  return true;
}

const clampLine = (state, n) => Math.min(state.doc.lines, Math.max(1, n));

// The head moves: lines up or down, a character left or right (not past the box's longest line).
const moveBox = (dLine, dCol) => (view) => {
  const { state } = view;
  const { anchor, head } = boxOf(state, dLine);
  let { line, col } = head;
  line = clampLine(state, line + dLine);
  if (dCol) {
    const next = stepColumn(state.doc.line(line).text, col, dCol, state.tabSize);
    let longest = 0;
    for (let n = Math.min(anchor.line, line); n <= Math.max(anchor.line, line); n++) {
      const text = state.doc.line(n).text;
      longest = Math.max(longest, columnAt(text, text.length, state.tabSize));
    }
    col = dCol > 0 && next > longest ? Math.max(col, longest) : next;
  }
  return draw(view, { anchor, head: { line, col } });
};

// A cursor more on the line above the top one (or below the bottom one), in the head's column.
const addCursor = (dir) => (view) => {
  const { state } = view;
  const { anchor, head } = boxOf(state, dir);
  const headFar = dir > 0 ? head.line >= anchor.line : head.line <= anchor.line;
  const [far, near] = headFar ? [head, anchor] : [anchor, head];
  const line = clampLine(state, far.line + dir);
  return draw(view, { anchor: { line: near.line, col: head.col }, head: { line, col: head.col } });
};

export const boxUp = moveBox(-1, 0);
export const boxDown = moveBox(1, 0);
export const boxLeft = moveBox(0, -1);
export const boxRight = moveBox(0, 1);
export const addCursorAbove = addCursor(-1);
export const addCursorBelow = addCursor(1);

/** Notepad++'s Shift+Alt+arrows (VS Code's Ctrl+Shift+Alt+arrows too; Cmd+Shift+Option on macOS), VS Code's Ctrl+Alt+↑/↓. */
export const columnKeymap = [
  ...[
    ['ArrowUp', boxUp],
    ['ArrowDown', boxDown],
    ['ArrowLeft', boxLeft],
    ['ArrowRight', boxRight],
  ].flatMap(([arrow, run]) => [
    { key: `Shift-Alt-${arrow}`, mac: `Mod-Shift-Alt-${arrow}`, run, preventDefault: true },
    { key: `Ctrl-Shift-Alt-${arrow}`, run, preventDefault: true },
  ]),
  { key: 'Ctrl-Alt-ArrowUp', mac: 'Mod-Alt-ArrowUp', run: addCursorAbove, preventDefault: true },
  { key: 'Ctrl-Alt-ArrowDown', mac: 'Mod-Alt-ArrowDown', run: addCursorBelow, preventDefault: true },
];
