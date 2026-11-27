// Where things go in a comparison side by side (app/js/diffLayout.js) and the unified view's
// chunks from lineDiff.js (app/js/diffView.js unifiedDiff, through @codemirror/merge's state:
// no view needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkAtLine, firstVisible, mapThrough, ribbonPath, scrollPoints, stepChunk } from '../app/js/diffLayout.js';
import { EditorState, getChunks, getOriginalDoc } from '../app/vendor/cm/codemirror.js';
import { unifiedDiff } from '../app/js/diffView.js';

// Lines 2-3 changed, 3 lines added on the right before line 10, line 20 removed on the right.
const chunks = [
  { a0: 2, a1: 4, b0: 2, b1: 4, kind: 'modify' },
  { a0: 10, a1: 10, b0: 10, b1: 13, kind: 'insert' },
  { a0: 20, a1: 21, b0: 23, b1: 23, kind: 'delete' },
];

test('the chunk at a line, on either side', () => {
  assert.equal(chunkAtLine(chunks, 'a', 0), -1);
  assert.equal(chunkAtLine(chunks, 'a', 3), 0);
  assert.equal(chunkAtLine(chunks, 'a', 4), -1);
  // No lines on the left: it counts on the line after its place.
  assert.equal(chunkAtLine(chunks, 'a', 10), 1);
  assert.equal(chunkAtLine(chunks, 'b', 12), 1);
  assert.equal(chunkAtLine(chunks, 'b', 13), -1);
  assert.equal(chunkAtLine(chunks, 'b', 23), 2);
  assert.equal(chunkAtLine(chunks, 'a', 20), 2);
  // Lines added just above changed ones: the changed lines win where the cursor is on them.
  const near = [{ a0: 5, a1: 5, b0: 5, b1: 7 }, { a0: 5, a1: 6, b0: 7, b1: 8 }];
  assert.equal(chunkAtLine(near, 'a', 5), 1);
  assert.equal(chunkAtLine(near, 'b', 5), 0);
});

test('stepping from chunk to chunk, around the ends', () => {
  assert.equal(stepChunk(chunks, 'a', 0, 1), 0);
  assert.equal(stepChunk(chunks, 'a', 2, 1), 1);
  assert.equal(stepChunk(chunks, 'a', 15, 1), 2);
  assert.equal(stepChunk(chunks, 'a', 30, 1), 0);
  assert.equal(stepChunk(chunks, 'a', 30, -1), 2);
  assert.equal(stepChunk(chunks, 'a', 15, -1), 1);
  assert.equal(stepChunk(chunks, 'b', 11, -1), 0);
  assert.equal(stepChunk(chunks, 'a', 1, -1), 2);
  assert.equal(stepChunk([], 'a', 1, 1), -1);
});

test('scrolling in step: alike between chunks, each side its own height across one', () => {
  // 20 px lines; the bounds of the chunks above on each side.
  const y = (n) => n * 20;
  const bounds = chunks.map((c) => [y(c.a0), y(c.a1), y(c.b0), y(c.b1)]);
  const { a, b } = scrollPoints(bounds, y(30), y(32), 10);
  for (let i = 1; i < a.length; i++) assert.ok(a[i] >= a[i - 1] && b[i] >= b[i - 1], 'both rise');
  assert.equal(mapThrough(a, b, y(1)), y(1));
  assert.equal(mapThrough(a, b, y(6)), y(6));
  // Past the added lines the right is 3 lines further down; past the removed one, 2.
  assert.equal(mapThrough(a, b, y(15)), y(18));
  assert.equal(mapThrough(b, a, y(18)), y(15));
  assert.equal(mapThrough(a, b, y(25)), y(27));
  // Across the place of the added lines the right side goes through them (over a line, not a jump).
  const before = mapThrough(a, b, y(10) - 10);
  const after = mapThrough(a, b, y(10) + 10);
  assert.equal(before, y(10) - 10);
  assert.equal(after, y(13) + 10);
  assert.ok(mapThrough(a, b, y(10)) > before && mapThrough(a, b, y(10)) < after);
  // Past the end: on in step.
  assert.equal(mapThrough(a, b, y(40)), y(42));
  assert.equal(firstVisible(bounds, y(5)), 1);
  assert.equal(firstVisible(bounds, y(30)), 3);
});

test('a ribbon: curves from the left band to the right one', () => {
  const { fill, edges } = ribbonPath(40, 10, 30, 50, 90);
  assert.equal(fill, 'M0 10C20 10 20 50 40 50L40 90C20 90 20 30 0 30Z');
  assert.equal(edges, 'M0 10C20 10 20 50 40 50M0 30C20 30 20 90 40 90');
});

test('the unified view takes its chunks from lineDiff.js and keeps them as either text changes', () => {
  const a = ['<?php', 'class A {', '  const X = 1;', '', '  function index($args, $filter = "1")', '  {', '    return 1;', '  }', '}', ''].join('\n');
  const b = ['<?php', 'class A {', '  const X = 1;', "  const T = 'view';", "  const U = 'app';", '', '  function index($args, $filter = "2")', '  {', '    return 1;', '  }', '}', ''].join('\n');
  let state = EditorState.create({ doc: b, extensions: unifiedDiff({ original: a, mergeControls: false }, {}) });
  const list = (st) => getChunks(st).chunks.map((c) => [c.fromA, c.toA, c.fromB, c.toB, c.changes.map((m) => b.slice(c.fromB + m.fromB, c.fromB + m.toB))]);
  assert.deepEqual(list(state), [
    [31, 31, 31, 70, []],
    [32, 71, 71, 110, ['2']],
  ]);
  const at = state.doc.toString().indexOf('"2"') + 1;
  state = state.update({ changes: { from: at, to: at + 1, insert: '1' } }).state;
  assert.equal(getChunks(state).chunks.length, 1);
  // Lines added after a last line without a line break take that line in, as the package's own
  // chunks would (a block cannot start past the end of a text).
  const end = EditorState.create({ doc: 'x\ny\nz', extensions: unifiedDiff({ original: 'x\ny', mergeControls: false }, {}) });
  assert.deepEqual(
    getChunks(end).chunks.map((c) => [c.fromA, c.toA, c.fromB, c.toB]),
    [[2, 4, 2, 6]],
  );
  // Whitespace and highlighting options reach it.
  const spaces = EditorState.create({ doc: 'a  \nb', extensions: unifiedDiff({ original: 'a\nb', mergeControls: false }, { whitespace: 'trim' }) });
  assert.equal(getChunks(spaces).chunks.length, 0);
  assert.equal(getOriginalDoc(spaces).toString(), 'a\nb');
});
