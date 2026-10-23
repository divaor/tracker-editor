// The data repo on this device (localRepo.js): GitHub's calls over a small git-like
// store, the editor's sync running against it, history, two writers, tidying up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, createLocalRepo, memoryBackend } from '../app/js/localRepo.js';
import { gitBlobSha, parseIndex, INDEX_PATH, createFile } from '../app/js/model.js';
import { syncOnce } from '../app/js/sync.js';
import { parseData } from '../app/js/tracker-model.js';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const tick = () => new Date((clock += 1000)).toISOString();

test('blob shas are git’s, the same as GitHub’s', async () => {
  assert.equal(await blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(await blobSha('héllo'), await gitBlobSha('héllo'));
});

test('files: write, read, conditions as GitHub sets them, folders, history', async () => {
  const repo = createLocalRepo(memoryBackend(), { now: tick });
  assert.equal(await repo.getBranchHead('main'), null);
  assert.equal(await repo.getFile('tracker.json'), null);
  const a = await repo.putFile('tracker.json', { text: '{"items":[]}', message: 'start' });
  assert.equal(a.sha, await blobSha('{"items":[]}'));
  assert.deepEqual(await repo.getFile('tracker.json'), { sha: a.sha, text: '{"items":[]}' });
  // Writing without the current sha, or with an old one, is refused as GitHub does.
  await assert.rejects(repo.putFile('tracker.json', { text: 'x', message: 'm' }), (e) => e.status === 422);
  await assert.rejects(repo.putFile('tracker.json', { text: 'x', sha: 'f'.repeat(40), message: 'm' }), (e) => e.status === 409);
  const b = await repo.putFile('tracker.json', { text: '{"items":[1]}', sha: a.sha, message: 'second' });
  await repo.putFile('files/doc/plan.md', { text: '# Plan', message: 'doc' });
  assert.equal((await repo.getFile('tracker.json')).text, '{"items":[1]}');
  // At an earlier commit, the earlier text.
  assert.equal((await repo.getFile('tracker.json', a.commit)).text, '{"items":[]}');
  await assert.rejects(repo.getFile('files'), (e) => e.status === 400);
  assert.deepEqual(await repo.listDir('files'), [{ name: 'doc', path: 'files/doc', sha: '', type: 'dir' }]);
  assert.deepEqual((await repo.listDir('files/doc')).map((e) => e.name), ['plan.md']);
  assert.equal(await repo.listDir('nothing'), null);
  // History of a file: the commits that changed it, newest first.
  const history = await repo.listCommits({ path: 'tracker.json' });
  assert.deepEqual(history.map((c) => c.message), ['second', 'start']);
  assert.equal(history[0].sha, b.commit);
  assert.deepEqual((await repo.listCommits({ path: 'files/doc' })).map((c) => c.message), ['doc']);
  assert.deepEqual((await repo.listTree()).map((e) => e.path).sort(), ['files/doc/plan.md', 'tracker.json']);
  await repo.deleteFile('files/doc/plan.md', { sha: await blobSha('# Plan'), message: 'gone' });
  assert.equal(await repo.getFile('files/doc/plan.md'), null);
  assert.equal((await repo.getRepo()).default_branch, 'main');
});

test('the editor’s sync runs against it: files, tracker.json, a second device, a race', async () => {
  const backend = memoryBackend();
  const repo = createLocalRepo(backend, { now: tick });
  const file = { ...createFile({ name: 'notes.md', updatedBy: 'pc' }, tick()), baseSha: '', dirty: true };
  const first = await syncOnce({
    client: repo,
    files: [file],
    texts: new Map([[file.id, 'hello']]),
    device: 'pc',
    now: tick,
    trackerChange: ({ items, projects }) => ({ items, projects: [...projects, { key: 'alpha', name: 'Alpha', area: 'work', color: '#123456', createdAt: tick(), updatedAt: tick(), updatedBy: 'pc' }] }),
  });
  assert.ok(first.commit);
  const index = parseIndex((await repo.getFile(INDEX_PATH)).text);
  assert.equal(index.files[0].name, 'notes.md');
  assert.equal(parseData((await repo.getFile('tracker.json')).text).projects[0].name, 'Alpha');
  // Another app on the same store sees the file and its text.
  const other = createLocalRepo(backend, { now: tick });
  const second = await syncOnce({ client: other, files: [], device: 'tracker', now: tick });
  assert.equal(second.files.length, 1);
  assert.equal(second.texts.get(file.id), 'hello');
  // A race: the branch moved between reading and writing; updateBranch says 422 and sync tries again.
  const tip = await repo.getBranchHead('main');
  const tree = await repo.createTree(await repo.getCommitTree(tip), [{ path: 'x.txt', content: 'x' }]);
  const stale = await repo.createCommit('stale', tree, [tip]);
  await repo.putFile('y.txt', { text: 'y', message: 'meanwhile' });
  await assert.rejects(repo.updateBranch('main', stale), (e) => e.status === 422);
  const edited = second.files.map((f) => ({ ...f, dirty: true, modifiedAt: tick() }));
  const third = await syncOnce({ client: other, files: edited, texts: new Map([[file.id, 'hello again']]), device: 'tracker', now: tick });
  assert.ok(third.commit);
  assert.equal((await repo.getFile(`editor/files/${file.id}/notes.md`)).text, 'hello again');
  assert.equal((await repo.getFile('y.txt')).text, 'y', 'the other write stays');
});

test('two writers at once: both land, one after the other', async () => {
  const backend = memoryBackend();
  const one = createLocalRepo(backend, { now: tick });
  const two = createLocalRepo(backend, { now: tick });
  await one.putFile('a.txt', { text: '0', message: 'start' });
  await Promise.all([one.putFile('b.txt', { text: 'b', message: 'b' }), two.putFile('c.txt', { text: 'c', message: 'c' })]);
  assert.deepEqual((await one.listTree()).map((e) => e.path).sort(), ['a.txt', 'b.txt', 'c.txt']);
});

test('many versions read back through their changes; old ones are tidied away', async () => {
  const backend = memoryBackend();
  const repo = createLocalRepo(backend, { now: tick });
  let sha;
  for (let i = 0; i < 150; i++) sha = (await repo.putFile('n.txt', { text: `v${i}`, sha, message: `v${i}` })).sha;
  // A fresh reader (no cache) follows the chain of changes, with full trees on the way.
  const fresh = createLocalRepo(backend, { now: tick });
  assert.equal((await fresh.getFile('n.txt')).text, 'v149');
  let full = 0;
  for (const { key } of await backend.list('tree/')) if (JSON.parse(await backend.get(key)).full) full++;
  assert.ok(full >= 3, `full trees: ${full}`); // the first, then one every 64 changes
  // Tidying: versions older than the cut go, the last one before it stays as the first.
  const history = await repo.listCommits({ path: 'n.txt', perPage: 200 });
  assert.equal(history.length, 150);
  const cutAt = Date.parse(history[50].date);
  const later = cutAt + 180 * 86400000 + 500;
  // Everything was written "long ago" for the grace period.
  for (const entry of backend.map.values()) entry.time = 0;
  const { removed } = await repo.prune({ nowMs: later });
  assert.ok(removed > 0);
  const kept = await fresh.listCommits({ path: 'n.txt', perPage: 200 });
  assert.ok(kept.length <= 51 && kept.length >= 49, String(kept.length));
  assert.equal((await fresh.getFile('n.txt')).text, 'v149');
  assert.equal((await createLocalRepo(backend).getFile('n.txt', kept.at(-1).sha)).text, kept.at(-1).message);
  assert.equal(await backend.get(`blob/${await blobSha('v0')}`), null, 'old texts are gone');
  assert.ok((await repo.getMeta()).prunedAt);
});

test('notes on the store: where the data went', async () => {
  const repo = createLocalRepo(memoryBackend());
  assert.deepEqual(await repo.getMeta(), {});
  await repo.setMeta({ movedTo: { owner: 'me', repo: 'data' } });
  await repo.setMeta({ prunedAt: 'x' });
  assert.deepEqual(await repo.getMeta(), { movedTo: { owner: 'me', repo: 'data' }, prunedAt: 'x' });
});
