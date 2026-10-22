// 0.10: mirrors (a server folder kept the same as one here), with both sides in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planMirror, runMirror, conflictName, excluder } = require('../electron/mirror.cjs');

let clock = 1_000_000;
const tick = () => (clock += 5000);

/** Two sides in memory: files (rel → { data, mtimeMs }) and folders. */
function world({ local = {}, remote = {} } = {}) {
  const make = (files) => ({ files: new Map(Object.entries(files).map(([rel, data]) => [rel, { data, mtimeMs: tick() }])), dirs: new Set() });
  const L = make(local);
  const R = make(remote);
  let saved = null;
  const list = (side) => {
    const out = {};
    for (const [rel, f] of side.files) {
      out[rel] = { dir: false, size: f.data.length, mtimeMs: f.mtimeMs };
      for (let d = rel; d.includes('/'); ) {
        d = d.slice(0, d.lastIndexOf('/'));
        out[d] = { dir: true, size: 0, mtimeMs: 0 };
      }
    }
    for (const d of side.dirs) out[d] = { dir: true, size: 0, mtimeMs: 0 };
    return out;
  };
  const stat = (side, rel) => {
    const f = side.files.get(rel);
    return f && { dir: false, size: f.data.length, mtimeMs: f.mtimeMs };
  };
  const trashed = [];
  const io = {
    listLocal: async () => list(L),
    listRemote: async () => list(R),
    readState: async () => saved && JSON.parse(JSON.stringify(saved)),
    writeState: async (s) => (saved = JSON.parse(JSON.stringify(s))),
    upload: async (rel) => {
      R.files.set(rel, { data: L.files.get(rel).data, mtimeMs: tick() });
      return { l: stat(L, rel), r: stat(R, rel) };
    },
    download: async (rel, as = rel) => {
      L.files.set(as, { data: R.files.get(rel).data, mtimeMs: tick() });
      return as === rel ? { l: stat(L, as), r: stat(R, rel) } : { l: stat(L, as) };
    },
    sameContent: async (rel) => L.files.get(rel).data === R.files.get(rel).data,
    trashLocal: async (rel) => (trashed.push(rel), L.files.delete(rel)),
    removeRemote: async (rel) => R.files.delete(rel),
    mkdirLocal: async (rel) => L.dirs.add(rel),
    mkdirRemote: async (rel) => R.dirs.add(rel),
    removeDirLocal: async (rel) => L.dirs.delete(rel),
    removeDirRemote: async (rel) => R.dirs.delete(rel),
  };
  const edit = (side, rel, data) => side.files.set(rel, { data, mtimeMs: tick() });
  const read = (side) => Object.fromEntries([...side.files].map(([rel, f]) => [rel, f.data]).sort());
  return { L, R, io, edit, read, trashed, state: () => saved };
}
const when = new Date(2026, 9, 22, 15, 4);
const sync = (w, mode = 'both', opts = {}) => runMirror({ mode }, w.io, { now: () => when, ...opts });

test('the first sync: what is on one side goes to the other, the same file is no conflict', async () => {
  const w = world({ local: { 'a.txt': 'A', 'same.txt': 'S', 'both.txt': 'mine!' }, remote: { 'b/b.txt': 'B', 'same.txt': 'S', 'both.txt': 'theirs' } });
  const r = await sync(w);
  assert.equal(r.uploaded, 1);
  assert.equal(r.downloaded, 1);
  assert.deepEqual(r.conflicts, [{ rel: 'both.txt', copy: 'both (server copy 2026-10-22 15.04).txt' }]);
  const expected = { 'a.txt': 'A', 'b/b.txt': 'B', 'both (server copy 2026-10-22 15.04).txt': 'theirs', 'both.txt': 'mine!', 'same.txt': 'S' };
  assert.deepEqual(w.read(w.L), expected);
  assert.deepEqual(w.read(w.R), expected, 'both versions on both sides');
  const again = await sync(w);
  assert.deepEqual([again.uploaded, again.downloaded, again.conflicts.length, again.deletedLocal], [0, 0, 0, 0], 'nothing to do the second time');
});

test('changes go across; deletions too (on the server only when agreed)', async () => {
  const w = world({ local: { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' }, remote: {} });
  await sync(w);
  w.edit(w.L, 'a.txt', 'A2');
  w.edit(w.R, 'b.txt', 'B2');
  let r = await sync(w);
  assert.deepEqual([r.uploaded, r.downloaded], [1, 1]);
  assert.equal(w.R.files.get('a.txt').data, 'A2');
  assert.equal(w.L.files.get('b.txt').data, 'B2');
  // Deleted on the server: here it goes to the Recycle Bin.
  w.R.files.delete('b.txt');
  r = await sync(w);
  assert.equal(r.deletedLocal, 1);
  assert.deepEqual(w.trashed, ['b.txt']);
  // Deleted here: the server's copy waits for a yes.
  w.L.files.delete('c.txt');
  r = await sync(w);
  assert.deepEqual(r.waiting, ['c.txt']);
  assert.ok(w.R.files.has('c.txt'));
  r = await sync(w);
  assert.deepEqual(r.waiting, ['c.txt'], 'still waiting');
  r = await sync(w, 'both', { confirmDeletes: true });
  assert.equal(r.deletedRemote, 1);
  assert.ok(!w.R.files.has('c.txt'));
  assert.ok(!('c.txt' in w.state().files));
});

test('a deletion here can be undone from the server instead', async () => {
  const w = world({ local: { 'keep.txt': 'K' } });
  await sync(w);
  w.L.files.delete('keep.txt');
  assert.deepEqual((await sync(w)).waiting, ['keep.txt']);
  const r = await sync(w, 'both', { restore: ['keep.txt'] });
  assert.equal(r.downloaded, 1);
  assert.equal(w.L.files.get('keep.txt').data, 'K');
  assert.deepEqual((await sync(w)).waiting, []);
});

test('an edit wins over a deletion on the other side; the same edit on both is no conflict', async () => {
  const w = world({ local: { 'x.txt': 'X', 'y.txt': 'Y', 'z.txt': 'Z' } });
  await sync(w);
  w.R.files.delete('x.txt');
  w.edit(w.L, 'x.txt', 'X edited');
  w.L.files.delete('y.txt');
  w.edit(w.R, 'y.txt', 'Y edited');
  w.edit(w.L, 'z.txt', 'Z2');
  w.edit(w.R, 'z.txt', 'Z2');
  const r = await sync(w);
  assert.equal(w.R.files.get('x.txt').data, 'X edited');
  assert.equal(w.L.files.get('y.txt').data, 'Y edited');
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.waiting, []);
});

test('one way: download only and upload only', async () => {
  const w = world({ remote: { 'a.txt': 'A', 'b.txt': 'B' }, local: { 'mine.txt': 'M' } });
  let r = await sync(w, 'download');
  assert.deepEqual(w.read(w.L), { 'a.txt': 'A', 'b.txt': 'B', 'mine.txt': 'M' });
  assert.ok(!w.R.files.has('mine.txt'), 'nothing goes up');
  w.edit(w.L, 'a.txt', 'local edit');
  w.edit(w.R, 'a.txt', 'server edit');
  w.L.files.delete('b.txt');
  r = await sync(w, 'download');
  assert.equal(w.L.files.get('a.txt').data, 'server edit', 'the server wins');
  assert.ok(w.R.files.has('b.txt') && r.waiting.length === 0, 'a deletion here is not sent');
  const u = world({ local: { 'a.txt': 'A' }, remote: { 'theirs.txt': 'T' } });
  await sync(u, 'upload');
  assert.deepEqual(u.read(u.R), { 'a.txt': 'A', 'theirs.txt': 'T' });
  assert.ok(!u.L.files.has('theirs.txt'), 'nothing comes down');
});

test('folders: made where missing, removed when deleted on the other side', async () => {
  const w = world({ local: { 'docs/a.md': 'A' } });
  w.L.dirs.add('empty');
  await sync(w);
  assert.ok(w.R.dirs.has('empty'), 'an empty folder is made on the server');
  w.R.dirs.delete('empty');
  await sync(w);
  assert.ok(!w.L.dirs.has('empty'), 'and removed here when it is deleted there');
});

test('a side that looks wiped out stops the sync', async () => {
  const w = world({ local: { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' } });
  await sync(w);
  w.L.files.clear();
  await assert.rejects(sync(w), /folder on this computer is empty or missing/);
  assert.equal(w.R.files.size, 5, 'nothing deleted on the server');
});

test('names and patterns', () => {
  assert.equal(conflictName('a/b/report.pdf', when), 'a/b/report (server copy 2026-10-22 15.04).pdf');
  assert.equal(conflictName('Makefile', when), 'Makefile (server copy 2026-10-22 15.04)');
  const out = excluder();
  assert.equal(out('.git/config'), true);
  assert.equal(out('src/node_modules/x.js'), true);
  assert.equal(out('~$report.docx'), true);
  assert.equal(out('src/app.js'), false);
  assert.equal(excluder('*.log, build')('build/out.js'), true);
  assert.deepEqual(planMirror({ local: {}, remote: {} }).upload, []);
});

test('only the deletions agreed to are made on the server', async () => {
  const w = world({ local: { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' } });
  await sync(w);
  w.L.files.delete('a.txt');
  w.L.files.delete('b.txt');
  assert.deepEqual((await sync(w)).waiting, ['a.txt', 'b.txt']);
  const r = await sync(w, 'both', { confirmDeletes: ['a.txt'] });
  assert.equal(r.deletedRemote, 1);
  assert.ok(!w.R.files.has('a.txt') && w.R.files.has('b.txt'));
  assert.deepEqual(r.waiting, ['b.txt'], 'the other still waits');
});

test('the server going away stops the sync; the next one finishes it', async () => {
  const w = world({ local: { 'a.txt': 'A', 'b.txt': 'B' } });
  await sync(w);
  w.edit(w.L, 'a.txt', 'A2');
  w.edit(w.L, 'b.txt', 'B2');
  const upload = w.io.upload;
  w.io.upload = async () => {
    throw Object.assign(new Error('The server disconnected during the sync'), { fatal: true });
  };
  await assert.rejects(sync(w), /disconnected/);
  w.io.upload = upload;
  const r = await sync(w);
  assert.equal(r.uploaded, 2);
  assert.equal(w.R.files.get('b.txt').data, 'B2');
});

test('a file changed during the sync is not written over: it is looked at again', async () => {
  const w = world({ local: { 'a.txt': 'A' } });
  await sync(w);
  w.edit(w.R, 'a.txt', 'from the server');
  const download = w.io.download;
  w.io.download = async () => {
    throw new Error('changed here during the sync; it is looked at again next time.');
  };
  const r = await sync(w);
  assert.equal(r.errors.length, 1);
  w.io.download = download;
  await sync(w);
  assert.equal(w.L.files.get('a.txt').data, 'from the server');
});
