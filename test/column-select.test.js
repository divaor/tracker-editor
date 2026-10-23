// Column selection from the keyboard (columnSelect.js): columns with tabs, the box's ranges, the commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '../app/vendor/cm/codemirror.js';
import { addCursorAbove, addCursorBelow, boxDown, boxLeft, boxRight, boxUp, columnAt, columnBox, offsetAt, stepColumn } from '../app/js/columnSelect.js';

test('columns: tabs go to their stop, combining marks take none', () => {
  assert.equal(columnAt('\tab', 1, 4), 4);
  assert.equal(columnAt('a\tb', 2, 4), 4);
  assert.equal(columnAt('éx', 2, 4), 1);
  assert.equal(columnAt('😀x', 2, 4), 1);
  assert.equal(offsetAt('\tab', 4, 4), 1);
  assert.equal(offsetAt('\tab', 2, 4), 1, 'inside a tab: after it');
  assert.equal(offsetAt('ab', 9, 4), 2, 'past the end: the end');
  assert.equal(offsetAt('éx', 1, 4), 2, 'a mark stays with its letter');
  assert.equal(stepColumn('a\tb', 1, 1, 4), 4);
  assert.equal(stepColumn('a\tb', 4, -1, 4), 1);
  assert.equal(stepColumn('a\tb', 2, -1, 4), 1, 'inside a tab: to its start');
  assert.equal(stepColumn('ab', 2, 1, 4), 3, 'past the end, a column at a time');
  assert.equal(stepColumn('ab', 5, -1, 4), 4);
  assert.equal(stepColumn('', 0, -1, 4), 0);
});

// A view's face for commands: the state and dispatch.
function editor(doc, anchor, head = anchor) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [EditorState.allowMultipleSelections.of(true), columnBox] }),
    dispatch(spec) {
      view.state = view.state.update(spec).state;
    },
  };
  return view;
}
const ranges = (view) => view.state.selection.ranges.map((r) => [r.anchor, r.head]);
const texts = (view) => view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to));

test('Shift+Alt+arrows draw a box from the cursor, across short lines', () => {
  const doc = 'alpha one\nbeta\nx\ngamma three';
  const v = editor(doc, 2); // al|pha
  boxDown(v);
  boxDown(v);
  assert.deepEqual(ranges(v), [[2, 2], [12, 12], [16, 16]], 'cursors; the short line gets one at its end');
  boxRight(v);
  boxRight(v);
  assert.deepEqual(texts(v), ['ph', 'ta', '']);
  boxDown(v);
  assert.deepEqual(texts(v), ['ph', 'ta', '', 'mm'], 'the box keeps its width past the short line');
  assert.equal(v.state.selection.mainIndex, 3, 'the head line is the main range');
  boxUp(v);
  boxLeft(v);
  assert.deepEqual(texts(v), ['p', 't', '']);
  // Typing ends the box; the next press goes on from the cursors.
  v.dispatch(v.state.replaceSelection('X'));
  assert.equal(v.state.field(columnBox), null);
  assert.equal(v.state.doc.toString(), 'alXha one\nbeXa\nxX\ngamma three');
  boxDown(v);
  assert.equal(v.state.selection.ranges.length, 4);
  assert.deepEqual(ranges(v).at(-1), [v.state.doc.line(4).from + 3, v.state.doc.line(4).from + 3]);
});

test('a selection becomes the box between its ends; moving left of the anchor flips it', () => {
  const v = editor('abcdef\nabcdef\nabcdef', 1, 3); // a[bc]def
  boxDown(v);
  assert.deepEqual(texts(v), ['bc', 'bc']);
  boxLeft(v);
  boxLeft(v);
  boxLeft(v);
  assert.deepEqual(ranges(v), [[1, 0], [8, 7]], 'the head goes left of the anchor');
  // Right stops at the longest line's end.
  for (let i = 0; i < 9; i++) boxRight(v);
  assert.deepEqual(texts(v), ['bcdef', 'bcdef']);
});

test('Ctrl+Alt+up and down add cursors outward, in the same column', () => {
  const v = editor('one\ntwo\nthree\nfour\nfive', 10); // th|ree... line 3, column 2
  addCursorBelow(v);
  addCursorAbove(v);
  addCursorAbove(v);
  const lines = v.state.selection.ranges.map((r) => v.state.doc.lineAt(r.head).number);
  assert.deepEqual(lines, [1, 2, 3, 4]);
  assert.ok(v.state.selection.ranges.every((r) => r.empty && r.head - v.state.doc.lineAt(r.head).from === 2));
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 1, 'the new cursor is the main one');
  // At the first line there is nothing above: the cursors stay.
  addCursorAbove(v);
  assert.equal(v.state.selection.ranges.length, 4);
});

test('a rectangle made with Alt+drag grows the way the key points', () => {
  const v = editor('abcd\nabcd\nabcd\nabcd', 0);
  v.dispatch({ selection: EditorSelection.create([EditorSelection.range(6, 8), EditorSelection.range(11, 13)]) });
  boxDown(v);
  assert.deepEqual(texts(v), ['bc', 'bc', 'bc']);
  v.dispatch({ selection: EditorSelection.create([EditorSelection.range(6, 8), EditorSelection.range(11, 13)]) });
  boxUp(v);
  assert.deepEqual(texts(v), ['bc', 'bc', 'bc']);
  assert.equal(v.state.doc.lineAt(v.state.selection.main.head).number, 1);
});
