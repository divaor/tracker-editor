// Compare with…: the open tabs nearest the open one first, then sections for the files in the
// folders (while typing), my files and tracker documents (comparePick.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSections, folderOfPath, nearestTabs } from '../app/js/comparePick.js';

const names = { a: 'index.php', b: 'style.css', c: 'index.php', d: 'app.js', e: 'index.php', h: 'hidden.txt' };
const nameOf = (k) => names[k];

test('the tabs right next to the open one come first, the left one before the right', () => {
  assert.deepEqual(nearestTabs(['a', 'b', 'c', 'd', 'e'], 'c', nameOf), [
    { key: 'b', near: 'left' },
    { key: 'd', near: 'right' },
    // Two steps away on both sides, both named like it: the left one first.
    { key: 'a', near: '' },
    { key: 'e', near: '' },
  ]);
  // Among equals the same name wins over the left one.
  assert.deepEqual(nearestTabs(['b', 'a', 'c'], 'a', nameOf).map((t) => t.key), ['c', 'b']);
  // Tabs the bar's view hides come after, in their order, once each; never the open one.
  assert.deepEqual(nearestTabs(['a', 'b'], 'a', nameOf, ['h', 'a', 'b', 'h', 'd']).map((t) => t.key), ['b', 'h', 'd']);
  // The open tab not in the bar: the bar's order.
  assert.deepEqual(nearestTabs(['a', 'b'], 'x', nameOf), [{ key: 'a', near: '' }, { key: 'b', near: '' }]);
});

test('sections: open tabs, then my files and documents; folders only while typing', () => {
  const tabs = [
    { id: 'd:/www/site-b/index.php', name: 'index.php', rel: 'site-b/index.php', path: '/www/site-b/index.php' },
    { id: 'f:1', name: 'notes.md', project: 'Website' },
  ];
  const folders = [
    { id: 'd:/www/site-b/index.php', name: 'index.php', rel: 'index.php', path: '/www/site-b/index.php' },
    { id: 'd:/www/site-c/index.php', name: 'index.php', rel: 'index.php', path: '/www/site-c/index.php' },
    { id: 'd:/www/site-c/lib/db.php', name: 'db.php', rel: 'lib/db.php', path: '/www/site-c/lib/db.php' },
  ];
  const files = [
    { id: 'f:1', name: 'notes.md', project: 'Website' },
    { id: 'f:2', name: 'todo.md', project: '' },
    { id: 'f:3', name: 'index draft.php', project: 'Website' },
  ];
  const docs = [{ id: 'r:files/plan.md', name: 'plan.md', project: 'Website', item: 'Redesign' }];
  const all = { tabs, folders, files, docs };

  const idle = compareSections(all, '');
  assert.deepEqual(idle.map((s) => s.id), ['tabs', 'files', 'docs'], 'no folder files without a query');
  assert.deepEqual(idle[0].rows.map((r) => r.id), ['d:/www/site-b/index.php', 'f:1'], 'tabs in the order given');
  assert.deepEqual(idle[1].rows.map((r) => r.id), ['f:2', 'f:3'], 'my files without the open ones');

  const typed = compareSections(all, 'index');
  assert.deepEqual(typed.map((s) => s.id), ['tabs', 'folders', 'files']);
  assert.deepEqual(typed[1].rows.map((r) => r.id), ['d:/www/site-c/index.php'], 'folder files not open in a tab');
  assert.deepEqual(typed[2].rows.map((r) => r.id), ['f:3']);
  // A folder inside matches too (by `rel`), and the project of my files and documents.
  assert.deepEqual(compareSections(all, 'lib/db').find((s) => s.id === 'folders').rows.map((r) => r.id), ['d:/www/site-c/lib/db.php']);
  assert.deepEqual(compareSections(all, 'redesign').map((s) => s.id), ['docs']);
  assert.deepEqual(compareSections(all, 'zzz'), []);

  // Long lists: the latest few without a query, and how many were left out.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `f:n${i}`, name: `note ${i}.md`, project: '' }));
  const [mine] = compareSections({ files: many }, '', { recent: 40 });
  assert.equal(mine.rows.length, 40);
  assert.equal(mine.more, 20);
  assert.equal(compareSections({ files: many }, 'note 5', { limit: 5 })[0].rows[0].id, 'f:n5');
});

test('the folder a path is in', () => {
  assert.equal(folderOfPath('/www/site-b/index.php'), '/www/site-b');
  assert.equal(folderOfPath('C:\\www\\site-b\\index.php'), 'C:\\www\\site-b');
  assert.equal(folderOfPath('C:\\index.php'), 'C:\\');
  assert.equal(folderOfPath('/index.php'), '/');
  assert.equal(folderOfPath('index.php'), '');
});
