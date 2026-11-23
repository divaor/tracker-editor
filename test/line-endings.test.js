// Line endings (lineEndings.js): what a new file gets (the place's system, the setting, the kind,
// an .editorconfig), a disk tab's state (converted, mixed, kept), saving each line's own ending in
// a mixed file, what the status bar says, and a lock's header keeping a file's endings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  convertEndings, endingsChanged, eolChoices, eolCounts, eolFields, eolStatus, eolUndecided, fileEolOf, keepEols, kindEol, mixedWords, newFileEol,
  placeEol, saveEndings, saveTarget, savedEolFields, systemOf, uniformEol, writeFormat,
} from '../app/js/lineEndings.js';
import { afterDiskEdit, isMarked, textMark } from '../app/js/model.js';
import { lockedHeader, lockText, unlockText } from '../app/js/locked.js';

const require = createRequire(import.meta.url);
const disk = require('../electron/diskFiles.cjs');

test('the kind of file: batch files CRLF, shell scripts and #! scripts LF, the rest free', () => {
  for (const name of ['build.bat', 'C:\\x\\RUN.CMD', 'old.btm']) assert.equal(kindEol(name), 'crlf', name);
  for (const name of ['deploy.sh', 'x.bash', '.zshrc.zsh', 'a.ksh', 'conf.fish', '/srv/app/start.sh']) assert.equal(kindEol(name), 'lf', name);
  assert.equal(kindEol('tool', '#!/usr/bin/env python3\nprint(1)\n'), 'lf', 'a script by its first line');
  assert.equal(kindEol('notes.txt'), null);
  assert.equal(kindEol('readme.md', '# #!not first'), null);
  assert.equal(kindEol('bat'), null, 'a name, not an extension');
});

test('the system of a place: this computer, a server (its paths, what it said), Docker and WSL, the phone, the browser', () => {
  assert.equal(systemOf('C:\\Users\\a\\x.txt', { platform: 'win32' }), 'windows');
  assert.equal(systemOf('/home/a/x.txt', { platform: 'linux' }), 'unix');
  assert.equal(systemOf('/Users/a/x.txt', { platform: 'darwin' }), 'unix');
  assert.equal(systemOf('/storage/emulated/0/x.txt', { platform: 'android' }), 'unix');
  assert.equal(systemOf('content://com.android.providers.downloads.documents/document/12', { platform: 'android' }), 'unix');
  // A server: a Windows OpenSSH server's paths are /C:/…; otherwise what it said when it connected.
  assert.equal(systemOf('remote://ab12/C:/Users/me/x.txt', { platform: 'linux', conn: { protocol: 'sftp' } }), 'windows');
  assert.equal(systemOf('remote://ab12/srv/x.txt', { platform: 'win32', conn: { protocol: 'sftp' } }), 'unix', 'a Linux server from Windows');
  assert.equal(systemOf('remote://ab12/site/x.txt', { platform: 'linux', conn: { protocol: 'ftp', system: 'windows' } }), 'windows', 'an IIS FTP server');
  assert.equal(systemOf('remote://ab12/x.txt', { platform: 'win32', conn: { protocol: 'docker', system: 'windows' } }), 'unix', 'a container is Linux');
  assert.equal(systemOf('remote://ab12/home/u/x', { platform: 'win32', conn: { protocol: 'wsl' } }), 'unix');
  assert.equal(systemOf('remote://gone/x', { platform: 'win32', conn: null }), 'unix');
  // The web app: what the browser says.
  assert.equal(systemOf('', { browserWindows: true }), 'windows');
  assert.equal(systemOf('', {}), 'unix');
});

test('a new file: .editorconfig, then the kind, then the setting, then the system', () => {
  assert.deepEqual(newFileEol({ name: 'a.txt', system: 'windows' }), { eol: 'crlf', why: 'system' });
  assert.deepEqual(newFileEol({ name: 'a.txt', system: 'unix' }), { eol: 'lf', why: 'system' });
  assert.deepEqual(newFileEol({ name: 'a.txt', system: 'unix', setting: 'crlf' }), { eol: 'crlf', why: 'setting' });
  assert.deepEqual(newFileEol({ name: 'a.txt', system: 'windows', setting: 'lf' }), { eol: 'lf', why: 'setting' });
  assert.deepEqual(newFileEol({ name: 'go.sh', system: 'windows', setting: 'crlf' }), { eol: 'lf', why: 'kind' });
  assert.deepEqual(newFileEol({ name: 'go.bat', system: 'unix', setting: 'lf' }), { eol: 'crlf', why: 'kind' });
  assert.deepEqual(newFileEol({ name: 'tool', text: '#!/bin/sh\n', system: 'windows' }), { eol: 'lf', why: 'kind' });
  assert.deepEqual(newFileEol({ name: 'go.sh', system: 'windows', editorconfig: 'crlf' }), { eol: 'crlf', why: 'editorconfig' }, 'the project says so: it wins');
  assert.deepEqual(newFileEol({ name: 'a.txt', editorconfig: 'cr' }), { eol: 'cr', why: 'editorconfig' });
  assert.deepEqual(newFileEol({ name: 'a.txt', editorconfig: 'native', system: 'windows' }), { eol: 'crlf', why: 'system' });
  assert.equal(placeEol('auto', 'windows'), 'crlf');
  assert.equal(placeEol('auto', 'unix'), 'lf');
  assert.equal(placeEol('lf', 'windows'), 'lf');
  assert.equal(placeEol(undefined, 'windows'), 'crlf', 'no setting yet: auto');
});

test('a read file as a tab: its endings; none yet takes the place\'s; a mixed one keeps its letters', () => {
  const crlf = disk.decode(Buffer.from('a\r\nb\r\n'));
  assert.deepEqual(eolFields(crlf, 'lf'), { eol: 'crlf', fileEol: 'crlf', breaks: 2, mixed: undefined, eols: undefined, eolBase: undefined, eolChoice: undefined, eolChosen: undefined });
  const empty = disk.decode(Buffer.from(''));
  assert.equal(eolFields(empty, 'crlf').eol, 'crlf', 'an empty file on Windows: CRLF');
  assert.equal(eolFields(empty, 'crlf').fileEol, 'crlf', 'nothing to convert: it is not "changed"');
  assert.equal(eolFields(disk.decode(Buffer.from('one line')), 'crlf').eol, 'crlf');
  const mixed = disk.decode(Buffer.from('a\r\nb\nc\r\n'));
  const f = eolFields(mixed, 'lf');
  assert.equal(f.fileEol, 'mixed');
  assert.equal(f.eol, 'crlf');
  assert.equal(f.eols, 'CLC');
  assert.equal(f.eolBase, 'a\nb\nc\n');
  // Older main processes said nothing of breaks: as they are.
  assert.equal(eolFields({ eol: 'lf', text: '' }, 'crlf').eol, 'lf');
  assert.equal(fileEolOf({ eol: 'crlf' }), 'crlf', 'a tab kept by an older version');
});

test('converting a tab: unsaved until saved, back to the file\'s is saved again, typing and undoing never hides it', () => {
  let tab = { text: 'a\nb\n', dirty: false, ...eolFields(disk.decode(Buffer.from('a\nb\n'))) };
  const set = (patch) => {
    // store.js setDiskEol's rule.
    const next = { ...tab, ...patch };
    const saved = tab.dirty ? tab.saved : textMark(tab.text);
    const dirty = !isMarked(saved, next.text) || endingsChanged(next);
    tab = { ...next, dirty, saved: dirty ? saved : undefined };
  };
  const edit = (text) => (tab = { ...tab, ...afterDiskEdit(tab, text) });
  set(convertEndings(tab, 'crlf'));
  assert.equal(tab.dirty, true, 'converted: Save writes CRLF');
  assert.deepEqual(saveEndings(tab), { eol: 'crlf', why: 'chosen' });
  edit('a\nb\nc\n');
  edit('a\nb\n');
  assert.equal(tab.dirty, true, 'undone back to the text: still unsaved, the endings changed');
  set(convertEndings(tab, 'lf'));
  assert.equal(endingsChanged(tab), false);
  assert.equal(tab.dirty, false, 'back to what the file has');
  // Saved: the file holds those now.
  const saved = savedEolFields('a\nb\n', { eol: 'crlf' });
  assert.deepEqual(saved, { eol: 'crlf', fileEol: 'crlf', breaks: 2, mixed: undefined, eols: undefined, eolBase: undefined, eolChoice: undefined, eolChosen: undefined });
});

test('a mixed file: undecided asks; keep each line\'s own (lines changed and new get the most common); or one kind', () => {
  const read = disk.decode(Buffer.from('one\r\ntwo\nthree\r\nfour\r\n'));
  let tab = { text: read.text, dirty: false, ...eolFields(read) };
  assert.equal(eolUndecided(tab), true);
  assert.equal(saveTarget(tab), null);
  assert.equal(saveEndings(tab), null);
  assert.deepEqual(eolStatus(tab), { text: 'Mixed', tone: 'warn', title: 'Mixed line endings: 3 Windows (CRLF), 1 Unix (LF). Saving asks how to save them; click to choose now.' });
  tab = { ...tab, ...convertEndings(tab, 'keep') };
  assert.equal(eolUndecided(tab), false);
  assert.equal(endingsChanged(tab), false, 'keeping changes nothing by itself');
  // A line added after "one", "three" changed: those get CRLF; "two" keeps its LF.
  tab.text = 'one\nnew\ntwo\nTHREE\nfour\n';
  const ends = saveEndings(tab);
  assert.deepEqual(ends, { eol: 'crlf', why: 'keep', eols: 'CCLCC' });
  assert.equal(disk.encode(tab.text, ends).toString(), 'one\r\nnew\r\ntwo\nTHREE\r\nfour\r\n');
  // Saved: still mixed, the new base is what was written; asked once only.
  const after = savedEolFields(tab.text, ends);
  assert.equal(after.fileEol, 'mixed');
  assert.equal(after.eolBase, tab.text);
  assert.deepEqual(after.mixed, { crlf: 4, lf: 1, cr: 0 });
  assert.equal(eolUndecided({ ...tab, ...after }), false);
  // All one kind instead.
  const all = { ...tab, ...eolFields(read), ...convertEndings(tab, 'lf') };
  assert.equal(endingsChanged(all), true);
  assert.deepEqual(saveEndings(all), { eol: 'lf', why: 'chosen' });
  assert.equal(savedEolFields(read.text, saveEndings(all)).fileEol, 'lf');
  // Keeping lines that all end alike: no longer mixed.
  assert.equal(savedEolFields('a\nb\n', { eol: 'crlf', eols: 'CC' }).fileEol, 'crlf');
});

test('keeping each line\'s own: unchanged lines by a diff, the last line, too different texts', () => {
  assert.equal(keepEols('a\nb\nc', 'LC', 'a\nb\nc', 'crlf'), 'LC', 'unchanged');
  assert.equal(keepEols('a\nb\nc', 'LC', 'x\na\nb\nc', 'crlf'), 'CLC', 'a line at the start');
  assert.equal(keepEols('a\nb\nc', 'LC', 'a\nc', 'crlf'), 'L', '"b" gone: "a" keeps its own');
  assert.equal(keepEols('a\nb', 'L', 'a\nb\nc', 'crlf'), 'LC', 'the old last line gets a break: the most common');
  assert.equal(keepEols('a\nb\n', 'RL', 'a\nb\n', 'lf'), 'RL');
  assert.equal(keepEols('', '', 'a\nb', 'cr'), 'R');
  // Too different for the diff: the same lines at both ends keep theirs.
  const n = 9000;
  const base = Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  const letters = 'L'.repeat(n - 1);
  const now = ['line 0', ...Array.from({ length: n - 2 }, (_, i) => `other ${i}`), `line ${n - 1}`].join('\n');
  const kept = keepEols(base, letters, now, 'crlf');
  assert.equal(kept.length, n - 1);
  assert.equal(kept[0], 'L');
  assert.equal(kept[1], 'C');
});

test('what the status bar says, and the menu\'s choices', () => {
  const lf = { ...eolFields(disk.decode(Buffer.from('a\nb\n'))), text: 'a\nb\n' };
  assert.equal(eolStatus(lf).text, 'LF');
  assert.deepEqual(eolChoices(lf).map((c) => [c.id, c.checked]), [['crlf', false], ['lf', true]]);
  const ec = { ...lf, ecEol: 'crlf' };
  assert.equal(eolStatus(ec).text, 'LF → CRLF · .editorconfig');
  assert.deepEqual(saveEndings(ec), { eol: 'crlf', why: 'editorconfig' });
  assert.equal(endingsChanged(ec), false, '.editorconfig does not make the tab unsaved: saving converts, said in the status bar');
  const chosen = { ...ec, ...convertEndings(ec, 'lf') };
  assert.deepEqual(saveEndings(chosen), { eol: 'lf', why: 'chosen' }, 'picked by hand: over the .editorconfig');
  assert.equal(eolStatus({ ...lf, ...convertEndings(lf, 'crlf') }).text, 'LF → CRLF');
  const cr = { ...eolFields(disk.decode(Buffer.from('a\rb\r'))), text: 'a\nb\n' };
  assert.equal(eolStatus(cr).text, 'CR');
  assert.deepEqual(eolChoices(cr).map((c) => c.id), ['crlf', 'lf', 'cr'], 'Classic Mac only for a CR file');
  const mixed = { ...eolFields(disk.decode(Buffer.from('a\r\nb\n'))), text: 'a\nb\n' };
  assert.deepEqual(eolChoices(mixed).map((c) => c.id), ['crlf', 'lf', 'keep']);
  assert.equal(eolStatus({ ...mixed, ecEol: 'lf' }).text, 'Mixed → LF · .editorconfig');
  assert.equal(mixedWords({ crlf: 1200, lf: 3, cr: 0 }), '1,200 Windows (CRLF), 3 Unix (LF)');
  assert.equal(uniformEol('CCC'), 'crlf');
  assert.equal(uniformEol('CLC'), null);
});

test('writing to a file not open: its endings and encoding; a mixed one keeps each line\'s; none yet gets the place\'s', () => {
  const read = disk.decode(Buffer.from('a\r\nb\nc\r\n'));
  const fmt = writeFormat(read, 'a\nb\nc\nd\n');
  assert.deepEqual(fmt, { eol: 'crlf', bom: false, encoding: 'utf-8', eols: 'CLCC' });
  assert.deepEqual(writeFormat(disk.decode(Buffer.from('x')), 'x\ny', 'crlf'), { eol: 'crlf', bom: false, encoding: 'utf-8' });
  assert.deepEqual(writeFormat(disk.decode(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])), 'b\n'), { eol: 'lf', bom: true, encoding: 'utf-8' });
});

test('Folders\' Line endings: counts for a target', () => {
  const files = [{ eol: 'lf' }, { eol: 'crlf' }, { eol: 'mixed' }, { eol: 'none' }, { eol: 'cr' }];
  assert.deepEqual(eolCounts(files, 'crlf'), { change: 3, right: 2, mixed: 1 });
  assert.deepEqual(eolCounts(files, 'lf'), { change: 3, right: 2, mixed: 1 });
  assert.deepEqual(eolCounts([], 'lf'), { change: 0, right: 0, mixed: 0 });
});

test('a locked file keeps the line endings it had in its header; old ones without it still open', async () => {
  const made = await lockText('one\ntwo\n', 'a long password', { name: 'notes.txt', eol: 'crlf', iterations: 100000 });
  assert.match(made.text.split('\n')[1], /"relock":false,"eol":"crlf"\}$/);
  assert.equal(lockedHeader(made.text).eol, 'crlf');
  const open = await unlockText(made.text, 'a long password');
  assert.equal(open.plain, 'one\ntwo\n');
  assert.equal(open.header.eol, 'crlf');
  const plain = await lockText('x', 'a long password', { name: 'a.txt', iterations: 100000 });
  assert.equal(lockedHeader(plain.text).eol, undefined);
  assert.ok(!plain.text.includes('"eol"'), 'no eol: the header as before');
  // A header naming something else is not one this version opens.
  const odd = plain.text.replace('"relock":false}', '"relock":false,"eol":"native"}');
  assert.equal(lockedHeader(odd), null);
});
