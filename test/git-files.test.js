// The Git panel's picked files (0.52): ranges and toggles, what can be done with them, and the
// ignore patterns that name exactly them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoreChoices, ignorePattern, namesList, pickActions, pickAfterClick, pickedWords, rangeOf, tidyPicked } from '../app/js/gitFiles.js';

test('picking: a box adds or takes out one, Shift picks the range from the last one clicked', () => {
  const rels = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  let picked = pickAfterClick(new Set(), rels, 'b.js');
  assert.deepEqual([...picked], ['b.js']);
  picked = pickAfterClick(picked, rels, 'd.js', { shift: true, anchor: 'b.js' });
  assert.deepEqual([...picked].sort(), ['b.js', 'c.js', 'd.js']);
  // The range back up from the same anchor, and Shift from an anchor not picked takes them out.
  assert.deepEqual([...pickAfterClick(picked, rels, 'a.js', { shift: true, anchor: 'b.js' })].sort(), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual([...pickAfterClick(new Set(['a.js', 'b.js', 'c.js']), rels, 'c.js', { shift: true, anchor: 'e.js' })].sort(), ['a.js', 'b.js']);
  // Shift with nothing picked yet picks the range.
  assert.deepEqual([...pickAfterClick(new Set(), rels, 'c.js', { shift: true, anchor: 'a.js' })].sort(), ['a.js', 'b.js', 'c.js']);
  // An anchor no longer listed: just the one clicked.
  assert.deepEqual([...pickAfterClick(new Set(), rels, 'c.js', { shift: true, anchor: 'gone.js' })], ['c.js']);
  assert.deepEqual([...pickAfterClick(new Set(['b.js']), rels, 'b.js')], []);
  assert.deepEqual(rangeOf(rels, 'd.js', 'b.js'), ['b.js', 'c.js', 'd.js']);
  assert.deepEqual(rangeOf(rels, 'x', 'z'), []);
});

test('after Git is read again: only the files still listed stay picked (the same set when none went)', () => {
  const picked = new Set(['a.js', 'b.js']);
  assert.equal(tidyPicked(picked, ['a.js', 'b.js', 'c.js']), picked);
  assert.deepEqual([...tidyPicked(picked, ['b.js'])], ['b.js']);
});

test('what can be done: per section and kind of file', () => {
  const changes = [
    ['src/app.js', 'M'],
    ['old.txt', 'D'],
    ['notes/todo.log', 'U'],
    ['merge.js', 'C'],
  ];
  const a = pickActions('changes', changes);
  assert.deepEqual(a.stage, ['src/app.js', 'old.txt', 'notes/todo.log', 'merge.js']);
  assert.equal(a.unstage, null);
  assert.deepEqual(a.stash, { paths: ['src/app.js', 'old.txt', 'notes/todo.log'], untracked: true, left: 1 }, 'not a file in conflict; a new file takes untracked ones along');
  assert.deepEqual(a.discard, { paths: ['src/app.js', 'old.txt', 'notes/todo.log'], fresh: 1, left: 1 });
  assert.deepEqual(a.ignore, ['notes/todo.log'], 'Git ignores only what it does not follow');
  assert.deepEqual(a.skip, ['src/app.js'], 'my changes kept out: tracked files changed');
  assert.deepEqual(a.untrack, ['src/app.js'], 'a deleted file has nothing to untrack');
  assert.equal(a.compare, null, 'one modified file only');
  assert.equal(pickActions('changes', [['src/app.js', 'M']]).compare, 'src/app.js');
  assert.equal(pickActions('changes', [['src/app.js', 'M']]).stash.untracked, false);

  const staged = pickActions('staged', [
    ['a.js', 'A'],
    ['b.js', 'M'],
    ['c.js', 'R'],
  ]);
  assert.deepEqual(staged.unstage, ['a.js', 'b.js', 'c.js']);
  assert.equal(staged.stage, null);
  assert.equal(staged.discard, null, 'discard is for changes not staged');
  assert.equal(staged.ignore, null);
  assert.equal(staged.skip, null);
  assert.deepEqual(staged.untrack, ['b.js', 'c.js'], 'a file added only now is unstaged instead');
  assert.equal(pickActions('changes', [['merge.js', 'C']]).stash, null);
  assert.equal(pickActions('changes', [['merge.js', 'C']]).discard, null);
});

test('ignore patterns name exactly these files: anchored, Git’s special characters escaped', () => {
  assert.equal(ignorePattern('build/out.log'), '/build/out.log');
  assert.equal(ignorePattern('a[1]*?.txt'), '/a\\[1\\]\\*\\?.txt');
  assert.equal(ignorePattern('#notes!'), '/\\#notes\\!');
  assert.equal(ignorePattern('trailing  '), '/trailing\\ \\ ');
  assert.equal(ignorePattern('logs', { folder: true }), '/logs/');
  const one = ignoreChoices(['logs/today.log']);
  assert.deepEqual(one.files, { patterns: ['/logs/today.log'], label: 'today.log' });
  assert.deepEqual(one.folders, { patterns: ['/logs/'], label: 'logs/' });
  assert.deepEqual(one.ext, { patterns: ['*.log'], label: 'every .log file' });
  const mixed = ignoreChoices(['a.log', 'tmp/b.txt']);
  assert.equal(mixed.folders, undefined, 'a file at the top: its folder is the whole repository');
  assert.equal(mixed.ext, undefined, 'different kinds');
  assert.equal(mixed.files.label, 'these 2 files');
  assert.equal(ignoreChoices(['Makefile.backup', '.env']).ext, undefined);
});

test('the picked files in words', () => {
  assert.equal(pickedWords(['src/app.js']), 'app.js');
  assert.equal(pickedWords(['a', 'b']), '2 files');
  assert.equal(namesList(['x/a.js', 'b.js', 'c.js'], 2), 'a.js, b.js and 1 more');
});
