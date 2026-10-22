import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { regFile, launchedPaths, TEXT_EXTS } = require('../electron/shellIntegration.cjs');

const EXE = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\tracker-editor\\Tracker Editor.exe';

test('the .reg file registers Open with, Edit with and Open in, for the current user', () => {
  const reg = regFile(EXE, { exts: ['.txt', '.log'] });
  assert.ok(reg.startsWith('Windows Registry Editor Version 5.00\r\n'));
  assert.ok(!reg.includes('HKEY_LOCAL_MACHINE'));
  // Open with: the app and a ProgID offered for the types, never their default.
  assert.ok(reg.includes('[HKEY_CURRENT_USER\\Software\\Classes\\Applications\\Tracker Editor.exe\\shell\\open\\command]\r\n@="\\"C:\\\\Users\\\\Ana\\\\AppData\\\\Local\\\\Programs\\\\tracker-editor\\\\Tracker Editor.exe\\" \\"%1\\""'));
  assert.ok(reg.includes('[HKEY_CURRENT_USER\\Software\\Classes\\.log\\OpenWithProgids]\r\n"TrackerEditor.File"=""'));
  assert.ok(!/\[HKEY_CURRENT_USER\\Software\\Classes\\\.txt\]\r\n@=/.test(reg), 'the default program of .txt is left alone');
  // The right-click menu of files and folders.
  assert.ok(reg.includes('[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\TrackerEditor]\r\n@="Edit with Tracker Editor"'));
  assert.ok(reg.includes('[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\TrackerEditor\\command]\r\n@="\\"C:'));
  assert.ok(reg.includes('\\" \\"%V\\""'));
});

test('turning it off removes the same keys and values', () => {
  const reg = regFile(EXE, { on: false, exts: ['.txt'] });
  assert.ok(reg.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\Applications\\Tracker Editor.exe]'));
  assert.ok(reg.includes('[-HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\TrackerEditor]'));
  assert.ok(reg.includes('[HKEY_CURRENT_USER\\Software\\Classes\\.txt\\OpenWithProgids]\r\n"TrackerEditor.File"=-'));
  assert.ok(!reg.includes('command]'));
  assert.ok(TEXT_EXTS.includes('.json') && TEXT_EXTS.includes('.ps1') && !TEXT_EXTS.includes('.exe'));
});

test('the files and folders the system gives the app on its command line', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-launch-')));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'with space.md'), 'x');
  fs.mkdirSync(path.join(dir, 'logs'));
  const argv = ['/opt/app/tracker-editor', '--no-sandbox', 'notes.txt', pathToFileURL(path.join(dir, 'with space.md')).href, path.join(dir, 'logs'), 'missing.txt', 'tracker-editor://file/abc', 'https://example.com/x'];
  assert.deepEqual(launchedPaths(argv, { cwd: dir }), [
    { path: path.join(dir, 'notes.txt'), dir: false },
    { path: path.join(dir, 'with space.md'), dir: false },
    { path: path.join(dir, 'logs'), dir: true },
  ]);
  // In development the app is `electron .`: its folder is not something to open.
  assert.deepEqual(launchedPaths(['electron', '--no-sandbox', '.', 'notes.txt'], { cwd: dir, exclude: [dir] }), [{ path: path.join(dir, 'notes.txt'), dir: false }]);
  assert.deepEqual(launchedPaths(['electron', '.'], { cwd: dir, exclude: [dir] }), []);
});
