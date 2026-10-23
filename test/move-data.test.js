// Moving the data between this device and GitHub (moveData.js): everything the other
// side lacks is copied, tracker.json merged item by item, then the editor's sync
// carries on there with nothing lost; and back again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from './helpers/fake-github.js';
import { createGitHubClient } from '../app/js/github.js';
import { createLocalRepo, memoryBackend } from '../app/js/localRepo.js';
import { moveData } from '../app/js/moveData.js';
import { syncOnce } from '../app/js/sync.js';
import { createFile, INDEX_PATH, parseIndex } from '../app/js/model.js';
import { createItem, mergeItems, mergeProjects, parseData, serializeDocument } from '../app/js/tracker-model.js';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();
const mergeTracker = (theirs, ours) => {
  const a = parseData(theirs);
  const b = parseData(ours);
  return serializeDocument(mergeItems(a.items, b.items), mergeProjects(a.projects, b.projects), a.extra);
};
const github = (opts) => {
  const fake = createFakeGitHub(opts);
  return { fake, client: createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: fake.fetch, cacheMode: '' }) };
};

// The editor used on this device only: two files, a tracker item, an attachment, the vault.
async function localDevice() {
  const repo = createLocalRepo(memoryBackend(), { now: tick });
  const files = ['notes.md', 'todo.txt'].map((name) => ({ ...createFile({ name, updatedBy: 'pc' }, tick()), baseSha: '', dirty: true }));
  const texts = new Map(files.map((f) => [f.id, `text of ${f.name}`]));
  const item = createItem({ title: 'Local task', project: 'Alpha' }, tick());
  const result = await syncOnce({ client: repo, files, texts, device: 'pc', now: tick, trackerChange: ({ items, projects }) => ({ items: [...items, item], projects }) });
  await repo.putFile('files/2026-10-21-plan-abc123/plan.md', { text: '# Plan', message: 'attachment' });
  await repo.putFile('editor/vault.json', { text: '{"v":1}', message: 'vault' });
  return { repo, records: result.files, item };
}

test('to an empty GitHub repo: everything goes, and the editor syncs on there', async () => {
  const { repo, records, item } = await localDevice();
  const { client } = github({ empty: true });
  const moved = await moveData({ from: repo, to: client, mergeTracker, device: 'pc' });
  assert.equal(moved.tracker, true);
  assert.equal(moved.copied, 4, 'two files, the attachment, the vault');
  assert.equal((await client.getFile('files/2026-10-21-plan-abc123/plan.md')).text, '# Plan');
  assert.equal(parseData((await client.getFile('tracker.json')).text).items[0].title, item.title);
  // The editor's sync there: its records (with the shas from the device) are now in GitHub's index, texts and all.
  const after = await syncOnce({ client, files: records, device: 'pc', now: tick });
  const index = parseIndex((await client.getFile(INDEX_PATH)).text);
  assert.deepEqual(index.files.map((f) => f.name).sort(), ['notes.md', 'todo.txt']);
  for (const f of index.files) assert.equal((await client.getFile(`editor/files/${f.id}/${f.name}`)).text, `text of ${f.name}`);
  assert.equal(after.texts.size, 0, 'nothing to download: the texts are the same');
  // Again: nothing more to copy.
  assert.deepEqual(await moveData({ from: repo, to: client, mergeTracker }), { copied: 0, tracker: false });
});

test('to a GitHub repo with data from elsewhere: the tracker items are merged, files from both stay', async () => {
  const { repo, item } = await localDevice();
  const { client } = github();
  const theirs = createItem({ title: 'From the phone' }, tick());
  await client.putFile('tracker.json', { text: serializeDocument([theirs], []), message: 'phone' });
  await client.putFile('editor/files/x/other.md', { text: 'other', message: 'phone' });
  await moveData({ from: repo, to: client, mergeTracker });
  const doc = parseData((await client.getFile('tracker.json')).text);
  assert.deepEqual(doc.items.map((i) => i.title).sort(), [item.title, 'From the phone'].sort());
  assert.equal((await client.getFile('editor/files/x/other.md')).text, 'other');
  assert.equal((await client.getFile('README.md')).text, '# data\n', 'nothing of theirs removed');
});

test('a tracker.json there that cannot be read is never overwritten', async () => {
  const { repo } = await localDevice();
  const { client } = github();
  await client.putFile('tracker.json', { text: 'not json', message: 'broken' });
  await assert.rejects(moveData({ from: repo, to: client, mergeTracker }));
  assert.equal((await client.getFile('tracker.json')).text, 'not json');
});

test('back from GitHub to this device: what the device lacks comes over', async () => {
  const { client } = github();
  const theirs = createItem({ title: 'On GitHub' }, tick());
  await client.putFile('tracker.json', { text: serializeDocument([theirs], []), message: 'x' });
  await client.putFile('files/doc/a.md', { text: 'A', message: 'x' });
  const repo = createLocalRepo(memoryBackend(), { now: tick });
  const moved = await moveData({ from: client, to: repo, mergeTracker });
  assert.equal(moved.copied, 2, 'the attachment and the README');
  assert.equal(parseData((await repo.getFile('tracker.json')).text).items[0].title, 'On GitHub');
  assert.equal((await repo.getFile('files/doc/a.md')).text, 'A');
});
