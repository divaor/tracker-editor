// Disk tabs' line endings in the real store (kept in memory here: no IndexedDB in Node): a file
// with no line break takes the place's, a converted tab stays unsaved until saved (and is saved
// again when converted back), a mixed file saved keeping each line's own, and tabs kept unsaved by
// versions that read Windows files as Latin-1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const memory = new Map();
globalThis.localStorage ??= { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };

const { fromLatin1, setEolFallback, store } = await import('../app/js/store.js');
const { convertEndings, saveEndings } = await import('../app/js/lineEndings.js');
const require = createRequire(import.meta.url);
const disk = require('../electron/diskFiles.cjs');

const read = (path, raw, extra = {}) => ({ path, name: path.split('/').pop(), ...disk.decode(Buffer.from(raw, 'latin1')), mtimeMs: 1, size: raw.length, truncated: false, ...extra });

test('a file with no line break takes the endings the app gives its place', () => {
  setEolFallback((path) => (path.endsWith('.sh') ? 'lf' : 'crlf'));
  store.openDiskFile(read('/w/empty.txt', ''));
  assert.equal(store.diskTab('/w/empty.txt').eol, 'crlf');
  assert.equal(store.diskTab('/w/empty.txt').fileEol, 'crlf');
  store.openDiskFile(read('/w/run.sh', 'echo one'));
  assert.equal(store.diskTab('/w/run.sh').eol, 'lf');
  store.openDiskFile(read('/w/lines.txt', 'a\nb\n'));
  assert.equal(store.diskTab('/w/lines.txt').eol, 'lf', 'a file with breaks keeps its own');
  setEolFallback(() => 'lf');
});

test('converted: unsaved until saved; edits undone keep it so; converted back, saved again; saved, the file holds them', () => {
  const p = '/w/conv.txt';
  store.openDiskFile(read(p, 'one\ntwo\n'));
  store.setDiskEol(p, convertEndings(store.diskTab(p), 'crlf'));
  assert.equal(store.diskTab(p).dirty, true);
  store.setDiskText(p, 'one\ntwo\nthree\n');
  store.setDiskText(p, 'one\ntwo\n');
  assert.equal(store.diskTab(p).dirty, true, 'the text is back, the endings are not');
  store.setDiskEol(p, convertEndings(store.diskTab(p), 'lf'));
  assert.equal(store.diskTab(p).dirty, false, 'back to what the file holds');
  store.setDiskEol(p, convertEndings(store.diskTab(p), 'crlf'));
  const ends = saveEndings(store.diskTab(p));
  store.diskSaved(p, { text: 'one\ntwo\n', mtimeMs: 2, size: 10, ends });
  const t = store.diskTab(p);
  assert.deepEqual([t.dirty, t.eol, t.fileEol, t.eolChosen], [false, 'crlf', 'crlf', undefined]);
});

test('a mixed file kept: the letters for the text now, still mixed after, not asked again', () => {
  const p = '/w/mixed.txt';
  store.openDiskFile(read(p, 'a\r\nb\nc\r\n'));
  assert.equal(saveEndings(store.diskTab(p)), null, 'undecided: saving asks');
  store.setDiskText(p, 'a\nb\nnew\nc\n');
  store.setDiskEol(p, convertEndings(store.diskTab(p), 'keep'));
  const ends = saveEndings(store.diskTab(p));
  assert.equal(disk.encode(store.diskTab(p).text, ends).toString(), 'a\r\nb\nnew\r\nc\r\n');
  store.diskSaved(p, { text: 'a\nb\nnew\nc\n', mtimeMs: 2, size: 14, ends });
  const t = store.diskTab(p);
  assert.equal(t.fileEol, 'mixed');
  assert.equal(t.eols, 'CLCC');
  assert.equal(t.eolBase, 'a\nb\nnew\nc\n');
  assert.notEqual(saveEndings(t), null);
});

test('a tab kept unsaved by 0.52 (Latin-1): its C1 characters become Windows-1252\'s, the same bytes when saved', () => {
  const old = { path: '/w/old.txt', encoding: 'latin1', eol: 'crlf', dirty: true, text: 'price \u0080 \u0093q\u0094 café\n' };
  const now = fromLatin1(old);
  assert.equal(now.text, 'price € “q” café\n');
  assert.deepEqual(disk.encode(now.text, now), Buffer.from('price \x80 \x93q\x94 caf\xe9\r\n', 'latin1'));
  const kept = { ...old, fileEol: 'crlf' };
  assert.equal(fromLatin1(kept), kept, 'tabs from 0.53 on are left as they are');
  const utf = { ...old, encoding: 'utf-8' };
  assert.equal(fromLatin1(utf), utf);
});
