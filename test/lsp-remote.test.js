// Language servers on SSH servers and for synced files (lspRemote.cjs, lsp.cjs): the probe
// script (run here with sh over a made-up home folder), what it finds, the command a channel
// runs, the channel as a process, and the host starting a server "there" through a stand-in
// connection (sh here, the fake server behind a catalog name). Also marker patterns and groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lsp = require('../electron/lsp.cjs');
const remote = require('../electron/lspRemote.cjs');
const { serverLabel, whereLabel } = await import('../app/js/lspTools.js');
const FAKE = fileURLToPath(new URL('./helpers/fake-lsp.cjs', import.meta.url));

const exe = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
};
const file = (p, text = '') => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
};

/** A made-up server's home: a Python project, a TypeScript one, a C# solution, programs in ~/bin. */
function serverHome() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-home-')));
  file(`${home}/proj/pyproject.toml`, '[project]\n');
  file(`${home}/proj/pkg/main.py`, 'x = 1\n');
  file(`${home}/web/package.json`, '{}');
  file(`${home}/web/src/app.ts`, 'export {};\n');
  file(`${home}/web/node_modules/typescript/package.json`, '{\n  "name": "typescript",\n  "version": "5.6.3"\n}\n');
  exe(`${home}/web/node_modules/.bin/typescript-language-server`, '#!/bin/sh\n');
  file(`${home}/sln/All.sln`, '');
  file(`${home}/sln/app/app.csproj`, '<Project />');
  file(`${home}/sln/app/Program.cs`, 'class P {}\n');
  file(`${home}/repo/.git/HEAD`, 'ref: refs/heads/main\n');
  file(`${home}/repo/conf/deep/settings.json`, '{}');
  file(`${home}/loose/notes/data.json`, '{}');
  // Programs on PATH: Pyright (the fake server behind its name), a rust-analyzer stand-in that
  // fails (as rustup's does before the component is added), and tsc with TypeScript beside it.
  exe(`${home}/bin/pyright-langserver`, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  exe(`${home}/bin/rust-analyzer`, '#!/bin/sh\nexit 1\n');
  exe(`${home}/npm/lib/node_modules/typescript/bin/tsc`, '#!/bin/sh\necho "Version 7.0.2"\n');
  file(`${home}/npm/lib/node_modules/typescript/lib/tsserver.js`, '');
  symlinkSync(`${home}/npm/lib/node_modules/typescript/bin/tsc`, `${home}/bin/tsc`);
  return home;
}
// The probe as a server would run it: sh, with that home and PATH.
// (No login shell: this machine's profile would add its own programs.)
const runHere = (home) => (script) => execFileSync('sh', ['-c', script], { env: { HOME: home, SHELL: '/bin/false', PATH: `${home}/bin:/usr/bin:/bin` }, encoding: 'utf8' });
const probe = (home, opts) => remote.parseProbe(runHere(home)(remote.probeScript(opts)));

test('a probe finds the project by its markers, up to the home folder', () => {
  const home = serverHome();
  const python = lsp.CATALOG.find((e) => e.id === 'python');
  const p = probe(home, { file: `${home}/proj/pkg/main.py`, markers: python.markers, programs: python.programs });
  assert.equal(p.complete, true);
  assert.equal(p.root, `${home}/proj`);
  assert.equal(p.home, home);
  assert.equal(p.on['pyright-langserver'], `${home}/bin/pyright-langserver`);
  assert.equal(p.on['basedpyright-langserver'], undefined);
  assert.match(p.path, new RegExp(`^${home}/bin:.*:\\$HOME/.local/bin|${home}/bin`));
  // A stop given (the folder the search does not go above).
  assert.equal(probe(home, { file: `${home}/proj/pkg/main.py`, markers: python.markers, stop: `${home}/proj/pkg` }).root, `${home}/proj/pkg`);
});

test('a probe takes marker patterns and groups: the solution before the nearest project', () => {
  const home = serverHome();
  const csharp = lsp.CATALOG.find((e) => e.id === 'csharp');
  assert.equal(probe(home, { file: `${home}/sln/app/Program.cs`, markers: csharp.markers }).root, `${home}/sln`);
  assert.equal(probe(home, { file: `${home}/sln/app/Program.cs`, markers: [['*.csproj']] }).root, `${home}/sln/app`);
});

test('a probe gives light servers the Git repository, else the file’s folder', () => {
  const home = serverHome();
  assert.equal(probe(home, { file: `${home}/repo/conf/deep/settings.json`, markers: [], scope: 'folder' }).root, `${home}/repo`);
  assert.equal(probe(home, { file: `${home}/loose/notes/data.json`, markers: [], scope: 'folder' }).root, `${home}/loose/notes`);
});

test('a probe finds a project’s own programs, checks stand-ins, and TypeScript’s versions', () => {
  const home = serverHome();
  const ts = lsp.CATALOG.find((e) => e.id === 'typescript');
  const p = probe(home, { file: `${home}/web/src/app.ts`, markers: ts.markers, programs: ts.programs, typescript: true });
  assert.equal(p.root, `${home}/web`);
  assert.equal(p.bins['typescript-language-server'], `${home}/web/node_modules/.bin/typescript-language-server`);
  assert.equal(p.ts, '5.6.3');
  assert.equal(p.tsc, '7.0.2');
  assert.equal(p.tsserver, `${home}/npm/lib/node_modules/typescript/lib/tsserver.js`);
  const rust = probe(home, { file: `${home}/proj/main.rs`, markers: ['Cargo.toml'], programs: ['rust-analyzer'], verify: ['rust-analyzer'] });
  assert.equal(rust.on['rust-analyzer'], `${home}/bin/rust-analyzer`);
  assert.equal(rust.works.size, 0);
  // Only plain names reach the script.
  assert.doesNotMatch(remote.probeScript({ file: '/a/b.py', programs: ['ok-name', 'bad;rm -rf'], markers: ['x.toml', '../y'] }), /bad;|\.\.\/y/);
});

test('the catalog’s finds, answered from a probe', async () => {
  const ts = lsp.CATALOG.find((e) => e.id === 'typescript');
  const base = { root: '/srv/web', on: {}, bins: {}, works: new Set(), ts: '', tsc: '', tsserver: '', path: '', home: '/home/u', complete: true };
  // The project's TypeScript 5 with its typescript-language-server.
  let found = await ts.find(remote.remoteContext({ ...base, ts: '5.6.3', bins: { 'typescript-language-server': '/srv/web/node_modules/.bin/typescript-language-server' } }));
  assert.deepEqual(found, { name: 'TypeScript 5.6.3', command: '/srv/web/node_modules/.bin/typescript-language-server', args: ['--stdio'], init: { preferences: { useAliasesForRenames: false } } });
  // The project's TypeScript 7: its own server.
  found = await ts.find(remote.remoteContext({ ...base, ts: '7.0.2' }));
  assert.deepEqual(found, { name: 'TypeScript 7.0.2', command: '/srv/web/node_modules/.bin/tsc', args: ['--lsp', '--stdio'] });
  // Installed for everyone: typescript-language-server with the TypeScript next to it.
  found = await ts.find(remote.remoteContext({ ...base, tsc: '5.4.0', tsserver: '/usr/lib/node_modules/typescript/lib/tsserver.js', on: { tsc: '/usr/bin/tsc', 'typescript-language-server': '/usr/bin/typescript-language-server' } }));
  assert.equal(found.command, '/usr/bin/typescript-language-server');
  assert.equal(found.init.tsserver.fallbackPath, '/usr/lib/node_modules/typescript/lib/tsserver.js');
  // rust-analyzer only when it runs; Java and C# by name.
  const rust = lsp.CATALOG.find((e) => e.id === 'rust');
  assert.equal(await rust.find(remote.remoteContext({ ...base, on: { 'rust-analyzer': '/u/bin/rust-analyzer' } })), null);
  assert.equal((await rust.find(remote.remoteContext({ ...base, on: { 'rust-analyzer': '/u/bin/rust-analyzer' }, works: new Set(['/u/bin/rust-analyzer']) }))).command, '/u/bin/rust-analyzer');
  for (const [id, name] of [['java', 'jdtls'], ['csharp', 'csharp-ls']]) {
    const entry = lsp.CATALOG.find((e) => e.id === id);
    assert.deepEqual(entry.programs, [name]);
    assert.equal((await entry.find(remote.remoteContext({ ...base, on: { [name]: `/opt/bin/${name}` } }))).command, `/opt/bin/${name}`);
  }
  // Every catalog entry says which programs a probe looks for.
  for (const entry of lsp.CATALOG) assert.ok((entry.programs ?? entry.find.programs ?? []).length, entry.id);
});

test('the command a channel runs: quoted, in the project, with the probe’s PATH', () => {
  assert.equal(remote.remoteCommand({ root: "/srv/it's", command: '/u/bin/pyright-langserver', args: ['--stdio'], path: '/u/bin:/usr/bin' }), "PATH='/u/bin:/usr/bin'; export PATH; cd '/srv/it'\\''s' 2>/dev/null; exec '/u/bin/pyright-langserver' '--stdio'");
  assert.equal(remote.remoteCommand({ root: '/a', command: 'x' }), "cd '/a' 2>/dev/null; exec 'x'");
});

/** An ssh2 exec channel's face over a local process: the stream is stdout, writes go to stdin. */
function fakeChannel(child) {
  const stream = new EventEmitter();
  stream.stderr = child.stderr;
  stream.write = (b) => child.stdin.write(b);
  stream.signal = () => child.kill('SIGKILL');
  stream.close = () => child.stdin.end();
  child.stdout.on('data', (d) => stream.emit('data', d));
  child.on('exit', (code) => (stream.emit('exit', code), stream.emit('close')));
  return stream;
}

test('a channel works as a process: output, input, its end and its code', async () => {
  const child = spawn('sh', ['-c', 'read line; echo "got $line"; exit 4']);
  const proc = remote.channelProcess(fakeChannel(child));
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  const ended = new Promise((resolve) => proc.on('exit', resolve));
  proc.stdin.write('hello\n');
  assert.equal(await ended, 4);
  assert.equal(out.join('').trim(), 'got hello');
  assert.equal(typeof proc.kill, 'function');
});

function remoteHost(home, { connected = () => true, delay = 0 } = {}) {
  const events = [];
  const waiters = [];
  const send = (sender, channel, payload) => {
    events.push({ sender, channel, payload });
    for (const w of [...waiters]) if (w.match({ channel, payload })) waiters.splice(waiters.indexOf(w), 1), w.resolve({ channel, payload });
  };
  const next = (match) => {
    const seen = events.find(match);
    return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const children = [];
  const host = lsp.createLspHost({
    send,
    catalog: () => [lsp.customEntry({ id: 'mine', label: 'Mine', exts: ['.py'], command: '/bin/true', args: [], markers: [] }), ...lsp.CATALOG],
    remote: {
      run: async (_id, script) => runHere(home)(script),
      exec: async (_id, command) => {
        await new Promise((r) => setTimeout(r, delay));
        const child = spawn('sh', ['-c', command], { env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin` } });
        children.push(child);
        return fakeChannel(child);
      },
      label: () => 'Box',
      connected,
    },
  });
  return { host, events, next, children };
}

test('a server on an SSH server: found there, started there, messages waiting for its channel', async () => {
  const home = serverHome();
  const { host, events, next } = remoteHost(home, { delay: 150 });
  const sender = { id: 'page' };
  const started = await host.start(sender, `${home}/proj/pkg/main.py`, { remote: 'box1' });
  // Servers of your own run on this computer only: the catalog's Pyright here.
  assert.equal(started.server, 'Pyright');
  assert.deepEqual(started.where, { kind: 'remote', id: 'box1', name: 'Box' });
  assert.equal(started.root, `${home}/proj`);
  // Sent while the channel opens: kept, then delivered.
  assert.equal(host.write(started.id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } }), sender), true);
  const answer = await next((e) => e.channel === 'lsp:message' && e.payload.data.includes('"id":1'));
  assert.equal(JSON.parse(answer.payload.data).result.serverInfo.name, 'fake-lsp');
  const row = host.list(sender)[0];
  assert.match(row.command, /pyright-langserver --stdio \(on Box\)$/);
  assert.deepEqual(row.where, started.where);
  // The same project again: the same server.
  assert.equal((await host.start(sender, `${home}/proj/pkg/other.py`, { remote: 'box1' })).id, started.id);
  host.stopRemote('box1');
  await next((e) => e.channel === 'lsp:status' && e.payload.state === 'removed');
  assert.equal(host.list(sender).length, 0);
  assert.ok(events.some((e) => e.payload.state === 'starting'));
});

test('nothing installed there: Set up… for that server, with Linux’s commands', async () => {
  const home = serverHome();
  const { host } = remoteHost(home);
  const missing = await host.start({ id: 'page' }, `${home}/proj/tool.go`, { remote: 'box1' });
  assert.equal(missing.missing.language, 'Go (gopls)');
  assert.deepEqual(missing.missing.where, { kind: 'remote', id: 'box1', name: 'Box' });
  assert.deepEqual(missing.missing.install, ['go install golang.org/x/tools/gopls@latest']);
  // A kind of file with no server at all.
  assert.deepEqual(await host.start({ id: 'page' }, `${home}/proj/notes.txt`, { remote: 'box1' }), { none: true });
});

test('the connection went: the server is left stopped (not started again by itself)', async () => {
  const home = serverHome();
  let up = true;
  const { host, next, children } = remoteHost(home, { connected: () => up });
  const sender = { id: 'page' };
  const started = await host.start(sender, `${home}/proj/pkg/main.py`, { remote: 'box1' });
  await next((e) => e.channel === 'lsp:status' && e.payload.state === 'starting');
  await new Promise((r) => setTimeout(r, 200));
  up = false;
  children[0].kill('SIGKILL');
  const stopped = await next((e) => e.channel === 'lsp:status' && e.payload.state === 'stopped');
  assert.match(stopped.payload.message, /The connection to Box closed/);
  host.stop(started.id, '', sender);
});

test('a synced file: one server for all of them, in the notes folder', async () => {
  const notes = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-notes-')));
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-bin-')));
  exe(`${bin}/pyright-langserver`, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  const host = lsp.createLspHost({ send: () => {}, env: { PATH: `${bin}:/usr/bin:/bin` }, locateServer: (f, opts) => lsp.locate(f, { ...opts, login: false }) });
  const sender = { id: 'page' };
  try {
    const a = await host.start(sender, `${notes}/aaa/one.py`, { note: true, root: notes });
    const b = await host.start(sender, `${notes}/bbb/two.py`, { note: true, root: notes });
    assert.equal(a.id, b.id);
    assert.equal(a.root, notes);
    assert.deepEqual(a.where, { kind: 'notes' });
  } finally {
    host.stopAll();
  }
});

test('marker patterns and groups here too: the solution before the project', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-glob-')));
  file(`${dir}/All.sln`, '');
  file(`${dir}/app/app.csproj`, '');
  file(`${dir}/app/Program.cs`, '');
  const csharp = lsp.CATALOG.find((e) => e.id === 'csharp');
  assert.equal(lsp.rootFor(csharp, `${dir}/app/Program.cs`, { stop: dir }), dir);
  assert.equal(lsp.findRoot(`${dir}/app/Program.cs`, ['*.csproj'], { stop: dir }), `${dir}/app`);
  // Java: a Gradle build's top folder (its settings file) before the module's own build file.
  file(`${dir}/gradle/settings.gradle.kts`, '');
  file(`${dir}/gradle/core/build.gradle.kts`, '');
  file(`${dir}/gradle/core/src/A.java`, '');
  assert.equal(lsp.rootFor(lsp.CATALOG.find((e) => e.id === 'java'), `${dir}/gradle/core/src/A.java`, { stop: dir }), `${dir}/gradle`);
  // Windows .bat launchers (jdtls.bat) go through cmd.exe, as .cmd ones do.
  assert.deepEqual(lsp.runnable('C:\\jdtls\\bin\\jdtls.bat', { platform: 'win32', realpath: (p) => p, read: () => '@echo off\n' }), { command: 'C:\\jdtls\\bin\\jdtls.bat', shell: true });
});

test('labels say where a server runs', () => {
  assert.equal(serverLabel({ server: 'Pyright', state: 'running', where: { kind: 'remote', id: 'x', name: 'Box' } }), 'Pyright on Box · ready');
  assert.equal(serverLabel({ server: 'Pyright', state: 'running', where: { kind: 'notes' } }), 'Pyright · ready');
  assert.equal(whereLabel({ kind: 'remote', name: 'Box' }), 'on Box');
  assert.equal(whereLabel({ kind: 'local' }), 'on this computer');
  assert.equal(whereLabel(null), 'on this computer');
  assert.match(whereLabel({ kind: 'notes' }), /single files/);
});
