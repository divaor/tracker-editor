// The Android app's page side: text from file bytes by the desktop's rules (textBytes.js),
// what the app was given (androidApp.js) and where a content:// file is (where.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeAppended, decodeText, encodeText, fromBase64, fromWholeLine, toBase64 } from '../app/js/textBytes.js';
import { changedSince, routeOfLink, sortLaunch } from '../app/js/androidApp.js';
import { contentPlace, isContentPath } from '../app/js/where.js';

const require = createRequire(import.meta.url);
const disk = require('../electron/diskFiles.cjs');

const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));

test('text from bytes: the same as the desktop app reads it', () => {
  const samples = [
    Buffer.from('plain\nlines\n'),
    Buffer.from('windows\r\nlines\r\n'),
    Buffer.from('mixed\r\nmostly\nunix\nlines\n'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('with a BOM: café\n')]),
    Buffer.from('ñandú, Windows-1252\n', 'latin1'),
    Buffer.from('emoji 🎉 and accents àé\n'),
    Buffer.from(''),
  ];
  for (const buf of samples) assert.deepEqual(decodeText(new Uint8Array(buf)), disk.decode(buf), JSON.stringify(buf.toString('latin1')));
  assert.throws(() => decodeText(bytes('abc', [0], 'def')), /not a text file/);
});

test('bytes for the text: line endings, BOM and encoding put back', () => {
  for (const [text, opts] of [
    ['a\nb\n', {}],
    ['a\nb\n', { eol: 'crlf' }],
    ['café\n', { bom: true }],
    ['ñandú\n', { encoding: 'latin1', eol: 'crlf' }],
  ]) {
    assert.deepEqual(Buffer.from(encodeText(text, opts)), disk.encode(text, opts), JSON.stringify([text, opts]));
    // Read back, it is the same text with the same settings.
    const back = decodeText(encodeText(text, opts));
    assert.equal(back.text, text);
    assert.equal(back.bom, Boolean(opts.bom));
  }
  // A character a Latin-1 file cannot hold becomes "?" (rather than a wrong byte).
  assert.deepEqual([...encodeText('a€', { encoding: 'latin1' })], [0x61, 0x3f]);
});

test('followed files, large files and base64', () => {
  assert.equal(decodeAppended(new Uint8Array(Buffer.from('new\r\nlines'))), 'new\nlines');
  assert.equal(decodeAppended(new Uint8Array(Buffer.from('é', 'latin1')), 'latin1'), 'é');
  assert.equal(fromWholeLine('rt of a line\nwhole\n'), 'whole\n');
  const all = new Uint8Array(70000).map((_, i) => i % 256);
  assert.deepEqual(fromBase64(toBase64(all)), all);
  assert.equal(toBase64(new Uint8Array(Buffer.from('hi'))), 'aGk=');
});

test('changed since it was read: by time when known, else by size', () => {
  assert.equal(changedSince({ mtimeMs: 1000, size: 5 }, { expectedMtime: 1000, expectedSize: 9 }), false, 'same time: unchanged');
  assert.equal(changedSince({ mtimeMs: 2000, size: 5 }, { expectedMtime: 1000, expectedSize: 5 }), true);
  assert.equal(changedSince({ mtimeMs: -1, size: 7 }, { expectedMtime: -1, expectedSize: 5 }), true, 'no time: the size');
  assert.equal(changedSince({ mtimeMs: -1, size: 5 }, { expectedMtime: -1, expectedSize: 5 }), false);
  assert.equal(changedSince({ mtimeMs: -1, size: -1 }, { expectedMtime: 1000, expectedSize: 5 }), false, 'nothing known: written over');
  assert.equal(changedSince({ mtimeMs: 1000, size: 5 }, {}), false);
});

test('what the app was given: files to open where they are, things shared, links', async () => {
  const read = async (uri) => new TextEncoder().encode(`text of ${uri}`);
  const sorted = await sortLaunch(
    [
      { kind: 'file', action: 'view', uri: 'content://a/1', name: 'notes.md' },
      { kind: 'file', action: 'edit', uri: 'content://a/2', name: 'app.yaml' },
      { kind: 'file', action: 'send', uri: 'content://b/3', name: 'shared.txt', mime: 'text/plain' },
      { kind: 'text', action: 'send', text: 'a link', title: 'Subject' },
      { kind: 'text', action: 'process', text: 'selected words' },
      { kind: 'link', url: 'tracker-editor://new' },
    ],
    read,
  );
  assert.deepEqual(sorted.launched, [
    { path: 'content://a/1', name: 'notes.md' },
    { path: 'content://a/2', name: 'app.yaml' },
  ]);
  assert.equal(sorted.shared.length, 3);
  assert.equal(sorted.shared[0].files[0].name, 'shared.txt');
  assert.equal(await sorted.shared[0].files[0].text(), 'text of content://b/3');
  assert.deepEqual(sorted.shared.slice(1).map((s) => [s.title, s.text]), [
    ['Subject', 'a link'],
    ['', 'selected words'],
  ]);
  assert.deepEqual(sorted.links, ['tracker-editor://new']);
  // A shared file that cannot be read is left out.
  assert.equal((await sortLaunch([{ kind: 'file', action: 'send', uri: 'x' }], async () => Promise.reject(new Error('gone')))).shared.length, 0);
});

test('editor links and shortcuts become the page’s addresses', () => {
  assert.equal(routeOfLink('tracker-editor://file/abc123'), '#/file/abc123');
  assert.equal(routeOfLink('tracker-editor://repo/files/2026-10-22-plan/plan.md'), '#/repo/files/2026-10-22-plan/plan.md');
  assert.equal(routeOfLink('tracker-editor://new'), '#/new');
  assert.equal(routeOfLink('tracker-editor:///voice'), '#/voice');
  assert.equal(routeOfLink('tracker-editor://settings'), null);
  assert.equal(routeOfLink('https://example.com'), null);
});

test('where a file from another app is', () => {
  assert.ok(isContentPath('content://com.android.providers.downloads.documents/document/12'));
  assert.ok(!isContentPath('/storage/emulated/0/notes.txt'));
  assert.equal(contentPlace('content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fwork%2Fnotes.txt'), 'Phone storage · Documents/work');
  assert.equal(contentPlace('content://com.android.externalstorage.documents/document/primary%3Anotes.txt'), 'Phone storage');
  assert.equal(contentPlace('content://com.android.externalstorage.documents/document/1A2B-3C4D%3ALogs%2Fa.log'), 'SD card · Logs');
  assert.equal(contentPlace('content://com.android.providers.downloads.documents/document/1234'), 'Downloads');
  assert.equal(contentPlace('content://com.google.android.apps.nbu.files.provider/2/123'), 'Files by Google');
  assert.equal(contentPlace('content://com.mixplorer.file/x'), 'From Mixplorer');
  assert.equal(contentPlace('content://provider.files/x'), 'From another app');
  assert.equal(contentPlace('/not/content'), '');
});
