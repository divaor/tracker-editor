// Git with the model, the main process's side: what the model may look at (log, show, diff,
// a file at a commit or now, the reflog, the snapshot), the commands the panel has no button
// for (merge, rebase, reset, revert, delete a branch, .gitignore…), and the backups that make
// each of them undoable. Against real repositories made here (git is on CI and dev machines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as gitStatus from '../app/js/gitStatus.js';

const require = createRequire(import.meta.url);
const { createGit, safeRev, safeRange, cleanUrl } = require('../electron/git.cjs');

function repo() {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-model-')));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' };
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir], { env, stdio: 'pipe' });
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@example.org');
  // Windows' Git turns line endings into CRLF on checkout: the files stay as written here.
  git('config', 'core.autocrlf', 'false');
  git('remote', 'set-url', 'origin', remote);
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('push', '-q', '-u', 'origin', 'main');
  const g = createGit({ parseStatus: gitStatus.parseStatus, parse: gitStatus });
  return { base, dir, git, g };
}
const commit = async (g, dir, file, text, message) => {
  writeFileSync(path.join(dir, file), text);
  await g.act(dir, { op: 'stage-all' });
  await g.act(dir, { op: 'commit', message });
};

test('names the model may give: commits and ranges, never options, paths or commands', () => {
  for (const ok of ['HEAD', 'HEAD~2', 'main', 'origin/main', 'abc1234', 'stash@{1}', '@{u}', 'v1.0', 'feature/x', 'HEAD^']) assert.ok(safeRev(ok), ok);
  for (const bad of ['-f', '--all', 'a b', 'main:file', '$(rm)', 'a;b', '', 'a..b', 'x\ny']) assert.ok(!safeRev(bad), bad);
  assert.ok(safeRange('main..feature'));
  assert.ok(safeRange('main...origin/main'));
  assert.ok(!safeRange('main....x'));
  assert.ok(!safeRange('--all..x'));
  assert.equal(cleanUrl('https://me:ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(cleanUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

test('looking: the snapshot, log, show, diff, a file at a commit and as it is now, the reflog', async () => {
  const { dir, git, g } = repo();
  await commit(g, dir, 'b.txt', 'b\n', 'add b');
  git('remote', 'set-url', 'origin', 'https://me:token123@example.org/a/b.git');
  writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  const snap = await g.act(dir, { op: 'snapshot' });
  assert.equal(snap.status.branch, 'main');
  assert.equal(snap.status.ahead, 1);
  assert.deepEqual(snap.status.unstaged, { 'a.txt': 'M' });
  assert.match(snap.graph, /add b/);
  assert.match(snap.graph, /first/);
  assert.deepEqual(snap.remotes, ['origin https://example.org/a/b.git']);
  assert.ok(!JSON.stringify(snap).includes('token123'), 'no password goes to the model');
  assert.equal(snap.inProgress, null);
  assert.deepEqual(snap.identity, { name: true, email: true });
  assert.equal(snap.branches.local[0].name, 'main');
  assert.match(snap.reflog, /commit: add b/);

  assert.match(await g.act(dir, { op: 'log', count: 5 }), /\* \w+ .*add b · t,/);
  assert.match(await g.act(dir, { op: 'log', range: 'origin/main..main' }), /add b/);
  assert.doesNotMatch(await g.act(dir, { op: 'log', range: 'origin/main..main' }), /first/);
  assert.match(await g.act(dir, { op: 'show', rev: 'HEAD' }), /\+b/);
  assert.match(await g.act(dir, { op: 'diff' }), /-two\n\+TWO/);
  assert.equal(await g.act(dir, { op: 'diff', staged: true }), '(no differences)');
  assert.match(await g.act(dir, { op: 'diff', from: 'HEAD~1', to: 'HEAD', stat: true }), /b\.txt \| 1 \+/);
  assert.equal(await g.act(dir, { op: 'file-at', rev: 'HEAD~1', path: 'a.txt' }), 'one\ntwo\nthree\n');
  assert.equal(await g.act(dir, { op: 'read', path: 'a.txt' }), 'one\nTWO\nthree\n');
  // Nothing outside the repository, not even through a link.
  await assert.rejects(g.act(dir, { op: 'read', path: '../remote.git/HEAD' }));
  writeFileSync(path.join(dir, '..', 'outside.txt'), 'secret');
  symlinkSync(path.join(dir, '..', 'outside.txt'), path.join(dir, 'link.txt'));
  await assert.rejects(g.act(dir, { op: 'read', path: 'link.txt' }), /Not a file of this repository/);
  await assert.rejects(g.act(dir, { op: 'show', rev: '--output=/tmp/x' }), /Not a commit/);
  await assert.rejects(g.act(dir, { op: 'log', range: '--all' }), /Not a commit/);
});

test('a reset, backed up first, then undone: the commit and the changes not committed come back', async () => {
  const { dir, git, g } = repo();
  await commit(g, dir, 'b.txt', 'b\n', 'add b');
  writeFileSync(path.join(dir, 'a.txt'), 'work in progress\n');
  const head = git('rev-parse', 'HEAD').trim();
  const backup = await g.act(dir, { op: 'backup', label: 'git reset --hard HEAD~1' });
  assert.equal(backup.head, head);
  assert.equal(backup.branch, 'main');
  assert.ok(backup.changes, 'the changes not committed are kept');
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'work in progress\n', 'backing up touches no file');
  await g.act(dir, { op: 'reset', mode: 'hard', rev: 'HEAD~1' });
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  assert.notEqual(git('rev-parse', 'HEAD').trim(), head);
  // The backup's commit survives Git's clean-up.
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '-q', '--prune=now');
  const undone = await g.act(dir, { op: 'undo', id: backup.id });
  assert.doesNotMatch((await g.act(dir, { op: 'snapshot' })).graph, /Tracker Editor backup/, 'the backups stay out of the graph');
  assert.doesNotMatch(await g.act(dir, { op: 'log', all: true }), /Tracker Editor backup/);
  assert.equal(git('rev-parse', 'HEAD').trim(), head);
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'work in progress\n');
  assert.equal(readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\n');
  // The undo is itself backed up.
  const list = await g.act(dir, { op: 'backups' });
  assert.equal(list[0].id, undone.backup.id);
  assert.match(list[0].label, /before undoing/);
  await assert.rejects(g.act(dir, { op: 'undo', id: 'nope' }), /That backup is gone/);
});

test('a deleted branch comes back with its backup; a rebase halfway is aborted by the undo', async () => {
  const { dir, git, g } = repo();
  await g.act(dir, { op: 'switch', name: 'topic', create: true });
  await commit(g, dir, 'a.txt', 'topic\n', 'topic change');
  const topic = git('rev-parse', 'HEAD').trim();
  await g.act(dir, { op: 'switch', name: 'main' });
  await commit(g, dir, 'a.txt', 'main\n', 'main change');
  // Delete the unmerged branch: refused without force, done with it.
  await assert.rejects(g.act(dir, { op: 'delete-branch', name: 'topic' }));
  const b1 = await g.act(dir, { op: 'backup', label: 'delete topic', keep: ['topic'] });
  await g.act(dir, { op: 'delete-branch', name: 'topic', force: true });
  assert.equal(git('branch', '--list', 'topic').trim(), '');
  // Its commit is kept by our ref even when Git cleans up; the undo makes the branch again.
  git('reflog', 'expire', '--expire=now', '--all');
  git('gc', '-q', '--prune=now');
  await g.act(dir, { op: 'undo', id: b1.id });
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.equal(git('rev-parse', 'topic').trim(), topic);
  // A rebase that conflicts: halfway, then the undo aborts it and goes back.
  await g.act(dir, { op: 'switch', name: 'topic' });
  const b2 = await g.act(dir, { op: 'backup', label: 'rebase on main' });
  const failed = await g.act(dir, { op: 'rebase', onto: 'main' }).catch((err) => err);
  assert.equal(gitStatus.gitError(failed.stderr, failed.stdout).kind, 'conflict');
  assert.equal(await g.act(dir, { op: 'in-progress' }), 'rebase');
  assert.equal((await g.act(dir, { op: 'snapshot' })).inProgress, 'rebase');
  await g.act(dir, { op: 'undo', id: b2.id });
  assert.equal(await g.act(dir, { op: 'in-progress' }), null);
  assert.equal(git('rev-parse', 'HEAD').trim(), topic);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'topic');
});

test('merge, revert, cherry-pick, rename and tag; restore throws changes away', async () => {
  const { dir, git, g } = repo();
  await g.act(dir, { op: 'switch', name: 'feature', create: true });
  await commit(g, dir, 'f.txt', 'f\n', 'feature file');
  const feature = git('rev-parse', '--short', 'HEAD').trim();
  await g.act(dir, { op: 'switch', name: 'main' });
  await g.act(dir, { op: 'merge', rev: 'feature', how: 'no-ff' });
  assert.match(git('log', '-1', '--format=%s'), /Merge branch 'feature'/);
  await g.act(dir, { op: 'revert', rev: 'HEAD~1' }).catch(() => g.act(dir, { op: 'revert', rev: feature }));
  await g.act(dir, { op: 'switch', name: 'other', create: true, from: 'origin/main' }).catch(async () => {
    await g.act(dir, { op: 'switch', name: 'other', create: true });
  });
  await g.act(dir, { op: 'reset', mode: 'hard', rev: 'origin/main' });
  await g.act(dir, { op: 'cherry-pick', rev: feature });
  assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'f\n');
  await g.act(dir, { op: 'rename-branch', to: 'picked' });
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'picked');
  await g.act(dir, { op: 'tag', name: 'v1', message: 'first tag' });
  assert.equal(git('tag', '-l', '-n1', 'v1').trim().replace(/\s+/g, ' '), 'v1 first tag');
  writeFileSync(path.join(dir, 'f.txt'), 'scribbles\n');
  await g.act(dir, { op: 'restore', paths: ['f.txt'] });
  assert.equal(readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'f\n');
  await assert.rejects(g.act(dir, { op: 'restore', paths: ['../x'] }));
  await assert.rejects(g.act(dir, { op: 'reset', mode: 'keep', rev: 'HEAD' }), /Not a reset/);
});

test('.gitignore: lines added once, the file’s line endings kept; untrack leaves the file on disk', async () => {
  const { dir, git, g } = repo();
  await commit(g, dir, 'debug.log', 'noise\n', 'oops, a log');
  const first = await g.act(dir, { op: 'ignore', patterns: ['*.log', 'node_modules/', 'bad\nline'] });
  assert.deepEqual(first, { added: ['*.log', 'node_modules/'], already: 0 });
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.log\nnode_modules/\n');
  writeFileSync(path.join(dir, '.gitignore'), 'dist\r\n*.log');
  assert.deepEqual(await g.act(dir, { op: 'ignore', patterns: ['*.log', '.env'] }), { added: ['.env'], already: 1 });
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'dist\r\n*.log\r\n.env\r\n');
  await g.act(dir, { op: 'untrack', paths: ['debug.log'] });
  assert.equal(readFileSync(path.join(dir, 'debug.log'), 'utf8'), 'noise\n');
  assert.equal((await g.status(dir)).staged['debug.log'], 'D');
});

test('force push only with a lease: refused when the remote moved on unseen', async () => {
  const { dir, base, git, g } = repo();
  await commit(g, dir, 'b.txt', 'b\n', 'b');
  await g.act(dir, { op: 'push' });
  await g.act(dir, { op: 'reset', mode: 'soft', rev: 'HEAD~1' });
  await g.act(dir, { op: 'commit', message: 'b, again' });
  await assert.rejects(g.act(dir, { op: 'push' }));
  await g.act(dir, { op: 'push', force: true });
  assert.equal(git('rev-parse', 'HEAD').trim(), git('rev-parse', 'origin/main').trim());
  // Someone else pushes; we rewrite without fetching: the lease refuses.
  const other = path.join(base, 'other');
  execFileSync('git', ['clone', '-q', path.join(base, 'remote.git'), other], { stdio: 'pipe' });
  const at = (...args) => execFileSync('git', args, { cwd: other, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'o', GIT_AUTHOR_EMAIL: 'o@x', GIT_COMMITTER_NAME: 'o', GIT_COMMITTER_EMAIL: 'o@x' } });
  writeFileSync(path.join(other, 'o.txt'), 'o\n');
  at('add', '.');
  at('commit', '-q', '-m', 'theirs');
  at('push', '-q');
  await g.act(dir, { op: 'commit', message: 'empty?', amend: true });
  await assert.rejects(g.act(dir, { op: 'push', force: true }));
});

test('work moved off main: a new branch takes the commits, main goes back, a range is copied, nothing tracks dev by mistake', async () => {
  const { dir, git, g } = repo();
  // Two commits on main by mistake, and an edit not committed.
  await commit(g, dir, 'a.txt', 'one\ntwo\nthree\nfour\n', 'four');
  await commit(g, dir, 'b.txt', 'b\n', 'add b');
  writeFileSync(path.join(dir, 'c.txt'), 'not committed\n');
  const tip = git('rev-parse', 'HEAD').trim();
  await g.act(dir, { op: 'switch', name: 'feature/work', create: true });
  const b = await g.act(dir, { op: 'backup', label: 'git branch -f main origin/main', keep: ['main'] });
  await g.act(dir, { op: 'move-branch', name: 'main', to: 'origin/main' });
  assert.equal(git('rev-parse', 'main').trim(), git('rev-parse', 'origin/main').trim(), 'main is as it was');
  assert.equal(git('rev-parse', 'HEAD').trim(), tip, 'the branch has the commits');
  assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'not committed\n', 'and the change not committed');
  // The branch checked out cannot be moved this way (Git refuses).
  await assert.rejects(g.act(dir, { op: 'move-branch', name: 'feature/work', to: 'main' }));
  // Undo puts main back on the commits.
  await g.act(dir, { op: 'undo', id: b.id });
  assert.equal(git('rev-parse', 'main').trim(), git('rev-parse', 'feature/work').trim());
  await g.act(dir, { op: 'move-branch', name: 'main', to: 'origin/main' });
  // The same commits onto an existing branch: a range.
  await g.act(dir, { op: 'stash', untracked: true });
  git('branch', 'dev', 'origin/main');
  await g.act(dir, { op: 'switch', name: 'dev' });
  await g.act(dir, { op: 'cherry-pick', rev: 'main..feature/work' });
  assert.deepEqual(git('log', '--format=%s', '-2').trim().split('\n'), ['add b', 'four']);
  // A branch from a remote one does not follow it: its first push makes its own.
  await g.act(dir, { op: 'push' }).catch(() => {});
  await g.act(dir, { op: 'fetch' });
  await g.act(dir, { op: 'switch', name: 'feature/next', create: true, from: 'origin/main' });
  assert.throws(() => git('rev-parse', '--abbrev-ref', '@{u}'), 'no upstream yet');
  await commit(g, dir, 'n.txt', 'n\n', 'next');
  await g.act(dir, { op: 'push' });
  assert.equal(git('rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feature/next');
  assert.notEqual(git('rev-parse', 'origin/main').trim(), git('rev-parse', 'HEAD').trim(), 'main on the remote untouched');
});

test('a merge reverted (pushed): the side merged in is undone with a new commit', async () => {
  const { dir, git, g } = repo();
  await g.act(dir, { op: 'switch', name: 'feature', create: true });
  await commit(g, dir, 'f.txt', 'f\n', 'feature');
  await g.act(dir, { op: 'switch', name: 'main' });
  await commit(g, dir, 'm.txt', 'm\n', 'main moves on');
  await g.act(dir, { op: 'merge', rev: 'feature', how: 'no-ff' });
  await assert.rejects(g.act(dir, { op: 'revert', rev: 'HEAD' }), 'a merge needs its side');
  await g.act(dir, { op: 'abort', what: 'revert' }).catch(() => {});
  await g.act(dir, { op: 'revert', rev: 'HEAD', mainline: 1 });
  assert.equal(existsSync(path.join(dir, 'f.txt')), false);
  assert.equal(existsSync(path.join(dir, 'm.txt')), true);
  assert.match(git('log', '-1', '--format=%s'), /^Revert "Merge branch 'feature'"/);
});
