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
  assert.deepEqual(d, { text: '[server]\nport=80\n', eol: 'crlf', bom: true, encoding: 'utf-8', breaks: 2 });
  assert.deepEqual(encode('[server]\nport=8080\n', d), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[server]\r\nport=8080\r\n')]));
  const latin = Buffer.from('caf\xe9\n', 'latin1');
  const l = decode(latin);
  assert.equal(l.text, 'café\n');
  assert.equal(l.encoding, 'latin1');
  assert.deepEqual(encode(l.text, l), latin);
  assert.equal(decode(Buffer.from('a\nb\n')).eol, 'lf');
  assert.throws(() => decode(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), /not a text file/);
});

test('Windows-1252: € “ ” – … read as they are, bytes back exactly; what it cannot hold is refused, never written wrong', () => {
  const { cannotHold, CP1252_HIGH } = require('../electron/diskFiles.cjs');
  // "€5 – “quoted” …" as Notepad writes it in Windows (Western).
  const win = Buffer.from([0x80, 0x35, 0x20, 0x96, 0x20, 0x93, 0x71, 0x94, 0x20, 0x85, 0x0d, 0x0a, 0xe9]);
  const d = decode(win);
  assert.equal(d.encoding, 'latin1');
  assert.equal(d.text, '€5 – “q” …\né');
  assert.equal(d.eol, 'crlf');
  assert.deepEqual(encode(d.text, d), win, 'byte for byte');
  // Every byte but NUL comes back (the five undefined ones stay U+0081 and so on).
  const all = Buffer.from(Array.from({ length: 255 }, (_, i) => i + 1));
  const a = decode(all);
  assert.deepEqual(encode(a.text, a), all);
  assert.equal(a.text.includes('\u0081') && a.text.includes('\u009d'), true);
  assert.equal(CP1252_HIGH.length, 32);
  // Typed into it: € and “ fit (before 0.53 € was saved as byte 0xAC); an emoji or Ő does not.
  assert.deepEqual([...encode('a€“', { encoding: 'latin1' })], [0x61, 0x80, 0x93]);
  assert.throws(() => encode('a😀b', { encoding: 'latin1' }), (err) => err.unencodable && /cannot hold “😀”/.test(err.message));
  assert.throws(() => encode('\u0080', { encoding: 'latin1' }), /cannot hold/, 'U+0080 is not a byte of it (0x80 is €)');
  assert.deepEqual(cannotHold('€ő😀ő\u0081a', 'latin1'), ['ő', '😀']);
  assert.deepEqual(cannotHold('😀', 'utf-8'), []);
  // Followed (tail -f): the same table.
  const dir = tmp();
  const log = path.join(dir, 'w.log');
  fs.writeFileSync(log, Buffer.from([0x61, 0x0a]));
  fs.appendFileSync(log, Buffer.from([0x80, 0x96, 0x0d, 0x0a]));
  assert.equal(readAppended(log, 2, { encoding: 'latin1' }).text, '€–\n');
});

test('line endings: counted, a lone CR (old Macs) kept, a mixed file gets each break\'s letter and comes back as it was', () => {
  const { newFileText, withEols } = require('../electron/diskFiles.cjs');
  assert.deepEqual(decode(Buffer.from('a\rb\rc')), { text: 'a\nb\nc', eol: 'cr', bom: false, encoding: 'utf-8', breaks: 2 });
  assert.deepEqual(encode('a\nb\nc', { eol: 'cr' }), Buffer.from('a\rb\rc'));
  const raw = 'one\r\ntwo\nthree\r\nfour\rfive\r\n';
  const m = decode(Buffer.from(raw));
  assert.equal(m.eol, 'crlf', 'most lines');
  assert.deepEqual(m.mixed, { crlf: 3, lf: 1, cr: 1 });
  assert.equal(m.eols, 'CLCRC');
  assert.equal(m.breaks, 5);
  assert.equal(encode(m.text, m).toString(), raw, 'each line keeps its own');
  assert.equal(encode(m.text, { eol: 'lf' }).toString(), 'one\ntwo\nthree\nfour\nfive\n', 'or all one kind');
  // More breaks than letters: the rest get eol.
  assert.equal(withEols('a\nb\nc\n', 'crlf', 'L'), 'a\nb\r\nc\r\n');
  // No line break: LF, and `breaks` 0 says so (the page then uses the place's).
  assert.deepEqual(decode(Buffer.from('one line')), { text: 'one line', eol: 'lf', bom: false, encoding: 'utf-8', breaks: 0 });
  assert.equal(decode(Buffer.from('')).breaks, 0);
  // A tie: CRLF.
  assert.equal(decode(Buffer.from('a\r\nb\n')).eol, 'crlf');
  // A new file's text with the endings the page chose; without one, as given.
  assert.equal(newFileText('a\nb\r\nc', 'crlf'), 'a\r\nb\r\nc');
  assert.equal(newFileText('a\r\nb', 'lf'), 'a\nb');
  assert.equal(newFileText('a\nb', 'cr'), 'a\rb');
  assert.equal(newFileText('a\r\nb\n', undefined), 'a\r\nb\n');
  assert.equal(newFileText('a\nb', 'nonsense'), 'a\nb');
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
  assert.equal(info.eols, undefined, 'the tail is read-only: no letters kept');
});

test('the start of a file for a preview: whole lines, never half a character', () => {
  const { cutText, readHead } = require('../electron/diskFiles.cjs');
  assert.equal(cutText(Buffer.from('one\ntwo\nthr')).toString(), 'one\ntwo\n');
  // One long line: a character that does not fit is left out, not broken.
  const text = Buffer.from('añ€😀');
  for (let n = 1; n <= text.length; n++) {
    const cut = cutText(text.subarray(0, n)).toString();
    assert.ok(!cut.includes('�') && 'añ€😀'.startsWith(cut), `${n}: ${JSON.stringify(cut)}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-head-'));
  const file = path.join(dir, 'min.json');
  fs.writeFileSync(file, `{"name":"${'é'.repeat(200)}"}`);
  const head = readHead(file, 101);
  assert.equal(head.more, true);
  assert.ok(head.text.startsWith('{"name":"éé') && !head.text.includes('Ã'), head.text.slice(0, 20));
});
