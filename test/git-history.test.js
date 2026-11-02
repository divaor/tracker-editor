// The history view's side in the main process (git.cjs act: history, commit-info, file-text,
// changed-since, branch-at) and its parsers (gitStatus.js parseRefs, parseHistory), against real
// repositories made here: branches, a merge, tags and a remote's branch as each commit's refs;
// pages that join up to the whole list; one branch; words in the message and an author; a folder
// (parents rewritten, so the graph still joins up) and a file followed through a rename; HEAD on
// no branch; no commit yet; our backups and the stash never named. Then over the SSH stand-in
// (test/helpers/ssh-server.cjs), where git runs through the shell runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as gitStatus from '../app/js/gitStatus.js';
import { graphRows } from '../app/js/gitGraph.js';

const require = createRequire(import.meta.url);
const { createGit, shellRunner } = require('../electron/git.cjs');

const IDENTITY = { GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@example.org', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@example.org' };
const tmp = (name) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), name)));

/**
 * A repository with a remote: main (first, "Fix the login page" by Bob, the merge), feature
 * (two commits, merged with --no-ff), tags v1 (annotated, on the merge) and light (on Bob's),
 * main pushed (origin/main on the merge). Times one minute apart, so the order is known.
 */
function repo() {
  const base = tmp('git-history-');
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'pipe' });
  let tick = 1_700_000_000;
  const git = (...args) => {
    tick += 60;
    const when = `${tick} +0000`;
    return execFileSync('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when }, encoding: 'utf8', stdio: 'pipe' });
  };
  git('config', 'user.name', 'Ann');
  git('config', 'user.email', 'ann@example.org');
  git('config', 'core.autocrlf', 'false');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('a.txt', 'one\ntwo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('switch', '-q', '-c', 'feature');
  write('src/f.js', 'export const f = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Add f');
  write('src/f.js', 'export const f = 2;\n');
  git('commit', '-q', '-am', 'Change f');
  git('switch', '-q', 'main');
  write('a.txt', 'one\nTWO\n');
  execFileSync('git', ['commit', '-q', '-am', 'Fix the login page'], { cwd: dir, env: { ...process.env, ...IDENTITY, GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.org', GIT_AUTHOR_DATE: `${(tick += 60)} +0000`, GIT_COMMITTER_DATE: `${tick} +0000` }, stdio: 'pipe' });
  git('tag', 'light');
  git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  git('tag', '-a', '-m', 'Version one', 'v1');
  git('push', '-q', '-u', 'origin', 'main');
  const g = createGit({ parseStatus: gitStatus.parseStatus, parse: gitStatus });
  const hash = (rev) => git('rev-parse', rev).trim();
  return { base, dir, git, write, g, hash };
}

test('parseRefs: the branch checked out first, then branches, remote branches, tags; a remote’s HEAD left out', () => {
  assert.deepEqual(gitStatus.parseRefs('tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, HEAD -> refs/heads/main, refs/heads/dev'), [
    { kind: 'head', name: 'main' },
    { kind: 'branch', name: 'dev' },
    { kind: 'remote', name: 'origin/main' },
    { kind: 'tag', name: 'v1' },
  ]);
  assert.deepEqual(gitStatus.parseRefs('HEAD, refs/heads/feature/x'), [
    { kind: 'detached', name: 'HEAD' },
    { kind: 'branch', name: 'feature/x' },
  ]);
  assert.deepEqual(gitStatus.parseRefs(''), []);
});

test('parseHistory: fields, a subject holding the separator, a file’s name then (renames, quoted names); junk skipped', () => {
  const rec = (fields, extra = '') => `\x1e${fields.join('\x1f')}\n${extra}`;
  const out = [
    rec(['a'.repeat(40), `${'b'.repeat(40)} ${'c'.repeat(40)}`, 'Ann', 'ann@x', '1700000000', 'Cy', '1700000060', 'HEAD -> refs/heads/main', 'Merge x\x1fy']),
    rec(['b'.repeat(40), '', 'Bob', 'bob@x', '1700000001', 'Bob', '1700000002', '', 'first'], '\nR087\told name.txt\t"new\\tname.txt"\n'),
    'garbage\x1fwithout a hash',
  ].join('');
  const list = gitStatus.parseHistory(out);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].parents, ['b'.repeat(40), 'c'.repeat(40)]);
  assert.equal(list[0].subject, 'Merge x\x1fy');
  assert.deepEqual([list[0].author, list[0].mail, list[0].time, list[0].committer, list[0].committerTime], ['Ann', 'ann@x', 1700000000, 'Cy', 1700000060]);
  assert.deepEqual(list[0].refs, [{ kind: 'head', name: 'main' }]);
  assert.equal(list[0].path, undefined);
  assert.deepEqual([list[1].status, list[1].from, list[1].path, list[1].parents], ['R', 'old name.txt', 'new\tname.txt', []]);
  assert.deepEqual(gitStatus.parseHistory(''), []);
});

test('the history: every branch, tag and remote branch, in topo order, with the refs each commit has; the graph joins up', async () => {
  const { dir, g, hash } = repo();
  const h = await g.act(dir, { op: 'history' });
  assert.equal(h.more, false);
  assert.equal(h.branch, 'main');
  assert.equal(h.head, hash('HEAD'));
  assert.deepEqual(h.commits.map((c) => c.subject), ['Merge feature', 'Change f', 'Add f', 'Fix the login page', 'first']);
  const [merge, change, , fix, first] = h.commits;
  assert.deepEqual(merge.parents, [hash('HEAD^1'), hash('HEAD^2')]);
  assert.deepEqual(merge.refs, [
    { kind: 'head', name: 'main' },
    { kind: 'remote', name: 'origin/main' },
    { kind: 'tag', name: 'v1' },
  ]);
  assert.deepEqual(change.refs, [{ kind: 'branch', name: 'feature' }]);
  assert.deepEqual(fix.refs, [{ kind: 'tag', name: 'light' }]);
  assert.equal(fix.author, 'Bob');
  assert.equal(fix.mail, 'bob@example.org');
  assert.deepEqual(first.parents, []);
  assert.ok(first.time > 1_700_000_000 && first.time < merge.time);
  const { rows, width } = graphRows(h.commits);
  assert.equal(width, 2);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 1, 0, 0]);
});

test('pages of the history join up to the whole list; one branch; HEAD alone', async () => {
  const { dir, g } = repo();
  const whole = (await g.act(dir, { op: 'history' })).commits.map((c) => c.hash);
  const got = [];
  for (let skip = 0, more = true; more; skip += 2) {
    const page = await g.act(dir, { op: 'history', skip, limit: 2 });
    assert.ok(page.commits.length <= 2);
    got.push(...page.commits.map((c) => c.hash));
    more = page.more;
  }
  assert.deepEqual(got, whole);
  assert.deepEqual((await g.act(dir, { op: 'history', ref: 'feature' })).commits.map((c) => c.subject), ['Change f', 'Add f', 'first']);
  assert.deepEqual((await g.act(dir, { op: 'history', ref: 'light' })).commits.map((c) => c.subject), ['Fix the login page', 'first']);
  assert.equal((await g.act(dir, { op: 'history', ref: 'HEAD', limit: 1 })).more, true);
});

test('searching: all the words of a message in any case, an author, both', async () => {
  const { dir, g } = repo();
  const subjects = async (q) => (await g.act(dir, { op: 'history', ...q })).commits.map((c) => c.subject);
  assert.deepEqual(await subjects({ query: 'LOGIN fix' }), ['Fix the login page']);
  assert.deepEqual(await subjects({ query: 'f' }), ['Merge feature', 'Change f', 'Add f', 'Fix the login page', 'first']);
  assert.deepEqual(await subjects({ query: 'login nothing' }), []);
  assert.deepEqual(await subjects({ author: 'BOB' }), ['Fix the login page']);
  assert.deepEqual(await subjects({ author: 'ann@example', query: 'change' }), ['Change f']);
  // Words are words: a pattern's marks mean nothing, an option is a word, a line break a space.
  assert.deepEqual(await subjects({ query: '.*' }), []);
  assert.deepEqual(await subjects({ query: '--all' }), []);
  assert.deepEqual(await subjects({ query: 'the\nlogin' }), ['Fix the login page']);
});

test('a folder’s history (parents rewritten: it joins up) and a file followed through a rename', async () => {
  const { dir, g, git, write } = repo();
  const src = await g.act(dir, { op: 'history', path: 'src' });
  assert.deepEqual(src.commits.map((c) => c.subject), ['Change f', 'Add f']);
  assert.deepEqual(src.commits[0].parents, [src.commits[1].hash], 'its parent: the commit before that changed the folder');
  assert.deepEqual(src.commits[1].parents, []);
  fs.mkdirSync(path.join(dir, 'docs'));
  git('mv', 'a.txt', 'docs/b.txt');
  git('commit', '-q', '-m', 'Move a');
  write('docs/b.txt', 'one\nTWO\nthree\n');
  git('commit', '-q', '-am', 'Grow b');
  const b = await g.act(dir, { op: 'history', path: 'docs/b.txt', follow: true });
  assert.deepEqual(b.commits.map((c) => [c.subject, c.status, c.path, c.from ?? '']), [
    ['Grow b', 'M', 'docs/b.txt', ''],
    ['Move a', 'R', 'docs/b.txt', 'a.txt'],
    ['Fix the login page', 'M', 'a.txt', ''],
    ['first', 'A', 'a.txt', ''],
  ]);
  const page = await g.act(dir, { op: 'history', path: 'docs/b.txt', follow: true, skip: 1, limit: 2 });
  assert.deepEqual([page.commits.map((c) => c.subject), page.more], [['Move a', 'Fix the login page'], true]);
  // Without following: the name it has now only.
  assert.deepEqual((await g.act(dir, { op: 'history', path: 'docs/b.txt' })).commits.map((c) => c.subject), ['Grow b', 'Move a']);
});

test('HEAD on no branch; a repository without a commit; our backups and the stash never show', async () => {
  const { dir, g, git, hash, write } = repo();
  await g.act(dir, { op: 'backup', label: 'test' });
  write('a.txt', 'changed, stashed\n');
  git('stash', '-q');
  const h = await g.act(dir, { op: 'history' });
  assert.equal(h.commits.length, 5, 'the stash’s commits are not in the list');
  for (const c of h.commits) assert.ok(c.refs.every((r) => !/tracker-editor|stash/.test(r.name)), JSON.stringify(c.refs));
  git('switch', '-q', '--detach', 'HEAD~1');
  const d = await g.act(dir, { op: 'history' });
  assert.equal(d.branch, '');
  assert.equal(d.head, hash('HEAD'));
  assert.deepEqual(d.commits.find((c) => c.hash === d.head).refs, [{ kind: 'detached', name: 'HEAD' }, { kind: 'tag', name: 'light' }]);
  const empty = tmp('git-history-empty-');
  execFileSync('git', ['init', '-q', '-b', 'trunk', empty]);
  assert.deepEqual(await g.act(empty, { op: 'history' }), { commits: [], more: false, head: '', branch: 'trunk', empty: true });
});

test('what the page names is checked: a ref, a path; limits kept', async () => {
  const { dir, g } = repo();
  for (const ref of ['--all', 'a..b', 'x y', 'main:a.txt']) await assert.rejects(g.act(dir, { op: 'history', ref }), /Not a branch or commit/);
  for (const p of ['../x', '/etc/passwd', 'C:/x', 'a\nb']) await assert.rejects(g.act(dir, { op: 'history', path: p }), /Not a file of this repository/);
  await assert.rejects(g.act(dir, { op: 'history', ref: 'no-such-branch' }));
  assert.equal((await g.act(dir, { op: 'history', limit: -5 })).commits.length, 1);
  assert.equal((await g.act(dir, { op: 'history', limit: 'x' })).commits.length, 5);
  assert.equal((await g.act(dir, { op: 'history', skip: 99 })).commits.length, 0);
});

test('a commit’s details, a file at a commit, what differs from the working tree, a branch made at a commit', async () => {
  const { dir, g, git, hash, write } = repo();
  const info = await g.act(dir, { op: 'commit-info', hash: hash('feature') });
  assert.deepEqual([info.message, info.files], ['Change f', [{ status: 'M', path: 'src/f.js' }]]);
  const merge = await g.act(dir, { op: 'commit-info', hash: hash('HEAD') });
  assert.deepEqual(merge.files, [{ status: 'A', path: 'src/f.js' }], 'a merge: against its first parent');
  await assert.rejects(g.act(dir, { op: 'commit-info', hash: 'HEAD' }), /Not a commit/);
  assert.equal((await g.act(dir, { op: 'file-text', hash: hash('feature~1'), path: 'src/f.js' })).toString(), 'export const f = 1;\n');
  assert.equal(await g.act(dir, { op: 'file-text', hash: hash('main~1'), path: 'src/f.js' }), null);
  await assert.rejects(g.act(dir, { op: 'file-text', hash: hash('HEAD'), path: '../x' }), /Not a file at a commit/);
  write('a.txt', 'changed now\n');
  write('new.txt', 'not in Git\n');
  git('rm', '-q', 'src/f.js');
  assert.deepEqual(await g.act(dir, { op: 'changed-since', hash: hash('HEAD') }), { files: [{ status: 'M', path: 'a.txt' }, { status: 'D', path: 'src/f.js' }], more: 0 });
  assert.deepEqual((await g.act(dir, { op: 'changed-since', hash: hash('light~1') })).files.map((f) => f.path), ['a.txt']);
  await g.act(dir, { op: 'branch-at', name: 'from-first', rev: hash('light~1') });
  assert.equal(hash('from-first'), hash('light~1'));
  assert.equal(git('symbolic-ref', '--short', 'HEAD').trim(), 'main', 'the branch checked out stays');
  assert.equal(spawnSync('git', ['config', '--get', 'branch.from-first.merge'], { cwd: dir }).status, 1, 'it follows no branch');
  await assert.rejects(g.act(dir, { op: 'branch-at', name: 'from-first', rev: hash('HEAD') }), (err) => /already exists/.test(err.stderr));
  await assert.rejects(g.act(dir, { op: 'branch-at', name: 'bad..name', rev: hash('HEAD') }), /Not a branch name or commit/);
  await assert.rejects(g.act(dir, { op: 'branch-at', name: 'x.lock', rev: hash('HEAD') }));
});

// ---- Over SSH (the stand-in server), where git runs through the shell runner ----
const posixTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'printf x | base64 | base64 -d >/dev/null && head -c 1 /dev/null && command -v git >/dev/null'], { encoding: 'utf8' }).status === 0;
const skip = !posixTools && 'needs a POSIX sh with base64 and head, and git (as a server has)';

test('over SSH: the history with its refs and pages, a file followed, a commit’s files, a file at a commit', { skip }, async () => {
  const { startSshServer } = require('./helpers/ssh-server.cjs');
  const { createRemote } = require('../electron/remote.cjs');
  const { dir, hash, git } = repo();
  git('mv', 'a.txt', `it's b.txt`);
  git('commit', '-q', '-m', 'Move a');
  const srv = await startSshServer({ shell: '/bin/sh', home: tmp('ssh-home-'), env: IDENTITY });
  let data = {};
  const remote = createRemote({
    store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
    askHostKey: async () => true,
    onStatus: () => {},
  });
  try {
    const conn = remote.saveConnection({ protocol: 'sftp', name: 'build-box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
    const g = createGit({ parseStatus: gitStatus.parseStatus, parse: gitStatus, runner: shellRunner({ run: (script, args, opts) => remote.runArgs(conn.id, script, args, opts), where: () => 'build-box' }) });
    const root = await g.repoOf(dir);
    const h = await g.act(root, { op: 'history', limit: 3 });
    assert.deepEqual([h.commits.map((c) => c.subject), h.more, h.branch], [['Move a', 'Merge feature', 'Change f'], true, 'main']);
    assert.deepEqual(h.commits[1].refs.map((r) => r.name), ['origin/main', 'v1']);
    const next = await g.act(root, { op: 'history', limit: 3, skip: 3 });
    assert.deepEqual([next.commits.map((c) => c.subject), next.more], [['Add f', 'Fix the login page', 'first'], false]);
    const followed = await g.act(root, { op: 'history', path: `it's b.txt`, follow: true, query: 'MOVE' });
    assert.deepEqual(followed.commits.map((c) => [c.subject, c.path]), [['Move a', `it's b.txt`]]);
    const all = await g.act(root, { op: 'history', path: `it's b.txt`, follow: true });
    assert.deepEqual(all.commits.map((c) => c.path), [`it's b.txt`, 'a.txt', 'a.txt']);
    const info = await g.act(root, { op: 'commit-info', hash: hash('HEAD') });
    assert.deepEqual(info.files, [{ status: 'R', from: 'a.txt', path: `it's b.txt` }]);
    assert.equal((await g.act(root, { op: 'file-text', hash: hash('HEAD~1'), path: 'a.txt' })).toString(), 'one\nTWO\n');
  } finally {
    remote.disconnectAll();
    await srv.close();
  }
});
