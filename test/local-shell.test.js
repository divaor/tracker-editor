// The terminal on this computer: which shell, its environment and folder, and a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { defaultShell, listShells, listWslDistros, openLocalShell, shellEnv, startDir } = require('../electron/localShell.cjs');
const { integrate, POWERSHELL, cmdPrompt } = require('../electron/shellHooks.cjs');
const { commandLine } = await import('../app/js/terminalTabs.js');

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
  // The nonce of "this line runs" (OSC 633;E): in its environment for the shells that say it; not cmd's.
  assert.equal(integrate({ id: 'fish', args: [], integration: 'fish' }, env, dir, { nonce: 'abcdef0123456789' }).env.TE_NONCE, 'abcdef0123456789');
  assert.equal(integrate({ id: 'bash', args: [], integration: 'bash' }, env, dir, { nonce: 'abcdef0123456789' }).nonce, 'abcdef0123456789');
  assert.equal(integrate({ id: 'cmd', args: [], integration: 'cmd' }, env, dir, { nonce: 'abcdef0123456789' }).env.TE_NONCE, undefined);
  assert.equal(integrate({ id: 'zsh', args: [], integration: 'zsh' }, env, dir, { nonce: 'not hex;' }).env.TE_NONCE, undefined);
  const ps = integrate({ id: 'pwsh', args: ['-NoLogo'], integration: 'powershell' }, env, dir);
  assert.deepEqual(ps.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  assert.equal(Buffer.from(ps.args[3], 'base64').toString('utf16le'), POWERSHELL);
  assert.equal(integrate({ id: 'cmd', args: [], integration: 'cmd' }, { PROMPT: '$P$_$G' }, dir).env.PROMPT, '$E]633;D$E\\$E]9;9;$P$E\\$P$_$G');
  assert.equal(cmdPrompt(''), '$E]633;D$E\\$E]9;9;$P$E\\$P$G');
  assert.equal(bash.integrated, true);
  // A shell without integration (WSL, sh), or no folder to keep the scripts: as it is.
  assert.deepEqual(integrate({ id: 'wsl', args: ['-d', 'Ubuntu'], integration: null }, env, dir), { args: ['-d', 'Ubuntu'], env, integrated: false });
  assert.deepEqual(integrate({ id: 'bash', args: [], integration: 'bash' }, env, ''), { args: [], env, integrated: false });
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
  // A command that fails: the prompt after it says it ended, with its code.
  s.write('false\r');
  const said = await until(() => out.includes(`\u001b]7;file://`) && out.includes(target.split(' ')[0].split('/').pop()) && /\u001b\]7;file:\/\/[^\u0007]*a%20dir/.test(out));
  const own = await until(() => out.includes('own=yes'));
  const ended = await until(() => out.includes('\u001b]633;D;1\u0007') && out.includes('\u001b]633;D;0\u0007'));
  // Each line it runs, as typed, before it runs (OSC 633;E with the nonce, then C); a line with a
  // semicolon and a backslash comes back as it was.
  s.write(`echo "semi;colon" back\\\\slash\r`);
  s.write('echo "nonce=[$TE_NONCE]"\r');
  const lines = () => [...out.matchAll(/\u001b\]633;([^\u0007]*)\u0007/g)].map((m) => commandLine(m[1], s.nonce)).filter((l) => l !== null);
  const runs = await until(() => lines().includes(`echo "semi;colon" back\\\\slash`) && lines().includes('false') && lines().includes(`cd '${target}'`) && out.includes('nonce=['));
  s.close();
  assert.equal(s.integrated, true, 'it says when commands end');
  assert.match(s.nonce, /^[0-9a-f]{16}$/);
  assert.ok(runs, `no lines (OSC 633;E) as they ran: ${JSON.stringify(lines())}\n${out}`);
  assert.ok(out.includes('\u001b]633;C\u0007'), 'it says a command starts');
  assert.ok(out.includes('nonce=[]'), 'the nonce is not in the environment the commands see');
  return { said, own, ended, out };
}

test('bash says its folder after a cd, and runs ~/.bashrc (macOS: a login shell, ~/.bash_profile)', { skip: !existsSync('/usr/bin/bash') && !existsSync('/bin/bash') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  writeFileSync(path.join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), 'export OWN_RC=yes\nPS1="$ "\n');
  const r = await saysFolder('bash', home);
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
  assert.ok(r.ended, `no end of command (OSC 633;D) with its code:\n${r.out}`);
});

test('zsh says its folder after a cd, and runs ~/.zshrc', { skip: !existsSync('/usr/bin/zsh') && !existsSync('/bin/zsh') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  writeFileSync(path.join(home, '.zshrc'), 'export OWN_RC=yes\nPROMPT="$ "\n');
  const r = await saysFolder('zsh', home);
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
  assert.ok(r.ended, `no end of command (OSC 633;D) with its code:\n${r.out}`);
});

test('fish says its folder after a cd', { skip: !existsSync('/usr/bin/fish') }, async () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'home-')));
  mkdirSync(path.join(home, '.config', 'fish'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'fish', 'config.fish'), 'set -gx OWN_RC yes\n');
  const r = await saysFolder('fish', home, { XDG_CONFIG_HOME: path.join(home, '.config') });
  assert.ok(r.said, `no OSC 7 after the cd:\n${r.out}`);
  assert.ok(r.own, `own startup file not run:\n${r.out}`);
  assert.ok(r.ended, `no end of command (OSC 633;D) with its code:\n${r.out}`);
});

// PowerShell's prompt, for real where it is installed (GitHub's Windows, macOS and Ubuntu machines
// have pwsh): the folder (OSC 9;9) and the end of the command before, with its code (OSC 633;D).
const pwshOnPath = (() => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
test('PowerShell’s prompt says the folder and how the last command ended', { skip: !pwshOnPath }, () => {
  const run = (before) =>
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL}\n${before}\nprompt`], { encoding: 'utf8', cwd: os.tmpdir() });
  const failed = run("$null = Get-Item 'no-such-thing-here' -ErrorAction SilentlyContinue");
  assert.match(failed, /\u001b\]633;D;1\u0007/, JSON.stringify(failed));
  assert.match(failed, /\u001b\]9;9;"[^"]+"\u0007/, 'the folder');
  const ok = run('$null = 1');
  assert.match(ok, /\u001b\]633;D;0\u0007/, JSON.stringify(ok));
  // A program's own exit code.
  const code = run(process.platform === 'win32' ? 'cmd /c exit 3' : "sh -c 'exit 3'");
  assert.match(code, /\u001b\]633;D;3\u0007/, JSON.stringify(code));
});

// PowerShell as you use it (pwsh in a pseudo-terminal, with PSReadLine reading the keys): each line
// typed is said as it runs (OSC 633;E with the nonce, then C), the nonce is out of the commands'
// environment, and the shell goes on reading lines (the wrapper never stops it). Not on Windows:
// the same script runs there, and Windows' own console host is what passes the sequences on.
test('PowerShell says each line it reads, with the nonce, and keeps reading', { skip: !pwshOnPath || process.platform === 'win32' }, async () => {
  const pty = require('@lydell/node-pty');
  const hooks = mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  const nonce = '0123456789abcdef';
  const run = integrate({ id: 'pwsh', args: ['-NoLogo', '-NoProfile'], integration: 'powershell' }, { ...process.env, TERM: 'xterm-256color' }, hooks, { nonce });
  assert.equal(run.env.TE_NONCE, nonce);
  const p = pty.spawn('pwsh', run.args, { name: 'xterm-256color', cols: 160, rows: 40, cwd: os.tmpdir(), env: run.env });
  let out = '';
  // A terminal answers where its cursor is (PSReadLine asks with ESC[6n before it draws, and reads
  // keys as the answer otherwise); xterm.js does in the app.
  p.onData((d) => {
    out += d;
    for (const _ of d.matchAll(/\u001b\[6n/g)) p.write('\u001b[1;1R');
  });
  const until = async (fn, ms = 20000) => {
    for (let t = 0; t < ms && !fn(); t += 100) await new Promise((r) => setTimeout(r, 100));
    return fn();
  };
  const lines = () => [...out.matchAll(/\u001b\]633;([^\u0007]*)\u0007/g)].map((m) => commandLine(m[1], nonce)).filter((l) => l !== null);
  try {
    // The first prompt (its folder, OSC 9;9), then three lines one after the other.
    assert.ok(await until(() => out.includes('\u001b]9;9;')), `no prompt:\n${out}`);
    p.write(`Write-Output "semi;colon" back\\slash\r`);
    assert.ok(await until(() => lines().includes('Write-Output "semi;colon" back\\slash')), `no line said (OSC 633;E): ${JSON.stringify(lines())}\n${out}`);
    p.write('Write-Output "nonce=[$env:TE_NONCE]"\r');
    assert.ok(await until(() => out.includes('nonce=[]')), `the nonce is in the commands' environment, or the shell stopped reading:\n${out}`);
    p.write("Write-Output 'ssh -p 2222 me@host.example'\r");
    assert.ok(await until(() => lines().includes("Write-Output 'ssh -p 2222 me@host.example'")), JSON.stringify(lines()));
    assert.ok(out.includes('\u001b]633;C\u0007'), 'it says a command starts');
    assert.ok(/\u001b\]633;D;0\u0007/.test(out), 'and how the one before ended');
    // A line said without the nonce (a program printing it) is not taken.
    assert.equal(commandLine('E;ssh evil;0000000000000000', nonce), null);
  } finally {
    p.kill();
  }
});
