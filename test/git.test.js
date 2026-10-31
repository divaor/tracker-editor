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

// A repository with a remote (a bare one here), as the Git panel uses them.
function repoWithRemote() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-write-')));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' };
  const at = (dir) => (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir], { env, stdio: 'pipe' });
  const git = at(dir);
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.org');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('push', '-q', '-u', 'origin', 'main');
  return { base, dir, remote, git, at, env };
}

test('stage, unstage, commit and amend', async () => {
  const { dir, git } = repoWithRemote();
  const g = createGit({ parseStatus, parse: await import('../app/js/gitStatus.js') });
  writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  await g.act(dir, { op: 'stage', paths: ['a.txt'] });
  let s = await g.status(dir);
  assert.deepEqual(s.staged, { 'a.txt': 'M' });
  assert.deepEqual(s.unstaged, { 'b.txt': 'U' });
  await g.act(dir, { op: 'stage-all' });
  assert.deepEqual((await g.status(dir)).staged, { 'a.txt': 'M', 'b.txt': 'A' });
  await g.act(dir, { op: 'unstage', paths: ['b.txt'] });
  assert.deepEqual((await g.status(dir)).staged, { 'a.txt': 'M' });
  await assert.rejects(g.act(dir, { op: 'stage', paths: ['../outside.txt'] }), /Not files/);
  await assert.rejects(g.act(dir, { op: 'commit', message: '  ' }), (err) => /empty commit message/.test(err.stderr));
  await g.act(dir, { op: 'commit', message: 'Second\n\nWith a body' });
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Second');
  assert.equal(await g.act(dir, { op: 'last-message' }), 'Second\n\nWith a body');
  await g.act(dir, { op: 'stage-all' });
  await g.act(dir, { op: 'commit', message: 'Second, with b', amend: true });
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Second, with b');
  // Amending without a message keeps the one it had.
  await g.act(dir, { op: 'commit', message: '', amend: true });
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Second, with b');
  const nothing = await g.act(dir, { op: 'commit', message: 'Empty' }).catch((err) => err);
  assert.match(`${nothing.stdout}${nothing.stderr}`, /nothing to commit/);
});

test('one change of a file staged: its text in the index, the file left as it is', async () => {
  const { dir } = repoWithRemote();
  const { stageBlock } = await import('../app/js/gitStatus.js');
  const g = createGit({ parseStatus });
  const file = path.join(dir, 'a.txt');
  writeFileSync(file, 'one\nTWO\nthree\nfour\n');
  const index = (await g.indexBytes(file)).bytes.toString();
  const now = 'one\nTWO\nthree\nfour\n';
  const staged = stageBlock(index, now, 2);
  assert.equal(staged, 'one\nTWO\nthree\n');
  await g.setIndexBytes(file, Buffer.from(staged));
  assert.equal((await g.indexBytes(file)).bytes.toString(), 'one\nTWO\nthree\n');
  const s = await g.status(dir);
  assert.equal(s.staged['a.txt'], 'M');
  assert.equal(s.unstaged['a.txt'], 'M', 'line 4 is still a change not staged');
});

test('branches: list, create, switch, and a remote one followed', async () => {
  const { dir, at, base, remote, env } = repoWithRemote();
  const g = createGit({ parseStatus, parse: await import('../app/js/gitStatus.js') });
  // Someone else pushes a branch.
  const other = path.join(base, 'other');
  execFileSync('git', ['clone', '-q', remote, other], { env, stdio: 'pipe' });
  at(other)('switch', '-q', '-c', 'feature/login');
  writeFileSync(path.join(other, 'login.txt'), 'x\n');
  at(other)('add', '.');
  at(other)('commit', '-q', '-m', 'login');
  at(other)('push', '-q', '-u', 'origin', 'feature/login');
  await g.act(dir, { op: 'fetch' });
  const branches = await g.act(dir, { op: 'branches' });
  assert.deepEqual(branches.local.map((b) => [b.name, b.current, b.upstream]), [['main', true, 'origin/main']]);
  assert.deepEqual(branches.remote.map((b) => b.name).sort(), ['origin/feature/login', 'origin/main']);
  await g.act(dir, { op: 'switch', name: 'origin/feature/login', track: true });
  assert.equal(await g.branch(dir), 'feature/login');
  await g.act(dir, { op: 'switch', name: 'fix/typo', create: true, from: 'main' });
  assert.equal(await g.branch(dir), 'fix/typo');
  await assert.rejects(g.act(dir, { op: 'switch', name: '--orphan' }), /Not a branch name/);
  await assert.rejects(g.act(dir, { op: 'switch', name: 'bad name', create: true }), /Not a branch name/);
});

test('stash: put changes aside, list them, bring them back', async () => {
  const { dir } = repoWithRemote();
  const g = createGit({ parseStatus, parse: await import('../app/js/gitStatus.js') });
  writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  await g.act(dir, { op: 'stash', message: 'half done', untracked: true });
  assert.deepEqual((await g.status(dir)).files, {});
  const list = await g.act(dir, { op: 'stashes' });
  assert.equal(list.length, 1);
  assert.equal(list[0].ref, 'stash@{0}');
  assert.equal(list[0].message, 'half done');
  await g.act(dir, { op: 'stash-pop', ref: 'stash@{0}' });
  assert.deepEqual((await g.status(dir)).files, { 'a.txt': 'M', 'new.txt': 'U' });
  assert.equal((await g.act(dir, { op: 'stashes' })).length, 0);
  await assert.rejects(g.act(dir, { op: 'stash-drop', ref: 'HEAD' }), /Not a stash/);
});

test('push, fetch and pull with a remote: first push sets the upstream, a diverged pull says so', async () => {
  const { dir, git, at, base, remote, env } = repoWithRemote();
  const g = createGit({ parseStatus, parse: await import('../app/js/gitStatus.js') });
  // A new branch's first push: to origin, followed from then on.
  await g.act(dir, { op: 'switch', name: 'topic', create: true });
  writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  await g.act(dir, { op: 'stage-all' });
  await g.act(dir, { op: 'commit', message: 'c' });
  const lines = [];
  await g.act(dir, { op: 'push' }, { onProgress: (l) => lines.push(l) });
  assert.equal(git('rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/topic');
  assert.ok(lines.length > 0, 'progress lines came');
  // Someone else pushes to main; we commit on main too: a pull that cannot just move forward.
  await g.act(dir, { op: 'switch', name: 'main' });
  const other = path.join(base, 'other');
  execFileSync('git', ['clone', '-q', remote, other], { env, stdio: 'pipe' });
  writeFileSync(path.join(other, 'a.txt'), 'theirs\ntwo\nthree\n');
  at(other)('commit', '-q', '-am', 'theirs');
  at(other)('push', '-q');
  writeFileSync(path.join(dir, 'd.txt'), 'd\n');
  await g.act(dir, { op: 'stage-all' });
  await g.act(dir, { op: 'commit', message: 'ours' });
  await g.act(dir, { op: 'fetch' });
  assert.deepEqual([(await g.status(dir)).ahead, (await g.status(dir)).behind], [1, 1]);
  const { gitError } = await import('../app/js/gitStatus.js');
  const ff = await g.act(dir, { op: 'pull' }).catch((err) => err);
  assert.equal(gitError(ff.stderr, ff.stdout).kind, 'diverged');
  const pushed = await g.act(dir, { op: 'push' }).catch((err) => err);
  assert.equal(gitError(pushed.stderr, pushed.stdout).kind, 'rejected');
  await g.act(dir, { op: 'pull', how: 'rebase' });
  assert.deepEqual([(await g.status(dir)).ahead, (await g.status(dir)).behind], [1, 0]);
  await g.act(dir, { op: 'push' });
  assert.equal(await g.act(dir, { op: 'in-progress' }), null);
});

test('a pull that conflicts: in progress, then aborted', async () => {
  const { dir, at, base, remote, env } = repoWithRemote();
  const g = createGit({ parseStatus, parse: await import('../app/js/gitStatus.js') });
  const other = path.join(base, 'other');
  execFileSync('git', ['clone', '-q', remote, other], { env, stdio: 'pipe' });
  writeFileSync(path.join(other, 'a.txt'), 'THEIRS\n');
  at(other)('commit', '-q', '-am', 'theirs');
  at(other)('push', '-q');
  writeFileSync(path.join(dir, 'a.txt'), 'OURS\n');
  await g.act(dir, { op: 'stage-all' });
  await g.act(dir, { op: 'commit', message: 'ours' });
  const failed = await g.act(dir, { op: 'pull', how: 'merge' }).catch((err) => err);
  const { gitError } = await import('../app/js/gitStatus.js');
  assert.equal(gitError(failed.stderr, failed.stdout).kind, 'conflict');
  assert.equal((await g.status(dir)).files['a.txt'], 'C');
  assert.equal(await g.act(dir, { op: 'in-progress' }), 'merge');
  await g.act(dir, { op: 'abort', what: 'merge' });
  assert.equal(await g.act(dir, { op: 'in-progress' }), null);
  assert.deepEqual((await g.status(dir)).files, {});
});
