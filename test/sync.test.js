import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createFakeGitHub } from './helpers/fake-github.js';
import { createGitHubClient } from '../app/js/github.js';
import { syncOnce } from '../app/js/sync.js';
import { INDEX_PATH, applyFilePatch, contentPath, createFile, gitBlobSha, parseIndex, tombstone } from '../app/js/model.js';
import { createItem, serializeDocument, parseData } from '../app/js/tracker-model.js';
import { createVault, isSealed, seal, unseal } from '../app/js/crypto.js';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();

function setup(opts) {
  const github = createFakeGitHub(opts);
  const client = createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: github.fetch, cacheMode: '' });
  return { github, client };
}

// A device: its file records and texts, synced the way the app's store does.
function device(name, client) {
  const state = { files: [], texts: new Map() };
  const d = {
    state,
    create(fileName, text, fields = {}) {
      const file = { ...createFile({ name: fileName, updatedBy: name, modifiedBy: name, ...fields }, tick()), baseSha: '', dirty: true };
      state.files.push(file);
      state.texts.set(file.id, text);
      return file.id;
    },
    edit(id, text) {
      state.texts.set(id, text);
      state.files = state.files.map((f) => (f.id === id ? { ...f, dirty: true, modifiedAt: tick(), modifiedBy: name } : f));
    },
    patch(id, patch) {
      state.files = state.files.map((f) => (f.id === id ? { ...applyFilePatch(f, { ...patch, updatedBy: name }, tick()), baseSha: f.baseSha, dirty: f.dirty } : f));
    },
    remove(id) {
      state.files = state.files.map((f) => (f.id === id ? { ...tombstone(f, tick(), name), baseSha: f.baseSha, dirty: false } : f));
      state.texts.delete(id);
    },
    text: (id) => state.texts.get(id),
    byName: (n) => state.files.find((f) => f.name === n && !f.deleted),
    live: () => state.files.filter((f) => !f.deleted).map((f) => f.name).sort(),
    async sync(extra = {}) {
      const dirty = new Map(state.files.filter((f) => f.dirty).map((f) => [f.id, state.texts.get(f.id) ?? '']));
      const result = await syncOnce({ client, files: state.files, texts: dirty, device: name, now: tick, ...extra });
      state.files = result.files;
      for (const [id, text] of result.texts) state.texts.set(id, text);
      for (const f of state.files) if (f.deleted) state.texts.delete(f.id);
      return result;
    },
  };
  return d;
}

test('gitBlobSha matches git hash-object', async () => {
  for (const text of ['hello', '', 'línea con acentos ✓\nsecond line\n']) {
    const expected = execFileSync('git', ['hash-object', '--stdin'], { input: text }).toString().trim();
    assert.equal(await gitBlobSha(text), expected);
  }
});

test('first sync writes every file, the index and nothing else, in one commit', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const a = pc.create('notes.md', '# Notes\n', { project: 'Platform', tags: ['api'] });
  pc.create('new 1', 'pasted text');
  const commitsBefore = github.log.length;
  const result = await pc.sync();
  assert.equal(github.log.length, commitsBefore + 1, 'one commit');
  assert.match(github.log.at(-1), /Editor: sync from Work PC \(2 added\)/);
  const file = pc.state.files.find((f) => f.id === a);
  assert.equal(github.read(contentPath(file)), '# Notes\n');
  assert.equal(file.sha, await gitBlobSha('# Notes\n'));
  assert.equal(file.dirty, false);
  const index = parseIndex(github.read(INDEX_PATH));
  assert.deepEqual(index.files.map((f) => f.name).sort(), ['new 1', 'notes.md']);
  assert.equal(index.files.find((f) => f.id === a).project, 'Platform');
  assert.equal(github.read('README.md'), '# data\n', 'other files untouched');
  assert.equal(result.commit, github.head());

  // Nothing changed: no commit.
  const again = await pc.sync();
  assert.equal(again.commit, null);
  assert.equal(github.log.length, commitsBefore + 1);
});

test('another device downloads new files and edits', async () => {
  const { client } = setup();
  const pc = device('Work PC', client);
  const phone = device('Phone', client);
  const id = pc.create('todo.txt', 'one');
  await pc.sync();
  await phone.sync();
  assert.equal(phone.text(id), 'one');
  pc.edit(id, 'one\ntwo');
  await pc.sync();
  const result = await phone.sync();
  assert.equal(phone.text(id), 'one\ntwo');
  assert.equal(result.commit, null, 'pulling needs no commit');
});

test('both devices edit the same file: ours stays, theirs becomes a copy', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const phone = device('Phone', client);
  const id = pc.create('plan.md', 'v1');
  await pc.sync();
  await phone.sync();
  pc.edit(id, 'v2 from pc');
  phone.edit(id, 'v2 from phone');
  await pc.sync();
  const result = await phone.sync();
  assert.equal(result.conflicts.length, 1);
  assert.equal(phone.text(id), 'v2 from phone');
  const copy = phone.state.files.find((f) => f.id === result.conflicts[0].id);
  assert.match(copy.name, /^plan \(from Work PC, 2026-10-21 \d\d\.\d\d\)\.md$/);
  assert.equal(phone.text(copy.id), 'v2 from pc');
  assert.equal(github.read(contentPath(copy)), 'v2 from pc');
  await pc.sync();
  assert.equal(pc.text(id), 'v2 from phone');
  assert.equal(pc.text(copy.id), 'v2 from pc');
  assert.deepEqual(pc.live(), phone.live());
});

test('a rename on one device and an edit on another both survive', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const phone = device('Phone', client);
  const id = pc.create('draft.txt', 'hello');
  await pc.sync();
  await phone.sync();
  phone.patch(id, { name: 'final.md', tags: ['done'] });
  await phone.sync();
  pc.edit(id, 'hello world');
  await pc.sync();
  const file = pc.state.files.find((f) => f.id === id);
  assert.equal(file.name, 'final.md');
  assert.deepEqual(file.tags, ['done']);
  assert.equal(github.read(contentPath(file)), 'hello world');
  assert.equal(github.paths().filter((p) => p.includes(id)).length, 1, 'old path removed');
});

test('a file deleted elsewhere keeps unsynced edits as a new file', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const phone = device('Phone', client);
  const id = pc.create('scratch.txt', 'a');
  await pc.sync();
  await phone.sync();
  phone.remove(id);
  await phone.sync();
  assert.equal(github.paths().some((p) => p.includes(id)), false, 'content removed from the repo');
  pc.edit(id, 'a + important edits');
  const result = await pc.sync();
  assert.equal(result.conflicts[0].reason, 'deleted');
  const rescued = pc.byName('scratch.txt');
  assert.notEqual(rescued.id, id);
  assert.equal(pc.text(rescued.id), 'a + important edits');
  await phone.sync();
  assert.equal(phone.text(rescued.id), 'a + important edits');
});

test('deleting removes the content and leaves a tombstone', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const phone = device('Phone', client);
  const id = pc.create('old.txt', 'bye');
  await pc.sync();
  await phone.sync();
  pc.remove(id);
  await pc.sync();
  assert.equal(parseIndex(github.read(INDEX_PATH)).files.find((f) => f.id === id).deleted, true);
  await phone.sync();
  assert.deepEqual(phone.live(), []);
  assert.equal(phone.text(id), undefined);
});

test('retries when another device commits in between', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  pc.create('a.txt', 'A');
  github.hooks.beforeUpdateRef = () => github.commit({ 'tracker.json': serializeDocument([createItem({ title: 'From the tracker' })]) }, 'Tracker: sync');
  await pc.sync();
  assert.ok(github.read('tracker.json').includes('From the tracker'), "the other commit is kept");
  assert.equal(parseIndex(github.read(INDEX_PATH)).files.length, 1);
});

test('starts an empty repository and creates a missing branch', async () => {
  const empty = setup({ empty: true });
  const pc = device('Work PC', empty.client);
  pc.create('first.txt', 'hi');
  await pc.sync();
  assert.equal(parseIndex(empty.github.read(INDEX_PATH)).files[0].name, 'first.txt');

  const other = setup();
  const laptop = device('Laptop', other.client);
  laptop.create('x.txt', 'x');
  await laptop.sync({ branch: 'notes' });
  assert.ok(other.github.read(INDEX_PATH, 'notes'));
  assert.equal(other.github.read(INDEX_PATH), undefined, 'default branch untouched');
});

test('never overwrites an index it cannot read', async () => {
  const { github, client } = setup();
  github.commit({ [INDEX_PATH]: '{ broken' });
  const pc = device('Work PC', client);
  pc.create('a.txt', 'A');
  await assert.rejects(pc.sync(), /not valid JSON/);
  assert.equal(github.read(INDEX_PATH), '{ broken');
});

test('editing a tracker attachment updates the file and the tracker item in one commit', async () => {
  const { github, client } = setup();
  const item = createItem({ title: 'Proposal', type: 'doc', files: [{ path: 'files/p/proposal.md', name: 'proposal.md', sha: '', size: 2 }] });
  github.commit({ 'files/p/proposal.md': 'v1', 'tracker.json': serializeDocument([item]) });
  const sha = github.gitSha('v1');
  const pc = device('Work PC', client);
  const before = github.log.length;
  const result = await pc.sync({ repoEdits: [{ path: 'files/p/proposal.md', text: 'v1 + my notes', baseSha: sha }] });
  assert.equal(github.log.length, before + 1);
  assert.equal(github.read('files/p/proposal.md'), 'v1 + my notes');
  const saved = parseData(github.read('tracker.json')).items[0];
  assert.equal(saved.files[0].sha, await gitBlobSha('v1 + my notes'));
  assert.equal(saved.updatedBy, 'Work PC');
  assert.equal(result.repoResults[0].sha, saved.files[0].sha);

  // Changed elsewhere meanwhile (e.g. Claude sent a new version): ours becomes an editor file.
  github.commit({ 'files/p/proposal.md': 'v2 from Claude' });
  const conflict = await pc.sync({ repoEdits: [{ path: 'files/p/proposal.md', text: 'stale edit', baseSha: saved.files[0].sha }] });
  assert.equal(github.read('files/p/proposal.md'), 'v2 from Claude');
  assert.equal(conflict.repoResults[0].conflict, true);
  assert.equal(conflict.repoResults[0].text, 'v2 from Claude');
  const copy = pc.state.files.find((f) => f.id === conflict.repoResults[0].copyId);
  assert.equal(copy.name, 'proposal (your edits).md');
  assert.equal(pc.text(copy.id), 'stale edit');
});

test('tracker changes go into the same commit and keep the rest of tracker.json', async () => {
  const { github, client } = setup();
  github.commit({ 'tracker.json': serializeDocument([createItem({ title: 'Keep me' })], [], { future: 1 }) });
  const pc = device('Work PC', client);
  pc.create('a.txt', 'A', { project: 'Garden' });
  const before = github.log.length;
  const result = await pc.sync({
    trackerChange: ({ items, projects }) => ({ items: [...items, createItem({ title: 'Read a.txt', url: 'https://x/#/file/1' })], projects: [...projects, { key: 'garden', name: 'Garden', area: 'personal' }] }),
  });
  assert.equal(github.log.length, before + 1);
  const doc = parseData(github.read('tracker.json'));
  assert.deepEqual(doc.items.map((i) => i.title).sort(), ['Keep me', 'Read a.txt']);
  assert.equal(doc.projects[0].area, 'personal');
  assert.equal(doc.extra.future, 1);
  assert.equal(result.projects[0].name, 'Garden');
});

test('a device with no files makes no commit, and tracker-only changes are described', async () => {
  const { github, client } = setup();
  const pc = device('Work PC', client);
  const before = github.log.length;
  const result = await pc.sync();
  assert.equal(result.commit, null);
  assert.equal(github.log.length, before);
  assert.equal(github.read(INDEX_PATH), undefined);
  await pc.sync({ trackerChange: ({ items, projects }) => ({ items: [...items, createItem({ title: 'From the editor' })], projects }) });
  assert.equal(github.log.at(-1), 'Editor: sync from Work PC (tracker updated)');
});

test('encrypted files: ciphertext in the repo, plaintext on the devices', async () => {
  const { github, client } = setup();
  const { key } = await createVault('a passphrase', { iterations: 1000 });
  const hooks = {
    encode: async (file, text) => (file.encrypted ? seal(key, text) : text),
    decode: async (_file, text) => (isSealed(text) ? unseal(key, text) : text),
  };
  const a = device('Work PC', client);
  const b = device('Phone', client);
  const id = a.create('secret.md', 'the secret plan\n', { encrypted: true });
  a.create('plain.md', 'nothing to hide\n');
  await a.sync(hooks);
  const stored = github.read(contentPath(a.byName('secret.md')));
  assert.ok(isSealed(stored) && !stored.includes('secret plan'));
  assert.equal(github.read(contentPath(a.byName('plain.md'))), 'nothing to hide\n');
  const record = parseIndex(github.read(INDEX_PATH)).files.find((f) => f.id === id);
  assert.equal(record.encrypted, true);
  assert.equal(record.sha, await gitBlobSha(stored));

  await b.sync(hooks);
  assert.equal(b.text(id), 'the secret plan\n');
  // Without the key a device gets the ciphertext, to keep sealed.
  const c = device('Old laptop', client);
  await c.sync();
  assert.ok(isSealed(c.text(id)));

  // Both edit it: the copy of theirs is encrypted too.
  a.edit(id, 'plan v2 from work\n');
  b.edit(id, 'plan v2 from the phone\n');
  await a.sync(hooks);
  const result = await b.sync(hooks);
  assert.equal(result.conflicts.length, 1);
  const copy = b.state.files.find((f) => f.id === result.conflicts[0].id);
  assert.equal(copy.encrypted, true);
  assert.equal(b.text(copy.id), 'plan v2 from work\n');
  assert.ok(isSealed(github.read(contentPath(copy))));

  // Turning encryption off stores the text in the clear again.
  b.patch(id, { encrypted: false });
  b.edit(id, b.text(id));
  await b.sync(hooks);
  assert.equal(github.read(contentPath(b.byName('secret.md'))), 'plan v2 from the phone\n');
});
