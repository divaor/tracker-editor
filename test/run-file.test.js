// Run this file: the command for its type, quoted for the terminal's shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunCommands, quoteFor, runCommandFor, runLine, shellKind, wslPath } from '../app/js/runFile.js';

const file = (p) => ({ path: p, name: p.split(/[\\/]/).pop(), dir: p.replace(/[\\/][^\\/]+$/, '') });

test('commands by type, here and on Windows', () => {
  assert.equal(runCommandFor(file('/w/app.py')), 'python3 /w/app.py');
  assert.equal(runCommandFor(file('C:\\w\\app.py'), { platform: 'win32' }), "python 'C:\\w\\app.py'");
  assert.equal(runCommandFor(file('/w/my app/run.sh')), "bash '/w/my app/run.sh'");
  assert.equal(runCommandFor(file('/w/x.js')), 'node /w/x.js');
  assert.equal(runCommandFor(file('C:\\w\\s.ps1'), { platform: 'win32' }), "powershell -ExecutionPolicy Bypass -File 'C:\\w\\s.ps1'");
  assert.equal(runCommandFor(file('C:\\w\\b.bat'), { platform: 'win32', shell: 'cmd.exe' }), 'cmd /c "C:\\w\\b.bat"');
  assert.equal(runCommandFor(file('/w/b.bat')), null, 'no batch files outside Windows');
  assert.equal(runCommandFor(file('/w/notes.md')), null);
  // Settings win.
  assert.equal(runCommandFor(file('/w/app.py'), { custom: { py: 'uv run {file}' } }), 'uv run /w/app.py');
  assert.equal(runCommandFor(file('/w/main.go'), { custom: { go: 'cd {dir} && go run .' } }), 'cd /w && go run .');
});

test('shells and quoting', () => {
  assert.equal(shellKind('/bin/bash'), 'posix');
  assert.equal(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
  assert.equal(shellKind('pwsh'), 'powershell');
  assert.equal(shellKind('cmd.exe'), 'cmd');
  assert.equal(shellKind('', 'win32'), 'powershell');
  assert.equal(quoteFor('posix', "it's here"), "'it'\\''s here'");
  assert.equal(quoteFor('powershell', "it's"), "'it''s'");
});

test('the line typed: into the folder first', () => {
  assert.equal(runLine({ command: 'python3 app.py', dir: '/w/my app' }), "cd -- '/w/my app' && python3 app.py");
  assert.equal(runLine({ command: "python 'C:\\w\\a.py'", dir: 'C:\\w', kind: 'powershell' }), "Set-Location -LiteralPath 'C:\\w'; python 'C:\\w\\a.py'");
  assert.equal(runLine({ command: 'cmd /c x.bat', dir: 'C:\\w', kind: 'cmd' }), 'cd /d "C:\\w" && cmd /c x.bat');
  assert.equal(runLine({ command: 'node x.js', dir: '' }), 'node x.js');
});

test('run commands from the settings', () => {
  const custom = parseRunCommands('# mine\npy: uv run {file}\n.TS : bun {file}\n\njs:\nnot a rule');
  assert.deepEqual(custom, { py: 'uv run {file}', ts: 'bun {file}', js: '' });
  assert.equal(runCommandFor(file('/w/a.ts'), { custom }), 'bun /w/a.ts');
  assert.equal(runCommandFor(file('/w/a.js'), { custom }), null, 'an empty command turns a type off');
  assert.equal(runCommandFor(file('/w/a.rb'), { custom }), 'ruby /w/a.rb', 'the others keep their defaults');
});

test('WSL: Linux commands, and the paths as WSL sees them', () => {
  assert.equal(wslPath('C:\\Users\\Me\\my app'), '/mnt/c/Users/Me/my app');
  assert.equal(wslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me');
  assert.equal(quoteFor('wsl', 'C:\\a b\\x.py'), "'/mnt/c/a b/x.py'");
  const f = { path: 'C:\\p\\a.py', dir: 'C:\\p', name: 'a.py' };
  assert.equal(runCommandFor(f, { platform: 'win32', kind: 'wsl' }), 'python3 /mnt/c/p/a.py');
  assert.equal(runCommandFor(f, { platform: 'win32', kind: 'cmd' }), 'python "C:\\p\\a.py"');
  assert.equal(runLine({ command: 'make', dir: 'C:\\p', kind: 'wsl' }), 'cd -- /mnt/c/p && make');
});
