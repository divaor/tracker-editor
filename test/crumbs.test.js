// The breadcrumbs (crumbs.js): a tab's place (a folder shown in Folders, a server, My files, the
// tracker), the symbols around the cursor, a symbol's siblings and children, and a folder's
// listing as a crumb's menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingRows, placeCrumbs, symbolChildren, symbolCrumbs, symbolSiblings, topSymbols } from '../app/js/crumbs.js';

const labels = (crumbs) => crumbs.map((c) => c.label);
const kinds = (crumbs) => crumbs.map((c) => c.kind);

test('a file on this computer: from the folder shown in Folders that holds it (the deepest one)', () => {
  const roots = ['/home/ana/work', '/home/ana/work/site'];
  const c = placeCrumbs({ key: 'd:/home/ana/work/site/src/lib/store.js', roots });
  assert.deepEqual(labels(c), ['site', 'src', 'lib', 'store.js']);
  assert.deepEqual(kinds(c), ['root', 'folder', 'folder', 'file']);
  assert.equal(c[0].path, '/home/ana/work/site');
  assert.equal(c[2].path, '/home/ana/work/site/src/lib');
  assert.equal(c[3].path, '/home/ana/work/site/src/lib/store.js');
  // Right in the folder shown.
  assert.deepEqual(labels(placeCrumbs({ key: 'd:/home/ana/work/site/README.md', roots })), ['site', 'README.md']);
});

test('Windows paths, and a file in no folder shown: the last folders above it', () => {
  const c = placeCrumbs({ key: 'd:C:\\Users\\ana\\proj\\app\\main.py', roots: ['C:\\Users\\ana\\proj'] });
  assert.deepEqual(labels(c), ['proj', 'app', 'main.py']);
  assert.equal(c[1].path, 'C:\\Users\\ana\\proj\\app');
  const loose = placeCrumbs({ key: 'd:/tmp/downloads/today/notes.txt', roots: ['/home/ana/work'] });
  assert.deepEqual(labels(loose), ['downloads', 'today', 'notes.txt']);
  assert.deepEqual(kinds(loose), ['folder', 'folder', 'file']);
  assert.deepEqual(labels(placeCrumbs({ key: 'd:/tmp/downloads/today/notes.txt', keep: 1 })), ['today', 'notes.txt']);
});

test('a file on a server: the server, then its path (from a folder shown when one holds it)', () => {
  const name = (id) => (id === 'abc' ? 'web box' : '');
  const c = placeCrumbs({ key: 'd:remote://abc/var/www/site/index.php', serverName: name });
  assert.deepEqual(labels(c), ['web box', 'var', 'www', 'site', 'index.php']);
  assert.deepEqual(kinds(c), ['server', 'folder', 'folder', 'folder', 'file']);
  assert.equal(c[0].path, 'remote://abc/');
  assert.equal(c[3].path, 'remote://abc/var/www/site');
  const shown = placeCrumbs({ key: 'd:remote://abc/var/www/site/inc/db.php', serverName: name, roots: ['remote://abc/var/www/site'] });
  assert.deepEqual(labels(shown), ['web box', 'site', 'inc', 'db.php']);
  assert.deepEqual(kinds(shown), ['server', 'root', 'folder', 'file']);
  // A server without a name, a file at its top.
  assert.deepEqual(labels(placeCrumbs({ key: 'd:remote://xyz/notes.txt' })), ['Server', 'notes.txt']);
});

test('synced files and tracker documents', () => {
  assert.deepEqual(labels(placeCrumbs({ key: 'f:1', file: { name: 'plan.md', project: 'Deep Time' } })), ['My files', 'Deep Time', 'plan.md']);
  assert.deepEqual(kinds(placeCrumbs({ key: 'f:1', file: { name: 'plan.md', project: '' } })), ['files', 'file']);
  assert.deepEqual(placeCrumbs({ key: 'f:1', file: null }), []);
  const doc = placeCrumbs({ key: 'r:files/2026-x/report.md', doc: { name: 'report.md', item: { id: 'i1', title: 'Quarterly report' } } });
  assert.deepEqual(labels(doc), ['Tracker', 'Quarterly report', 'report.md']);
  assert.equal(doc[1].itemId, 'i1');
  assert.deepEqual(labels(placeCrumbs({ key: 'r:files/x/a.txt' })), ['Tracker', 'a.txt']);
  // A file another Android app gave: its name only.
  assert.deepEqual(kinds(placeCrumbs({ key: 'd:content://com.app/doc/42', doc: { name: 'Notes.txt' } })), ['file']);
  assert.deepEqual(placeCrumbs({ key: 'c:5' }), []);
});

// An outline as outline.js gives it: a class with methods, then functions.
const OUTLINE = [
  { line: 1, level: 1, title: 'Store' },
  { line: 3, level: 2, title: 'load' },
  { line: 9, level: 2, title: 'save' },
  { line: 15, level: 2, title: 'clear' },
  { line: 20, level: 1, title: 'helper' },
  { line: 30, level: 1, title: 'Cache' },
  { line: 31, level: 2, title: 'get' },
];

test('the symbols around the cursor, a symbol’s siblings and children', () => {
  const scope = [OUTLINE[0], OUTLINE[2]];
  const crumbs = symbolCrumbs(OUTLINE, scope);
  assert.deepEqual(crumbs.map((c) => [c.label, c.index, c.line]), [
    ['Store', 0, 1],
    ['save', 2, 9],
  ]);
  assert.deepEqual(symbolSiblings(OUTLINE, 2).map((e) => e.title), ['load', 'save', 'clear']);
  assert.deepEqual(symbolSiblings(OUTLINE, 6).map((e) => e.title), ['get']);
  assert.deepEqual(symbolSiblings(OUTLINE, 0).map((e) => e.title), ['Store', 'helper', 'Cache']);
  assert.deepEqual(symbolChildren(OUTLINE, 0).map((e) => [e.title, e.index]), [
    ['load', 1],
    ['save', 2],
    ['clear', 3],
  ]);
  assert.deepEqual(symbolChildren(OUTLINE, 4), []);
  assert.deepEqual(symbolChildren(OUTLINE, 99), []);
  assert.deepEqual(topSymbols(OUTLINE).map((e) => e.title), ['Store', 'helper', 'Cache']);
  assert.deepEqual(topSymbols([]), []);
  // Markdown headings: children are the next level down only.
  const md = [
    { line: 1, level: 1, title: 'Guide' },
    { line: 3, level: 2, title: 'Start' },
    { line: 5, level: 3, title: 'Install' },
    { line: 9, level: 2, title: 'Use' },
  ];
  assert.deepEqual(symbolChildren(md, 0).map((e) => e.title), ['Start', 'Use']);
  assert.deepEqual(symbolSiblings(md, 2).map((e) => e.title), ['Install']);
  // Entries not in the outline (another version of it) are left out.
  assert.deepEqual(symbolCrumbs(OUTLINE, [{ line: 1, level: 1, title: 'Store' }]), []);
});

test('a folder’s listing as a crumb’s menu: folders first, by name, hidden ones only when shown, capped', () => {
  const entries = [
    { name: 'b.js', path: '/p/b.js' },
    { name: 'src', path: '/p/src', dir: true },
    { name: '.env', path: '/p/.env', hidden: true },
    { name: 'a10.js', path: '/p/a10.js' },
    { name: 'a9.js', path: '/p/a9.js' },
    { name: 'docs', path: '/p/docs', dir: true },
  ];
  const { rows, more } = listingRows(entries);
  assert.deepEqual(rows.map((r) => r.name), ['docs', 'src', 'a9.js', 'a10.js', 'b.js']);
  assert.equal(more, 0);
  assert.ok(listingRows(entries, { hidden: true }).rows.some((r) => r.name === '.env'));
  assert.deepEqual(listingRows(entries, { filesOnly: true }).rows.map((r) => r.name), ['a9.js', 'a10.js', 'b.js']);
  const capped = listingRows(entries, { max: 2 });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.more, 3);
});
