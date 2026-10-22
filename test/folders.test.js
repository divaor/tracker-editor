import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { allowedBy, canOpenExternally, checkName, cleanExports, copyInto, exportName, freePath, isImage, isInside, listFolder, moveInto, renameEntry, writeExport } = require('../electron/folders.cjs');
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

// ---- Changing folders (electron/folders.cjs) ----

test('names for new and renamed entries are checked for every system', () => {
  assert.equal(checkName('  notes.md '), 'notes.md');
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'x*', 'a<b', 'pipe|', 'dot.', 'CON', 'nul.txt', 'com1', 'LPT9.log']) assert.throws(() => checkName(bad), undefined, bad);
  assert.equal(checkName('console.log'), 'console.log', 'only the reserved names themselves');
  assert.equal(checkName('trailing space '), 'trailing space', 'spaces around a name are dropped');
});

test('free names: numbered for new files, "- Copy" for copies, as Explorer does', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), '');
  assert.equal(path.basename(freePath(dir, 'b.txt')), 'b.txt');
  assert.equal(path.basename(freePath(dir, 'a.txt')), 'a (2).txt');
  assert.equal(path.basename(freePath(dir, 'a.txt', { copy: true })), 'a - Copy.txt');
  fs.writeFileSync(path.join(dir, 'a - Copy.txt'), '');
  assert.equal(path.basename(freePath(dir, 'a.txt', { copy: true })), 'a - Copy (2).txt');
  assert.equal(path.basename(freePath(dir, 'README', { copy: true })), 'README - Copy');
});

test('copying and moving files and folders, with names kept free', () => {
  const root = tmp();
  const docs = path.join(root, 'docs');
  const archive = path.join(root, 'archive');
  fs.mkdirSync(path.join(docs, 'deep'), { recursive: true });
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(docs, 'plan.md'), 'plan');
  fs.writeFileSync(path.join(docs, 'deep', 'x.txt'), 'x');
  fs.writeFileSync(path.join(archive, 'plan.md'), 'old plan');

  const copies = copyInto([path.join(docs, 'plan.md')], docs);
  assert.equal(path.basename(copies[0].to), 'plan - Copy.md', 'a copy in the same folder');
  const deepCopy = copyInto([path.join(docs, 'deep')], archive);
  assert.equal(fs.readFileSync(path.join(deepCopy[0].to, 'x.txt'), 'utf8'), 'x', 'folders are copied with what is inside');

  const moves = moveInto([path.join(docs, 'plan.md')], archive);
  assert.equal(path.basename(moves[0].to), 'plan (2).md', 'a name already there is kept');
  assert.equal(fs.readFileSync(path.join(archive, 'plan.md'), 'utf8'), 'old plan');
  assert.equal(fs.existsSync(path.join(docs, 'plan.md')), false);
  assert.deepEqual(moveInto([path.join(archive, 'plan.md')], archive), [], 'already there: nothing to do');
  assert.throws(() => moveInto([docs], path.join(docs, 'deep')), /inside itself/);
  assert.throws(() => copyInto([docs], path.join(docs, 'deep')), /inside itself/);
});

test('renaming: refused over another file, allowed when only the case changes', () => {
  const dir = tmp();
  const a = path.join(dir, 'a.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  assert.throws(() => renameEntry(a, 'b.txt'), /already exists/);
  assert.throws(() => renameEntry(a, 'x/y.txt'));
  const c = renameEntry(a, 'c.txt');
  assert.equal(fs.readFileSync(c, 'utf8'), 'a');
  const upper = renameEntry(c, 'C.txt');
  assert.equal(path.basename(upper), 'C.txt');
  assert.equal(fs.readFileSync(upper, 'utf8'), 'a');
});

test('other programs open documents and media, never programs or scripts', () => {
  for (const ok of ['report.pdf', 'photo.JPG', 'sheet.xlsx', 'slides.pptx', 'song.mp3', 'archive.zip', 'page.html']) assert.equal(canOpenExternally(ok), true, ok);
  for (const no of ['setup.exe', 'run.bat', 'x.cmd', 'tool.ps1', 'a.vbs', 'b.js', 'c.msi', 'link.lnk', 'site.url', 'x.scr', 'y.hta', 'app.jar', 'go.sh', 'z.command', 'Makefile', 'macro.docm', 'evil.reg', 'query.iqy', 'start.jnlp', 'help.chm', 'x.theme', 'pkg.msix']) assert.equal(canOpenExternally(no), false, no);
  assert.equal(isImage('scan.TIFF'), true);
  assert.equal(isImage('doc.pdf'), false);
});

// ---- The explorer's helpers (app/js/folders.js) ----

test('entries sorted with folders first, by name, date, size or type', () => {
  const e = [
    { name: 'b.txt', dir: false, size: 10, mtimeMs: 3 },
    { name: 'Zeta', dir: true, size: 0, mtimeMs: 1 },
    { name: 'a10.md', dir: false, size: 30, mtimeMs: 1 },
    { name: 'a9.md', dir: false, size: 20, mtimeMs: 2 },
    { name: 'alpha', dir: true, size: 0, mtimeMs: 9 },
  ];
  const names = (sort) => page.sortEntries(e, sort).map((x) => x.name).join(' ');
  assert.equal(names('name'), 'alpha Zeta a9.md a10.md b.txt');
  assert.equal(names('modified'), 'alpha Zeta b.txt a9.md a10.md');
  assert.equal(names('size'), 'alpha Zeta a10.md a9.md b.txt');
  assert.equal(names('type'), 'alpha Zeta a9.md a10.md b.txt');
});

test('selection ranges, rename ranges, what opens where', () => {
  assert.deepEqual(page.rangeOf(['a', 'b', 'c', 'd'], 'c', 'a'), ['a', 'b', 'c']);
  assert.deepEqual(page.rangeOf(['a', 'b'], null, 'b'), ['b']);
  assert.deepEqual(page.renameRange('report.final.docx'), [0, 12]);
  assert.deepEqual(page.renameRange('.gitignore'), [0, 10]);
  assert.deepEqual(page.renameRange('v1.2', true), [0, 4]);
  assert.equal(page.opensInEditor('notes.md'), true);
  assert.equal(page.opensInEditor('Makefile'), true, 'unknown types are tried as text');
  assert.equal(page.opensInEditor('photo.png'), false);
  assert.equal(page.opensInEditor('budget.xlsx'), false);
  assert.equal(page.isImageName('scan.jpeg'), true);
  assert.equal(page.isImageName('logo.svg'), false, 'SVG is text');
});

test('open tabs follow what moved, inside folders too', () => {
  assert.equal(page.remapPath('/a/docs/x.md', '/a/docs', '/a/old/docs'), '/a/old/docs/x.md');
  assert.equal(page.remapPath('/a/docs', '/a/docs', '/b/docs'), '/b/docs');
  assert.equal(page.remapPath('/a/docs2/x.md', '/a/docs', '/b/docs'), null);
  assert.equal(page.remapPath('C:\\work\\a\\x.md', 'C:\\work\\a', 'C:\\work\\b'), 'C:\\work\\b\\x.md');
});

test('the status line counts the selection', () => {
  const e = [
    { path: '/a', name: 'a', dir: true, size: 0 },
    { path: '/b', name: 'b', dir: false, size: 1000 },
    { path: '/c', name: 'c', dir: false, size: 24 },
  ];
  assert.equal(page.selectionSummary(e, new Set()), '3 items');
  assert.equal(page.selectionSummary(e, new Set(['/a', '/b', '/c'])), '3 of 3 items selected · 1024 B');
  assert.equal(page.selectionSummary(e, new Set(['/a'])), '1 of 3 items selected');
});
