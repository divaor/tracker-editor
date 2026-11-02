// A file tab undone back to what the file holds is saved again (model.js afterDiskEdit, used by
// store.js's disk tabs): before 0.48.1 it stayed "Not saved" until saved once more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterDiskEdit, isMarked, textMark } from '../app/js/model.js';

test('textMark: the same text gives the same mark, another text another one', () => {
  const a = textMark('hello world\n');
  assert.deepEqual(a, textMark('hello world\n'));
  assert.equal(a.length, 12);
  assert.ok(Number.isSafeInteger(a.hash) && a.hash >= 0);
  // Same length, one character apart, a swap, case: all different.
  for (const other of ['hello world!', 'hello wrold\n', 'Hello world\n', 'hello world\r']) assert.notEqual(textMark(other).hash, a.hash, other);
  assert.ok(isMarked(a, 'hello world\n'));
  assert.ok(!isMarked(a, 'hello world'));
  assert.ok(!isMarked(null, ''));
  assert.deepEqual(textMark(''), textMark(undefined));
  // Characters past the first plane and long texts.
  assert.notEqual(textMark('😀a').hash, textMark('a😀').hash);
  const big = 'x'.repeat(2_000_000);
  assert.ok(isMarked(textMark(big), big));
  assert.ok(!isMarked(textMark(big), big.slice(1) + 'y'));
});

test('a tab edited, then undone back to what the file holds, is saved again', () => {
  let tab = { text: 'one\ntwo\n', dirty: false };
  const edit = (text) => (tab = { ...tab, ...afterDiskEdit(tab, text) });
  edit('one\ntwo\nthree\n');
  assert.equal(tab.dirty, true);
  assert.deepEqual(tab.saved, textMark('one\ntwo\n'), 'the mark of the text before the first edit');
  edit('one\ntwo\nthree\nfour\n');
  assert.equal(tab.dirty, true);
  edit('one\ntwo\n');
  assert.equal(tab.dirty, false, 'undone all the way back');
  assert.equal(tab.saved, undefined);
  // The same length but other characters is still an edit.
  edit('one\ntwx\n');
  assert.equal(tab.dirty, true);
  edit('one\ntwo\n');
  assert.equal(tab.dirty, false);
});

test('after a save, the saved text is what counts; an old unsaved tab without a mark stays unsaved', () => {
  // store.diskSaved: the tab text moved on while it saved → unsaved, marked with what was written.
  let tab = { text: 'v2 and more', dirty: true, saved: textMark('v2') };
  tab = { ...tab, ...afterDiskEdit(tab, 'v2') };
  assert.equal(tab.dirty, false);
  // Kept unsaved by 0.48.0 (no mark): even text equal to the file's cannot be told, so unsaved.
  let old = { text: 'edited', dirty: true };
  old = { ...old, ...afterDiskEdit(old, 'original') };
  assert.equal(old.dirty, true);
});
