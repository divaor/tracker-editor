import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGitHub } from './helpers/fake-github.js';
import { createGitHubClient } from '../app/js/github.js';
import { describeCommit, fileVersions } from '../app/js/versions.js';

test('reads who made a version from the commit message', () => {
  assert.deepEqual(describeCommit('Editor: sync from Work PC (1 updated, 1 renamed)'), { who: 'Work PC', what: 'Editor: sync from Work PC (1 updated, 1 renamed)' });
  assert.deepEqual(describeCommit('Editor: sync from Phone'), { who: 'Phone', what: 'Editor: sync from Phone' });
  assert.equal(describeCommit('Tracker: update proposal.md (from Laptop)\n\nmore').who, 'Laptop');
  assert.equal(describeCommit('Claude: save notes.md').who, 'Claude');
  assert.equal(describeCommit('Initial commit').who, '');
});

test('lists the versions of an editor file, through renames, and of any repo file', async () => {
  const github = createFakeGitHub();
  const client = createGitHubClient({ token: 'good-token', owner: 'me', repo: 'data', fetchImpl: github.fetch });
  github.commit({ 'editor/files/f1/notes.txt': 'v1' }, 'Editor: sync from Work PC (1 added)');
  github.commit({ 'editor/files/other/x.txt': 'unrelated' }, 'Editor: sync from Phone (1 added)');
  github.commit({ 'editor/files/f1/notes.txt': 'v2' }, 'Editor: sync from Phone (1 updated)');
  github.commit({ 'editor/files/f1/notes.txt': null, 'editor/files/f1/plan.md': 'v3' }, 'Editor: sync from Work PC (1 updated, 1 renamed)');
  github.commit({ 'editor/files/f1/plan.md': null }, 'Editor: sync from Work PC (1 deleted)');
  const versions = await fileVersions(client, { id: 'f1' });
  assert.deepEqual(versions.map((v) => v.who), ['Work PC', 'Work PC', 'Phone', 'Work PC']);
  assert.ok(versions[0].date > versions[1].date);
  assert.deepEqual(await Promise.all(versions.map((v) => v.load())), [null, { text: 'v3', name: 'plan.md' }, { text: 'v2', name: 'notes.txt' }, { text: 'v1', name: 'notes.txt' }]);

  github.commit({ 'files/p1/proposal.md': '# v1' }, 'Tracker: add proposal.md (from Claude)');
  github.commit({ 'files/p1/proposal.md': '# v2' }, 'Tracker: update proposal.md (from Laptop)');
  const repo = await fileVersions(client, { path: 'files/p1/proposal.md' });
  assert.deepEqual(repo.map((v) => v.who), ['Laptop', 'Claude']);
  assert.deepEqual(await repo[1].load(), { text: '# v1', name: 'proposal.md' });
});

test('a copy of an old version is named after its date', async () => {
  const { versionName } = await import('../app/js/versions.js');
  const iso = new Date(2026, 9, 21, 14, 3).toISOString();
  assert.equal(versionName('plan.md', iso), 'plan (2026-10-21 14.03).md');
  assert.equal(versionName('new 1', iso), 'new 1 (2026-10-21 14.03)');
  assert.equal(versionName('x.txt', 'garbage'), 'x (old version).txt');
});
