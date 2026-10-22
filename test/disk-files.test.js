import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { decode, encode, readTextFile, readAppended, writeTextFile, MAX_FULL } = require('../electron/diskFiles.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editor-disk-'));

test('line endings, BOM and encoding are remembered and put back', () => {
  const win = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[server]\r\nport=80\r\n')]);
  const d = decode(win);
  assert.deepEqual(d, { text: '[server]\nport=80\n', eol: 'crlf', bom: true, encoding: 'utf-8' });
  assert.deepEqual(encode('[server]\nport=8080\n', d), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[server]\r\nport=8080\r\n')]));
  const latin = Buffer.from('caf\xe9\n', 'latin1');
  const l = decode(latin);
  assert.equal(l.text, 'café\n');
  assert.equal(l.encoding, 'latin1');
  assert.deepEqual(encode(l.text, l), latin);
  assert.equal(decode(Buffer.from('a\nb\n')).eol, 'lf');
  assert.throws(() => decode(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), /not a text file/);
});

test('reading, saving, conflicts and what was appended', () => {
  const dir = tmp();
  const file = path.join(dir, 'app.conf');
  fs.writeFileSync(file, 'a=1\r\nb=2\r\n');
  const info = readTextFile(file);
  assert.equal(info.text, 'a=1\nb=2\n');
  assert.equal(info.name, 'app.conf');
  assert.equal(info.truncated, false);
  const saved = writeTextFile(file, 'a=1\nb=3\n', { ...info, expectedMtime: info.mtimeMs });
  assert.equal(fs.readFileSync(file, 'utf8'), 'a=1\r\nb=3\r\n');
  // Changed by someone else since: not written.
  fs.writeFileSync(file, 'other\r\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const conflict = writeTextFile(file, 'mine\n', { ...info, expectedMtime: saved.mtimeMs });
  assert.equal(conflict.conflict, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'other\r\n');
  writeTextFile(file, 'mine\n', { ...info, expectedMtime: saved.mtimeMs, force: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\r\n');

  const log = path.join(dir, 'app.log');
  fs.writeFileSync(log, 'one\n');
  const start = fs.statSync(log).size;
  fs.appendFileSync(log, 'two\r\nthree\n');
  assert.deepEqual({ ...readAppended(log, start), mtimeMs: 0 }, { text: 'two\nthree\n', size: start + 11, mtimeMs: 0, skipped: 0 });
  fs.writeFileSync(log, 'new\n');
  assert.equal(readAppended(log, start + 11).reset, true);
});

test('very large files open by their last part', () => {
  const dir = tmp();
  const file = path.join(dir, 'big.log');
  const line = `${'x'.repeat(99)}\n`;
  fs.writeFileSync(file, line.repeat(Math.ceil((MAX_FULL + 1000) / line.length)) + 'last line\n');
  const info = readTextFile(file);
  assert.equal(info.truncated, true);
  assert.ok(info.text.endsWith('last line\n'));
  assert.ok(info.text.startsWith('x'.repeat(99)));
  assert.ok(info.text.length <= 5 * 1024 * 1024);
});
