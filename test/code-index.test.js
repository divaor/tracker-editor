// Code across the open folders: where a name is declared (F12 in another file) and the
// symbols of every file (Ctrl+T), read again only when a file changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { declarationKind } from '../app/js/codeNav.js';
import { outline } from '../app/js/outline.js';
import { fuzzyScore } from '../app/js/search.js';

const require = createRequire(import.meta.url);
const { findDeclarations, createSymbolIndex } = require('../electron/codeIndex.cjs');

// A folder tree in memory: path → text (or null for a folder), with mtimes.
function fakeFs(tree) {
  const mtimes = new Map(Object.keys(tree).map((p) => [p, 1]));
  let reads = 0;
  return {
    tree,
    mtimes,
    reads: () => reads,
    list: async (dir) =>
      Object.keys(tree)
        .filter((p) => p.startsWith(`${dir}/`) && p !== `${dir}/` && !p.slice(dir.length + 1).replace(/\/$/, '').includes('/'))
        .map((p) => ({ name: p.slice(dir.length + 1).replace(/\/$/, ''), path: p.replace(/\/$/, ''), dir: p.endsWith('/'), size: (tree[p] ?? '').length, mtimeMs: mtimes.get(p) })),
    read: async (p) => {
      reads++;
      return Buffer.from(tree[p] ?? '');
    },
    decode: (b) => b.toString('utf8'),
  };
}
const languageFor = (name) => ({ js: 'JavaScript', py: 'Python', go: 'Go' })[name.split('.').pop()] ?? null;

test('where a name is declared, in other files of the folders', async () => {
  const fs = fakeFs({
    '/w/src/': null,
    '/w/src/store.js': 'export class Store {\n  save() {}\n}\n',
    '/w/src/app.js': "import { Store } from './store.js';\nconst s = new Store();\nlet count = 0;\n",
    '/w/lib/': null,
    '/w/lib/util.py': 'def make_store():\n    return Store()\n',
    '/w/node_modules/': null,
    '/w/node_modules/x.js': 'class Store {}\n',
    '/w/notes.md': '# Store\n',
  });
  const base = { roots: ['/w'], list: fs.list, read: fs.read, decode: fs.decode, isCode: (n) => Boolean(languageFor(n)), kindOf: declarationKind };
  const r = await findDeclarations({ ...base, word: 'Store' });
  // The class, and the import (a declaration in its file too); not node_modules or Markdown.
  assert.deepEqual(r.found.map((f) => `${f.path}:${f.line}:${f.column}`).sort(), ['/w/src/app.js:1:10', '/w/src/store.js:1:14']);
  assert.equal(r.found.find((f) => f.path === '/w/src/store.js').text, 'export class Store {');
  // Only assignments: given when nothing stronger is.
  const count = await findDeclarations({ ...base, word: 'count' });
  assert.deepEqual(count.found.map((f) => `${f.path}:${f.line}`), ['/w/src/app.js:3']);
  assert.deepEqual((await findDeclarations({ ...base, word: 'nowhere' })).found, []);
  // Limits.
  let t = 0;
  const slow = await findDeclarations({ ...base, word: 'Store', timeLimit: 5, now: () => (t += 10) });
  assert.equal(slow.truncated, true);
});

test('symbols of every file: ranked by name, read again only when changed', async () => {
  const fs = fakeFs({
    '/w/a.js': 'class Store {\n  save(name) {\n  }\n}\nfunction makeStore() {}\n',
    '/w/b.py': 'def store_items():\n    pass\n',
    '/w/c.go': 'package x\n\nfunc Restore() {}\n',
    '/w/readme.md': '# Store\n',
  });
  const index = createSymbolIndex({ list: fs.list, read: fs.read, decode: fs.decode, outline, languageFor, score: fuzzyScore });
  const first = await index.refresh('/w');
  assert.deepEqual(first, { files: 3, symbols: 5, truncated: false });
  const found = index.query(['/w'], 'store');
  assert.deepEqual(found.map((s) => s.title), ['Store', 'store_items', 'Restore', 'makeStore']);
  assert.deepEqual(found[0], { line: 1, level: 1, title: 'Store', column: 7, path: '/w/a.js' });
  assert.deepEqual(index.query(['/w'], 'save').map((s) => `${s.title}@${s.path}:${s.line}`), ['save@/w/a.js:2']);
  assert.deepEqual(index.query(['/other'], 'store'), []);
  // Unchanged files are not read again; a changed one is; a removed one goes.
  const reads = fs.reads();
  await index.refresh('/w');
  assert.equal(fs.reads(), reads);
  fs.tree['/w/b.py'] = 'def other():\n    pass\n';
  fs.mtimes.set('/w/b.py', 2);
  delete fs.tree['/w/c.go'];
  await index.refresh('/w');
  assert.equal(fs.reads(), reads + 1);
  assert.deepEqual(index.query(['/w'], 'store').map((s) => s.title), ['Store', 'makeStore']);
  index.forget('/w');
  assert.deepEqual(index.query(['/w'], ''), []);
});
