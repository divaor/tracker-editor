// Two folders compared (folderCompare.js): each entry's state from both listings, folders
// taking their contents' state, the rows shown, counts, what to check, where the next
// difference is, and what a copy or making one side like the other does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareListings, copyPlan, countStates, nextDifference, safeRel, syncPlan, toCheck, treeRows } from '../app/js/folderCompare.js';

const T = 1_700_000_000_000;
const file = (size, mtimeMs = T) => ({ dir: false, size, mtimeMs });
const dir = () => ({ dir: true, size: 0, mtimeMs: T });

const LEFT = {
  'README.md': file(10),
  src: dir(),
  'src/app.js': file(100),
  'src/util.js': file(50),
  'src/same-size.js': file(70, T),
  'src/old.js': file(5),
  docs: dir(),
  'docs/a.md': file(3),
  only: dir(),
  'only/x.txt': file(1),
  'only/deep': dir(),
  'only/deep/y.txt': file(2),
  clash: dir(),
};
const RIGHT = {
  'README.md': file(10, T + 1000), // within the slack: the same
  src: dir(),
  'src/app.js': file(120), // another size
  'src/util.js': file(50),
  'src/same-size.js': file(70, T + 60_000), // same size, another date: unsure
  'src/new.js': file(9),
  docs: dir(),
  'docs/a.md': file(3),
  clash: file(4),
};

test('each entry is the same, different, on one side, unsure, or a folder against a file', () => {
  const e = compareListings(LEFT, RIGHT);
  const state = (rel) => e.get(rel).state;
  assert.equal(state('README.md'), 'same');
  assert.equal(state('src/app.js'), 'changed');
  assert.equal(state('src/util.js'), 'same');
  assert.equal(state('src/same-size.js'), 'unsure');
  assert.equal(state('src/old.js'), 'left');
  assert.equal(state('src/new.js'), 'right');
  assert.equal(state('clash'), 'kind');
  // Folders take what is inside them.
  assert.equal(state('src'), 'changed');
  assert.equal(state('docs'), 'same');
  assert.equal(state('only'), 'left');
  assert.equal(state('only/deep/y.txt'), 'left');
  // What the content check found settles the unsure ones.
  assert.equal(compareListings(LEFT, RIGHT, { checked: { 'src/same-size.js': true } }).get('src/same-size.js').state, 'same');
  assert.equal(compareListings(LEFT, RIGHT, { checked: { 'src/same-size.js': false } }).get('src/same-size.js').state, 'changed');
  // A folder whose only difference is unsure is unsure itself.
  const onlyUnsure = compareListings({ d: dir(), 'd/f': file(1, T) }, { d: dir(), 'd/f': file(1, T + 99_000) });
  assert.equal(onlyUnsure.get('d').state, 'unsure');
});

test('the rows shown: differences by default, under open folders, folders first', () => {
  const e = compareListings(LEFT, RIGHT);
  const rels = (opts) => treeRows(e, opts).map((r) => r.rel);
  assert.deepEqual(rels({}), ['clash', 'only', 'src']);
  assert.deepEqual(rels({ expanded: new Set(['src', 'only']) }), ['clash', 'only', 'only/deep', 'only/x.txt', 'src', 'src/app.js', 'src/new.js', 'src/old.js', 'src/same-size.js']);
  assert.deepEqual(rels({ show: 'all' }), ['clash', 'docs', 'only', 'src', 'README.md']);
  assert.deepEqual(rels({ show: 'all', expanded: new Set(['docs']) }), ['clash', 'docs', 'docs/a.md', 'only', 'src', 'README.md']);
  assert.deepEqual(rels({ show: 'left', expanded: new Set(['src', 'only']) }), ['only', 'only/deep', 'only/x.txt', 'src', 'src/old.js']);
  assert.deepEqual(rels({ show: 'right', expanded: new Set(['src']) }), ['src', 'src/new.js']);
});

test('counts: files, a folder on one side once, folders on both sides through their files', () => {
  assert.deepEqual(countStates(compareListings(LEFT, RIGHT)), { same: 3, changed: 1, left: 2, right: 1, unsure: 1, kind: 1 });
});

test('what to check: same size, another date, small enough, smallest first', () => {
  const e = compareListings({ a: file(9, T), b: file(3, T), big: file(50_000_000, T) }, { a: file(9, T + 9000), b: file(3, T + 9000), big: file(50_000_000, T + 9000) });
  assert.deepEqual(toCheck(e), ['b', 'a']);
});

test('the next difference, the one before, wrapping around; none when all are the same', () => {
  const e = compareListings(LEFT, RIGHT);
  const rows = treeRows(e, { show: 'all', expanded: new Set(['src', 'docs', 'only', 'only/deep']) });
  assert.equal(nextDifference(rows, null), 'clash');
  assert.equal(nextDifference(rows, 'clash'), 'only');
  assert.equal(nextDifference(rows, 'src/app.js'), 'src/new.js');
  assert.equal(nextDifference(rows, 'src/same-size.js'), 'clash');
  assert.equal(nextDifference(rows, 'src/app.js', -1), 'only/x.txt');
  assert.equal(nextDifference(treeRows(compareListings({ a: file(1) }, { a: file(1) }), { show: 'all' }), null), null);
});

test('copying: files that are the same stay, a folder on both sides is gone through, one on one side goes whole', () => {
  const e = compareListings(LEFT, RIGHT);
  assert.deepEqual(copyPlan(e, ['src'], 'left'), { copy: ['src/app.js', 'src/old.js', 'src/same-size.js'], same: 1, missing: 1 });
  assert.deepEqual(copyPlan(e, ['only', 'only/x.txt'], 'left'), { copy: ['only'], same: 0, missing: 0 });
  assert.deepEqual(copyPlan(e, ['src/new.js'], 'right'), { copy: ['src/new.js'], same: 0, missing: 0 });
  assert.deepEqual(copyPlan(e, ['clash'], 'right').copy, ['clash']);
});

test('making one side like the other: what is copied there, and what is only there', () => {
  const e = compareListings(LEFT, RIGHT);
  assert.deepEqual(syncPlan(e, 'right'), { copy: ['clash', 'only', 'src/app.js', 'src/old.js', 'src/same-size.js'], extra: ['src/new.js'] });
  assert.deepEqual(syncPlan(e, 'left'), { copy: ['clash', 'src/app.js', 'src/new.js', 'src/same-size.js'], extra: ['only', 'src/old.js'] });
});

test('relative paths from a listing: plain names only', () => {
  assert.ok(safeRel('a/b.txt'));
  for (const bad of ['', '/a', 'a//b', '../a', 'a/../b', 'a/./b', 'a\\b', null]) assert.equal(safeRel(bad), false, String(bad));
});

test('a file inside a folder, as the app addresses it: on a server, here, on Windows', async () => {
  const { childPath } = await import('../app/js/folderCompare.js');
  assert.equal(childPath('remote://box/srv/', 'a/b.txt'), 'remote://box/srv/a/b.txt');
  assert.equal(childPath('/home/me/site', 'a/b.txt'), '/home/me/site/a/b.txt');
  assert.equal(childPath('C:\\Users\\me\\site', 'a/b.txt'), 'C:\\Users\\me\\site\\a\\b.txt');
  assert.equal(childPath('D:\\', 'x.txt'), 'D:\\x.txt');
});
