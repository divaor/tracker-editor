// The terminal on this computer: which shell, its environment and folder, and a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { defaultShell, openLocalShell, shellEnv, startDir } = require('../electron/localShell.cjs');

test('the default shell', () => {
  const has = (...files) => (p) => files.includes(p);
  assert.deepEqual(defaultShell({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, exists: has('/usr/bin/fish') }), { file: '/usr/bin/fish', args: [], kind: 'posix' });
  assert.equal(defaultShell({ platform: 'linux', env: {}, exists: has('/bin/bash') }).file, '/bin/bash');
  assert.equal(defaultShell({ platform: 'linux', env: { SHELL: '/gone' }, exists: has() }).file, '/bin/sh');
  assert.deepEqual(defaultShell({ platform: 'darwin', env: {}, exists: has() }), { file: '/bin/zsh', args: ['-l'], kind: 'posix' });
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.equal(defaultShell({ platform: 'win32', env: { PATH: 'C:\\Windows;C:\\Program Files\\PowerShell\\7' }, exists: has(pwsh) }).file, pwsh);
  const old = defaultShell({ platform: 'win32', env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\WINDOWS' }, exists: has() });
  assert.equal(old.file, 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(old.kind, 'powershell');
});

test('the environment and the folder', () => {
  const env = shellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', APPDIR: '/tmp/.mount_x', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib:/opt/lib', HOME: '/home/me' });
  // The person's own variables stay; Electron's and the AppImage's go.
  assert.deepEqual(env, { PATH: '/bin', NODE_OPTIONS: '--x', HOME: '/home/me', LD_LIBRARY_PATH: '/opt/lib', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TrackerEditor' });
  assert.equal(startDir(os.tmpdir()), os.tmpdir());
  assert.equal(startDir('relative/dir'), os.homedir());
  assert.equal(startDir('/no/such/folder/here'), os.homedir());
});

test('the shell runs in a pseudo-terminal: keys in, output out, closing ends it', { skip: process.platform === 'win32' }, async () => {
  const dir = realpathSync(os.tmpdir());
  const shell = openLocalShell({ cwd: dir, cols: 80, rows: 24, env: { ...process.env, SHELL: '/bin/sh', PS1: '$ ' } });
  let out = '';
  shell.on('data', (d) => (out += d));
  shell.write('echo "sum=$((20 + 22))"; pwd\r');
  const until = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  assert.ok(await until(() => out.includes('sum=42')), out);
  assert.ok(out.includes(dir), out);
  shell.setWindow(30, 100);
  const closed = new Promise((r) => shell.once('close', r));
  shell.close();
  await closed;
});
