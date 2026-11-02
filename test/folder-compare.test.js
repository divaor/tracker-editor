// Two folders compared (folderCompare.js): each entry's state from both listings, folders
// taking their contents' state, the rows shown, counts, what to check, where the next
// difference is, and what a copy or making one side like the other does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, choicePlan, compareListings, copyPlan, countStates, defaultChoice, folderChoice, folderChoices, nextDifference, presetChoice, presetChoices, safeRel, setChoice, syncPlan, syncUnits, toCheck, treeRows, withChecks } from '../app/js/folderCompare.js';

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

test('content checks are kept with the sizes and dates they were for: read again, only what changed is unsure', () => {
  const e = compareListings(LEFT, RIGHT);
  const checked = withChecks({}, e, { 'src/same-size.js': true, 'src/gone.js': true });
  assert.deepEqual(Object.keys(checked), ['src/same-size.js'], 'only what is listed is kept');
  assert.equal(checked['src/same-size.js'].key, checkKey(LEFT['src/same-size.js'], RIGHT['src/same-size.js']));
  // Both folders read again, nothing changed: still the same, nothing to check.
  const again = compareListings({ ...LEFT }, { ...RIGHT }, { checked });
  assert.equal(again.get('src/same-size.js').state, 'same');
  assert.equal(again.get('src').state, 'changed');
  assert.deepEqual(toCheck(again), []);
  // The right one saved again since (another date): not known until checked again.
  const touched = compareListings(LEFT, { ...RIGHT, 'src/same-size.js': file(70, T + 120_000) }, { checked });
  assert.equal(touched.get('src/same-size.js').state, 'unsure');
  assert.deepEqual(toCheck(touched), ['src/same-size.js']);
  // Could not tell: different, to be looked at; the old true/false form still works.
  assert.equal(compareListings(LEFT, RIGHT, { checked: withChecks(checked, e, { 'src/same-size.js': null }) }).get('src/same-size.js').state, 'changed');
  assert.equal(compareListings(LEFT, RIGHT, { checked: { 'src/same-size.js': true } }).get('src/same-size.js').state, 'same');
});

test('while contents are checked, the differences leave out the unsure files (and folders holding only those)', () => {
  const e = compareListings(LEFT, RIGHT);
  const rels = (opts) => treeRows(e, { expanded: new Set(['src']), ...opts }).map((r) => r.rel);
  assert.ok(rels({}).includes('src/same-size.js'));
  assert.ok(!rels({ hideUnsure: new Set(['src/same-size.js']) }).includes('src/same-size.js'));
  assert.ok(!rels({ hideUnsure: true }).includes('src/same-size.js'));
  assert.ok(rels({ hideUnsure: new Set(['other']) }).includes('src/same-size.js'), 'only the ones named');
  // Everything shows them anyway (as not known yet).
  assert.ok(rels({ show: 'all', hideUnsure: true }).includes('src/same-size.js'));
  // A folder whose only differences are being checked does not show at all.
  const onlyUnsure = compareListings({ d: dir(), 'd/f': file(1, T), 'd/g': file(2, T) }, { d: dir(), 'd/f': file(1, T + 99_000), 'd/g': file(2, T + 99_000) });
  assert.deepEqual(treeRows(onlyUnsure, { expanded: new Set(['d']) }).map((r) => r.rel), ['d', 'd/f', 'd/g']);
  assert.deepEqual(treeRows(onlyUnsure, { expanded: new Set(['d']), hideUnsure: new Set(['d/f', 'd/g']) }), []);
  assert.deepEqual(treeRows(onlyUnsure, { expanded: new Set(['d']), hideUnsure: new Set(['d/f']) }).map((r) => r.rel), ['d', 'd/g']);
});

// Two copies of a project, with dates: what a sync does.
const SL = {
  'a.txt': file(5, T + 600_000), // newer on the left
  'b.txt': file(6, T), // newer on the right
  'c.txt': file(7, T), // another size, the same date
  'd.txt': file(8, T), // same size, another date: not checked yet
  lib: dir(),
  'lib/x.js': file(3, T),
  'lib/onlyleft.js': file(1),
  'lib/same.js': file(2),
  newdir: dir(),
  'newdir/inner.txt': file(1),
  thing: dir(),
  'thing/inside.txt': file(1),
};
const SR = {
  'a.txt': file(50, T),
  'b.txt': file(60, T + 600_000),
  'c.txt': file(70, T),
  'd.txt': file(8, T + 600_000),
  lib: dir(),
  'lib/x.js': file(30, T + 600_000),
  'lib/onlyright.js': file(1),
  'lib/same.js': file(2),
  'gone.txt': file(4),
  thing: file(9),
};

test('a sync works on units: files that differ, what is on one side only (top-most), a folder against a file', () => {
  const e = compareListings(SL, SR);
  assert.deepEqual(syncUnits(e), ['lib/onlyleft.js', 'lib/onlyright.js', 'lib/x.js', 'newdir', 'thing', 'a.txt', 'b.txt', 'c.txt', 'd.txt', 'gone.txt']);
});

test('newer replaces older: a different file goes to the older side, one side only is copied, the rest skipped', () => {
  const e = compareListings(SL, SR);
  const c = (rel) => defaultChoice(e.get(rel));
  assert.equal(c('a.txt'), 'right');
  assert.equal(c('b.txt'), 'left');
  assert.equal(c('c.txt'), 'skip', 'the same date: which one is newer is not known');
  assert.equal(c('d.txt'), 'skip', 'not checked yet');
  assert.equal(c('newdir'), 'right');
  assert.equal(c('gone.txt'), 'left');
  assert.equal(c('thing'), 'skip', 'a folder against a file');
  // Once checked and different, the newer one wins.
  const checked = compareListings(SL, SR, { checked: { 'd.txt': false } });
  assert.equal(defaultChoice(checked.get('d.txt')), 'left');
});

test('presets: everything to one side copies only; exactly like deletes too; skip all', () => {
  const e = compareListings(SL, SR);
  const all = (preset) => Object.fromEntries(presetChoices(e, preset));
  assert.deepEqual(all('right'), { 'lib/onlyleft.js': 'right', 'lib/onlyright.js': 'skip', 'lib/x.js': 'right', newdir: 'right', thing: 'right', 'a.txt': 'right', 'b.txt': 'right', 'c.txt': 'right', 'd.txt': 'skip', 'gone.txt': 'skip' });
  assert.deepEqual(all('mirror-left'), { 'lib/onlyleft.js': 'left', 'lib/onlyright.js': 'left', 'lib/x.js': 'left', newdir: 'left', thing: 'left', 'a.txt': 'left', 'b.txt': 'left', 'c.txt': 'left', 'd.txt': 'skip', 'gone.txt': 'left' });
  assert.ok([...presetChoices(e, 'skip').values()].every((c) => c === 'skip'));
  assert.equal(presetChoice(e.get('a.txt'), 'newer'), 'right');
  // The person's own choices win over the preset's.
  assert.equal(presetChoices(e, 'right', new Map([['a.txt', 'left'], ['gone.txt', 'bogus']])).get('a.txt'), 'left');
  assert.equal(presetChoices(e, 'right', new Map([['gone.txt', 'bogus']])).get('gone.txt'), 'skip');
});

test('setting a choice: a folder gives it to what is inside; copying never deletes; ✕ deletes each on its side', () => {
  const e = compareListings(SL, SR);
  const lib = setChoice(new Map(), e, ['lib'], 'right');
  assert.deepEqual(Object.fromEntries(lib), { 'lib/onlyleft.js': 'right', 'lib/onlyright.js': 'skip', 'lib/x.js': 'right' });
  const choices = (o) => presetChoices(e, 'skip', o);
  assert.equal(folderChoice(choices(lib), 'lib'), 'right', 'what goes, goes right (one skipped)');
  const mixed = setChoice(lib, e, ['lib/onlyright.js'], 'left');
  assert.equal(folderChoices(choices(mixed)).get('lib'), 'mixed');
  assert.equal(folderChoice(choices(setChoice(mixed, e, ['lib'], 'skip')), 'lib'), 'skip');
  assert.equal(folderChoice(choices(new Map()), 'nowhere'), null);
  // ✕ on several picked rows: what is on one side only is deleted there; the rest stays.
  const del = setChoice(new Map([['a.txt', 'left']]), e, ['newdir', 'gone.txt', 'a.txt', 'lib'], 'delete');
  assert.deepEqual(Object.fromEntries(del), { 'a.txt': 'left', newdir: 'left', 'gone.txt': 'right', 'lib/onlyleft.js': 'left', 'lib/onlyright.js': 'right' });
  // Copying a row only on the left to the left would delete it: skipped instead.
  assert.equal(setChoice(new Map(), e, ['newdir'], 'left').get('newdir'), 'skip');
  // Inside a folder on one side: the folder is the unit.
  assert.deepEqual(Object.fromEntries(setChoice(new Map(), e, ['newdir/inner.txt'], 'right')), {});
});

test('the plan: copies each way (and what they replace), deletions, what is left alone', () => {
  const e = compareListings(SL, SR);
  assert.deepEqual(choicePlan(e, presetChoices(e, 'mirror-right')), {
    toRight: ['lib/onlyleft.js', 'lib/x.js', 'newdir', 'thing', 'a.txt', 'b.txt', 'c.txt'],
    toLeft: [],
    deleteLeft: [],
    deleteRight: ['lib/onlyright.js', 'gone.txt'],
    replaceRight: 5,
    replaceLeft: 0,
    skipped: 1,
  });
  const newer = choicePlan(e, presetChoices(e, 'newer'));
  assert.deepEqual(newer.toRight, ['lib/onlyleft.js', 'newdir', 'a.txt']);
  assert.deepEqual(newer.toLeft, ['lib/onlyright.js', 'lib/x.js', 'b.txt', 'gone.txt']);
  assert.equal(newer.replaceRight, 1);
  assert.equal(newer.replaceLeft, 2);
  assert.equal(newer.skipped, 3);
  assert.deepEqual([newer.deleteLeft, newer.deleteRight], [[], []]);
});
