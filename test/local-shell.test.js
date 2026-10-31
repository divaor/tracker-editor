// The terminal on this computer: which shell, its environment and folder, and a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { defaultShell, listShells, listWslDistros, openLocalShell, shellEnv, startDir } = require('../electron/localShell.cjs');
const { integrate, POWERSHELL, cmdPrompt } = require('../electron/shellHooks.cjs');

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

test('the shells offered: Windows’ own, Git Bash and WSL; the person’s and the usual ones elsewhere', async () => {
  const has = (...files) => (p) => files.includes(p);
  const win = listShells({
    platform: 'win32',
    env: { PATH: 'C:\\Program Files\\PowerShell\\7;C:\\Program Files\\Git\\cmd', SystemRoot: 'C:\\WINDOWS', ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    exists: has('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\WINDOWS\\System32\\wsl.exe'),
    distros: ['Ubuntu', 'Debian'],
  });
  assert.deepEqual(win.map((sh) => [sh.id, sh.kind]), [['pwsh', 'powershell'], ['powershell', 'powershell'], ['cmd', 'cmd'], ['gitbash', 'posix'], ['wsl:Ubuntu', 'wsl'], ['wsl:Debian', 'wsl']]);
  assert.equal(win.find((sh) => sh.id === 'gitbash').file, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.deepEqual(win.find((sh) => sh.id === 'wsl:Debian').args, ['-d', 'Debian']);
  const linux = listShells({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, exists: has('/usr/bin/fish', '/bin/bash', '/usr/bin/zsh') });
  assert.deepEqual(linux.map((sh) => sh.id), ['fish', 'zsh', 'bash']);
  assert.deepEqual(listShells({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: has('/bin/zsh', '/bin/bash') }).map((sh) => [sh.id, sh.args]), [['zsh', ['-l']], ['bash', ['-l']]]);
  // WSL's list comes in UTF-16, with a byte order mark and odd lines.
  const utf16 = Buffer.from('\ufeffUbuntu\r\nDebian\r\n\r\n', 'utf16le');
  assert.deepEqual(await listWslDistros({ run: (_f, _a, _o, cb) => cb(null, utf16) }), ['Ubuntu', 'Debian']);
  assert.deepEqual(await listWslDistros({ run: (_f, _a, _o, cb) => cb(new Error('no wsl')) }), []);
});

test('each shell is started so it says its folder, its own startup files still run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  const env = { PATH: '/bin' };
  const bash = integrate({ id: 'bash', args: [], integration: 'bash' }, env, dir);
  // Git Bash takes C:/… better than C:\… (Windows).
  const initFile = path.join(dir, 'bash', 'init.bash');
  assert.deepEqual(bash.args, ['--init-file', process.platform === 'win32' ? initFile.replace(/\\/g, '/') : initFile, '-i']);
  assert.ok(existsSync(path.join(dir, 'bash', 'init.bash')));
  // A login shell (macOS, Git Bash) runs the login files from the init file instead.
  assert.equal(integrate({ id: 'bash', args: ['-l'], integration: 'bash' }, env, dir).env.TRACKER_LOGIN, '1');
  const zsh = integrate({ id: 'zsh', args: ['-l'], integration: 'zsh' }, { ...env, ZDOTDIR: '/home/me/.config/zsh' }, dir);
  assert.equal(zsh.env.ZDOTDIR, path.join(dir, 'zsh'));
  assert.equal(zsh.env.TE_ZDOTDIR, '/home/me/.config/zsh');
  assert.deepEqual(zsh.args, ['-l']);
  assert.equal(integrate({ id: 'fish', args: [], integration: 'fish' }, env, dir).args[0], '--init-command');
  const ps = integrate({ id: 'pwsh', args: ['-NoLogo'], integration: 'powershell' }, env, dir);
  assert.deepEqual(ps.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  assert.equal(Buffer.from(ps.args[3], 'base64').toString('utf16le'), POWERSHELL);
  assert.equal(integrate({ id: 'cmd', args: [], integration: 'cmd' }, { PROMPT: '$P$_$G' }, dir).env.PROMPT, '$E]9;9;$P$E\\$P$_$G');
  assert.equal(cmdPrompt(''), '$E]9;9;$P$E\\$P$G');
  // A shell without integration (WSL, sh), or no folder to keep the scripts: as it is.
  assert.deepEqual(integrate({ id: 'wsl', args: ['-d', 'Ubuntu'], integration: null }, env, dir), { args: ['-d', 'Ubuntu'], env });
  assert.deepEqual(integrate({ id: 'bash', args: [], integration: 'bash' }, env, ''), { args: [], env });
});

// A real shell with its integration: after a cd it says the new folder (OSC 7), and the
// person's own startup file ran first.
async function saysFolder(shell, home, extraEnv = {}) {
  const hooks = mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  const target = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'a dir ')));
  const s = openLocalShell({ shell, hooksDir: hooks, cwd: home, cols: 120, rows: 30, env: { PATH: process.env.PATH, HOME: home, SHELL: `/usr/bin/${shell}`, TERM: 'xterm', ...extraEnv } });
  let out = '';
  s.on('data', (d) => (out += d));
  const until = async (fn, ms = 8000) => {
    for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  await until(() => out.length > 0);
  s.write(`cd '${target}'\r`);
  s.write('echo "own=$OWN_RC"\r');
  const said = await until(() => out.includes(`\u001b]7;file://`) && out.includes(target.split(' ')[0].split('/').pop()) && /\u001b\]7;file:\/\/[^\u0007]*a%20dir/.test(out));
  const own = await until(() => out.includes('own=yes'));
  s.close();
  return { said, own, out };
}

test('bash says its folder after a cd, and runs ~/.bashrc (macOS: a login shell, ~/.bash_profile)', { skip: !existsSync('/usr/bin/bash') && !existsSync('/bin/bash') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  writeFileSync(path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), 'export OWN_RC=yes\nPS1="$ "\n');
  const r = await saysFolder('bash', home);
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
});

test('zsh says its folder after a cd, and runs ~/.zshrc', { skip: !existsSync('/usr/bin/zsh') && !existsSync('/bin/zsh') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  writeFileSync(path.join(home, '.zshrc'), 'export OWN_RC=yes\nPROMPT="$ "\n');
  const r = await saysFolder('zsh', home);
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
});

test('fish says its folder after a cd', { skip: !existsSync('/usr/bin/fish') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), 'set -gx OWN_RC yes\n');
  const r = await saysFolder('fish', home, { XDG_CONFIG_HOME: path.join(home, '.config') });
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
});
