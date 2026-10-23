// Language servers in the main process (electron/lsp.cjs): message framing, the project
// folder, finding servers on PATH and in projects, and running them (the fake server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lsp = require('../electron/lsp.cjs');
const FAKE = fileURLToPath(new URL('./helpers/fake-lsp.cjs', import.meta.url));

test('messages are framed with their length in bytes', () => {
  assert.equal(lsp.frame('{"a":"é"}').toString('utf8'), 'Content-Length: 10\r\n\r\n{"a":"é"}');
});

test('messages are read whatever chunks they come in', () => {
  const got = [];
  const read = lsp.createReader((m) => got.push(m));
  const one = lsp.frame('{"id":1,"text":"ünïcode ✓"}');
  const two = lsp.frame('{"id":2}');
  const all = Buffer.concat([one, two]);
  // Byte by byte (headers and characters cut in two), then two at once.
  for (const byte of all) read(Buffer.from([byte]));
  read(all);
  assert.deepEqual(got, ['{"id":1,"text":"ünïcode ✓"}', '{"id":2}', '{"id":1,"text":"ünïcode ✓"}', '{"id":2}']);
  // Other headers are fine; something that is not LSP stops the reader.
  const other = [];
  const errors = [];
  const read2 = lsp.createReader((m) => other.push(m), (e) => errors.push(e));
  read2(Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}'));
  read2(Buffer.from('Hello there\r\n\r\n{}'));
  read2(lsp.frame('{}'));
  assert.deepEqual(other, ['{}']);
  assert.match(errors[0], /Not a language server message/);
});

test('the project folder: the nearest marker up to the folder picked', () => {
  // Absolute paths in this system's form (C:\w\… on Windows).
  const w = (...p) => path.resolve('/w', ...p);
  const files = new Set([w('app', 'package.json'), w('.git'), w('app', 'src', 'x', '.keep'), w('py', 'pyproject.toml')]);
  const exists = (p) => files.has(p);
  const file = w('app', 'src', 'x', 'a.ts');
  assert.equal(lsp.findRoot(file, ['tsconfig.json', 'package.json'], { stop: w(), exists }), w('app'));
  // Never above the folder picked: there, the .git found on the way, else the file's folder.
  assert.equal(lsp.findRoot(file, ['tsconfig.json', 'package.json'], { stop: w('app', 'src'), exists }), w('app', 'src', 'x'));
  assert.equal(lsp.findRoot(w('lib', 'a.py'), ['pyproject.toml'], { stop: w(), exists }), w());
  assert.equal(lsp.findRoot(w('py', 'sub', 'a.py'), ['pyproject.toml'], { stop: w(), exists }), w('py'));
  // A file opened alone (no folder picked): its own folder unless a marker is right there.
  assert.equal(lsp.findRoot(file, ['package.json'], { exists }), w('app', 'src', 'x'));
});

test('servers are found on PATH (with Windows extensions) and run on Electron’s Node when they are scripts', () => {
  const have = new Set(['/usr/local/bin/pyright-langserver', 'C:\\Users\\me\\AppData\\Roaming\\npm\\tsc.cmd']);
  const exists = (p) => have.has(p);
  assert.equal(lsp.searchPath('pyright-langserver', { env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'linux', exists }), '/usr/local/bin/pyright-langserver');
  assert.equal(lsp.searchPath('tsc', { env: { Path: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm' }, platform: 'win32', exists }), 'C:\\Users\\me\\AppData\\Roaming\\npm\\tsc.cmd');
  assert.equal(lsp.searchPath('gopls', { env: { PATH: '/usr/bin' }, platform: 'linux', exists }), null);

  // An npm link resolves to a .js file; a script with a node shebang; an npm .cmd shim; a program.
  assert.deepEqual(lsp.runnable('/usr/bin/x', { platform: 'linux', realpath: () => '/usr/lib/node_modules/x/cli.mjs' }), { script: '/usr/lib/node_modules/x/cli.mjs' });
  assert.deepEqual(lsp.runnable('/usr/bin/tsc', { platform: 'linux', realpath: (p) => p, read: () => '#!/usr/bin/env node\nrequire("x")' }), { script: '/usr/bin/tsc' });
  const shim = '@ECHO off\r\nGOTO start\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\typescript\\bin\\tsc" %*\r\n';
  assert.deepEqual(lsp.runnable('C:\\npm\\tsc.cmd', { platform: 'win32', realpath: (p) => p, read: () => shim }), { script: 'C:\\npm\\node_modules\\typescript\\bin\\tsc' });
  assert.deepEqual(lsp.runnable('/usr/bin/gopls', { platform: 'linux', realpath: (p) => p, read: () => '\x7fELF' }), { command: '/usr/bin/gopls' });
  // A link to a program runs by its own name (rustup's rust-analyzer is a link to rustup).
  assert.deepEqual(lsp.runnable('/h/.cargo/bin/rust-analyzer', { platform: 'linux', realpath: () => '/h/.cargo/bin/rustup', read: () => '\x7fELF' }), { command: '/h/.cargo/bin/rust-analyzer' });

  // Electron's own variables never reach a server; PATH gets the login shell's folders after the app's.
  assert.deepEqual(lsp.serverEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
  const env = lsp.searchEnv({ PATH: '/usr/bin:/bin' }, '/opt/node/bin:/usr/bin', 'linux');
  assert.match(env.PATH, /^\/usr\/bin:\/bin:\/opt\/node\/bin:/);
});

test('the catalog: TypeScript and Python files, with what to install', () => {
  assert.equal(lsp.catalogFor('/w/a.tsx').id, 'typescript');
  assert.equal(lsp.catalogFor('/w/a.MJS').languageIds['.mjs'], 'javascript');
  assert.equal(lsp.catalogFor('/w/a.py').id, 'python');
  assert.equal(lsp.catalogFor('/w/notes.md'), null);
  assert.deepEqual(lsp.CATALOG.find((e) => e.id === 'typescript').install, ['npm install -g typescript']);
});

test('a project’s own servers: TypeScript 7 in node_modules, Pyright in node_modules/.bin', async () => {
  // The real path (macOS's temporary folder is behind a link), as the main process resolves them.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-proj-')));
  const ts = path.join(dir, 'node_modules', 'typescript');
  mkdirSync(path.join(ts, 'lib'), { recursive: true });
  writeFileSync(path.join(ts, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.1.0' }));
  writeFileSync(path.join(ts, 'lib', 'tsc.js'), '');
  writeFileSync(path.join(dir, 'package.json'), '{}');
  mkdirSync(path.join(dir, 'src'));
  const found = await lsp.locate(path.join(dir, 'src', 'a.ts'), { stop: dir, env: { PATH: '' }, login: false });
  assert.equal(found.root, dir);
  // The native program for this platform is not there: the script that starts it.
  assert.deepEqual(found.found, { name: 'TypeScript 7.1.0', script: path.join(ts, 'lib', 'tsc.js'), args: ['--lsp', '--stdio'] });

  const bin = path.join(dir, 'node_modules', '.bin');
  mkdirSync(bin);
  writeFileSync(path.join(dir, 'server.js'), '#!/usr/bin/env node\n');
  // npm links the program on macOS and Linux, and writes a .cmd that names the script on Windows.
  if (process.platform === 'win32') writeFileSync(path.join(bin, 'pyright-langserver.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\..\\server.js" %*\r\n');
  else symlinkSync(path.join(dir, 'server.js'), path.join(bin, 'pyright-langserver'));
  const py = await lsp.locate(path.join(dir, 'tool.py'), { stop: dir, env: { PATH: '' }, login: false });
  assert.deepEqual(py.found, { name: 'Pyright', script: path.join(dir, 'server.js'), args: ['--stdio'] });
  const none = await lsp.locate(path.join(mkdtempSync(path.join(tmpdir(), 'lsp-empty-')), 'a.py'), { env: { PATH: '' }, login: false });
  assert.equal(none.found, null);
});

test('more languages: Go, Rust, C and C++, JSON, CSS, HTML, YAML, Bash', async () => {
  const ids = { 'a.go': 'go', 'lib.rs': 'rust', 'x.c': 'c', 'x.hpp': 'c', 'package.json': 'json', 'tsconfig.jsonc': 'json', 'a.scss': 'css', 'index.htm': 'html', 'ci.yml': 'yaml', 'run.sh': 'bash' };
  for (const [name, id] of Object.entries(ids)) assert.equal(lsp.catalogFor(`/w/${name}`)?.id, id, name);
  assert.equal(lsp.catalogFor('/w/x.cpp').languageIds['.cpp'], 'cpp');
  assert.equal(lsp.catalogFor('/w/run.sh').languageIds['.sh'], 'shellscript');
  // Install commands per platform where they differ (clangd), else the same everywhere.
  const c = lsp.CATALOG.find((e) => e.id === 'c');
  assert.deepEqual(lsp.installFor(c, 'win32'), ['winget install LLVM.LLVM']);
  assert.ok(lsp.installFor(c, 'linux').includes('sudo apt install clangd'));
  assert.deepEqual(lsp.installFor(lsp.CATALOG.find((e) => e.id === 'go'), 'darwin'), ['go install golang.org/x/tools/gopls@latest']);
  // The JSON server knows the schemas of well-known files.
  assert.ok(lsp.JSON_SCHEMAS.some((x) => x.fileMatch.includes('package.json') && x.url.endsWith('/package.json')));

  // Found on PATH (a fake bin folder): each with its arguments.
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-bin-')));
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-langs-')));
  const program = (name, text = '#!/bin/sh\nexit 0\n') => {
    const file = path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);
    writeFileSync(file, text, { mode: 0o755 });
    return file;
  };
  program('gopls');
  program('clangd');
  writeFileSync(path.join(dir, 'server.js'), '#!/usr/bin/env node\n');
  for (const name of ['vscode-json-language-server', 'yaml-language-server', 'bash-language-server']) {
    if (process.platform === 'win32') writeFileSync(path.join(bin, `${name}.cmd`), '@ECHO off\r\n"%_prog%"  "%dp0%\\server.js" %*\r\n');
    else symlinkSync(path.join(dir, 'server.js'), path.join(bin, name));
  }
  const env = { PATH: bin };
  const at = (name) => lsp.locate(path.join(dir, name), { stop: dir, env, login: false });
  assert.deepEqual((await at('main.go')).found, { name: 'gopls', command: path.join(bin, process.platform === 'win32' ? 'gopls.exe' : 'gopls'), args: [] });
  assert.equal((await at('a.c')).found.name, 'clangd');
  assert.deepEqual((await at('x.json')).found.args, ['--stdio']);
  assert.deepEqual((await at('x.yaml')).found.args, ['--stdio']);
  assert.deepEqual((await at('x.sh')).found.args, ['start']);
  assert.equal((await at('x.css')).found, null);

  if (process.platform !== 'win32') {
    // rustup's stand-in for rust-analyzer fails until the component is added: missing, not broken.
    program('rust-analyzer', '#!/bin/sh\necho "error: Unknown binary rust-analyzer" >&2\nexit 1\n');
    assert.equal((await at('main.rs')).found, null);
    program('rust-analyzer', '#!/bin/sh\necho "rust-analyzer 1.0"\n');
    assert.equal((await at('main.rs')).found.name, 'rust-analyzer');
  }
});

test('light servers run once for the folder opened; project servers per project', () => {
  const w = (...p) => path.resolve('/w', ...p);
  const files = new Set([w('app', 'package.json'), w('svc', 'go.mod')]);
  const exists = (p) => files.has(p);
  const json = lsp.CATALOG.find((e) => e.id === 'json');
  const go = lsp.CATALOG.find((e) => e.id === 'go');
  // A JSON file deep inside: the folder opened, not its project.
  assert.equal(lsp.rootFor(json, w('app', 'src', 'x.json'), { stop: w(), exists }), w());
  // Opened alone (no folder picked): its own folder.
  assert.equal(lsp.rootFor(json, w('app', 'src', 'x.json'), { exists }), w('app', 'src'));
  assert.equal(lsp.rootFor(go, w('svc', 'cmd', 'main.go'), { stop: w(), exists }), w('svc'));
});

test('servers of your own: described, checked, and found as named', async () => {
  assert.deepEqual(lsp.parseArgs(`--stdio --log "C:\\Program Files\\x.log" 'a b'`), ['--stdio', '--log', 'C:\\Program Files\\x.log', 'a b']);
  const def = lsp.cleanCustom({ label: 'Lua', exts: 'lua, .LUAU *.rockspec', command: 'lua-language-server', args: '--stdio', markers: '.luarc.json' });
  assert.deepEqual(def, { id: 'lua', label: 'Lua', exts: ['.lua', '.luau', '.rockspec'], command: 'lua-language-server', args: ['--stdio'], markers: ['.luarc.json'] });
  assert.throws(() => lsp.cleanCustom({ label: '', exts: '.lua', command: 'x' }), /name/);
  assert.throws(() => lsp.cleanCustom({ label: 'X', exts: '', command: 'x' }), /extensions/);
  assert.throws(() => lsp.cleanCustom({ label: 'X', exts: '.x', command: 'a\nb' }), /program/);
  assert.throws(() => lsp.cleanCustom({ label: 'X', exts: '.x', command: 'x', markers: '../up' }), /markers/);

  // As a catalog entry: before the built-in ones for its extensions.
  const entry = lsp.customEntry({ ...def, exts: ['.lua', '.json'] });
  assert.equal(lsp.catalogFor('/w/a.json', [entry, ...lsp.CATALOG]).id, 'custom:lua');
  assert.equal(entry.languageIds['.lua'], 'lua');
  // It runs exactly the program named: a full path must be there; a name is looked for on PATH.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-custom-')));
  const missing = await lsp.locate(path.join(dir, 'a.lua'), { stop: dir, env: { PATH: '' }, login: false, entries: [entry] });
  assert.equal(missing.found, null);
  const full = lsp.customEntry({ ...def, command: FAKE });
  const found = await lsp.locate(path.join(dir, 'a.lua'), { stop: dir, env: { PATH: '' }, login: false, entries: [full] });
  assert.deepEqual(found.found, { name: 'Lua', script: FAKE, args: ['--stdio'] });
  // Without project files, the folder opened is its folder.
  assert.equal(found.root, dir);
});

// ---- Running the fake server ----

function fakeHost(opts = {}) {
  const events = [];
  const waiters = [];
  const send = (sender, channel, payload) => {
    events.push({ channel, payload });
    for (const w of [...waiters]) if (w.test({ channel, payload })) w.resolve({ channel, payload }), waiters.splice(waiters.indexOf(w), 1);
  };
  const next = (test, ms = 8000) =>
    new Promise((resolve, reject) => {
      const found = events.find(test);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error('timed out')), ms);
      waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  const host = lsp.createLspHost({
    send,
    nodePath: process.execPath,
    locateServer: async (file) => ({ entry: lsp.catalogFor(file), root: path.dirname(file), found: { name: 'Fake', script: FAKE, args: ['--stdio'] }, env: process.env }),
    ...opts,
  });
  return { host, events, next };
}

test('a server starts, talks, and stops', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lsp-run-'));
  const { host, events, next } = fakeHost();
  const sender = { id: 'page' };
  const started = await host.start(sender, path.join(dir, 'a.ts'));
  assert.equal(started.server, 'Fake');
  assert.equal(started.languageId, 'typescript');
  // A second file of the same project uses the same server.
  assert.equal((await host.start(sender, path.join(dir, 'b.js'))).id, started.id);
  assert.equal((await host.start(sender, path.join(dir, 'b.js'))).languageId, 'javascript');
  host.write(started.id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } }), sender);
  const answer = await next((e) => e.channel === 'lsp:message' && e.payload.data.includes('"id":1'));
  assert.equal(JSON.parse(answer.payload.data).result.serverInfo.name, 'fake-lsp');
  // Another page cannot write to it.
  assert.equal(host.write(started.id, '{}', { id: 'other' }), false);
  assert.match(host.list(sender)[0].stderr.join('\n'), /fake-lsp started/);
  host.stop(started.id, '', sender);
  await next((e) => e.channel === 'lsp:status' && e.payload.state === 'removed');
  assert.equal(host.list(sender).length, 0);
  assert.ok(events.some((e) => e.payload.state === 'starting'));
});

test('a server that ends is started again, and left stopped after three times', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lsp-crash-'));
  let t = 0;
  const { host, next, events } = fakeHost({ now: () => (t += 10) });
  const sender = {};
  const { id } = await host.start(sender, path.join(dir, 'a.py'));
  const crash = () => host.write(id, JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///x.py', languageId: 'python', version: 0, text: 'CRASH_NOW' } } }), sender);
  crash();
  await next((e) => e.payload.state === 'restarting');
  await next((e) => e.payload.state === 'starting' && events.filter((x) => x.payload.state === 'starting').length >= 2);
  crash();
  await next((e) => events.filter((x) => x.payload.state === 'restarting').length >= 2);
  await new Promise((r) => setTimeout(r, 2300));
  crash();
  const stopped = await next((e) => e.payload.state === 'stopped');
  assert.match(stopped.payload.message, /ended 3 times/);
  // Restart (from the panel) brings it back.
  host.restart(id, sender);
  await next((e) => e.payload.state === 'starting' && events.filter((x) => x.payload.state === 'starting').length >= 4);
  host.stopAll();
});

test(`at most ${lsp.MAX_SERVERS} servers: one more stops the one used longest ago`, async () => {
  let t = 0;
  const { host, next } = fakeHost({ now: () => (t += 10) });
  const sender = {};
  const ids = [];
  for (let i = 0; i <= lsp.MAX_SERVERS; i++) ids.push((await host.start(sender, path.join(mkdtempSync(path.join(tmpdir(), 'lsp-many-')), 'a.ts'))).id);
  const removed = await next((e) => e.payload.state === 'removed');
  assert.equal(removed.payload.id, ids[0]);
  assert.match(removed.payload.message, new RegExp(`at most ${lsp.MAX_SERVERS}`));
  assert.equal(host.list(sender).length, lsp.MAX_SERVERS);
  host.stopAll();
});

test('a server of your own starts through the catalog the host is given', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-own-')));
  const entry = lsp.customEntry(lsp.cleanCustom({ label: 'Fake Lua', exts: '.lua', command: FAKE, args: '--stdio' }));
  const { host, next } = fakeHost({ locateServer: lsp.locate, catalog: () => [entry, ...lsp.CATALOG] });
  const sender = {};
  const started = await host.start(sender, path.join(dir, 'a.lua'), { stop: dir });
  assert.equal(started.server, 'Fake Lua');
  assert.equal(started.languageId, 'lua');
  host.write(started.id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } }), sender);
  await next((e) => e.channel === 'lsp:message' && e.payload.data.includes('fake-lsp'));
  // Changed or removed in Settings: it stops.
  host.stopEntry(entry.id, 'Fake Lua was removed.');
  const removed = await next((e) => e.payload.state === 'removed');
  assert.match(removed.payload.message, /removed/);
  // Missing: what to tell the person.
  const gone = lsp.customEntry(lsp.cleanCustom({ label: 'Gone', exts: '.zz', command: '/nowhere/zz-server', args: '' }));
  const { host: host2 } = fakeHost({ locateServer: lsp.locate, catalog: () => [gone] });
  const missing = await host2.start(sender, path.join(dir, 'a.zz'), { stop: dir });
  assert.equal(missing.missing.custom, true);
  assert.equal(missing.missing.command, '/nowhere/zz-server');
});
