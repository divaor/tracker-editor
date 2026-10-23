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

// 0.13: the folders view's filter looks in the folders inside.
test('names in the folders inside: found under their folders, links and .git left out', async () => {
  const { findNames } = require('../electron/findInFolder.cjs');
  const { nameMatcher } = await import('../app/js/folders.js');
  const tree = {
    '/r/': null,
    '/r/config.yml': '',
    '/r/app/': null,
    '/r/app/deploy/': null,
    '/r/app/deploy/config.yml': '',
    '/r/app/deploy/other.txt': '',
    '/r/app/config/': null,
    '/r/app/config/readme.md': '',
    '/r/.hidden/': null,
    '/r/.hidden/config.yml': '',
    '/r/node_modules/': null,
    '/r/node_modules/config.yml': '',
    '/r/linked/': null,
    '/r/linked/config.yml': '',
  };
  const lister = async (dir) =>
    Object.keys(tree)
      .filter((p) => p !== dir && p.startsWith(dir) && !p.slice(dir.length).replace(/\/$/, '').includes('/'))
      .map((p) => ({ name: p.slice(dir.length).replace(/\/$/, ''), path: p.replace(/\/$/, '') + (p.endsWith('/') ? '/' : ''), dir: p.endsWith('/'), link: p === '/r/linked/' }));
  const res = await findNames({ root: '/r/', list: lister, matches: nameMatcher('config') });
  const paths = (list) => list.map((f) => f.entry.path).sort();
  // config.yml directly in /r/ is left to the listing; the folder named config is found too.
  assert.deepEqual(paths(res.found), ['/r/app/config/', '/r/app/deploy/config.yml']);
  assert.deepEqual(paths(res.folders), ['/r/app/', '/r/app/deploy/']);
  assert.equal(res.found.find((f) => f.entry.name === 'config.yml').parent, '/r/app/deploy/');
  assert.equal(res.truncated, false);
  const hidden = await findNames({ root: '/r/', list: lister, matches: nameMatcher('*.yml'), hidden: true });
  assert.deepEqual(paths(hidden.found), ['/r/.hidden/config.yml', '/r/app/deploy/config.yml']);
  // Limits: results, folders listed, time.
  const few = await findNames({ root: '/r/', list: lister, matches: () => true, maxResults: 2 });
  assert.equal(few.found.length, 2);
  assert.equal(few.truncated, true);
  const shallow = await findNames({ root: '/r/', list: lister, matches: nameMatcher('config'), maxFolders: 1 });
  assert.deepEqual(shallow.found, []);
  assert.equal(shallow.truncated, true);
  let t = 0;
  const slow = await findNames({ root: '/r/', list: lister, matches: nameMatcher('config'), timeLimit: 5, now: () => (t += 10) });
  assert.equal(slow.truncated, true);
  const controller = new AbortController();
  controller.abort();
  const stopped = await findNames({ root: '/r/', list: lister, matches: () => true, signal: controller.signal });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.truncated, false);
});

test('the folders filter: text anywhere in the name, or a pattern', async () => {
  const { nameMatcher, treeRows } = await import('../app/js/folders.js');
  assert.equal(nameMatcher('Conf')('my-config.json'), true);
  assert.equal(nameMatcher('*.yml')('deploy.YML'), true);
  assert.equal(nameMatcher('*.yml')('deploy.yaml'), false);
  assert.equal(nameMatcher('test?.js')('test1.js'), true);
  assert.equal(nameMatcher('a(b')('xa(b'), true);
  assert.equal(nameMatcher('[x].*')('[x].md'), true);
  assert.equal(nameMatcher('  ')('anything'), true);
  const rows = treeRows([{ name: 'app', path: '/r/app', dir: true }, { name: 'b.yml', path: '/r/b.yml' }], {
    query: '*.yml',
    expanded: new Set(['/r/app']),
    children: new Map([['/r/app', [{ name: 'c.yml', path: '/r/app/c.yml' }, { name: 'd.txt', path: '/r/app/d.txt' }]]]),
  });
  assert.deepEqual(rows.map((r) => r.entry.path), ['/r/app', '/r/app/c.yml', '/r/b.yml']);
});

// Ctrl+P: every file in the folders open in Folders, by its path inside them.
test('files in a folder for quick open: nearest first, paths inside, the usual folders left out', async () => {
  const { listFiles } = require('../electron/findInFolder.cjs');
  const tree = {
    '/w/a.txt': '',
    '/w/src/': null,
    '/w/src/main.js': '',
    '/w/src/lib/': null,
    '/w/src/lib/util.js': '',
    '/w/.git/': null,
    '/w/.git/HEAD': '',
    '/w/.env': '',
    '/w/node_modules/': null,
    '/w/node_modules/x.js': '',
    '/w/link/': null,
    '/w/link/far.js': '',
  };
  const lister = async (dir) =>
    Object.keys(tree)
      .filter((p) => p.startsWith(`${dir}/`) && p !== `${dir}/` && !p.slice(dir.length + 1).replace(/\/$/, '').includes('/'))
      .map((p) => ({ name: p.slice(dir.length + 1).replace(/\/$/, ''), path: p.replace(/\/$/, ''), dir: p.endsWith('/'), link: p === '/w/link/', size: 1, mtimeMs: 5 }));
  const res = await listFiles({ root: '/w', list: lister });
  assert.deepEqual(res.files.map((f) => f.rel), ['a.txt', 'src/main.js', 'src/lib/util.js']);
  assert.deepEqual(res.files[2], { path: '/w/src/lib/util.js', name: 'util.js', rel: 'src/lib/util.js', size: 1, mtimeMs: 5 });
  assert.equal(res.truncated, false);
  const withHidden = await listFiles({ root: '/w/', list: async (d) => lister(d.replace(/\/$/, '')), hidden: true });
  assert.deepEqual(withHidden.files.map((f) => f.rel), ['a.txt', '.env', 'src/main.js', 'src/lib/util.js']);
  const few = await listFiles({ root: '/w', list: lister, maxFiles: 2 });
  assert.deepEqual(few.files.map((f) => f.rel), ['a.txt', 'src/main.js']);
  assert.equal(few.truncated, true);
  // Windows paths come out with "/".
  const win = await listFiles({ root: 'C:\\w', list: async (d) => (d === 'C:\\w' ? [{ name: 'd', path: 'C:\\w\\d', dir: true }] : [{ name: 'x.md', path: 'C:\\w\\d\\x.md', dir: false }]) });
  assert.deepEqual(win.files.map((f) => f.rel), ['d/x.md']);
});
