// Terminals kept on an SSH server (0.51.1): remote.cjs starts a terminal of your own inside a
// tmux session there when the server has tmux, so a dropped connection, a restart or Reopen takes
// it up again; × ends it. Against the stand-in SSH server (test/helpers/ssh-server.cjs) with this
// machine's tmux, its sockets in a folder of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createRemote } = require('../electron/remote.cjs');
const { startSshServer } = require('./helpers/ssh-server.cjs');

const hasTmux = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).status === 0;
let hasPty = false;
try {
  require('@lydell/node-pty');
  hasPty = true;
} catch {}
const skip = !(hasTmux && hasPty) && 'needs tmux and node-pty';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));

async function server(env = {}) {
  const tmuxDir = tmp('tmux-sock-');
  const srv = await startSshServer({ shell: '/bin/sh', home: tmp('keep-home-'), env: { TMUX_TMPDIR: tmuxDir, ...env } });
  let data = {};
  const remote = createRemote({
    store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
    askHostKey: async () => true,
  });
  const conn = remote.saveConnection({ protocol: 'sftp', name: 'box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
  const tmux = (...args) => spawnSync('tmux', args, { env: { ...process.env, TMUX_TMPDIR: tmuxDir }, encoding: 'utf8' });
  return { srv, remote, id: conn.id, tmux, done: async () => (tmux('kill-server'), remote.disconnectAll(), await srv.close()) };
}

/** A terminal's channel and what it printed (`text()`), `until(re)` to wait for something. */
function watch(stream) {
  let out = '';
  stream.on('data', (d) => (out += d.toString('utf8')));
  stream.stderr?.on('data', (d) => (out += d.toString('utf8')));
  const until = async (re, ms = 8000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`waited for ${re} in: ${JSON.stringify(out.slice(-400))}`);
      await sleep(50);
    }
  };
  return { text: () => out, until };
}

test('kept: the terminal runs in tmux there, a new connection takes it up again with its output, × ends it', { skip }, async () => {
  const s = await server();
  try {
    const dir = tmp('keep-cwd-');
    const first = await s.remote.openShell(s.id, { cols: 100, rows: 30, cwd: dir, keep: 'te-test1234' });
    const a = watch(first);
    await a.until(/\x1b\]7350;tmux\x07/);
    assert.ok(true, 'it says it is kept (OSC 7350)');
    first.write('echo "made-in-$(pwd)" > made.txt; echo first-session-$((6*7))\r');
    await a.until(/first-session-42/);
    assert.equal(fs.readFileSync(path.join(dir, 'made.txt'), 'utf8').trim(), `made-in-${dir}`, 'in the folder asked for');
    assert.equal(s.tmux('has-session', '-t', '=te-test1234').status, 0, 'the tmux session is there');

    // The connection goes away (the app closed, the network dropped): the session stays.
    first.close();
    s.remote.disconnectAll();
    await sleep(500);
    assert.equal(s.tmux('has-session', '-t', '=te-test1234').status, 0, 'still running after the connection went');

    // Reopened (a new connection): the same session, its screen as it was.
    const again = await s.remote.openShell(s.id, { cols: 100, rows: 30, cwd: '/', keep: 'te-test1234' });
    const b = watch(again);
    await b.until(/first-session-42/);
    again.write('echo second-$((2+3))\r');
    await b.until(/second-5/);
    assert.equal(s.tmux('list-sessions').stdout.trim().split('\n').length, 1, 'one session, taken up again');

    // × in the panel: the session ends there.
    assert.equal(await s.remote.endKeptShell(s.id, 'te-test1234'), true);
    await sleep(300);
    assert.notEqual(s.tmux('has-session', '-t', '=te-test1234').status, 0, 'gone after ×');
    // A name the app did not make is never sent; not connected: nothing.
    assert.equal(await s.remote.endKeptShell(s.id, 'x; touch pwned'), false);
    s.remote.disconnectAll();
    assert.equal(await s.remote.endKeptShell(s.id, 'te-test1234'), false);
  } finally {
    await s.done();
  }
});

test('a server without tmux: the usual shell, in its folder, not said to be kept', { skip }, async () => {
  // A PATH with sh (as every server has) but no tmux.
  const tools = tmp('no-tmux-');
  fs.symlinkSync('/bin/sh', path.join(tools, 'sh'));
  const s = await server({ PATH: tools });
  try {
    const dir = tmp('plain-cwd-');
    const stream = await s.remote.openShell(s.id, { cols: 80, rows: 24, cwd: dir, keep: 'te-plain123' });
    const w = watch(stream);
    stream.write('echo "here-$PWD"\r');
    await w.until(new RegExp(`here-${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(!/\x1b\]7350/.test(w.text()), 'no kept mark');
    stream.close();
  } finally {
    await s.done();
  }
});

test('names: only the app’s own (te- and letters/digits) start tmux; others get the usual shell', { skip }, async () => {
  const s = await server();
  try {
    const stream = await s.remote.openShell(s.id, { cols: 80, rows: 24, cwd: '', keep: "te-x'; touch pwned; '" });
    const w = watch(stream);
    stream.write('echo plain-$((1+1))\r');
    await w.until(/plain-2/);
    assert.ok(!/\x1b\]7350/.test(w.text()));
    assert.equal(s.tmux('list-sessions').status === 0 ? s.tmux('list-sessions').stdout.trim() : '', '');
    stream.close();
  } finally {
    await s.done();
  }
});
