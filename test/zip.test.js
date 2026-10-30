import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeEntry, tableCrc32, unzipFile, zipPaths } = require('../electron/zip.cjs');
const { zipSync, strToU8 } = require('fflate');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-zip-')));

test('names in an archive that are safe to write', () => {
  assert.deepEqual(safeEntry('docs/a.txt'), ['docs', 'a.txt']);
  assert.deepEqual(safeEntry('docs\\sub\\b.md'), ['docs', 'sub', 'b.md']);
  assert.deepEqual(safeEntry('./x//y/'), ['x', 'y']);
  for (const bad of ['../evil.txt', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'c:x', 'con.txt', 'a/b:c', '', '/', '..']) assert.equal(safeEntry(bad), null, bad);
});

test('zip and extract keep files, folders, empty folders and names', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'project', 'src', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project', 'readme.md'), '# Hello\n'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'project', 'src', 'año ñandú.txt'), 'unicode name');
  fs.writeFileSync(path.join(dir, 'project', 'src', 'blob.bin'), Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31) % 256)));
  fs.writeFileSync(path.join(dir, 'photo.png'), Buffer.alloc(3000, 7));
  const out = path.join(dir, 'Archive.zip');
  const made = await zipPaths([path.join(dir, 'project'), path.join(dir, 'photo.png')], out);
  assert.equal(made.files, 4);
  assert.ok(fs.statSync(out).size < 70000 + 8000 * 1 + 3000 + 2000);
  // A second zip with the same name is refused (nothing overwritten).
  await assert.rejects(zipPaths([path.join(dir, 'photo.png')], out), /EEXIST/);
  assert.equal(fs.statSync(out).size > 0, true);
  const dest = path.join(dir, 'Archive');
  const got = await unzipFile(out, dest);
  assert.equal(got.files, 4);
  assert.deepEqual(got.skipped, []);
  assert.equal(fs.readFileSync(path.join(dest, 'project', 'readme.md'), 'utf8'), '# Hello\n'.repeat(1000));
  assert.equal(fs.readFileSync(path.join(dest, 'project', 'src', 'año ñandú.txt'), 'utf8'), 'unicode name');
  assert.ok(fs.readFileSync(path.join(dest, 'project', 'src', 'blob.bin')).equals(fs.readFileSync(path.join(dir, 'project', 'src', 'blob.bin'))));
  assert.ok(fs.statSync(path.join(dest, 'project', 'src', 'empty')).isDirectory());
  assert.equal(fs.statSync(path.join(dest, 'photo.png')).size, 3000);
});

test('links are left out of a zip', async (t) => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'p'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  fs.writeFileSync(path.join(dir, 'p', 'in.txt'), 'inside');
  try {
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'p', 'link.txt'));
  } catch {
    return t.skip('no symlinks here');
  }
  const out = path.join(dir, 'p.zip');
  assert.equal((await zipPaths([path.join(dir, 'p')], out)).files, 1);
  const dest = path.join(dir, 'x');
  await unzipFile(out, dest);
  assert.deepEqual(fs.readdirSync(path.join(dest, 'p')), ['in.txt']);
});

test('extracting never writes outside its folder', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'evil.zip');
  fs.writeFileSync(zip, zipSync({ '../evil.txt': strToU8('no'), 'ok/fine.txt': strToU8('yes'), '/abs.txt': strToU8('no'), 'a/../../up.txt': strToU8('no'), 'con.txt': strToU8('no') }));
  const dest = path.join(dir, 'inside', 'evil');
  fs.mkdirSync(path.dirname(dest));
  const got = await unzipFile(zip, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'ok', 'fine.txt'), 'utf8'), 'yes');
  assert.equal(got.files, 1);
  assert.deepEqual(got.skipped.sort(), ['../evil.txt', '/abs.txt', 'a/../../up.txt', 'con.txt'].sort());
  assert.ok(!fs.existsSync(path.join(dir, 'inside', 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(dir, 'up.txt')));
});

test('an archive that expands far beyond its size is not extracted', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'bomb.zip');
  fs.writeFileSync(zip, zipSync({ 'zeros.bin': new Uint8Array(20 * 1024 * 1024) }, { level: 9 }));
  assert.ok(fs.statSync(zip).size < 100 * 1024);
  const dest = path.join(dir, 'bomb');
  await assert.rejects(unzipFile(zip, dest, { maxBytes: 5 * 1024 * 1024 }), /far more than its size/);
  assert.ok(!fs.existsSync(dest), 'the half-made folder is removed');
});

test('a file that is not a zip', async () => {
  const dir = tmp();
  const file = path.join(dir, 'fake.zip');
  fs.writeFileSync(file, 'just text, not an archive');
  await assert.rejects(unzipFile(file, path.join(dir, 'fake')), /not a zip/);
  assert.ok(!fs.existsSync(path.join(dir, 'fake')));
});

test('files holding zip data (a stored Office file, a zip in a database) come out whole', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'p'));
  // A .docx is a zip: stored as it is, its bytes hold local headers.
  const docx = Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document>hello</w:document>') }, { level: 0 }));
  fs.writeFileSync(path.join(dir, 'p', 'report.docx'), docx);
  // Incompressible bytes with a zip inside, under a name that is compressed.
  const noise = Buffer.from(Array.from({ length: 50000 }, (_, i) => (i * 2654435761) >>> 24));
  fs.writeFileSync(path.join(dir, 'p', 'data.sqlite'), Buffer.concat([noise, docx, noise]));
  // Before 1980: a zip cannot hold that date, so it is clamped instead of failing.
  fs.writeFileSync(path.join(dir, 'p', 'old.txt'), 'old');
  fs.utimesSync(path.join(dir, 'p', 'old.txt'), new Date('1970-01-02'), new Date('1970-01-02'));
  const out = path.join(dir, 'p.zip');
  await zipPaths([path.join(dir, 'p')], out);
  const dest = path.join(dir, 'x');
  const got = await unzipFile(out, dest);
  assert.equal(got.files, 3);
  assert.deepEqual(fs.readdirSync(path.join(dest, 'p')).sort(), ['data.sqlite', 'old.txt', 'report.docx']);
  assert.ok(fs.readFileSync(path.join(dest, 'p', 'report.docx')).equals(docx));
  assert.ok(fs.readFileSync(path.join(dest, 'p', 'data.sqlite')).equals(fs.readFileSync(path.join(dir, 'p', 'data.sqlite'))));
});

test('a damaged entry is found by its checksum', async () => {
  const dir = tmp();
  const zip = Buffer.from(zipSync({ 'a.txt': strToU8('hello hello hello') }, { level: 0 }));
  const at = zip.indexOf(Buffer.from('hello'));
  zip[at] = 'j'.charCodeAt(0);
  fs.writeFileSync(path.join(dir, 'bad.zip'), zip);
  await assert.rejects(unzipFile(path.join(dir, 'bad.zip'), path.join(dir, 'bad')), /damaged/);
  assert.ok(!fs.existsSync(path.join(dir, 'bad')));
});

test('the checksum works without zlib.crc32 (Node 18, the Android app\'s)', async () => {
  const zlib = require('node:zlib');
  assert.equal(tableCrc32(Buffer.from('123456789')), 0xcbf43926, 'the standard check value');
  assert.equal(tableCrc32(new Uint8Array(0)), 0);
  const bytes = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 7919) % 256));
  const whole = tableCrc32(bytes);
  assert.equal(tableCrc32(bytes.subarray(30000), tableCrc32(bytes.subarray(0, 30000))), whole, 'carried on across chunks');
  if (zlib.crc32) assert.equal(whole, zlib.crc32(bytes));

  // Extracting as on the phone: compressed and stored files, an empty one, a folder.
  const dir = tmp();
  const zip = path.join(dir, 'site.zip');
  fs.writeFileSync(zip, zipSync({ 'site/index.html': [strToU8('<h1>Hi</h1>'.repeat(500)), { level: 6 }], 'site/.nojekyll': [new Uint8Array(0), { level: 0 }], 'site/data/': {}, 'site/data/a.json': strToU8('{"a":1}') }));
  const saved = Object.getOwnPropertyDescriptor(zlib, 'crc32');
  if (saved) delete zlib.crc32;
  try {
    assert.equal(zlib.crc32, undefined);
    const result = await unzipFile(zip, path.join(dir, 'site-out'));
    assert.deepEqual([result.files, result.skipped], [3, []]);
    assert.equal(fs.readFileSync(path.join(dir, 'site-out', 'site', 'index.html'), 'utf8'), '<h1>Hi</h1>'.repeat(500));
    assert.equal(fs.statSync(path.join(dir, 'site-out', 'site', '.nojekyll')).size, 0);
  } finally {
    if (saved) Object.defineProperty(zlib, 'crc32', saved);
  }
});

test('an error while a file comes out is the one reported (the archive is closed after it)', async () => {
  // Its directory says a.bin is 10 bytes, but it inflates to a megabyte: stopped mid-file.
  const dir = tmp();
  const zip = Buffer.from(zipSync({ 'a.bin': new Uint8Array(1024 * 1024) }, { level: 9 }));
  const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(10, central + 24);
  fs.writeFileSync(path.join(dir, 'liar.zip'), zip);
  await assert.rejects(unzipFile(path.join(dir, 'liar.zip'), path.join(dir, 'liar'), { maxBytes: 64 * 1024 }), /far more than its size/);
  assert.ok(!fs.existsSync(path.join(dir, 'liar')));
});
