// The edit bar and the line-number menu (editKeys.js): the keyboard's state, the lines a tap
// selects, Select line, and what Copy and Cut take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '../app/vendor/cm/codemirror.js';
import { clipRanges, codeOfKey, EDIT_SYMBOLS, KEYBOARD_MIN, keyboardState, lineTapSelection, linesRange, selectLineRanges } from '../app/js/editKeys.js';

const TEXT = 'one\ntwo\nthree\nfour';
const at = (ranges, text = TEXT) =>
  EditorState.create({ doc: text, selection: EditorSelection.create(ranges.map(([a, h = a]) => EditorSelection.range(a, h))), extensions: EditorState.allowMultipleSelections.of(true) });

test('the keyboard is up while the page is much shorter than its full height at that width', () => {
  let s = keyboardState(null, { width: 390, height: 800 });
  assert.equal(s.open, false);
  s = keyboardState(s, { width: 390, height: 760 });
  assert.equal(s.open, false, 'the address bar showing is not the keyboard');
  s = keyboardState(s, { width: 390, height: 800 - KEYBOARD_MIN - 10 });
  assert.equal(s.open, true);
  s = keyboardState(s, { width: 390, height: 800 });
  assert.equal(s.open, false, 'back to full height: down');
  // Turned sideways with the keyboard up: a width not seen yet keeps the last answer…
  s = keyboardState(keyboardState(s, { width: 390, height: 420 }), { width: 844, height: 180 });
  assert.equal(s.open, true);
  // …until the keyboard goes down there and the full height is known.
  s = keyboardState(s, { width: 844, height: 390 });
  assert.equal(s.open, false);
  s = keyboardState(s, { width: 844, height: 180 });
  assert.equal(s.open, true);
  // Back upright: that width's full height is remembered.
  assert.equal(keyboardState(s, { width: 390, height: 800 }).open, false);
  assert.equal(keyboardState(s, { width: 390.4, height: 430 }).open, true);
});

test('lines with their line break, the last one without', () => {
  const { doc } = at([[0]]);
  assert.deepEqual(linesRange(doc, 2), { from: 4, to: 8 });
  assert.deepEqual(linesRange(doc, 3, 2), { from: 4, to: 14 });
  assert.deepEqual(linesRange(doc, 4), { from: 14, to: 18 });
  assert.deepEqual(linesRange(doc, 0, 99), { from: 0, to: 18 });
});

test('a tap on a line number selects the line; with Shift, from the selection to it', () => {
  assert.deepEqual(lineTapSelection(at([[0]]), 4, 7), { anchor: 4, head: 8 });
  // A folded block: all of it.
  assert.deepEqual(lineTapSelection(at([[0]]), 4, 13), { anchor: 4, head: 14 });
  // Extending down from a selected line, and up from it (selected upwards).
  const line2 = at([[4, 8]]);
  assert.deepEqual(lineTapSelection(line2, 14, 18, { extend: true }), { anchor: 4, head: 18 });
  assert.deepEqual(lineTapSelection(line2, 0, 3, { extend: true }), { anchor: 8, head: 0 });
  // From a cursor.
  assert.deepEqual(lineTapSelection(at([[9]]), 14, 18, { extend: true }), { anchor: 8, head: 18 });
});

test('Select line takes the lines touched, then one more each time', () => {
  const sel = (state) => selectLineRanges(state).map((r) => [r.anchor, r.head]);
  assert.deepEqual(sel(at([[5]])), [[4, 8]]);
  assert.deepEqual(sel(at([[4, 8]])), [[4, 14]], 'already whole: one more below');
  assert.deepEqual(sel(at([[5, 10]])), [[4, 14]]);
  assert.deepEqual(sel(at([[15]])), [[14, 18]], 'the last line');
  assert.deepEqual(sel(at([[14, 18]])), [[14, 18]], 'nothing below it');
  assert.deepEqual(sel(at([[1], [9]])), [[0, 4], [8, 14]], 'each cursor');
});

test('Copy takes the selection, or the whole line when nothing is selected', () => {
  assert.deepEqual(clipRanges(at([[4, 7]])), { text: 'two', ranges: [{ from: 4, to: 7 }] });
  assert.deepEqual(clipRanges(at([[5]])), { text: 'two\n', ranges: [{ from: 4, to: 8 }] });
  // The last line: Cut takes the break before it, so no empty line is left.
  assert.deepEqual(clipRanges(at([[16]])), { text: 'four\n', ranges: [{ from: 13, to: 18 }] });
  assert.deepEqual(clipRanges(at([[1]], 'only')), { text: 'only\n', ranges: [{ from: 0, to: 4 }] });
  // Several selections join with line breaks; cursors among them are left out.
  assert.deepEqual(clipRanges(at([[0, 3], [5], [8, 13]])), { text: 'one\nthree', ranges: [{ from: 0, to: 3 }, { from: 8, to: 13 }] });
  // Two cursors on one line copy it once; neighbouring lines merge into one range to cut.
  assert.deepEqual(clipRanges(at([[1], [2], [5]])), { text: 'one\ntwo\n', ranges: [{ from: 0, to: 8 }] });
});

test('synthetic keys carry the code a keyboard would', () => {
  assert.equal(codeOfKey('a'), 'KeyA');
  assert.equal(codeOfKey('Z'), 'KeyZ');
  assert.equal(codeOfKey('7'), 'Digit7');
  assert.equal(codeOfKey('/'), 'Slash');
  assert.equal(codeOfKey('ArrowLeft'), 'ArrowLeft');
  assert.equal(codeOfKey('Tab'), 'Tab');
  assert.equal(codeOfKey('§'), '');
  // The symbols row: one character each, none twice.
  assert.equal(new Set(EDIT_SYMBOLS).size, EDIT_SYMBOLS.length);
  assert.ok(EDIT_SYMBOLS.every((c) => [...c].length === 1));
});
