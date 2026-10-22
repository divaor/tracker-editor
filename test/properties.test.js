// 0.10: properties and permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modeString, octalMode, parseMode } from '../app/js/folders.js';

const require = createRequire(import.meta.url);
const { chmodEntries, dirMode, fileMode, folderSize, properties } = require('../electron/folders.cjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-props-')));
const posix = process.platform !== 'win32';

test('permissions as text and as a number', () => {
  assert.equal(modeString(0o755, true), 'drwxr-xr-x');
  assert.equal(modeString(0o644), '-rw-r--r--');
  assert.equal(modeString(0o4755), '-rwsr-xr-x');
  assert.equal(modeString(0o2640), '-rw-r-S---');
  assert.equal(modeString(0o1777, true), 'drwxrwxrwt');
  assert.equal(modeString(null), '');
  assert.equal(octalMode(0o644), '644');
  assert.equal(octalMode(0o4755), '4755');
  assert.equal(octalMode(0o7), '007');
  assert.equal(parseMode('0644'), 0o644);
  assert.equal(parseMode(' 755 '), 0o755);
  assert.equal(parseMode('8'), null);
  assert.equal(parseMode('12345'), null);
  assert.equal(dirMode(0o640), 0o750, 'folders inside keep "open" wherever they can be read');
  assert.equal(dirMode(0o600), 0o700);
  assert.equal(fileMode(0o751, 0o644), 0o640, 'like chmod X: no run for a file that could not');
  assert.equal(fileMode(0o751, 0o700), 0o751);
});

test('properties, a folder’s size, and permissions here', { skip: !posix && 'POSIX permissions' }, () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'abc');
  fs.writeFileSync(path.join(root, 'sub', 'deeper', 'c.txt'), 'x'.repeat(100));
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link-to-sub'));
  const file = properties(path.join(root, 'a.txt'));
  assert.equal(file.dir, false);
  assert.equal(file.size, 5);
  assert.equal(file.name, 'a.txt');
  assert.equal(typeof file.mode, 'number');
  assert.equal(properties(path.join(root, 'link-to-sub')).link, true);
  assert.deepEqual(folderSize(root), { size: 108, files: 3, folders: 2, truncated: false }, 'links are not followed');
  assert.equal(chmodEntries([path.join(root, 'a.txt')], 0o600), 1);
  assert.equal(fs.statSync(path.join(root, 'a.txt')).mode & 0o777, 0o600);
  fs.chmodSync(path.join(root, 'sub', 'deeper', 'c.txt'), 0o755);
  const changed = chmodEntries([path.join(root, 'sub')], 0o751, { recursive: true });
  assert.equal(changed, 4, 'sub, b.txt, deeper and c.txt');
  assert.equal(fs.statSync(path.join(root, 'sub')).mode & 0o777, 0o751, 'the folder asked for: as given');
  assert.equal(fs.statSync(path.join(root, 'sub', 'deeper')).mode & 0o777, 0o751, 'folders inside: open where readable');
  assert.equal(fs.statSync(path.join(root, 'sub', 'b.txt')).mode & 0o777, 0o640, 'a file that could not run still cannot');
  assert.equal(fs.statSync(path.join(root, 'sub', 'deeper', 'c.txt')).mode & 0o777, 0o751, 'one that could, can');
});
