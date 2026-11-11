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

test('making a folder a repository: what it would mean, git init with a branch name, the refusals', async () => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-init-')));
  const g = createGit({ parseStatus });
  const before = await g.info(dir);
  assert.equal(before.installed, true);
  assert.equal(before.root, null);
  assert.equal(await g.status(dir), null);
  const made = await g.init(dir, { branch: 'trunk' });
  assert.deepEqual(made, { root: dir, branch: 'trunk' });
  const s = await g.status(dir);
  assert.equal(s.root, dir);
  assert.equal(s.branch, 'trunk');
  await assert.rejects(g.init(dir, { branch: 'main' }), /a Git repository already/);
  // A folder inside it is in that repository, and becomes one of its own only when asked.
  const inner = path.join(dir, 'sub');
  mkdirSync(inner);
  assert.equal((await g.info(inner)).root, dir);
  assert.equal((await g.init(inner)).root, inner);
  await assert.rejects(g.init(inner, { branch: 'bad name' }), /Not a branch name/);
  await assert.rejects(g.init(path.join(dir, 'other'), { branch: '-x' }), /Not a branch name/);
});

test('making a repository without the git program: it says so', async () => {
  const g = createGit({
    parseStatus,
    runGit: async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.deepEqual(await g.info('/somewhere'), { installed: false, root: null, defaultBranch: '' });
  await assert.rejects(g.init('/somewhere'), /not installed/);
});

// ---- 0.48: blame of the editor's text, a commit for its card, a file at a commit ----

test('blame of the editor’s text: unsaved lines not committed yet; the same text and HEAD say so; too large; new files', async () => {
  const { parseBlame, NOT_COMMITTED } = await import('../app/js/gitStatus.js');
  const { dir, git } = repoWithRemote();
  git('config', 'user.name', 'Ana');
  git('config', 'user.email', 'ana@example.org');
  writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  execFileSync('git', ['commit', '-q', '-am', 'Second'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'Bruno', GIT_AUTHOR_EMAIL: 'bruno@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } });
  const [first, second] = git('log', '--reverse', '--format=%H').trim().split('\n');
  const g = createGit({ parseStatus, parse: { parseBlame } });
  // The editor has the third line changed and a fourth added, not saved.
  const r = await g.blame(dir, 'a.txt', Buffer.from('one\nTWO\nthree!\nfour\n'));
  assert.deepEqual(r.lines, [first, second, NOT_COMMITTED, NOT_COMMITTED]);
  assert.equal(r.commits[second].author, 'Bruno');
  assert.equal(r.commits[first].boundary, true);
  assert.deepEqual(r.me, { name: 'Ana', email: 'ana@example.org' });
  assert.equal(r.head, second);
  assert.equal(r.root, dir);
  assert.equal(r.rel, 'a.txt');
  assert.match(r.hash, /^[0-9a-f]{40}$/);
  // Asked again with what came back: nothing changed, nothing run.
  assert.deepEqual(await g.blame(dir, 'a.txt', Buffer.from('one\nTWO\nthree!\nfour\n'), { known: { hash: r.hash, head: r.head } }), { same: true, hash: r.hash, head: r.head });
  assert.ok(!(await g.blame(dir, 'a.txt', Buffer.from('one\n'), { known: { hash: r.hash, head: r.head } })).same, 'another text');
  // Over the cap: said, not run.
  const big = await g.blame(dir, 'a.txt', Buffer.alloc(64, 'x'), { max: 32 });
  assert.equal(big.tooBig, true);
  assert.equal(big.size, 64);
  // A new file, not in Git yet: every line is new.
  writeFileSync(path.join(dir, 'new.txt'), 'x\n');
  const fresh = await g.blame(dir, 'new.txt', Buffer.from('x\ny\n'));
  assert.equal(fresh.untracked, true);
  assert.equal(fresh.lines, undefined);
  // A repository without a commit yet.
  const empty = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-empty-')));
  execFileSync('git', ['init', '-q'], { cwd: empty });
  const none = await g.blame(empty, 'a.txt', Buffer.from('a\n'));
  assert.equal(none.untracked, true);
  assert.equal(none.head, '');
  await assert.rejects(g.blame(dir, '../a.txt', Buffer.from('')), /Not a file/);
});

test('a commit for its card, and a file before and after it (renamed too)', async () => {
  const { parseBlame } = await import('../app/js/gitStatus.js');
  const { dir, git } = repoWithRemote();
  git('mv', 'a.txt', 'b.txt');
  writeFileSync(path.join(dir, 'b.txt'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(path.join(dir, 'c.txt'), 'new\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Rename and grow', '-m', 'The body\nof two lines.');
  const [first, second] = git('log', '--reverse', '--format=%H').trim().split('\n');
  const g = createGit({ parseStatus, parse: { parseBlame } });
  const c = await g.commitInfo(dir, second);
  assert.equal(c.hash, second);
  assert.deepEqual(c.parents, [first]);
  assert.equal(c.author, 't');
  assert.equal(c.mail, 't@example.org');
  assert.ok(c.time > 0);
  assert.equal(c.message, 'Rename and grow\n\nThe body\nof two lines.');
  assert.deepEqual(c.files.map((f) => [f.status, f.path, f.from ?? '']).sort(), [['A', 'c.txt', ''], ['R', 'b.txt', 'a.txt']]);
  // The first commit: its files against nothing.
  assert.deepEqual((await g.commitInfo(dir, first)).files, [{ status: 'A', path: 'a.txt' }]);
  assert.equal(await g.commitInfo(dir, 'abcdef1234'), null, 'no such commit');
  await assert.rejects(g.commitInfo(dir, 'HEAD~1'), /Not a commit/, 'hashes only');
  // Blame names the line's commit and the one before it, with the file's names then.
  const blame = await g.blame(dir, 'b.txt', Buffer.from('one\ntwo\nthree\nfour\n'));
  const last = blame.commits[blame.lines[3]];
  assert.equal(last.hash, second);
  assert.deepEqual(last.previous, { hash: first, filename: 'a.txt' });
  assert.equal((await g.fileAt(dir, second, 'b.txt')).toString(), 'one\ntwo\nthree\nfour\n');
  assert.equal((await g.fileAt(dir, last.previous.hash, last.previous.filename)).toString(), 'one\ntwo\nthree\n');
  assert.equal(await g.fileAt(dir, first, 'b.txt'), null, 'not there then');
  await assert.rejects(g.fileAt(dir, first, '../x'), /Not a file/);
});

test('fetch, pull and push use the repository’s own core.sshCommand (Windows’ ssh and its agent), never asking', { skip: process.platform === 'win32' && 'a shell script stands in for ssh' }, async () => {
  // Until 0.52 the editor always set GIT_SSH_COMMAND='ssh -o BatchMode=yes', which outranks
  // core.sshCommand: on Windows Git's own ssh ran, without Windows' ssh-agent, and every pull
  // said "Permission denied (publickey)" while the same pull worked in a terminal.
  const { writeEnv, programOf } = require('../electron/git.cjs');
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-ssh-')));
  const tools = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-ssh-tools-')));
  const log = path.join(tools, 'calls.txt');
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } });
  // A stand-in for ssh: says what it was given, then fails as an unreachable host does.
  const fake = (name) => {
    const file = path.join(tools, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\necho "ssh: connect to host example.invalid: no route" >&2\nexit 255\n`, { mode: 0o755 });
    return file;
  };
  const read = () => (execFileSync('cat', [log]).toString().trim().split('\n').pop() ?? '');
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', 'ssh://git@example.invalid:1022/team/repo.git');
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_SSH;
  const saved = { cmd: process.env.GIT_SSH_COMMAND, ssh: process.env.GIT_SSH };
  delete process.env.GIT_SSH_COMMAND;
  delete process.env.GIT_SSH;
  try {
    const g = createGit({ parseStatus });
    // OpenSSH set by the person (a path, as on Windows): it runs, with BatchMode added.
    git('config', 'core.sshCommand', fake('ssh'));
    await assert.rejects(g.act(dir, { op: 'fetch' }));
    assert.match(read(), /^ssh -o BatchMode=yes .*example\.invalid/, 'the configured ssh ran, asking nothing');
    await assert.rejects(g.act(dir, { op: 'pull' }));
    assert.match(read(), /^ssh -o BatchMode=yes .*git-upload-pack/);
    await assert.rejects(g.act(dir, { op: 'push' }));
    assert.match(read(), /^ssh -o BatchMode=yes .*git-receive-pack/);
    // Another program (plink, a wrapper): run as configured, nothing added.
    git('config', 'core.sshCommand', fake('my-wrapper'));
    await assert.rejects(g.act(dir, { op: 'fetch' }));
    assert.match(read(), /^my-wrapper (?!-o BatchMode).*example\.invalid/);
  } finally {
    if (saved.cmd != null) process.env.GIT_SSH_COMMAND = saved.cmd;
    if (saved.ssh != null) process.env.GIT_SSH = saved.ssh;
  }

  // The environment's choice still wins; with nothing set, plain ssh asking nothing.
  assert.equal(writeEnv(env).GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.equal(writeEnv({ ...env, GIT_SSH_COMMAND: 'mine' }, { sshCommand: 'ssh' }).GIT_SSH_COMMAND, 'mine');
  assert.equal(writeEnv({ ...env, GIT_SSH: 'plink.exe' }, { sshCommand: 'ssh' }).GIT_SSH_COMMAND, undefined);
  assert.equal(writeEnv(env, { sshCommand: '"C:/Program Files/OpenSSH/ssh.exe" -i key' }).GIT_SSH_COMMAND, '"C:/Program Files/OpenSSH/ssh.exe" -i key -o BatchMode=yes');
  assert.equal(writeEnv(env, { sshCommand: 'ssh -o BatchMode=yes -v' }).GIT_SSH_COMMAND, undefined, 'already there: Git runs its own setting');
  assert.equal(writeEnv(env, { sshCommand: 'C:\\\\tools\\\\plink.exe -batch' }).GIT_SSH_COMMAND, undefined);
  assert.equal(programOf('C:/Windows/System32/OpenSSH/ssh.exe'), 'ssh');
  assert.equal(programOf("'/usr/bin/ssh' -F cfg"), 'ssh');
  assert.equal(programOf('TortoiseGitPlink.exe'), 'tortoisegitplink');
});

test('picked files (0.52): stash some, discard, ignore here only, keep my changes out, stop tracking', async () => {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-pick-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' } }).toString();
  const { readFileSync, existsSync } = await import('node:fs');
  const read = (rel) => readFileSync(path.join(dir, rel), 'utf8');
  git('init', '-q', '-b', 'main');
  // Files as written, line endings too (Windows' Git converts them by default).
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  writeFileSync(path.join(dir, 'config.json'), '{"db":"prod"}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const g = createGit({ parseStatus });

  // Stash two of three changed files (one new): the third stays as it is.
  writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b changed\n');
  writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  await g.act(dir, { op: 'stash', paths: ['a.txt', 'new.txt'], untracked: true, message: 'two of them' });
  assert.equal(read('a.txt'), 'a\n');
  assert.equal(existsSync(path.join(dir, 'new.txt')), false);
  assert.equal(read('b.txt'), 'b changed\n', 'not picked: left alone');
  await g.act(dir, { op: 'stash-pop', ref: 'stash@{0}' });
  assert.equal(read('a.txt'), 'a changed\n');
  assert.equal(read('new.txt'), 'new\n');

  // Discard: a tracked file goes back to what is staged, a new one is deleted; staged changes stay.
  writeFileSync(path.join(dir, 'b.txt'), 'b staged\n');
  git('add', 'b.txt');
  writeFileSync(path.join(dir, 'b.txt'), 'b staged, then more\n');
  const d = await g.act(dir, { op: 'discard', paths: ['b.txt', 'new.txt'] });
  assert.deepEqual(d, { restored: 1, deleted: 1 });
  assert.equal(read('b.txt'), 'b staged\n');
  assert.equal(existsSync(path.join(dir, 'new.txt')), false);
  assert.equal(git('diff', '--cached', '--name-only').trim(), 'b.txt');
  await assert.rejects(g.act(dir, { op: 'discard', paths: ['../outside.txt'] }), /Not files of this repository/);

  // Ignore on this computer only: .git/info/exclude, never .gitignore; then taken back.
  writeFileSync(path.join(dir, 'scratch.log'), 'x\n');
  const ig = await g.act(dir, { op: 'ignore', patterns: ['/scratch.log'], where: 'local' });
  assert.deepEqual(ig.added, ['/scratch.log']);
  assert.equal(existsSync(path.join(dir, '.gitignore')), false);
  assert.match(read('.git/info/exclude'), /^\/scratch\.log$/m);
  assert.equal((await g.status(dir)).files['scratch.log'], undefined, 'Git no longer lists it');
  // Keep my changes out (skip-worktree): the file looks unchanged, and is listed as kept out.
  writeFileSync(path.join(dir, 'config.json'), '{"db":"local"}\n');
  await g.act(dir, { op: 'skip', paths: ['config.json'], on: true });
  assert.equal((await g.status(dir)).files['config.json'], undefined);
  const kept = await g.act(dir, { op: 'kept-out' });
  assert.deepEqual(kept.skipped, ['config.json']);
  assert.ok(kept.patterns.includes('/scratch.log'));
  await g.act(dir, { op: 'skip', paths: ['config.json'], on: false });
  assert.equal((await g.status(dir)).files['config.json'], 'M', 'followed again');
  const un = await g.act(dir, { op: 'unignore', patterns: ['/scratch.log'], where: 'local' });
  assert.equal(un.removed, 1);
  assert.equal((await g.status(dir)).files['scratch.log'], 'U');
  assert.deepEqual((await g.act(dir, { op: 'kept-out' })).skipped, []);

  // Stop tracking and add to .gitignore: a deletion staged, the file kept on disk.
  await g.act(dir, { op: 'untrack', paths: ['config.json'] });
  await g.act(dir, { op: 'ignore', patterns: ['/config.json'] });
  assert.equal(read('config.json'), '{"db":"local"}\n');
  assert.match(git('diff', '--cached', '--name-status'), /^D\tconfig\.json$/m);
  assert.match(read('.gitignore'), /^\/config\.json$/m);
  // Undo: the deletion unstaged, the line out of .gitignore again.
  await g.act(dir, { op: 'unstage', paths: ['config.json'] });
  await g.act(dir, { op: 'unignore', patterns: ['/config.json'] });
  assert.doesNotMatch(git('diff', '--cached', '--name-status'), /config\.json/);
  assert.doesNotMatch(read('.gitignore'), /config\.json/);
});
