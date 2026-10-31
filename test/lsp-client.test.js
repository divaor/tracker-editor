// The page's side of the language servers (app/js/lsp.js) against the real host (lsp.cjs) and
// the fake server, without an editor: workspace folders as projects come and go, a question a
// slow server does not answer in time cancelled there, and languages turned off in Settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLanguageServers } from '../app/js/lsp.js';

const require = createRequire(import.meta.url);
const lsp = require('../electron/lsp.cjs');
const FAKE = fileURLToPath(new URL('./helpers/fake-lsp.cjs', import.meta.url));

/** The page's client wired to a host in this process, as main.cjs and the preload do. */
function connected({ languages = () => ({}) } = {}) {
  const on = { message: () => {}, status: () => {} };
  const sender = {};
  const host = lsp.createLspHost({
    send: (_sender, channel, payload) => (channel === 'lsp:message' ? on.message(payload) : on.status(payload)),
    locateServer: async (file) => ({ entry: lsp.catalogFor(file), root: path.dirname(file), found: { name: 'Fake', script: FAKE, args: ['--stdio'] }, env: process.env }),
  });
  const bridge = {
    onMessage: (f) => (on.message = f),
    onStatus: (f) => (on.status = f),
    start: (file, opts) => host.start(sender, file, { languages: opts?.languages }),
    send: (id, message) => host.write(id, message, sender),
    stop: (id) => host.stop(id, '', sender),
    restart: (id) => host.restart(id, sender),
    list: () => host.list(sender),
    multiRoot: (id, can) => host.multiRoot(id, sender, can),
    stopEntry: (id) => host.stopEntry(id, '', sender),
  };
  const editor = { setLanguageServer() {}, refreshProblems() {}, stateOf: () => null, viewFor: () => null, applyChanges() {} };
  const servers = createLanguageServers({ host: editor, bridge, languages });
  const stderr = () => host.list(sender).flatMap((r) => r.stderr).join('\n');
  return { host, servers, stderr };
}

const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('projects open at once share a server as its workspace folders', async () => {
  const { host, servers, stderr } = connected();
  const one = mkdtempSync(path.join(tmpdir(), 'client-one-'));
  const two = mkdtempSync(path.join(tmpdir(), 'client-two-'));
  await servers.attach('d:a', path.join(one, 'a.ts'));
  await until(() => servers.has('d:a'));
  assert.match(stderr(), new RegExp(`folders ${path.basename(one)}`));
  await servers.attach('d:b', path.join(two, 'b.ts'));
  assert.equal(servers.statusOf('d:b').id, servers.statusOf('d:a').id);
  await until(() => stderr().includes(`folders +${path.basename(two)}`));
  const [row] = await servers.list();
  assert.deepEqual(row.folders, [one, two]);
  // A second file there adds nothing; the last one closed lets the folder go.
  await servers.attach('d:c', path.join(two, 'c.ts'));
  servers.forget('d:b');
  assert.equal((await servers.list())[0].folders.length, 2);
  servers.forget('d:c');
  await until(() => stderr().includes(`folders -${path.basename(two)}`));
  assert.deepEqual((await servers.list())[0].folders, [one]);
  host.stopAll();
});

test('a question a server does not answer in time is cancelled there', async () => {
  const { host, servers, stderr } = connected();
  const dir = mkdtempSync(path.join(tmpdir(), 'client-slow-'));
  await servers.attach('d:a', path.join(dir, 'a.ts'));
  await until(() => servers.has('d:a'));
  const started = Date.now();
  assert.deepEqual(await servers.workspaceSymbols('SLOW'), []);
  assert.ok(Date.now() - started < 6000);
  await until(() => /cancelled \d+/.test(stderr()));
  host.stopAll();
});

test('a language turned off gets no server; turned on again, it does', async () => {
  let off = ['typescript'];
  const { host, servers } = connected({ languages: () => ({ off, prefer: {} }) });
  const dir = mkdtempSync(path.join(tmpdir(), 'client-off-'));
  await servers.attach('d:a', path.join(dir, 'a.ts'));
  assert.equal(servers.statusOf('d:a'), null);
  off = [];
  await servers.languagesChanged(['typescript']);
  await servers.attach('d:a', path.join(dir, 'a.ts'));
  await until(() => servers.has('d:a'));
  assert.equal(servers.entryOf('d:a'), 'typescript');
  // Turned off with the file open: the tab lets its server go, which stops.
  off = ['typescript'];
  await servers.languagesChanged(['typescript']);
  assert.equal(servers.statusOf('d:a'), null);
  await until(() => host.list().length === 0);
});
