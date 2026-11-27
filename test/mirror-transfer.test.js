// 0.54: mirrors by hand (electron/mirrorTransfer.cjs) against the stand-in SSH server
// (test/helpers/ssh-server.cjs, OpenSSH's sftp-server behind it): the paths the page names turned
// into relative ones inside the mirror, a check of what an upload or a download would do, the
// transfer (each file checked again, the old version kept, the state updated so a sync sees the
// two in step), Undo (only over what it wrote), a folder comparison's copies, and the history's
// limits. Node 18-safe (in test:phone-node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mirrorCheck from '../app/js/mirrorCheck.js';

const require = createRequire(import.meta.url);
const { createRemote, toUri, parseUri, isRemote } = require('../electron/remote.cjs');
const { createMirrorTransfers, pruneHistory } = require('../electron/mirrorTransfer.cjs');
const { runMirror, createMirrorIo, DEFAULT_EXCLUDE } = require('../electron/mirror.cjs');
const { startSshServer, SFTP_SERVERS } = require('./helpers/ssh-server.cjs');

const hasSftp = SFTP_SERVERS.some((p) => fs.existsSync(p));
const skip = (!hasSftp || process.platform === 'win32') && 'needs OpenSSH\'s sftp-server';
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A file's time moved back, as an older copy's would be.
const age = (p, seconds) => {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(p, t, t);
};

/** A mirror between a folder here and one on the stand-in server, and the transfers for it. */
async function setUp() {
  const home = tmp('mirror-srv-');
  const site = path.join(home, 'site');
  fs.mkdirSync(site);
  const local = tmp('mirror-here-');
  const data = tmp('mirror-data-');
  const srv = await startSshServer({ home });
  let store = {};
  const remote = createRemote({
    store: { read: () => store, write: (d) => (store = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
    askHostKey: async () => true,
  });
  const conn = remote.saveConnection({ protocol: 'sftp', name: 'box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
  const m = { id: 'm1', conn: conn.id, remote: site, local, mode: 'both', auto: false, exclude: DEFAULT_EXCLUDE };
  const trashed = [];
  const statePath = (x) => path.join(data, 'mirrors', `${x.id}.json`);
  let syncing = false;
  const t = createMirrorTransfers({
    remote,
    toUri,
    parseUri,
    isRemote,
    historyDir: path.join(data, 'mirror-history'),
    historyFile: path.join(data, 'mirror-history.json'),
    statePath,
    check: mirrorCheck,
    trash: async (p) => (trashed.push(p), fs.rmSync(p)),
    mirrorOf: (id) => (id === m.id ? m : null),
    busy: () => syncing,
  });
  const here = (rel, text) => (text === undefined ? fs.readFileSync(path.join(local, rel), 'utf8') : (fs.mkdirSync(path.dirname(path.join(local, rel)), { recursive: true }), fs.writeFileSync(path.join(local, rel), text)));
  const there = (rel, text) => (text === undefined ? fs.readFileSync(path.join(site, rel), 'utf8') : (fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true }), fs.writeFileSync(path.join(site, rel), text)));
  const uri = (rel) => toUri(conn.id, rel ? `${site}/${rel}` : site);
  const close = async () => {
    remote.disconnectAll();
    await srv.close();
  };
  return { home, site, local, data, remote, conn, m, t, trashed, here, there, uri, close, statePath, setSyncing: (v) => (syncing = v) };
}
const states = (check) => Object.fromEntries(check.files.map((r) => [r.rel, r.state]));
const itemsOf = (check, rels) => check.files.filter((r) => rels.includes(r.rel)).map((r) => ({ rel: r.rel, expect: (check.direction === 'upload' ? r.there : r.here) ?? null, size: (check.direction === 'upload' ? r.here : r.there)?.size ?? 0 }));

test('the paths the page names: relative ones inside the mirror, either side; nothing outside', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, local, uri, conn } = w;
    assert.deepEqual(t.relsOf(m, [path.join(local, 'a.txt'), uri('b/c.txt')]), ['a.txt', 'b/c.txt']);
    assert.deepEqual(t.relsOf(m, [local, path.join(local, 'x')]), [''], 'the folder itself: what is inside it goes with it');
    assert.deepEqual(t.relsOf(m, [uri('b'), uri('b/c.txt'), uri('d')]), ['b', 'd']);
    for (const bad of [path.dirname(local), path.join(local, '..', 'other'), toUri(conn.id, '/etc/passwd'), toUri('other-server', `${m.remote}/a`), `${uri('')}/../x`]) assert.throws(() => t.relsOf(m, [bad]), /not inside the mirror/, bad);
    assert.throws(() => t.relsOf(m, []), /Nothing/);
  } finally {
    await w.close();
  }
});

test('upload: checked first, then copied with the old version kept; the state in step; Undo puts it back', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, there, local, site, uri } = w;
    here('new.txt', 'only here');
    here('same.txt', 'same');
    there('same.txt', 'same');
    age(path.join(site, 'same.txt'), 3600);
    here('mine.txt', 'mine, newer');
    there('mine.txt', 'theirs, older');
    age(path.join(site, 'mine.txt'), 600);
    here('old.txt', 'mine, older');
    there('old.txt', 'theirs, newer!');
    age(path.join(local, 'old.txt'), 600);
    there('theirs.txt', 'only on the server');
    here('.git/HEAD', 'left out by the mirror');

    const check = await t.check(m, [local], 'upload');
    assert.deepEqual(states(check), { 'mine.txt': 'newer', 'new.txt': 'new', 'old.txt': 'older', 'theirs.txt': 'onlyThere' });
    assert.equal(check.counts.same, 1, 'the same bytes, another time');
    assert.equal(check.counts.risky, 1);
    assert.equal(mirrorCheck.checkSentence(check.counts, 'upload', 'box'), '3 differ: 1 newer here, 1 only here, 1 newer on box');
    // The same file found byte for byte is in step now: the next check needs no bytes.
    assert.ok(w.t.readState(m).files['same.txt']?.l, 'noted as in step');

    // What is safe goes; the risky one is left (the dialog's boxes).
    const r = await t.transfer(m, itemsOf(check, ['new.txt', 'mine.txt']), 'upload');
    assert.deepEqual(r.done.sort(), ['mine.txt', 'new.txt']);
    assert.deepEqual(r.skipped, []);
    assert.equal(there('new.txt'), 'only here');
    assert.equal(there('mine.txt'), 'mine, newer');
    assert.equal(there('old.txt'), 'theirs, newer!', 'left as it was');
    assert.ok(!fs.readdirSync(site).some((n) => n.includes('.part-')), 'no .part file left behind');
    const again = await t.check(m, [local], 'upload');
    assert.deepEqual(states(again), { 'old.txt': 'older', 'theirs.txt': 'onlyThere' }, 'in step after it');

    // The history: the old version kept, readable for a comparison.
    const [entry] = t.history(m.id);
    assert.equal(entry.id, r.entry);
    assert.equal(entry.direction, 'upload');
    const mine = entry.files.find((f) => f.rel === 'mine.txt');
    assert.equal(mine.before.kept, true);
    assert.equal(t.keptBytes(r.entry, 'mine.txt').toString(), 'theirs, older');
    assert.equal(entry.files.find((f) => f.rel === 'new.txt').before, null, 'it was new there');

    // Undo: the old version back, what was new deleted on the server; the state as before.
    const u = await t.undo(r.entry);
    assert.deepEqual(u.restored, ['mine.txt']);
    assert.deepEqual(u.removed, ['new.txt']);
    assert.deepEqual(u.left, []);
    assert.equal(there('mine.txt'), 'theirs, older');
    assert.ok(!fs.existsSync(path.join(site, 'new.txt')));
    assert.equal(here('mine.txt'), 'mine, newer', 'this side untouched');
    const after = await t.check(m, [path.join(local, 'mine.txt'), path.join(local, 'new.txt')], 'upload');
    assert.deepEqual(states(after), { 'mine.txt': 'newer', 'new.txt': 'new' }, 'as before the upload');
    assert.ok(t.history(m.id)[0].undone);
    await assert.rejects(t.undo(r.entry), /undone already/);
    assert.equal(t.keptBytes(r.entry, 'mine.txt'), null, 'nothing left to look at: its kept versions went');
    void uri;
  } finally {
    await w.close();
  }
});

test('changed since the check, or since the transfer: left as it is, and said', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, there, local, site } = w;
    here('a.txt', 'v1 here');
    there('a.txt', 'v0 there');
    age(path.join(site, 'a.txt'), 600);
    const check = await t.check(m, [path.join(local, 'a.txt')], 'upload');
    // Someone changes the server's copy after the check.
    await sleep(1100);
    there('a.txt', 'changed meanwhile');
    const r = await t.transfer(m, itemsOf(check, ['a.txt']), 'upload');
    assert.deepEqual(r.done, []);
    assert.deepEqual(r.skipped, [{ rel: 'a.txt', why: 'changed on the server since it was checked' }]);
    assert.equal(r.entry, null, 'nothing done: no history');
    assert.equal(there('a.txt'), 'changed meanwhile');
    // Transferred, then changed again on the server: Undo leaves it.
    const fresh = await t.check(m, [path.join(local, 'a.txt')], 'upload');
    const done = await t.transfer(m, itemsOf(fresh, ['a.txt']), 'upload');
    assert.deepEqual(done.done, ['a.txt']);
    await sleep(1100);
    there('a.txt', 'edited on the server after the upload');
    const u = await t.undo(done.entry);
    assert.deepEqual(u.restored, []);
    assert.deepEqual(u.left, [{ rel: 'a.txt', why: 'changed since; left as it is' }]);
    assert.equal(there('a.txt'), 'edited on the server after the upload');
    assert.equal(t.keptBytes(done.entry, 'a.txt').toString(), 'changed meanwhile', 'kept to compare');
  } finally {
    await w.close();
  }
});

test('download: the server\'s change comes here, the old file kept; Undo gives back its bytes and its time, or the Recycle Bin for new ones', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, there, local, site, trashed } = w;
    here('page.html', 'v1');
    there('page.html', 'v1');
    // In step: a first check notes them (the same bytes).
    let check = await t.check(m, [local], 'download');
    assert.equal(check.counts.same, 1);
    await sleep(1100);
    there('page.html', 'v2 from the server');
    there('img/new.png', 'PNG');
    check = await t.check(m, [local], 'download');
    assert.deepEqual(states(check), { 'img/new.png': 'new', 'page.html': 'ahead' });
    // The other way round, the same change is at risk.
    assert.deepEqual(states(await t.check(m, [local], 'upload')), { 'img/new.png': 'onlyThere', 'page.html': 'behind' });
    const oldTime = fs.statSync(path.join(local, 'page.html')).mtimeMs;
    const r = await t.transfer(m, itemsOf(check, ['page.html', 'img/new.png']), 'download');
    assert.deepEqual(r.done.sort(), ['img/new.png', 'page.html']);
    assert.equal(here('page.html'), 'v2 from the server');
    assert.equal(here('img/new.png'), 'PNG');
    assert.ok(!fs.readdirSync(local).some((n) => n.includes('.part-')));
    assert.deepEqual(states(await t.check(m, [local], 'upload')), {}, 'in step');
    // Edited here afterwards: an upload is safe, a download at risk.
    await sleep(1100);
    here('page.html', 'v3 here');
    assert.deepEqual(states(await t.check(m, [path.join(local, 'page.html')], 'upload')), { 'page.html': 'ahead' });
    assert.deepEqual(states(await t.check(m, [path.join(local, 'page.html')], 'download')), { 'page.html': 'behind' });
    here('page.html', 'v2 from the server');
    fs.utimesSync(path.join(local, 'page.html'), new Date(), new Date(r.entry ? t.history(m.id)[0].files.find((f) => f.rel === 'page.html').after.mtimeMs : 0));
    const u = await t.undo(r.entry);
    assert.deepEqual(u.restored, ['page.html']);
    assert.deepEqual(u.removed, ['img/new.png']);
    assert.equal(here('page.html'), 'v1');
    assert.ok(Math.abs(fs.statSync(path.join(local, 'page.html')).mtimeMs - oldTime) < 1000, 'its old time too');
    assert.deepEqual(trashed, [path.join(local, 'img', 'new.png')], 'to the Recycle Bin here');
    assert.deepEqual(states(await t.check(m, [path.join(local, 'page.html')], 'download')), { 'page.html': 'ahead' }, 'the server still newer, as before');
    void site;
  } finally {
    await w.close();
  }
});

test('a sync after a transfer sees the two in step; a transfer waits while a sync runs', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, there, local, remote, statePath } = w;
    here('a.txt', 'A');
    here('b/c.txt', 'C');
    there('b/c.txt', 'old C');
    const check = await t.check(m, [local], 'upload');
    const r = await t.transfer(m, itemsOf(check, ['a.txt', 'b/c.txt']), 'upload');
    assert.equal(r.done.length, 2);
    const io = createMirrorIo(m, { remote, toUri, statePath: statePath(m), trash: async () => {}, connected: () => true });
    const summary = await runMirror(m, io);
    assert.deepEqual([summary.uploaded, summary.downloaded, summary.conflicts.length], [0, 0, 0], 'nothing for the sync to do');
    w.setSyncing(true);
    await assert.rejects(t.transfer(m, [{ rel: 'a.txt' }], 'upload'), /syncing/);
  } finally {
    await w.close();
  }
});

test('a link here is left alone; names that would lead out are refused', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, local, there } = w;
    const outside = tmp('mirror-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(local, 'link.txt'));
    fs.symlinkSync(outside, path.join(local, 'dirlink'));
    there('link.txt', 'server');
    there('dirlink/secret.txt', 'from the server');
    const check = await t.check(m, [path.join(local, 'link.txt')], 'download');
    assert.deepEqual(check.left, [{ rel: 'link.txt', why: 'a link here: left alone' }]);
    const r = await t.transfer(m, [{ rel: 'link.txt' }, { rel: 'dirlink/secret.txt' }, { rel: '../x' }], 'download');
    assert.equal(r.done.length, 0);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret', 'never written through a link');
  } finally {
    await w.close();
  }
});

test('copies in a folder comparison between the mirror\'s two sides: history and state too', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, there, local, uri } = w;
    here('sub/a.txt', 'A');
    here('sub/deep/b.txt', 'B');
    fs.mkdirSync(path.join(local, 'sub', 'empty'));
    there('sub/a.txt', 'old A');
    const pair = t.pairOf([m], path.join(local, 'sub'), uri('sub'));
    assert.deepEqual({ ...pair, m: pair.m.id }, { m: 'm1', direction: 'upload', base: 'sub' });
    assert.equal(t.pairOf([m], uri('sub'), path.join(local, 'sub')).direction, 'download');
    assert.equal(t.pairOf([m], path.join(local, 'sub'), uri('other')), null, 'not counterparts');
    const r = await t.copyFromCompare(m, 'upload', 'sub', ['a.txt', 'deep', 'empty']);
    assert.deepEqual(r.done.sort(), ['sub/a.txt', 'sub/deep/b.txt']);
    assert.equal(there('sub/deep/b.txt'), 'B');
    assert.ok(fs.statSync(path.join(w.site, 'sub', 'empty')).isDirectory(), 'an empty folder made too');
    assert.deepEqual(states(await t.check(m, [path.join(local, 'sub')], 'upload')), {});
    await t.undo(r.entry);
    assert.equal(there('sub/a.txt'), 'old A');
    assert.ok(!fs.existsSync(path.join(w.site, 'sub', 'deep', 'b.txt')));
  } finally {
    await w.close();
  }
});

test('a mirror set to other folders since: its transfers are not undone (their paths would name other files)', { skip }, async () => {
  const w = await setUp();
  try {
    const { t, m, here, local } = w;
    here('a.txt', 'A');
    const r = await t.transfer(m, [{ rel: 'a.txt', expect: null }], 'upload');
    assert.deepEqual(r.done, ['a.txt']);
    const before = m.remote;
    m.remote = `${before}-elsewhere`;
    await assert.rejects(t.undo(r.entry), /other folders now/);
    m.remote = before;
    assert.deepEqual((await t.undo(r.entry)).removed, ['a.txt']);
    void local;
  } finally {
    await w.close();
  }
});

test('the history\'s limits: 200 entries, 30 days, 1 GB kept (the oldest lose theirs first)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const entry = (i, at, size = 10) => ({ id: `e${i}`, at, files: [{ rel: 'a', before: { size, mtimeMs: 1, blob: '0' } }] });
  const many = Array.from({ length: 205 }, (_, i) => entry(i, now - i * 1000));
  const r = pruneHistory(many, { now });
  assert.equal(r.keep.length, 200);
  assert.deepEqual(r.removeDirs, ['e200', 'e201', 'e202', 'e203', 'e204']);
  const old = pruneHistory([entry(1, now - 31 * DAY), entry(2, now - DAY)], { now });
  assert.deepEqual(old.keep.map((e) => e.id), ['e2']);
  assert.deepEqual(old.removeDirs, ['e1']);
  const big = pruneHistory([entry(1, now - 3000, 600), entry(2, now - 2000, 300), entry(3, now - 1000, 300)], { now, maxBytes: 1000 });
  assert.deepEqual(big.dropBlobs, [['e1', '0']], 'the oldest kept copy goes');
  assert.equal(big.keep.find((e) => e.id === 'e1').files[0].notKept, true);
  assert.equal(big.keep.find((e) => e.id === 'e3').files[0].before.blob, '0');
});
