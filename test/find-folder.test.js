// 0.10: find in a folder (the walk, without a disk or a server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findInFiles } from '../app/js/search.js';
import { opensInEditor } from '../app/js/folders.js';

const require = createRequire(import.meta.url);
const { findInFolder, nameFilter } = require('../electron/findInFolder.cjs');
const { decode } = require('../electron/diskFiles.cjs');

// A folder tree: path → text (folders end with /).
const TREE = {
  '/r/': null,
  '/r/a.js': 'const todo = 1;\n// TODO: more\n',
  '/r/b.md': '# Notes\nnothing here\n',
  '/r/logo.png': 'binary',
  '/r/data.bin': 'x\u0000y TODO',
  '/r/big.log': 'TODO '.repeat(100),
  '/r/.env': 'TODO=secret',
  '/r/src/': null,
  '/r/src/c.js': 'export const x = "todo";\n',
  '/r/node_modules/': null,
  '/r/node_modules/lib.js': 'TODO in a dependency',
  '/r/.git/': null,
  '/r/.git/HEAD': 'TODO',
};
const list = async (dir) =>
  Object.keys(TREE)
    .filter((p) => p !== dir && p.startsWith(dir) && !p.slice(dir.length).replace(/\/$/, '').includes('/'))
    .map((p) => ({ name: p.slice(dir.length).replace(/\/$/, ''), path: p, dir: p.endsWith('/'), size: TREE[p]?.length ?? 0 }));
const read = async (p) => Buffer.from(TREE[p]);
const run = (query, opts = {}) => {
  const found = [];
  return findInFolder({
    root: '/r/',
    list,
    read,
    decode: (b) => decode(b).text,
    match: (name, text) => findInFiles([{ id: name, name, text }], query, opts.search ?? {}).files[0] ?? null,
    isText: opensInEditor,
    relative: (p) => p.slice(3),
    onFound: (f) => found.push(f),
    maxSize: 200,
    ...opts,
  }).then((stats) => ({ stats, found: found.map((f) => `${f.name}:${f.count}`).sort() }));
};

test('find in a folder: into folders inside, never .git or node_modules', async () => {
  const { stats, found } = await run('todo');
  assert.deepEqual(found, ['a.js:2', 'src/c.js:1']);
  assert.equal(stats.found, 2);
  assert.deepEqual(stats.skipped, { large: 1, binary: 2, unreadable: 0 }, 'big.log is large; logo.png by its name and data.bin by its bytes are not text');
  assert.equal(stats.truncated, false);
});

test('find in a folder: options, hidden files, file names', async () => {
  assert.deepEqual((await run('TODO', { search: { caseSensitive: true } })).found, ['a.js:1']);
  assert.deepEqual((await run('TODO', { hidden: true, search: { caseSensitive: true } })).found, ['.env:1', 'a.js:1'], 'hidden files when asked (still not .git)');
  assert.deepEqual((await run('todo', { files: '*.md, src' })).found, [], 'only *.md and names with "src"');
  assert.deepEqual((await run('todo', { files: '*.js, !c.js' })).found, ['a.js:2']);
});

test('find in a folder: limits and stopping', async () => {
  const one = await run('todo', { maxResults: 1 });
  assert.equal(one.found.length, 1);
  assert.equal(one.stats.truncated, true);
  const controller = new AbortController();
  controller.abort();
  const stopped = await run('todo', { signal: controller.signal });
  assert.equal(stopped.stats.stopped, true);
  assert.deepEqual(stopped.found, []);
});

test('file name filters', () => {
  const f = nameFilter('*.log, !debug*');
  assert.equal(f('app.log'), true);
  assert.equal(f('debug.log'), false);
  assert.equal(f('app.txt'), false);
  assert.equal(nameFilter('')('anything'), true);
  assert.equal(nameFilter('report')('Q3 Report.md'), true);
});
