// Git for folders on this computer, against a real repository made here (the tests need
// the git program, which CI and development machines have).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseStatus } from '../app/js/gitStatus.js';

const require = createRequire(import.meta.url);
const { createGit } = require('../electron/git.cjs');

test('a repository: its root, status, branch and a file at the last commit', async () => {
  // The long, real path, as git reports it (Windows' temporary folder may come as RUNNER~1).
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-test-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'app.js'), 'one\ntwo\n');
  writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  writeFileSync(path.join(dir, 'src', 'app.js'), 'one\nTWO\n');
  writeFileSync(path.join(dir, 'src', 'new file.md'), '# new\n');
  execFileSync('rm', [path.join(dir, 'gone.txt')]);

  const g = createGit({ parseStatus });
  assert.equal(await g.repoOf(path.join(dir, 'src')), dir);
  const s = await g.status(path.join(dir, 'src'));
  assert.equal(s.root, dir);
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.files, { 'src/app.js': 'M', 'gone.txt': 'D', 'src/new file.md': 'U' });
  const head = await g.headBytes(path.join(dir, 'src', 'app.js'));
  assert.equal(head.rel, 'src/app.js');
  assert.equal(head.bytes.toString(), 'one\ntwo\n');
  assert.equal(await g.headBytes(path.join(dir, 'src', 'new file.md')), null, 'not committed yet');
  // Outside a repository: nothing.
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'no-git-')));
  assert.equal(await g.status(plain), null);
  assert.equal(await g.headBytes(path.join(plain, 'a.txt')), null);
});

test('without the git program: null, and it is not asked again', async () => {
  let calls = 0;
  const g = createGit({
    parseStatus,
    runGit: async () => {
      calls++;
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(await g.status('/somewhere'), null);
  assert.equal(await g.status('/elsewhere'), null);
  assert.equal(calls, 1);
  assert.equal(g.missing, true);
});
