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

test('a reversed sort keeps folders first; which way a column header points', () => {
  const e = [
    { name: 'b.txt', dir: false, size: 10, mtimeMs: 3 },
    { name: 'Zeta', dir: true, size: 0, mtimeMs: 1 },
    { name: 'a.md', dir: false, size: 30, mtimeMs: 1 },
    { name: 'alpha', dir: true, size: 0, mtimeMs: 9 },
  ];
  assert.equal(page.sortEntries(e, 'name', true).map((x) => x.name).join(' '), 'Zeta alpha b.txt a.md');
  assert.equal(page.sortEntries(e, 'size', true).map((x) => x.name).join(' '), 'Zeta alpha b.txt a.md');
  assert.equal(page.sortsUp('name'), true);
  assert.equal(page.sortsUp('name', true), false);
  assert.equal(page.sortsUp('modified'), false);
  assert.equal(page.sortsUp('size', true), true);
});

test('the folder as a tree: expanded folders show their contents, a filter keeps the way to matches', () => {
  const f = (path, dir = false, extra = {}) => ({ name: path.split('/').pop(), path, dir, size: 1, mtimeMs: 1, ...extra });
  const top = [f('/r/src', true), f('/r/docs', true), f('/r/readme.md'), f('/r/.env', false, { hidden: true })];
  const children = new Map([
    ['/r/src', [f('/r/src/main.js'), f('/r/src/lib', true)]],
    ['/r/src/lib', [f('/r/src/lib/util.js')]],
  ]);
  const show = (opts) => page.treeRows(top, { children, ...opts }).map((r) => `${'  '.repeat(r.depth)}${r.entry.name}${r.expanded ? '/' : ''}`).join('|');
  assert.equal(show({}), 'docs|src|readme.md');
  assert.equal(show({ expanded: new Set(['/r/src']) }), 'docs|src/|  lib|  main.js|readme.md');
  assert.equal(show({ expanded: new Set(['/r/src', '/r/src/lib']) }), 'docs|src/|  lib/|    util.js|  main.js|readme.md');
  // A folder expanded inside a collapsed one stays hidden.
  assert.equal(show({ expanded: new Set(['/r/src/lib']) }), 'docs|src|readme.md');
  assert.equal(show({ expanded: new Set(['/r/src', '/r/src/lib']), query: 'util' }), 'src/|  lib/|    util.js');
  assert.equal(show({ query: 'read' }), 'readme.md');
  assert.equal(show({ hidden: true }), 'docs|src|.env|readme.md');
  // Not listed yet: nothing under it.
  assert.equal(show({ expanded: new Set(['/r/docs']) }), 'docs/|src|readme.md');
});

test('what the preview shows for a file', () => {
  assert.equal(page.peekKind('photo.JPG'), 'image');
  assert.equal(page.peekKind('icon.webp'), 'image');
  assert.equal(page.peekKind('report.pdf'), 'pdf');
  assert.equal(page.peekKind('notes.md'), 'text');
  assert.equal(page.peekKind('Makefile'), 'text');
  assert.equal(page.peekKind('song.mp3'), 'none');
  assert.equal(page.peekKind('photo.heic'), 'none');
});

test('a folder selected with what is inside it counts once', () => {
  assert.deepEqual(page.topmost(['/r/src', '/r/src/a.js', '/r/src/lib/b.js', '/r/doc.md']), ['/r/src', '/r/doc.md']);
  assert.deepEqual(page.topmost(['/r/srcx/a', '/r/src']), ['/r/srcx/a', '/r/src']);
  assert.deepEqual(page.topmost(['C:\\r\\src', 'C:\\r\\SRC\\a.txt']), ['C:\\r\\src']);
  assert.deepEqual(page.topmost(['remote://s1/home/a', 'remote://s1/home/a/b']), ['remote://s1/home/a']);
});

test('recent and favorite folders', () => {
  assert.deepEqual(page.pushRecent(['/a', '/b', '/c'], '/b'), ['/b', '/a', '/c']);
  assert.deepEqual(page.pushRecent(['/a', '/b'], '/c', 2), ['/c', '/a']);
  assert.deepEqual(page.pushRecent(undefined, '/x'), ['/x']);
  assert.deepEqual(page.toggleFavorite(['/a'], '/b'), ['/a', '/b']);
  assert.deepEqual(page.toggleFavorite(['/a', '/b'], '/a'), ['/b']);
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
  // Between Windows and a server, the rest of the path takes the other separator.
  assert.equal(page.remapPath('C:\\work\\a\\sub\\x.md', 'C:\\work\\a', 'remote://s1/home/me/a'), 'remote://s1/home/me/a/sub/x.md');
  assert.equal(page.remapPath('remote://s1/home/me/a/sub/x.md', 'remote://s1/home/me/a', 'C:\\work\\a'), 'C:\\work\\a\\sub\\x.md');
  assert.equal(page.remapPath('/srv/a/x.md', '/srv/a', 'remote://s1/'), 'remote://s1/x.md');
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

// ---- Where a file lives (app/js/where.js) ----
const where = await import('../app/js/where.js');

test('the kind of a tab: my files, tracker, this computer, a server', () => {
  assert.equal(where.kindOfKey('f:abc'), 'synced');
  assert.equal(where.kindOfKey('r:files/x/plan.md'), 'doc');
  assert.equal(where.kindOfKey('d:C:\\logs\\app.log'), 'disk');
  assert.equal(where.kindOfKey('d:remote://a1b2c3d4e5/var/log/app.log'), 'remote');
  assert.equal(where.kindOfKey(null), null);
  assert.deepEqual(where.remoteParts('remote://a1b2c3d4e5/var/log/app.log'), { id: 'a1b2c3d4e5', path: '/var/log/app.log' });
  assert.deepEqual(where.remoteParts('remote://a1b2c3d4e5'), { id: 'a1b2c3d4e5', path: '/' });
});

test('a file on a server is shown as ssh writes it, or as a URL for another port', () => {
  const uri = 'remote://a1b2c3d4e5/etc/nginx/nginx.conf';
  assert.equal(where.remoteAddress(uri, { protocol: 'sftp', host: 'web1', port: 22, user: 'ana' }), 'ana@web1:/etc/nginx/nginx.conf');
  assert.equal(where.remoteAddress(uri, { protocol: 'sftp', host: 'web1', port: 2222, user: 'ana' }), 'sftp://ana@web1:2222/etc/nginx/nginx.conf');
  assert.equal(where.remoteAddress(uri, { protocol: 'ftp', host: 'files', port: 21, user: '' }), 'files:/etc/nginx/nginx.conf');
  assert.equal(where.remoteAddress(uri, null), '/etc/nginx/nginx.conf');
});

test('the state shown with where a file lives', () => {
  const text = (o) => where.whereState(o).text;
  assert.equal(text({ kind: 'synced', file: {}, sync: { configured: true } }), 'Synced');
  assert.equal(text({ kind: 'synced', file: { dirty: true }, sync: { configured: true, phase: 'idle' } }), 'Not synced yet');
  assert.equal(text({ kind: 'synced', file: { dirty: true }, sync: { configured: true, phase: 'offline' } }), 'Not synced · offline');
  assert.equal(text({ kind: 'synced', file: {}, sync: { configured: false } }), 'On this device only');
  assert.equal(text({ kind: 'doc', repo: { dirty: true } }), 'Not synced yet');
  assert.equal(text({ kind: 'disk', disk: { dirty: true } }), 'Not saved');
  assert.equal(text({ kind: 'disk', disk: { conflict: true, dirty: true } }), 'Changed on disk');
  assert.equal(text({ kind: 'disk', disk: { follow: true } }), 'Following');
  assert.equal(text({ kind: 'remote', disk: {} }), 'Saved on the server');
  assert.equal(text({ kind: 'remote', disk: { dirty: true } }), 'Not saved to the server');
  assert.equal(text({ kind: 'remote', disk: { saving: true, dirty: true } }), 'Saving…');
  assert.equal(text({ kind: 'remote', disk: { dirty: true, offline: true }, server: { state: 'error' } }), 'Not connected · not saved');
  assert.equal(text({ kind: 'remote', disk: { offline: true }, server: { state: 'connecting' } }), 'Connecting…');
  assert.equal(text({ kind: 'remote', disk: { missing: true } }), 'Not on the server');
  assert.equal(where.whereState({ kind: 'remote', disk: { conflict: true } }).tone, 'error');
  // Local mode: no word about syncing.
  assert.deepEqual(text({ kind: 'synced', file: { dirty: true }, sync: { local: true } }), 'Saved');
  assert.deepEqual(text({ kind: 'doc', repo: { dirty: true }, sync: { local: true } }), 'Saved');
});

// ---- Files on servers (electron/remote.cjs), without a server ----
const remoteMod = require('../electron/remote.cjs');

test('server paths stay on their server and names stay clean', () => {
  assert.deepEqual(remoteMod.parseUri('remote://a1b2c3d4e5/a/../../etc/passwd'), { id: 'a1b2c3d4e5', path: '/etc/passwd' });
  assert.deepEqual(remoteMod.parseUri('remote://a1b2c3d4e5'), { id: 'a1b2c3d4e5', path: '/' });
  assert.throws(() => remoteMod.parseUri('remote://../x'));
  assert.throws(() => remoteMod.parseUri('/etc/passwd'));
  assert.equal(remoteMod.toUri('a1b2c3d4e5', '/srv/x'), 'remote://a1b2c3d4e5/srv/x');
  assert.match(remoteMod.fingerprintOf(Buffer.from('key')), /^SHA256:[A-Za-z0-9+/]+$/);
  assert.match(remoteMod.friendlyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), { host: 'h', port: 22 }).message, /Nothing answers at h:22/);
  assert.match(remoteMod.friendlyError(new Error('All configured authentication methods failed'), null).message, /did not accept/);
});

test('connections are checked and kept without their secrets', () => {
  let stored = {};
  const secrets = new Map();
  const remote = remoteMod.createRemote({
    store: { read: () => stored, write: (d) => (stored = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (id, kind) => secrets.get(`${id}:${kind}`) ?? '', set: (id, kind, v) => (v ? secrets.set(`${id}:${kind}`, v) : secrets.delete(`${id}:${kind}`)) },
    askHostKey: async () => false,
  });
  assert.throws(() => remote.saveConnection({ host: '' }), /server name/);
  assert.throws(() => remote.saveConnection({ host: 'a/b' }), /without spaces/);
  assert.throws(() => remote.saveConnection({ host: 'h', port: 70000 }), /port/);
  assert.throws(() => remote.saveConnection({ host: 'h', auth: 'key', keyPath: '/home/x/.ssh/id_ed25519' }), /Choose the key file/);
  const c = remote.saveConnection({ host: 'h', user: 'u', protocol: 'ftp', auth: 'key', path: 'srv/www' }, { password: 'pw' });
  assert.equal(c.port, 21);
  assert.equal(c.auth, 'password', 'FTP signs in with a password');
  assert.equal(c.path, '/srv/www');
  assert.equal(c.hasPassword, true);
  assert.equal(JSON.stringify(stored).includes('pw'), false);
  remote.allowKey('/home/x/.ssh/id_ed25519');
  const k = remote.saveConnection({ host: 'h', auth: 'key', keyPath: '/home/x/.ssh/id_ed25519' });
  assert.equal(k.keyPath, '/home/x/.ssh/id_ed25519');
  remote.deleteConnection(c.id);
  assert.equal(secrets.has(`${c.id}:password`), false);
});

// ---- Text from images with the model (app/js/ocr.js) ----
const ocr = await import('../app/js/ocr.js');

test('a model is asked to transcribe images as they are', () => {
  const [system, user] = ocr.visionMessages(['data:image/png;base64,AAA', 'data:image/png;base64,BBB'], { langs: 'spa' });
  assert.match(system.content, /exactly as written \(most likely in Spanish\)/);
  assert.match(system.content, /Do not translate/);
  assert.equal(user.content[0].type, 'text');
  assert.match(user.content[0].text, /these 2 images.*## Image N/);
  assert.deepEqual(user.content.slice(1).map((p) => p.image_url.url), ['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
});

test('the reply is kept as the text, without fences or lead-ins', () => {
  assert.equal(ocr.cleanVisionReply('Here is the text from the image:\nInvoice 4471\nTotal 12'), 'Invoice 4471\nTotal 12');
  assert.equal(ocr.cleanVisionReply('```text\nline 1\nline 2\n```'), 'line 1\nline 2');
  assert.equal(ocr.cleanVisionReply('| a | b |\n|---|---|\n| 1 | 2 |'), '| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(ocr.cleanVisionReply(''), '');
  assert.equal(ocr.visionScale(4000, 1000), 0.5);
  assert.equal(ocr.visionScale(800, 600), 1);
  assert.equal(ocr.looksLikeVisionModel('llama3.2-vision:11b'), true);
  assert.equal(ocr.looksLikeVisionModel('qwen2.5vl:7b'), true);
  assert.equal(ocr.looksLikeVisionModel('llama3.2'), false);
  assert.equal(ocr.looksLikeVisionModel('nomic-embed-text'), false);
});

test('several folders side by side: replacing, adding, never one inside another', async () => {
  const { replaceSection, withCurrent, besideSettings, inPlaceSettings } = await import('../app/js/folders.js');
  // Going into a folder: it takes the place of the one shown.
  assert.deepEqual(replaceSection(['/a', '/b'], '/a', '/a/x'), ['/a/x', '/b']);
  assert.deepEqual(replaceSection(['/a', '/b'], '/b', '/c'), ['/a', '/c']);
  // Up to a folder that holds another open one: that one closes (a path shows once).
  assert.deepEqual(replaceSection(['/w/a', '/w/b', '/z'], '/w/a', '/w'), ['/w', '/z']);
  assert.deepEqual(replaceSection([], '', '/a'), ['/a']);
  // Servers and this computer never overlap.
  assert.deepEqual(replaceSection(['remote://s1/home', '/home'], '/home', '/home/me'), ['remote://s1/home', '/home/me']);
  // The current folder is always among them.
  assert.deepEqual(withCurrent([], '/a'), ['/a']);
  assert.deepEqual(withCurrent(['/a', '/b'], '/b'), ['/a', '/b']);
  assert.deepEqual(withCurrent(['/a', '/b'], '/c', '/a'), ['/c', '/b']);
  assert.deepEqual(withCurrent(['/a', '/b'], '/c', '/gone'), ['/a', '/b', '/c']);
  // Shown from elsewhere (a found file's folder): it takes the place of the open one it is in.
  assert.deepEqual(withCurrent(['/a', '/b'], '/b/sub', '/a'), ['/a', '/b/sub']);
  assert.deepEqual(withCurrent(['/a', '/a', ''], ''), ['/a']);
  assert.deepEqual(withCurrent(undefined, ''), []);
  // Shown in place of the current one: the others stay as they are.
  assert.deepEqual(inPlaceSettings({ folder: 'remote://s1/home', folderSections: ['remote://s1/home'] }, '/w'), { folder: '/w', folderSections: ['/w'] });
  assert.deepEqual(inPlaceSettings({ folder: '/b', folderSections: ['/a', '/b'] }, '/c'), { folder: '/c', folderSections: ['/a', '/c'] });
  assert.deepEqual(inPlaceSettings({ folder: '/b', folderSections: ['/a', '/b'] }, '/a/x'), { folder: '/a/x', folderSections: ['/a/x', '/b'] });
  // Opening one beside the others.
  const settings = { folder: '/a', folderSections: ['/a', 'remote://s1/srv'], folderCollapsed: ['/b'] };
  assert.deepEqual(besideSettings(settings, '/b'), { folder: '/b', folderSections: ['/a', 'remote://s1/srv', '/b'], folderCollapsed: [] });
  assert.deepEqual(besideSettings(settings, '/a/inside'), { folder: '/a', folderCollapsed: ['/b'], already: '/a' });
  assert.deepEqual(besideSettings({ folder: '/w/a', folderSections: ['/w/a', '/z'] }, '/w'), { folder: '/w', folderSections: ['/w', '/z'], folderCollapsed: [] });
  assert.deepEqual(besideSettings({ folder: 'C:\\Work', folderSections: [] }, 'c:\\work\\Proj').already, 'C:\\Work');
});
