// Folder comparisons in the main process (folderCompare.cjs): listings here and on a stand-in
// server, what they leave out, byte-for-byte checks, paths inside a folder only by plain names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fc = require('../electron/folderCompare.cjs');
const isRemote = (p) => p.startsWith('remote://');

const tree = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fcmp-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
};

test('a folder here: its files and folders, without .git, node_modules, partial transfers (and dot names when asked)', async () => {
  const root = tree({ 'a.txt': 'a', 'src/b.js': 'bb', 'node_modules/x/i.js': '', '.git/HEAD': '', '.env': 'k', 'up.bin.part-1a2b3c': '' });
  const io = { remote: null, isRemote };
  const all = await fc.listSide(root, { ...io, skip: fc.skipper() });
  assert.deepEqual(Object.keys(all).sort(), ['.env', 'a.txt', 'src', 'src/b.js']);
  assert.deepEqual(all['src/b.js'].size, 2);
  assert.equal(all.src.dir, true);
  assert.deepEqual(Object.keys(await fc.listSide(root, { ...io, skip: fc.skipper({ hidden: false }) })).sort(), ['a.txt', 'src', 'src/b.js']);
  assert.ok('node_modules/x/i.js' in (await fc.listSide(root, { ...io, skip: fc.skipper({ all: true }) })));
  await assert.rejects(fc.listSide(root, { ...io, skip: fc.skipper(), max: 2 }), /More than 2 files and folders/);
});

test('a folder on a server: its listing, through remote.cjs', async () => {
  const asked = [];
  const remote = { listTree: async (uri, skip, max) => (asked.push([uri, skip('x/.git'), max]), { 'r.txt': { dir: false, size: 1, mtimeMs: 5 } }) };
  assert.deepEqual(await fc.listSide('remote://box/srv', { remote, isRemote, skip: fc.skipper() }), { 'r.txt': { dir: false, size: 1, mtimeMs: 5 } });
  assert.deepEqual(asked, [['remote://box/srv', true, fc.MAX_ENTRIES]]);
});

test('the same bytes or not, here and on a server; null when it cannot tell', async () => {
  const a = tree({ 'f.txt': 'hello', 'g.txt': 'hellO' });
  const io = { remote: { readBytes: async (uri) => (uri.endsWith('missing') ? Promise.reject(new Error('Not found')) : Buffer.from('hello')) }, isRemote };
  assert.equal(await fc.sameFiles(path.join(a, 'f.txt'), 'remote://box/f.txt', io), true);
  assert.equal(await fc.sameFiles(path.join(a, 'g.txt'), 'remote://box/f.txt', io), false);
  assert.equal(await fc.sameFiles(path.join(a, 'f.txt'), 'remote://box/missing', io), null);
  assert.equal(await fc.sameFiles(path.join(a, 'f.txt'), path.join(a, 'g.txt'), { ...io, max: 2 }), null);
});

test('paths inside a folder are made of plain names only', () => {
  assert.equal(fc.joinRel('remote://box/srv/', 'a/b.txt', isRemote), 'remote://box/srv/a/b.txt');
  assert.equal(fc.joinRel('/home/me/site', 'a/b.txt', isRemote), path.join('/home/me/site', 'a', 'b.txt'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\..\\b', '']) assert.throws(() => fc.joinRel('/home/me/site', bad, isRemote), /not a path inside/);
});

test('what to copy, by the folder it goes into', () => {
  assert.deepEqual([...fc.byParent(['a.txt', 'src/b.js', 'src/c.js', 'src/deep/d.js'])], [['', ['a.txt']], ['src', ['src/b.js', 'src/c.js']], ['src/deep', ['src/deep/d.js']]]);
});
