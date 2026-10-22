import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { allowedBy, cleanExports, exportName, isInside, listFolder, writeExport } = require('../electron/folders.cjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-folders-')));

test('only paths inside a picked folder are allowed, links resolved', () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.equal(isInside(root, root), true);
  assert.equal(allowedBy([root], path.join(root, 'sub', 'a.txt')), true);
  assert.equal(allowedBy([root], path.join(root, 'sub', 'new.txt')), true, 'a file about to be created');
  assert.equal(allowedBy([root], path.join(root, 'sub', '..', '..', path.basename(outside), 'secret.txt')), false, '.. cannot leave it');
  assert.equal(allowedBy([root], path.join(root, 'link', 'secret.txt')), false, 'a link cannot lead out');
  assert.equal(allowedBy([root], path.join(outside, 'secret.txt')), false);
  assert.equal(allowedBy([root, outside], path.join(outside, 'secret.txt')), true);
  assert.equal(allowedBy([root], 'sub/a.txt'), false, 'relative paths are refused');
  assert.equal(allowedBy([`${root}-other`], path.join(root, 'sub', 'a.txt')), false, 'a sibling with a longer name is not inside');
});

test('a folder lists folders first, then files, in natural order', () => {
  const root = tmp();
  for (const name of ['file10.txt', 'file2.txt', '.hidden']) fs.writeFileSync(path.join(root, name), 'x');
  fs.mkdirSync(path.join(root, 'b-dir'));
  fs.mkdirSync(path.join(root, 'A-dir'));
  const { entries, truncated } = listFolder(root);
  assert.deepEqual(entries.map((e) => e.name), ['A-dir', 'b-dir', '.hidden', 'file2.txt', 'file10.txt']);
  assert.equal(entries[0].dir, true);
  assert.equal(entries.find((e) => e.name === '.hidden').hidden, true);
  assert.equal(entries.find((e) => e.name === 'file2.txt').size, 1);
  assert.equal(truncated, false);
});

test('dragged tabs leave a copy with a usable name, cleaned up later', () => {
  assert.equal(exportName('notes.md'), 'notes.md');
  assert.equal(exportName('new 3'), 'new 3.txt');
  assert.equal(exportName('a/b:c?.sql'), 'a b c .sql');
  assert.equal(exportName('..hidden'), 'hidden.txt');
  assert.equal(exportName(''), 'Untitled.txt');
  const base = tmp();
  const file = writeExport(base, 'Report.md', '# Hi\n');
  assert.equal(path.basename(file), 'Report.md');
  assert.equal(fs.readFileSync(file, 'utf8'), '# Hi\n');
  assert.notEqual(path.dirname(writeExport(base, 'Report.md', 'x')), path.dirname(file), 'each drag gets its own folder');
  assert.equal(cleanExports(base, 1000, Date.now()), 0);
  assert.equal(cleanExports(base, 1000, Date.now() + 5000), 2);
  assert.deepEqual(fs.readdirSync(base), []);
});

// ---- The page's side (app/js/folders.js) ----
const page = await import('../app/js/folders.js');

test('breadcrumbs go from the picked folder down, and never above it', () => {
  assert.deepEqual(page.breadcrumbs('/home/ana/notes/2026', '/home/ana/notes'), [
    { name: 'notes', path: '/home/ana/notes' },
    { name: '2026', path: '/home/ana/notes/2026' },
  ]);
  assert.deepEqual(page.breadcrumbs('C:\\Users\\Ana\\Docs\\Logs', 'C:\\Users\\Ana\\Docs').map((c) => c.path), ['C:\\Users\\Ana\\Docs', 'C:\\Users\\Ana\\Docs\\Logs']);
  assert.deepEqual(page.breadcrumbs('C:\\work', 'C:\\').map((c) => [c.name, c.path]), [['C:', 'C:\\'], ['work', 'C:\\work']]);
  assert.deepEqual(page.breadcrumbs('/srv/logs', '/').map((c) => c.path), ['/', '/srv', '/srv/logs']);
  assert.equal(page.parentOf('/home/ana/notes/2026', '/home/ana/notes'), '/home/ana/notes');
  assert.equal(page.parentOf('/home/ana/notes', '/home/ana/notes/'), null, 'not above the picked folder');
});

test('the picked folder that holds a path: the deepest, Windows without case', () => {
  const roots = ['/home/ana', '/home/ana/work', 'D:\\Logs'];
  assert.equal(page.rootOf('/home/ana/work/app/src', roots), '/home/ana/work');
  assert.equal(page.rootOf('/home/ana/notes', roots), '/home/ana');
  assert.equal(page.rootOf('/home/anabel', roots), null, 'a longer sibling name is not inside');
  assert.equal(page.rootOf('d:\\logs\\today', roots), 'D:\\Logs');
  assert.equal(page.rootOf('/etc', roots), null);
  assert.equal(page.isWithin('/home/ana', '/home/ana'), true);
  assert.equal(page.baseName('C:\\Users\\Ana\\'), 'Ana');
});

test('filtering a folder: hidden files only when asked', () => {
  const entries = [
    { name: '.git', dir: true, hidden: true },
    { name: 'Notes', dir: true, hidden: false },
    { name: 'notes.md', dir: false, hidden: false },
    { name: 'app.log', dir: false, hidden: false },
  ];
  assert.deepEqual(page.filterEntries(entries).map((e) => e.name), ['Notes', 'notes.md', 'app.log']);
  assert.deepEqual(page.filterEntries(entries, { query: ' NOTE ' }).map((e) => e.name), ['Notes', 'notes.md']);
  assert.deepEqual(page.filterEntries(entries, { hidden: true }).map((e) => e.name), ['.git', 'Notes', 'notes.md', 'app.log']);
});

test('Copy for Claude: the path of a file on disk, or the name and the text', () => {
  assert.equal(page.claudeText({ name: 'a.log', text: 'x', path: '/var/log/a.log' }), '/var/log/a.log');
  assert.equal(page.claudeText({ path: 'C:\\Users\\Ana\\My notes\\a.txt' }), '"C:\\Users\\Ana\\My notes\\a.txt"', 'quoted with spaces, as a terminal drop pastes it');
  assert.equal(page.claudeText({ name: 'query.sql', text: 'select 1;\n' }), 'query.sql:\n\n```sql\nselect 1;\n```\n');
  // A fence longer than any in the text.
  assert.equal(page.claudeText({ name: 'README', text: 'a\n````js\nb\n````' }), 'README:\n\n`````\na\n````js\nb\n````\n`````\n');
});

test('the copies a dragged tab leaves are recognized by their folder', () => {
  assert.equal(page.isDragCopy(path.join(os.tmpdir(), page.DRAG_DIR_NAME, 'ab12cd', 'notes.md')), true);
  assert.equal(page.isDragCopy('C:\\Users\\Ana\\AppData\\Local\\Temp\\Tracker Editor drag\\ab12cd\\notes.md'), true);
  assert.equal(page.isDragCopy('/home/ana/Tracker Editor drag notes.md'), false);
  assert.equal(page.isDragCopy(''), false);
});

test('the main process writes drag copies to the folder the page recognizes', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(main, new RegExp(`path\\.join\\(os\\.tmpdir\\(\\), '${page.DRAG_DIR_NAME}'\\)`));
});
