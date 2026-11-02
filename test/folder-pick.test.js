// The folder picker's tree (folderPick.js): blocks by root, rows listed as folders open, the
// filter over what is listed, revealing a folder, and where a folder is in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockFor, moveIn, parentPath, pathKey, pickBlocks, pickRows, quickFolders, revealChain, rowKey, samePath, subfolders, trailLabel } from '../app/js/folderPick.js';

const done = (...names) => ({ state: 'done', folders: names.map((n) => (typeof n === 'string' ? { name: n.split('/').pop(), path: n, hidden: n.split('/').pop().startsWith('.') } : n)), truncated: false });

test('the folder a folder is in, here and on a server', () => {
  assert.equal(parentPath('/home/ana/site'), '/home/ana');
  assert.equal(parentPath('/home/ana/site/'), '/home/ana');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '');
  assert.equal(parentPath('C:\\Users\\ana\\site'), 'C:\\Users\\ana');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('C:\\'), '');
  assert.equal(parentPath('\\\\nas\\share\\site'), '\\\\nas\\share');
  assert.equal(parentPath('\\\\nas\\share'), '');
  assert.equal(parentPath('remote://s1/var/www/site'), 'remote://s1/var/www');
  assert.equal(parentPath('remote://s1/var'), 'remote://s1/');
  assert.equal(parentPath('remote://s1/'), '');
  assert.equal(parentPath(''), '');
});

test('paths as keys: no separator at the end, Windows without case', () => {
  assert.equal(pathKey('/home/ana/'), '/home/ana');
  assert.equal(pathKey('/'), '/');
  assert.equal(pathKey('C:\\Users\\Ana\\'), 'c:\\users\\ana');
  assert.equal(pathKey('C:\\'), 'c:\\');
  assert.equal(pathKey('remote://s1/var/www/'), 'remote://s1/var/www');
  assert.equal(pathKey('remote://s1/'), 'remote://s1/');
  assert.ok(samePath('C:\\Site', 'c:\\site\\'));
  assert.ok(!samePath('/Site', '/site'));
  assert.ok(!samePath('', ''));
});

test('a listing becomes its folders, by name (numbers in order)', () => {
  const entries = [
    { name: 'b.txt', path: '/p/b.txt', dir: false },
    { name: 'v10', path: '/p/v10', dir: true },
    { name: 'v9', path: '/p/v9', dir: true },
    { name: '.git', path: '/p/.git', dir: true, hidden: true },
    { name: 'Alpha', path: '/p/Alpha', dir: true },
  ];
  assert.deepEqual(
    subfolders(entries).map((f) => f.name),
    ['.git', 'Alpha', 'v9', 'v10'],
  );
  assert.equal(subfolders(entries)[0].hidden, true);
  // A server's listing says nothing of hidden: a dot name is.
  assert.equal(subfolders([{ name: '.cache', path: 'remote://s/.cache', dir: true }])[0].hidden, true);
});

test('blocks: next to the other side, the folders in Folders, picked before, servers', () => {
  const blocks = pickBlocks({
    other: '/work/site/v2',
    shown: ['/work/site', 'remote://s1/var/www'],
    picked: ['/work/site', '/work/site/v2', '/data', 'remote://x/'],
    servers: ['s1', 's2'],
    connected: { s2: 'remote://s2/home/ana' },
  });
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.root, b.server]),
    [
      // /work/site is the other side's folder and a block already: no "next" block for it.
      ['shown', '/work/site', ''],
      ['shown', 'remote://s1/var/www', 's1'],
      ['picked', '/data', ''],
      // s1 has a folder in Folders; s2 is connected: its start folder.
      ['server', 'remote://s2/home/ana', 's2'],
    ],
  );
  // Deeper: the folder holding the other side comes first.
  const deeper = pickBlocks({ other: '/work/site/releases/v2', shown: ['/work/site'] });
  assert.deepEqual(deeper.map((b) => [b.id, b.root]), [
    ['next', '/work/site/releases'],
    ['shown:/work/site', '/work/site'],
  ]);
  // Not connected yet: no root; the other side at a server's top has nothing above it.
  assert.deepEqual(pickBlocks({ other: 'remote://s3/', servers: ['s3'] }).map((b) => [b.kind, b.root]), [['server', '']]);
  // Nothing to compare with yet (two panes from nowhere): no "next".
  assert.deepEqual(pickBlocks({ shown: ['/a', '/a'] }).map((b) => b.id), ['shown:/a']);
});

test('rows: heads, the folders of open ones, and what a listing says', () => {
  const blocks = [
    { id: 'A', root: '/a', label: 'a' },
    { id: 'S', root: '', label: 'My server' },
  ];
  const listings = new Map([
    ['/a', done('/a/src', '/a/.git', '/a/docs')],
    ['/a/src', done('/a/src/lib')],
    ['/a/docs', { state: 'done', folders: [], truncated: false }],
  ]);
  const rows = pickRows(blocks, { expanded: new Set(['/a', '/a/src', '/a/src/lib']), listings, other: '/a/docs' });
  assert.deepEqual(
    rows.map((r) => [r.type, r.name ?? r.state, r.depth]),
    [
      ['head', 'a', 0],
      ['folder', 'src', 1],
      ['folder', 'lib', 2],
      // lib is open but not listed yet.
      ['status', 'loading', 3],
      ['folder', 'docs', 1],
      ['head', 'My server', 0],
    ],
  );
  const docs = rows.find((r) => r.name === 'docs');
  assert.equal(docs.isOther, true);
  // Listed and empty: nothing to open.
  assert.equal(docs.canOpen, false);
  assert.equal(rows.find((r) => r.name === 'src').canOpen, true);
  assert.equal(rows[0].key, rowKey('A'));
  assert.equal(docs.key, rowKey('A', '/a/docs'));
  // Hidden folders when asked.
  assert.ok(pickRows(blocks, { expanded: new Set(['/a']), listings, hidden: true }).some((r) => r.name === '.git'));
  // A closed head shows nothing under it.
  assert.deepEqual(pickRows(blocks, { listings }).map((r) => r.type), ['head', 'head']);
});

test('rows: an error, an empty folder and a listing cut short say so', () => {
  const blocks = [{ id: 'A', root: '/a', label: 'a' }];
  const err = pickRows(blocks, { expanded: new Set(['/a']), listings: new Map([['/a', { state: 'error', error: 'No access' }]]) });
  assert.deepEqual(err.map((r) => [r.type, r.state, r.error]), [
    ['head', undefined, undefined],
    ['status', 'error', 'No access'],
  ]);
  const empty = pickRows(blocks, { expanded: new Set(['/a']), listings: new Map([['/a', done()]]) });
  assert.equal(empty[1].state, 'empty');
  const cut = pickRows(blocks, { expanded: new Set(['/a']), listings: new Map([['/a', { ...done('/a/x'), truncated: true }]]) });
  assert.deepEqual(cut.map((r) => r.state ?? r.name), ['a', 'x', 'truncated']);
});

test('the filter keeps what fits among everything listed, and the folders on the way', () => {
  const blocks = [
    { id: 'A', root: '/a', label: 'site' },
    { id: 'B', root: '/b', label: 'backup' },
    { id: 'S', root: '', label: 'Production' },
  ];
  const listings = new Map([
    ['/a', done('/a/src', '/a/docs')],
    ['/a/src', done('/a/src/components', '/a/src/lib')],
    ['/a/src/components', done('/a/src/components/button')],
    ['/b', done('/b/old')],
  ]);
  // /a/src is closed, but listed: its folders count.
  const rows = pickRows(blocks, { expanded: new Set(['/a']), listings, filter: 'butt' });
  assert.deepEqual(
    rows.map((r) => [r.name, r.depth, r.open, Boolean(r.match)]),
    [
      ['site', 0, true, false],
      ['src', 1, true, false],
      ['components', 2, true, false],
      ['button', 3, false, true],
    ],
  );
  // A head that fits stays alone; patterns work as in Folders.
  assert.deepEqual(pickRows(blocks, { listings, filter: 'back' }).map((r) => r.name), ['backup']);
  assert.deepEqual(pickRows(blocks, { listings, filter: 'prod*' }).map((r) => r.name), ['Production']);
  assert.deepEqual(pickRows(blocks, { listings, filter: 'nothing like it' }), []);
});

test('revealing a folder opens its block down to the folder holding it', () => {
  assert.deepEqual(revealChain('/a/src/lib/x', '/a'), ['/a', '/a/src', '/a/src/lib']);
  assert.deepEqual(revealChain('/a', '/a'), []);
  assert.deepEqual(revealChain('/elsewhere/x', '/a'), []);
  assert.deepEqual(revealChain('C:\\Site\\src\\lib', 'C:\\Site'), ['C:\\Site', 'C:\\Site\\src']);
  assert.deepEqual(revealChain('remote://s1/var/www/site/img', 'remote://s1/var/www'), ['remote://s1/var/www', 'remote://s1/var/www/site']);
  assert.deepEqual(revealChain('remote://s1/var/www', 'remote://s1/'), ['remote://s1/', 'remote://s1/var']);
  // Another server is not inside.
  assert.deepEqual(revealChain('remote://s2/var/www', 'remote://s1/'), []);
});

test('which block a folder is in: the deepest root holding it', () => {
  const blocks = [
    { id: 'next', root: '/a/src' },
    { id: 'A', root: '/a' },
    { id: 'S', root: '' },
    { id: 'R', root: 'remote://s1/home/ana' },
  ];
  assert.equal(blockFor('/a/src/lib', blocks).id, 'next');
  assert.equal(blockFor('/a/src/lib', blocks.filter((b) => b.id !== 'next')).id, 'A');
  assert.equal(blockFor('/a', blocks).id, 'A');
  assert.equal(blockFor('/b', blocks), null);
  assert.equal(blockFor('remote://s1/home/ana/www', blocks).id, 'R');
  assert.equal(blockFor('remote://s1/etc', blocks), null);
});

test('where a folder is, in words: its block, then the folders down to it', () => {
  assert.equal(trailLabel('/work/site/src/lib', '/work/site', 'site'), 'site › src › lib');
  assert.equal(trailLabel('/work/site', '/work/site', 'site'), 'site');
  assert.equal(trailLabel('C:\\work\\site\\src', 'C:\\work\\site', 'site'), 'site › src');
  assert.equal(trailLabel('remote://s1/var/www/site', 'remote://s1/var/www', 'www'), 'www › site');
  assert.equal(trailLabel('/other', '/work/site', 'site'), null);
});

test('moving with the keys passes over status rows and stays in a block for parent and child', () => {
  const rows = [
    { type: 'head', key: 'A|', block: 'A', depth: 0 },
    { type: 'folder', key: 'A|/a/src', block: 'A', depth: 1 },
    { type: 'status', key: 'A|/a/src|loading', block: 'A', depth: 2 },
    { type: 'folder', key: 'A|/a/docs', block: 'A', depth: 1 },
    { type: 'head', key: 'B|', block: 'B', depth: 0 },
  ];
  assert.equal(moveIn(rows, 'A|/a/src', 'down'), 'A|/a/docs');
  assert.equal(moveIn(rows, 'A|/a/docs', 'up'), 'A|/a/src');
  assert.equal(moveIn(rows, 'A|', 'up'), 'A|');
  assert.equal(moveIn(rows, 'B|', 'down'), 'B|');
  assert.equal(moveIn(rows, null, 'down'), 'A|');
  assert.equal(moveIn(rows, 'A|/a/docs', 'home'), 'A|');
  assert.equal(moveIn(rows, 'A|', 'end'), 'B|');
  assert.equal(moveIn(rows, 'A|/a/docs', 'parent'), 'A|');
  assert.equal(moveIn(rows, 'A|', 'parent'), 'A|');
  assert.equal(moveIn(rows, 'A|', 'child'), 'A|/a/src');
  // A head's next row in another block is not its child.
  assert.equal(moveIn(rows, 'B|', 'child'), 'B|');
  assert.equal(moveIn([], 'x', 'down'), null);
});

test('chips: favorites, then recent folders not among them, without the other side', () => {
  assert.deepEqual(quickFolders(['/a', '/b'], ['/b/', '/c', '/x'], { leave: '/x' }), [
    { path: '/a', kind: 'favorite' },
    { path: '/b', kind: 'favorite' },
    { path: '/c', kind: 'recent' },
  ]);
  assert.equal(quickFolders(['/1', '/2', '/3'], ['/4'], { max: 2 }).length, 2);
  assert.deepEqual(quickFolders(undefined, undefined), []);
});
