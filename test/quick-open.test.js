// Quick open (Ctrl+P) and the other pick lists: the letters marked, the compact times, the
// sections, where each file is, and where the keys take the selection (quickRows.js,
// search.js matchRanges, format.js shortAgo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, matchRanges, quickOpen } from '../app/js/search.js';
import { shortAgo } from '../app/js/format.js';
import { groupQuick, quickKind, quickMarks, quickPlace, quickSection, stepIndex, wordRanges } from '../app/js/quickRows.js';

const mark = (text, ranges) => ranges.reduceRight((s, [a, b]) => `${s.slice(0, a)}[${s.slice(a, b)}]${s.slice(b)}`, text);

test('matchRanges marks a whole match once, else the letters as fuzzyScore finds them', () => {
  assert.deepEqual(matchRanges('server.js', 'ver'), [[3, 6]]);
  assert.equal(mark('QuickOpen.js', matchRanges('QuickOpen.js', 'qopen')), '[Q]uick[Open].js');
  // Runs of letters next to each other are one range.
  assert.equal(mark('package.json', matchRanges('package.json', 'pkjs')), '[p]ac[k]age.[js]on');
  // Spaces in the query count for nothing, as in fuzzyScore.
  assert.equal(mark('read me.md', matchRanges('read me.md', 'read me')), '[read] [me].md');
  assert.deepEqual(matchRanges('notes.md', 'xyz'), []);
  assert.deepEqual(matchRanges('notes.md', ''), []);
  assert.deepEqual(matchRanges('', 'a'), []);
  // Whatever it marks, fuzzyScore finds too (and the other way round).
  for (const [text, q] of [['index.html', 'idx'], ['Makefile', 'mk'], ['a-b-c.txt', 'abc'], ['README', 'zz']]) {
    assert.equal(matchRanges(text, q).length > 0, fuzzyScore(text, q) >= 0, `${text} / ${q}`);
  }
});

test('shortAgo: minutes, hours and days in few letters, then the day', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(shortAgo('2026-11-02T11:59:40Z', now), 'now');
  assert.equal(shortAgo('2026-11-02T11:55:00Z', now), '5m');
  assert.equal(shortAgo('2026-11-02T10:00:00Z', now), '2h');
  assert.equal(shortAgo('2026-10-30T12:00:00Z', now), '3d');
  const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  assert.equal(shortAgo('2026-10-03T12:00:00Z', now), day.format(new Date('2026-10-03T12:00:00Z')));
  const withYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  assert.equal(shortAgo('2024-10-03T12:00:00Z', now), withYear.format(new Date('2024-10-03T12:00:00Z')));
  assert.equal(shortAgo('', now), '');
  assert.equal(shortAgo('not a date', now), '');
  // Never long enough to wrap: at most "Oct 30" (or with the year, a year back).
  assert.ok(shortAgo('2026-01-01T00:00:00Z', now).length <= 8);
});

const synced = { id: 'f1', name: 'plan.md', project: 'Deep Time', modifiedAt: '2026-11-01T10:00:00Z' };
const doc = { id: 'r:files/x/spec.md', name: 'spec.md', project: 'Deep Time', item: 'Write the spec', modifiedAt: '2026-10-01T10:00:00Z' };
const tab = { id: 'd:/home/me/proj/src/app.js', name: 'app.js', path: '/home/me/proj/src/app.js', rel: 'app.js', kind: 'disk', where: 'proj', tab: true };
const remoteTab = { id: 'd:remote://s1/var/www/site/index.php', name: 'index.php', path: 'remote://s1/var/www/site/index.php', rel: 'index.php', kind: 'remote', where: 'Web server', tab: true };
const inFolder = { id: 'd:/home/me/proj/lib/util/strings.js', name: 'strings.js', path: '/home/me/proj/lib/util/strings.js', rel: 'lib/util/strings.js', kind: 'disk', where: 'proj' };
const atTop = { id: 'd:/home/me/proj/Makefile', name: 'Makefile', path: '/home/me/proj/Makefile', rel: 'Makefile', kind: 'disk', where: 'proj' };
const typed = { id: 'typed:/tmp/a.txt', typed: '/tmp/a.txt', name: 'a.txt' };
const ask = { id: 'ask', ask: true, name: 'where is the docker command' };

test('sections: tabs, then recent while nothing is typed; while typing, my files, documents and folders apart', () => {
  assert.equal(quickSection(tab), 'tabs');
  assert.equal(quickSection(synced), 'recent');
  assert.equal(quickSection(doc), 'recent');
  assert.equal(quickSection(synced, { searching: true }), 'files');
  assert.equal(quickSection(doc, { searching: true }), 'docs');
  assert.equal(quickSection(inFolder, { searching: true }), 'folders');
  assert.equal(quickSection(typed, { searching: true }), 'typed');
  assert.equal(quickSection(ask, { searching: true }), 'ask');
});

test('groupQuick keeps the best match first: sections in the order of their first row, rows in order inside', () => {
  const rows = [inFolder, synced, atTop, doc, ask];
  const groups = groupQuick(rows, { searching: true });
  assert.deepEqual(
    groups.map((g) => [g.id, g.label, g.rows.map((r) => r.name)]),
    [
      ['folders', 'In your folders', ['strings.js', 'Makefile']],
      ['files', 'My files', ['plan.md']],
      ['docs', 'Tracker documents', ['spec.md']],
      ['ask', '', ['where is the docker command']],
    ],
  );
  // The rows the keys go through: each once, the first one still first.
  const flat = groups.flatMap((g) => g.rows);
  assert.equal(flat.length, rows.length);
  assert.equal(flat[0], rows[0]);
  // A question asked first stays first; a typed path has no header either.
  assert.deepEqual(groupQuick([typed, ask, tab, synced]).map((g) => [g.id, g.label]), [['typed', ''], ['ask', ''], ['tabs', 'Open tabs'], ['recent', 'Recent']]);
  assert.deepEqual(groupQuick([]), []);
});

test('quickPlace says where a file is in words', () => {
  assert.equal(quickPlace(synced), 'My files');
  assert.equal(quickPlace(doc), 'Tracker · Write the spec');
  assert.equal(quickPlace(inFolder), 'lib/util');
  assert.equal(quickPlace(atTop), '');
  // An open tab: the last folders of its path (a server's without its address).
  assert.equal(quickPlace(tab), 'proj/src');
  assert.equal(quickPlace(remoteTab), 'www/site');
  assert.equal(quickPlace({ ...tab, path: 'C:\\Users\\me\\notes\\todo.txt', name: 'todo.txt', rel: 'todo.txt' }), 'me/notes');
  assert.equal(quickPlace(typed), '/tmp/a.txt');
  assert.equal(quickPlace(ask), '');
});

test('quickKind: where.js kinds for the place’s color', () => {
  assert.equal(quickKind(synced), 'synced');
  assert.equal(quickKind(doc), 'doc');
  assert.equal(quickKind(tab), 'disk');
  assert.equal(quickKind(remoteTab), 'remote');
  assert.equal(quickKind(typed), 'disk');
});

test('quickMarks: the name’s own match, else the path in the folder split between folders and name', () => {
  assert.deepEqual(quickMarks(synced, 'plan'), { name: [[0, 4]], place: [], project: [] });
  assert.deepEqual(quickMarks(synced, ''), { name: [], place: [], project: [] });
  // "util/str" is not in the name: the folders get "util/", the name "str".
  const m = quickMarks(inFolder, 'util/str');
  assert.equal(mark('strings.js', m.name), '[str]ings.js');
  assert.equal(mark(quickPlace(inFolder), m.place), 'lib/[util]');
  // Found by its project and name: the project's letters in its chip, the name's in the name.
  const both = quickMarks(synced, 'deep plan');
  assert.equal(mark('plan.md', both.name), '[plan].md');
  assert.equal(mark('Deep Time', both.project), '[Deep] Time');
  assert.equal(mark('Deep Time', quickMarks(synced, 'time').project), 'Deep [Time]');
  // A tracker document found by its item: the item's letters are marked in the place.
  const byItem = quickMarks(doc, 'write');
  assert.equal(mark(quickPlace(doc), byItem.place), 'Tracker · [Write] the spec');
  assert.deepEqual(byItem.name, []);
  assert.deepEqual(quickMarks(typed, 'a'), { name: [], place: [], project: [] });
  assert.deepEqual(quickMarks(ask, 'docker'), { name: [], place: [], project: [] });
  // Whatever quickOpen lists for a query, something of it is marked.
  for (const q of ['strings', 'util/str', 'deep', 'spec', 'write', 'time']) {
    const listed = quickOpen([synced, doc, inFolder], q);
    assert.ok(listed.length > 0, q);
    for (const row of listed) {
      const marks = quickMarks(row, q);
      assert.ok(marks.name.length + marks.place.length + marks.project.length > 0, `${row.name} for “${q}”`);
    }
  }
});

test('wordRanges marks each word where it first is, joined when they touch', () => {
  assert.equal(mark('saveDiskTab', wordRanges('saveDiskTab', ['disk'])), 'save[Disk]Tab');
  assert.equal(mark('Format the document', wordRanges('Format the document', ['doc', 'form'])), '[Form]at the [doc]ument');
  assert.equal(mark('abcdef', wordRanges('abcdef', ['abc', 'cde'])), '[abcde]f');
  assert.equal(mark('abcdef', wordRanges('abcdef', ['ab', 'cd'])), '[abcd]ef');
  assert.deepEqual(wordRanges('abc', ['x']), []);
  assert.deepEqual(wordRanges('abc', []), []);
});

test('stepIndex: ↑ ↓ one row, a page at a time, Home End with Ctrl or in an empty field, never past the ends', () => {
  const key = (k, mods = {}) => ({ key: k, ...mods });
  assert.equal(stepIndex(key('ArrowDown'), 0, 10), 1);
  assert.equal(stepIndex(key('ArrowDown'), 9, 10), 9);
  assert.equal(stepIndex(key('ArrowUp'), 0, 10), 0);
  assert.equal(stepIndex(key('ArrowUp'), 5, 10), 4);
  assert.equal(stepIndex(key('PageDown'), 2, 30, { page: 8 }), 10);
  assert.equal(stepIndex(key('PageDown'), 25, 30, { page: 8 }), 29);
  assert.equal(stepIndex(key('PageUp'), 5, 30, { page: 8 }), 0);
  assert.equal(stepIndex(key('PageUp'), 20, 30, { page: 8 }), 12);
  assert.equal(stepIndex(key('PageDown'), 0, 30, { page: 0 }), 1);
  // Home and End move the text's cursor while something is typed, unless Ctrl (or Cmd) is held.
  assert.equal(stepIndex(key('End'), 3, 10), null);
  assert.equal(stepIndex(key('End', { ctrlKey: true }), 3, 10), 9);
  assert.equal(stepIndex(key('Home', { metaKey: true }), 3, 10), 0);
  assert.equal(stepIndex(key('End'), 3, 10, { empty: true }), 9);
  assert.equal(stepIndex(key('Home'), 3, 10, { empty: true }), 0);
  // Other keys, or nothing to move through.
  assert.equal(stepIndex(key('Enter'), 3, 10), null);
  assert.equal(stepIndex(key('a'), 3, 10), null);
  assert.equal(stepIndex(key('ArrowDown'), 0, 0), null);
  // A selection left past the end (the list got shorter) comes back inside.
  assert.equal(stepIndex(key('ArrowUp'), 12, 5), 3);
  assert.equal(stepIndex(key('ArrowDown'), -1, 5), 0);
});
