// 0.40: Find by asking in the editor: its sources (encrypted files by name only), the picture the
// model plans with, and the small helpers the results use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, plainPlan } from '../app/js/askFind.js';
import { askPicture, diskPlace, docSources, foundLabel, itemSources, searchedWords, syncedSources, tabKeyOf, trackerItemUrl } from '../app/js/askSources.js';

const files = [
  { id: 'a1', name: 'deploy.md', project: 'Deep Time', tags: ['docker'], modifiedAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'a2', name: 'new 3', project: '', tags: [], modifiedAt: '2026-10-31T10:00:00Z' },
  { id: 'a3', name: 'passwords.md', project: '', tags: ['secret-keys'], modifiedAt: '2026-10-20T10:00:00Z', encrypted: true },
  { id: 'a4', name: 'gone.md', deleted: true },
];
const texts = { a1: 'docker compose up -d', a2: 'docker run hello', a3: 'root password hunter2' };

test('synced files: their text, encrypted ones by name only, untitled ones marked', () => {
  const asked = [];
  const sources = syncedSources(files, (id) => (asked.push(id), texts[id]));
  assert.deepEqual(sources.map((s) => s.id), ['f:a1', 'f:a2', 'f:a3']);
  assert.deepEqual(sources[0], { id: 'f:a1', kind: 'synced', name: 'deploy.md', place: 'My files · Deep Time', project: 'Deep Time', tags: ['docker'], date: '2026-10-30T10:00:00Z', untitled: false, text: 'docker compose up -d' });
  assert.equal(sources[1].untitled, true);
  assert.equal(sources[2].encrypted, true);
  assert.equal(sources[2].text, '');
  assert.ok(!asked.includes('a3'), 'an encrypted file’s text is never even read');
  assert.deepEqual(measure(sources[2], { ...plainPlan(''), terms: ['password'] }).counts, [0]);
});

test('tracker documents and items (the other app’s, marked)', () => {
  const docs = docSources([{ path: 'files/x/notes.md', name: 'notes.md', project: 'Kitchen', tags: [], modifiedAt: '2026-10-02T00:00:00Z', item: { id: 'i1', title: 'Fix the leak' } }], (p) => (p === 'files/x/notes.md' ? 'call the plumber' : null));
  assert.deepEqual(docs[0], { id: 'r:files/x/notes.md', kind: 'doc', name: 'notes.md', place: 'Tracker · Fix the leak', project: 'Kitchen', tags: [], date: '2026-10-02T00:00:00Z', text: 'call the plumber' });
  assert.equal(docSources([{ path: 'p', name: 'p', item: { title: '' } }], () => null)[0].text, '', 'not downloaded yet');
  const items = itemSources([
    { id: 'm1', title: 'Docker cleanup', type: 'task', status: 'pending', project: 'Deep Time', tags: ['docker'], notes: 'docker system prune', feedback: '', comments: [{ id: 'c1', by: 'Laptop', at: '2026-10-01T00:00:00Z', text: 'also volumes' }, { id: 'c2', by: 'x', at: '2026-10-02T00:00:00Z', editedAt: '2026-10-02T00:00:00Z', deleted: true }], updatedAt: '2026-10-28T00:00:00Z' },
    { id: 'm2', title: 'Old', deleted: true },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].id, items[0].itemId, items[0].kind, items[0].from, items[0].type, items[0].status, items[0].place], ['i:m1', 'm1', 'item', 'tracker', 'task', 'pending', 'Tracker']);
  assert.equal(items[0].text, 'Docker cleanup\n\ndocker system prune\n\nalso volumes');
});

test('the picture: kinds present, types, projects, tags (not only encrypted files’), folders', () => {
  const picture = askPicture({ today: '2026-11-01', files, docs: [], items: [{ id: 'm1', title: 'x', project: 'Kitchen', tags: ['home', 'docker'] }], trackerProjects: [{ key: 'garden', name: 'Garden' }], folders: ['tracker-editor'] });
  assert.deepEqual(picture.kinds.map((k) => k.id), ['synced', 'disk', 'item']);
  assert.match(picture.about, /^My files; Files in the folders shown in Folders/);
  assert.deepEqual(picture.types.map((t) => t.id), ['task', 'idea', 'claude', 'doc']);
  assert.deepEqual(picture.projects.sort(), ['Deep Time', 'Garden', 'Kitchen']);
  assert.deepEqual(picture.tags, ['docker', 'home']);
  assert.ok(!picture.tags.includes('secret-keys'), 'an encrypted file’s tags stay out');
  assert.deepEqual(picture.folders, ['tracker-editor']);
  assert.deepEqual(askPicture({ today: '2026-11-01' }).kinds, []);
});

test('helpers: where a folder file is, the tracker link, tab keys, labels, what was searched', () => {
  assert.equal(diskPlace({ rel: 'src/lib/a.js' }, 'app'), 'app/src/lib');
  assert.equal(diskPlace({ rel: 'a.js' }, 'app'), 'app');
  assert.equal(trackerItemUrl('https://divaor.github.io/tracking_app/#/list', 'mvx-1'), 'https://divaor.github.io/tracking_app/#/item/mvx-1');
  assert.equal(trackerItemUrl('', 'a b'), 'https://divaor.github.io/tracking_app/#/item/a%20b');
  assert.equal(tabKeyOf({ id: 'f:a1' }), 'f:a1');
  assert.equal(tabKeyOf({ id: 'd:/x/y.md' }), 'd:/x/y.md');
  assert.equal(tabKeyOf({ id: 'i:m1' }), null);
  assert.equal(foundLabel('  the file where   I copied a docker command  '), 'the file where I copied a docke…');
  assert.equal(foundLabel('docker'), 'docker');
  assert.equal(searchedWords({ files: 12, docs: 1, items: 40, folders: { scanned: 1200, roots: 2, truncated: true } }), '12 files, 1 tracker document, 40 tracker items and 1,200 files in 2 folders (cut short)');
  assert.equal(searchedWords({}), 'nothing yet');
});
