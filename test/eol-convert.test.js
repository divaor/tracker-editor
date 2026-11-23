// Folders' Line endings in the main process (eolConvert.cjs): the files found under what was
// picked (no links, SKIP_DIRS, text names, caps), counted (a dry run), converted at the text level
// (BOM and encoding kept, only if unchanged since read), and undone over what was written only.
// Also how a server says it runs Windows (remote.cjs), for new files' line endings there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const disk = require('../electron/diskFiles.cjs');
const { eolFiles, eolScan, eolConvert, eolUndo, eolOfRead } = require('../electron/eolConvert.cjs');
const { createRemote, systemOfHome, ftpSystem } = require('../electron/remote.cjs');
const { startSshServer } = require('./helpers/ssh-server.cjs');

const isText = (name) => /\.(txt|md|js|bat|sh|json|csv)$/i.test(name) && !name.endsWith('.locked');
const stat = (p) => {
  const st = fs.lstatSync(p);
  return { dir: st.isDirectory(), size: st.size, link: st.isSymbolicLink() };
};
const list = async (d) =>
  (await fs.promises.readdir(d, { withFileTypes: true })).map((e) => ({ name: e.name, path: path.join(d, e.name), dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : 0, link: e.isSymbolicLink() }));
const read = (p) => disk.readTextFile(p);
const write = (p, text, opts) => disk.writeTextFile(p, text, opts);

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tinta-eol-'));
  const put = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  put('a.txt', 'one\ntwo\n');
  put('b.txt', 'one\r\ntwo\r\n');
  put('src/c.js', 'x\r\ny\nz\r\n'); // mixed
  put('src/d.md', 'no line break');
  put('src/win.txt', Buffer.from([0x80, 0x0a, 0x93, 0x94, 0x0a])); // Windows-1252, LF
  put('src/bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\nline\n')]));
  put('src/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  put('src/fake.txt', Buffer.from([0x61, 0, 0x62])); // a text name, binary bytes
  put('node_modules/lib/x.js', 'left\nalone\n');
  put('.hidden/h.txt', 'hidden\n');
  put('secret.txt.locked', 'TINTA-LOCKED v1\n{}\nAAAA\n');
  put('big.txt', 'x\n'.repeat(1000));
  try {
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link'));
  } catch {
    // no links here (some Windows setups)
  }
  return root;
}

test('the files under what was picked: text ones, no links, not node_modules nor hidden ones, caps', async () => {
  const root = project();
  const found = await eolFiles({ paths: [root], stat, list, isText, maxSize: 1500 });
  const rels = found.files.map((f) => path.relative(root, f.path).replace(/\\/g, '/')).sort();
  assert.deepEqual(rels, ['a.txt', 'b.txt', 'src/bom.txt', 'src/c.js', 'src/d.md', 'src/fake.txt', 'src/win.txt']);
  assert.equal(found.skipped.large, 1, 'big.txt over the cap');
  assert.ok(found.skipped.notText >= 2, 'the picture and the locked file');
  // Hidden ones when asked; open tabs with unsaved edits left out; a file picked itself.
  const more = await eolFiles({ paths: [root], stat, list, isText, hidden: true, skip: [path.join(root, 'a.txt')] });
  assert.ok(more.files.some((f) => f.path.endsWith('h.txt')));
  assert.equal(more.skipped.open, 1);
  const one = await eolFiles({ paths: [path.join(root, 'b.txt')], stat, list, isText });
  assert.deepEqual(one.files.map((f) => path.basename(f.path)), ['b.txt']);
  const capped = await eolFiles({ paths: [root], stat, list, isText, maxFiles: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.truncated, true);
});

test('counting (the dry run), converting to CRLF keeping encodings and BOMs, then Undo over what was written', async () => {
  const root = project();
  const found = await eolFiles({ paths: [root], stat, list, isText });
  const scan = await eolScan({ files: found.files, read });
  const by = Object.fromEntries(scan.files.map((f) => [path.basename(f.path), f.eol]));
  assert.deepEqual(by, { 'a.txt': 'lf', 'b.txt': 'crlf', 'c.js': 'mixed', 'd.md': 'none', 'win.txt': 'lf', 'bom.txt': 'lf', 'big.txt': 'lf' });
  assert.equal(scan.skipped.binary, 1, 'fake.txt');
  const before = Object.fromEntries(scan.files.map((f) => [f.path, fs.readFileSync(f.path)]));
  const progress = [];
  const toChange = scan.files.filter((f) => f.eol !== 'crlf' && f.eol !== 'none');
  // One changed after it was read: left alone (its write is refused).
  const changed = path.join(root, 'a.txt');
  const writeOnce = (p, text, opts) => {
    if (p === changed) {
      fs.writeFileSync(changed, 'changed meanwhile\n');
      fs.utimesSync(changed, new Date(), new Date(Date.now() + 5000));
    }
    return write(p, text, opts);
  };
  const r = await eolConvert({ files: toChange, eol: 'crlf', read, write: writeOnce, onProgress: (p) => progress.push(p) });
  assert.deepEqual(r.skipped.map((s) => [path.basename(s.path), s.reason]), [['a.txt', 'changed meanwhile']]);
  assert.equal(r.done.length, toChange.length - 1);
  assert.equal(progress.at(-1).done, toChange.length);
  assert.equal(fs.readFileSync(path.join(root, 'src/c.js'), 'utf8'), 'x\r\ny\r\nz\r\n');
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/win.txt')), Buffer.from([0x80, 0x0d, 0x0a, 0x93, 0x94, 0x0d, 0x0a]), 'Windows-1252 kept byte for byte');
  assert.deepEqual(fs.readFileSync(path.join(root, 'src/bom.txt')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\r\nline\r\n')]));
  assert.equal(fs.readFileSync(path.join(root, 'src/d.md'), 'utf8'), 'no line break', 'nothing to convert');
  assert.equal(r.undoable, r.done.length);
  // Undo: back byte for byte, except a file changed since (it stays).
  const later = path.join(root, 'src/bom.txt');
  fs.writeFileSync(later, 'edited after\r\n');
  fs.utimesSync(later, new Date(), new Date(Date.now() + 9000));
  const back = await eolUndo({ undo: r.undo, write });
  assert.deepEqual(back.skipped.map((s) => path.basename(s.path)), ['bom.txt']);
  for (const p of r.done.filter((p) => p !== later)) assert.deepEqual(fs.readFileSync(p), before[p], path.basename(p));
  assert.equal(fs.readFileSync(later, 'utf8'), 'edited after\r\n');
});

test('converting to LF; Undo capped; a stop leaves the rest; files already right are counted, not written', async () => {
  const root = project();
  const found = await eolFiles({ paths: [path.join(root, 'src')], stat, list, isText });
  const scan = await eolScan({ files: found.files, read });
  const all = scan.files;
  const controller = new AbortController();
  let n = 0;
  const r = await eolConvert({
    files: all,
    eol: 'lf',
    read,
    write: (p, text, opts) => {
      if (++n === 1) controller.abort();
      return write(p, text, opts);
    },
    signal: controller.signal,
    maxUndo: 0,
  });
  assert.equal(r.stopped, true);
  assert.ok(r.done.length <= 1);
  assert.equal(r.undo.length, 0, 'no room kept for Undo: done, not undoable');
  const again = await eolConvert({ files: all, eol: 'lf', read, write });
  assert.ok(again.right >= 3, 'the LF ones and the one with no break');
  assert.equal(fs.readFileSync(path.join(root, 'src/c.js'), 'utf8'), 'x\ny\nz\n');
  await assert.rejects(eolConvert({ files: all, eol: 'native', read, write }), /Not a kind/);
  assert.equal(eolOfRead({ breaks: 0, eol: 'lf' }), 'none');
  assert.equal(eolOfRead({ breaks: 3, eol: 'crlf', mixed: { crlf: 2, lf: 1 } }), 'mixed');
});

test('a server\'s system: SFTP gives a Windows server\'s home as /C:/…, FTP names Windows in SYST', () => {
  assert.equal(systemOfHome('/C:/Users/me'), 'windows');
  assert.equal(systemOfHome('/d:/sites'), 'windows');
  assert.equal(systemOfHome('/home/me'), 'unix');
  assert.equal(systemOfHome('/'), 'unix');
  assert.equal(ftpSystem('Windows_NT'), 'windows');
  assert.equal(ftpSystem('Windows_NT version 10.0'), 'windows');
  assert.equal(ftpSystem('UNIX Type: L8'), 'unix');
  assert.equal(ftpSystem(''), 'unix');
});

test('on an SSH server: a new file with the page\'s line endings, a folder\'s files converted and undone over SFTP', { skip: !require('./helpers/ssh-server.cjs').SFTP_SERVERS.some((p) => fs.existsSync(p)) && 'needs OpenSSH\'s sftp-server' }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tinta-eol-sftp-')));
  const srv = await startSshServer({ home });
  let data = {};
  const remote = createRemote({
    store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
    askHostKey: async () => true,
  });
  try {
    const conn = remote.saveConnection({ protocol: 'sftp', name: 'box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
    const dir = `remote://${conn.id}${home}`;
    const made = await remote.newFile(dir, 'new.txt', { text: 'a\nb\n', eol: 'crlf' });
    assert.equal(made, `${dir}/new.txt`);
    assert.equal(fs.readFileSync(path.join(home, 'new.txt'), 'utf8'), 'a\r\nb\r\n');
    await remote.newFile(dir, 'plain.txt', { text: 'x\r\ny\n' });
    assert.equal(fs.readFileSync(path.join(home, 'plain.txt'), 'utf8'), 'x\r\ny\n', 'no eol: as given');
    fs.mkdirSync(path.join(home, 'sub'));
    fs.writeFileSync(path.join(home, 'sub', 'mixed.md'), 'p\r\nq\n');
    const found = await eolFiles({ paths: [dir], stat: (p) => remote.entry(p), list: async (d) => (await remote.list(d)).entries, isText });
    assert.deepEqual(found.files.map((f) => f.path.slice(dir.length)).sort(), ['/new.txt', '/plain.txt', '/sub/mixed.md']);
    const scan = await eolScan({ files: found.files, read: (p) => remote.read(p) });
    assert.deepEqual(Object.fromEntries(scan.files.map((f) => [path.posix.basename(f.path), f.eol])), { 'new.txt': 'crlf', 'plain.txt': 'mixed', 'mixed.md': 'mixed' });
    const r = await eolConvert({ files: scan.files, eol: 'lf', read: (p) => remote.read(p), write: (p, text, opts) => remote.write(p, text, opts) });
    assert.equal(r.done.length, 3);
    assert.equal(fs.readFileSync(path.join(home, 'sub', 'mixed.md'), 'utf8'), 'p\nq\n');
    const back = await eolUndo({ undo: r.undo, write: (p, text, opts) => remote.write(p, text, opts) });
    assert.equal(back.restored.length, 3);
    assert.equal(fs.readFileSync(path.join(home, 'sub', 'mixed.md'), 'utf8'), 'p\r\nq\n', 'byte for byte again');
    assert.equal(fs.readFileSync(path.join(home, 'new.txt'), 'utf8'), 'a\r\nb\r\n');
  } finally {
    remote.disconnectAll();
    await srv.close();
  }
});

test('a Windows SFTP server (the stand-in, its home /C:/…): learned when it connects, kept, told to the page; asked again when its address changes', async () => {
  for (const [realHome, system] of [['/C:/Users/tester', 'windows'], [null, 'unix']]) {
    const srv = await startSshServer({ sftpServer: null, realHome, home: fs.realpathSync(os.tmpdir()) });
    let data = {};
    const statuses = [];
    const remote = createRemote({
      store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
      secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
      askHostKey: async () => true,
      onStatus: (s) => statuses.push(s),
    });
    try {
      const conn = remote.saveConnection({ protocol: 'sftp', name: 'box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
      assert.equal(remote.connections()[0].system, null, 'not known before it connects');
      await remote.connect(conn.id);
      for (let i = 0; i < 50 && !data.systems?.[conn.id]; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(data.systems?.[conn.id], system, 'kept in remote.json');
      assert.equal(remote.connections()[0].system, system, 'the page sees it, connected or not');
      assert.ok(statuses.some((s) => s.id === conn.id && s.system === system), 'and is told at once');
      remote.disconnect(conn.id);
      assert.equal(remote.connections()[0].system, system, 'still known after it disconnects');
      remote.saveConnection({ ...conn, host: 'localhost' });
      assert.equal(remote.connections()[0].system, null, 'another address: asked again');
    } finally {
      remote.disconnectAll();
      await srv.close();
    }
  }
});
