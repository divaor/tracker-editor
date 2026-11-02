// Git for folders on SSH servers and in places (Docker containers, WSL distributions): git.cjs's
// shellRunner and remote.cjs's runArgs. The command line a server's login shell parses (only
// sh -c 'BOOT' and base64 words: nasty paths, branch names and messages never become shell text,
// whatever the login shell: sh, bash, zsh, fish, busybox's), the values framed for the scripts
// (on stdin when they are many; a NUL, a line break or \037 refused), a profile that prints, a
// channel cut short, no base64 there. Then everything Git does against a stand-in SSH server
// (test/helpers/ssh-server.cjs: ssh2's own Server running each command with `<shell> -c`, as
// sshd does) and real repositories: status, HEAD, stage, commit, branches, switch, stash, push to
// a bare repository, a conflict halfway, the snapshot, backups and undo, one change staged, git
// init, a folder reached through a link, git missing there (with the command that installs it),
// the connection dropping mid-command and a command that does not answer; the environment it
// runs in (no prompts, no editor, ssh in batch mode unless the server says otherwise, sign-in
// failures in words naming the server); and the same in a place through the fake docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitStatus from '../app/js/gitStatus.js';
import { snapshotText } from '../app/js/gitAssist.js';

const require = createRequire(import.meta.url);
const places = require('../electron/places.cjs');
const { createRemote, toUri } = require('../electron/remote.cjs');
const { createGit, shellRunner, installCommand, parseInstallProbe, SHELL_PROLOGUE, ARGS_INLINE } = require('../electron/git.cjs');
const { startSshServer } = require('./helpers/ssh-server.cjs');
const FAKE_DOCKER = fileURLToPath(new URL('./helpers/fake-docker.cjs', import.meta.url));

// The scripts run as a server runs them: a POSIX sh with base64 and head -c, and git. Not on Windows.
const posixTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'printf x | base64 | base64 -d >/dev/null && head -c 1 /dev/null && command -v git >/dev/null'], { encoding: 'utf8' }).status === 0;
const skip = !posixTools && 'needs a POSIX sh with base64 and head, and git (as a server has)';
const BUSYBOX = ['/usr/bin/busybox', '/bin/busybox'].find((p) => fs.existsSync(p));
const GIT = posixTools ? spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() : '';
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/usr/bin/fish', '/bin/fish'].filter((s) => fs.existsSync(s));

// Names that would break a command line or a shell if they were ever pasted into one.
const NASTY = ['a b.txt', `q'u"o.md`, 'd$HOME.txt', '`id`.txt', 'semi;colon.txt', '-rf', 'ünïcødé 名前.txt', 'back\\slash.txt', 'star*?[x].txt', 'tab\there.txt', '$(touch pwned).txt', "it's.txt", '  spaces  .txt', '--help', ':colon', '|pipe&amp'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.org' };
const gitHere = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8', stdio: 'pipe' });

/** A repository with a remote (a bare one), as the Git panel uses them: { base, dir, remote }. */
function repoWithRemote() {
  const base = tmp('git-remote-');
  const remote = path.join(base, 'remote.git');
  const dir = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'pipe' });
  gitHere(dir, 'config', 'user.name', 't');
  gitHere(dir, 'config', 'user.email', 't@example.org');
  gitHere(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  gitHere(dir, 'add', '.');
  gitHere(dir, 'commit', '-q', '-m', 'first');
  gitHere(dir, 'push', '-q', '-u', 'origin', 'main');
  return { base, dir, remote };
}

/** What remote.cjs's runArgs does, without SSH: the server's command line run by `shell -c`, as sshd runs it. */
const runVia =
  (shell = 'sh', env = process.env) =>
  (script, args, { input = null, timeout = 30000, onStderr = null } = {}) =>
    places.runCommand({ program: shell, args: ['-c', places.bootCommand(script, args)], env, input, timeout, onStderr });
const gitWith = (run, where = 'build-box') => createGit({ parseStatus: gitStatus.parseStatus, parse: gitStatus, runner: shellRunner({ run, where: () => where }) });

// ---- The command line ------------------------------------------------------------------------

test('the command line for a server: sh -c with BOOT quoted, every other word base64; NUL and line breaks refused', () => {
  const line = places.bootCommand('echo hi', NASTY);
  const words = line.split(' ');
  assert.deepEqual(words.slice(0, 2), ['sh', '-c']);
  assert.ok(line.startsWith(`sh -c '${places.BOOT}' sh `), line.slice(0, 80));
  assert.doesNotMatch(places.BOOT, /['"\\]/, 'its quotes can only wrap it');
  const rest = line.slice(`sh -c '${places.BOOT}' sh `.length).split(' ');
  assert.equal(rest.length, 1 + NASTY.length);
  for (const word of rest) assert.match(word, /^[A-Za-z0-9+/]+=*$/, 'only base64’s letters');
  assert.equal(Buffer.from(rest[0], 'base64').toString(), `${places.PRELUDE}echo hi`);
  NASTY.forEach((name, i) => assert.equal(Buffer.from(rest[i + 1], 'base64').toString(), `:${name}`));
  assert.throws(() => places.bootCommand('x', ['a\nb']), /line break/);
  assert.throws(() => places.bootCommand('x', ['a\0b']), /line break/);
});

test('the longest command line a place gets stays under the 32 K characters Windows takes for docker.exe and wsl.exe', async () => {
  const { SHELL_SCRIPTS } = require('../electron/git.cjs');
  let longest = 0;
  for (const name of Object.keys(SHELL_SCRIPTS)) {
    const line = places.placeArgs({ protocol: 'wsl', distro: 'Ubuntu', user: '' }, SHELL_PROLOGUE + SHELL_SCRIPTS[name], ['argv', 'x'.repeat(ARGS_INLINE)]).join(' ');
    longest = Math.max(longest, line.length);
  }
  assert.ok(longest < 32000, `${longest}`);
  // Counted in bytes: names in another script (three bytes a character) go on stdin sooner.
  let sent = null;
  const runner = shellRunner({ run: async (script, args, opts) => ((sent = args), { code: 0, stdout: Buffer.from('\x1eTE<\n0\n\x1eTE>0\n', 'latin1'), stderr: Buffer.alloc(0) }), where: () => 'x' });
  const names = Array.from({ length: 400 }, (_, i) => `/srv/名前のファイル${i}.txt`);
  assert.ok(names.join('').length < ARGS_INLINE && Buffer.byteLength(names.join('')) > ARGS_INLINE, 'fewer characters than the limit, more bytes');
  await runner.exists(names);
  assert.deepEqual(sent, ['stdin']);
});

test('the quoting helper: what a POSIX shell reads back is the word, whatever it holds', { skip }, () => {
  for (const word of [...NASTY, '', "'", "''", "a'b'c", '\\', '!', '$', '%s', '\t']) {
    const out = spawnSync('sh', ['-c', `printf %s ${places.shellQuote(word)}`], { encoding: 'utf8' }).stdout;
    assert.equal(out, word, JSON.stringify(word));
  }
});

test('nasty values reach the scripts whole through any login shell (sh, bash, zsh, fish, busybox)', { skip }, async () => {
  const shells = [...SHELLS, ...(BUSYBOX ? [BUSYBOX] : [])];
  const dir = tmp('git-nasty-');
  for (const name of NASTY) fs.writeFileSync(path.join(dir, name), name);
  for (const shell of shells) {
    // busybox: `busybox sh -c …`; the others are a login shell themselves.
    const run = shell === BUSYBOX ? (script, args, opts) => places.runCommand({ program: BUSYBOX, args: ['sh', '-c', places.bootCommand(script, args)], input: opts?.input ?? null, timeout: 30000 }) : runVia(shell);
    const runner = shellRunner({ run, where: () => shell });
    const paths = [...NASTY.map((n) => path.join(dir, n)), path.join(dir, 'not there')];
    assert.deepEqual(await runner.exists(paths), [...NASTY.map(() => true), false], shell);
    for (const name of NASTY.slice(0, 6)) assert.equal((await runner.readFile(path.join(dir, name))).bytes.toString(), name, `${shell}: ${name}`);
  }
  assert.ok(![dir, os.homedir(), process.cwd()].some((d) => fs.existsSync(path.join(d, 'pwned'))), 'nothing in a name ever ran');
});

test('values on stdin when they are many; a NUL, a line break or \\037 is refused before anything runs', { skip }, async () => {
  const { dir } = repoWithRemote();
  const names = Array.from({ length: 400 }, (_, i) => `folder with a long name/file number ${String(i).padStart(4, '0')} with spaces.txt`);
  fs.mkdirSync(path.join(dir, 'folder with a long name'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), 'x\n');
  assert.ok(names.join('').length > ARGS_INLINE, 'long enough to go on stdin');
  let sent = null;
  const run = runVia('sh');
  const g = gitWith((script, args, opts) => ((sent = args), run(script, args, opts)));
  await g.act(dir, { op: 'stage', paths: names });
  assert.deepEqual(sent, ['stdin'], 'the values went on stdin');
  assert.equal(gitHere(dir, 'diff', '--cached', '--name-only').trim().split('\n').length, 400);
  // A commit message on stdin after them, whole.
  await g.act(dir, { op: 'commit', message: 'many\n\n$(id) `id` "quotes"' });
  assert.equal(gitHere(dir, 'log', '-1', '--format=%B').trim(), 'many\n\n$(id) `id` "quotes"');
  const runner = shellRunner({ run, where: () => 'x' });
  for (const bad of ['a\nb', 'a\0b', 'a\x1fb']) await assert.rejects(runner.exists([bad]), /line break or a control character/);
});

test('a profile that prints, a channel cut short, a server without base64: each said as it is', { skip }, async () => {
  const { dir } = repoWithRemote();
  const run = runVia('sh');
  // A login shell's profile printing a welcome before the command: left out.
  const noisy = gitWith(async (...a) => {
    const r = await run(...a);
    return { ...r, stdout: Buffer.concat([Buffer.from('Welcome to build-box!\nLast login: today\n'), r.stdout]) };
  });
  assert.equal((await noisy.status(dir)).branch, 'main');
  // Cut short (the connection went while it ran): never taken as the answer.
  const cut = gitWith(async (...a) => {
    const r = await run(...a);
    return { ...r, stdout: r.stdout.subarray(0, r.stdout.length - 4) };
  });
  await assert.rejects(cut.act(dir, { op: 'log' }), (err) => err.lost === true && /stopped before it finished/.test(err.message));
  // No base64 there: BOOT's eval runs nothing, and says nothing.
  const none = gitWith(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  await assert.rejects(none.act(dir, { op: 'log' }), /needs sh and base64 there/);
});

test('where git runs on a server: no prompts, no editor, no optional locks when reading; ssh in batch mode unless the server says how', { skip }, async () => {
  const { dir } = repoWithRemote();
  // A git that shows the environment it gets (and knows no core.sshCommand).
  const fakeBin = tmp('git-env-');
  fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\n[ "$1" = config ] && exit 1\nenv\n', { mode: 0o755 });
  const envFor = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  for (const k of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_OPTIONAL_LOCKS', 'GIT_EDITOR']) delete envFor[k];
  const shown = shellRunner({ run: runVia('sh', envFor), where: () => 'build-box' });
  const reading = String(await shown.git(['status'], dir)).split('\n');
  for (const v of ['GIT_OPTIONAL_LOCKS=0', 'LC_ALL=C', 'GIT_TERMINAL_PROMPT=0', 'GCM_INTERACTIVE=never']) assert.ok(reading.includes(v), v);
  assert.ok(!reading.some((l) => l.startsWith('GIT_SSH_COMMAND=')), 'reading talks to no remote');
  const writing = (await shown.gitWrite(['commit'], dir)).stdout.split('\n');
  for (const v of ['GIT_EDITOR=true', 'GIT_MERGE_AUTOEDIT=no', 'GIT_TERMINAL_PROMPT=0', 'GCM_INTERACTIVE=never', 'GIT_SSH_COMMAND=ssh -o BatchMode=yes']) assert.ok(writing.includes(v), v);
  assert.ok(!writing.some((l) => l.startsWith('GIT_OPTIONAL_LOCKS=')), 'writing takes Git’s own locks');
  // The server's own GIT_SSH_COMMAND is kept.
  const own = shellRunner({ run: runVia('sh', { ...envFor, GIT_SSH_COMMAND: 'ssh -i ~/.ssh/deploy' }), where: () => 'build-box' });
  assert.ok((await own.gitWrite(['push'], dir)).stdout.split('\n').includes('GIT_SSH_COMMAND=ssh -i ~/.ssh/deploy'));
});

test('a remote that refuses to sign in: Git’s words naming the server; its own core.sshCommand kept', { skip }, async () => {
  const { dir } = repoWithRemote();
  const bin = tmp('git-fake-ssh-');
  const log = path.join(bin, 'ssh.log');
  // An ssh that writes how it was run, and refuses as a remote without the key does.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho 'git@example.org: Permission denied (publickey).' >&2\nexit 255\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_SSH;
  const g = gitWith(runVia('sh', env));
  gitHere(dir, 'remote', 'set-url', 'origin', 'ssh://git@example.org/team/app.git');
  const t0 = Date.now();
  const failed = await g.act(dir, { op: 'push' }).catch((err) => err);
  assert.ok(Date.now() - t0 < 10000, 'no waiting on a question');
  assert.match(fs.readFileSync(log, 'utf8'), /-o BatchMode=yes/, 'batch mode: ssh never asks');
  const said = gitStatus.gitError(failed.stderr, failed.stdout, { place: { kind: 'ssh', name: 'build-box' } });
  assert.equal(said.kind, 'auth');
  assert.match(said.message, /^Git on the server build-box could not sign in/);
  assert.match(said.message, /SSH key on the server build-box/);
  // The server's own way of running ssh (a deploy key) is kept.
  fs.writeFileSync(log, '');
  gitHere(dir, 'config', 'core.sshCommand', `${path.join(bin, 'ssh')} -i deploy_key`);
  await g.act(dir, { op: 'fetch' }).catch((err) => err);
  assert.match(fs.readFileSync(log, 'utf8'), /-i deploy_key/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /BatchMode/);
});

// ---- Over SSH: the stand-in server, real repositories ----------------------------------------

/** A stand-in SSH server and remote.cjs connected to it: { srv, remote, id, g (git there), events }. */
async function overSsh({ shell = '/bin/sh', env = {}, home } = {}) {
  const srv = await startSshServer({ shell, home: home ?? tmp('ssh-home-'), env: { ...IDENTITY, ...env } });
  let data = {};
  const events = [];
  const remote = createRemote({
    store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
    secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} },
    askHostKey: async () => true,
    onStatus: (s) => events.push(s),
  });
  const conn = remote.saveConnection({ protocol: 'sftp', name: 'build-box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
  const g = gitWith((script, args, opts) => remote.runArgs(conn.id, script, args, opts));
  const done = async () => {
    remote.disconnectAll();
    await srv.close();
  };
  return { srv, remote, id: conn.id, g, events, done };
}

test('over SSH: status, HEAD, stage, commit, branches, switch, stash, push to a bare repository', { skip }, async () => {
  const { dir, remote: bare, base } = repoWithRemote();
  const s = await overSsh({ shell: SHELLS.includes('/bin/bash') ? '/bin/bash' : '/bin/sh' });
  try {
    const { g } = s;
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    fs.mkdirSync(path.join(dir, 'src dir'));
    fs.writeFileSync(path.join(dir, 'src dir', `it's new.md`), '# new\n');
    assert.equal(await g.repoOf(path.join(dir, 'src dir')), dir);
    const st = await g.status(dir);
    assert.deepEqual([st.root, st.branch, st.upstream], [dir, 'main', 'origin/main']);
    assert.deepEqual(st.files, { 'a.txt': 'M', "src dir/it's new.md": 'U' });
    const head = await g.headBytes(path.join(dir, 'a.txt'));
    assert.deepEqual([head.rel, head.bytes.toString()], ['a.txt', 'one\ntwo\nthree\n']);
    assert.equal(await g.headBytes(path.join(dir, 'src dir', `it's new.md`)), null, 'new: not at HEAD');
    assert.equal(await g.branch(dir), 'main');
    // Stage, unstage, commit (the message on stdin, whatever it holds), amend.
    await g.act(dir, { op: 'stage', paths: ['a.txt', "src dir/it's new.md"] });
    assert.deepEqual((await g.status(dir)).staged, { 'a.txt': 'M', "src dir/it's new.md": 'A' });
    await g.act(dir, { op: 'unstage', paths: ["src dir/it's new.md"] });
    await g.act(dir, { op: 'commit', message: `Second: 'quotes' "$HOME" \`id\` ; rm -rf\n\nbody` });
    assert.equal(gitHere(dir, 'log', '-1', '--format=%B').trim(), `Second: 'quotes' "$HOME" \`id\` ; rm -rf\n\nbody`);
    assert.equal(await g.act(dir, { op: 'last-message' }), `Second: 'quotes' "$HOME" \`id\` ; rm -rf\n\nbody`);
    await assert.rejects(g.act(dir, { op: 'stage', paths: ['../outside'] }), /Not files/);
    await assert.rejects(g.act(dir, { op: 'switch', name: '--orphan' }), /Not a branch name/);
    // Branches: made from here, switched, listed; someone else's followed.
    const other = path.join(base, 'other');
    execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
    gitHere(other, 'switch', '-q', '-c', 'feature/login');
    fs.writeFileSync(path.join(other, 'login.txt'), 'x\n');
    gitHere(other, 'add', '.');
    gitHere(other, 'commit', '-q', '-m', 'login');
    gitHere(other, 'push', '-q', '-u', 'origin', 'feature/login');
    const progress = [];
    await g.act(dir, { op: 'fetch' }, { onProgress: (l) => progress.push(l) });
    const branches = await g.act(dir, { op: 'branches' });
    assert.deepEqual(branches.local.map((b) => [b.name, b.current]), [['main', true]]);
    assert.ok(branches.remote.some((b) => b.name === 'origin/feature/login'));
    await g.act(dir, { op: 'switch', name: 'origin/feature/login', track: true });
    assert.equal(await g.branch(dir), 'feature/login');
    await g.act(dir, { op: 'switch', name: 'fix/typo', create: true, from: 'main' });
    assert.equal(await g.branch(dir), 'fix/typo');
    // Stash: aside, listed, back.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    await g.act(dir, { op: 'stash', message: 'half done', untracked: true });
    assert.deepEqual((await g.status(dir)).files, {});
    const stashes = await g.act(dir, { op: 'stashes' });
    assert.deepEqual(stashes.map((x) => [x.ref, x.message]), [['stash@{0}', 'half done']]);
    await g.act(dir, { op: 'stash-pop', ref: 'stash@{0}' });
    assert.deepEqual((await g.status(dir)).files, { 'a.txt': 'M', "src dir/it's new.md": 'U' });
    // A new branch's first push: to origin, followed from then on, with Git's progress.
    await g.act(dir, { op: 'stage-all' });
    await g.act(dir, { op: 'commit', message: 'on fix/typo' });
    const lines = [];
    await g.act(dir, { op: 'push' }, { onProgress: (l) => lines.push(l) });
    assert.equal(gitHere(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/fix/typo');
    assert.equal(execFileSync('git', ['--git-dir', bare, 'log', '-1', '--format=%s', 'fix/typo'], { encoding: 'utf8' }).trim(), 'on fix/typo');
    assert.ok(lines.length > 0, 'progress lines came over the channel');
  } finally {
    await s.done();
  }
});

test('over SSH: a pull that conflicts (in progress, aborted), the snapshot for the model, backups and undo', { skip }, async () => {
  const { dir, remote: bare, base } = repoWithRemote();
  const s = await overSsh();
  try {
    const { g } = s;
    const other = path.join(base, 'other');
    execFileSync('git', ['clone', '-q', bare, other], { stdio: 'pipe' });
    fs.writeFileSync(path.join(other, 'a.txt'), 'THEIRS\n');
    gitHere(other, 'commit', '-q', '-am', 'theirs');
    gitHere(other, 'push', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'OURS\n');
    await g.act(dir, { op: 'stage-all' });
    await g.act(dir, { op: 'commit', message: 'ours' });
    const ff = await g.act(dir, { op: 'pull' }).catch((err) => err);
    assert.equal(gitStatus.gitError(ff.stderr, ff.stdout).kind, 'diverged');
    const failed = await g.act(dir, { op: 'pull', how: 'merge' }).catch((err) => err);
    assert.equal(gitStatus.gitError(failed.stderr, failed.stdout).kind, 'conflict');
    assert.equal((await g.status(dir)).files['a.txt'], 'C');
    assert.equal(await g.act(dir, { op: 'in-progress' }), 'merge');
    const snap = await g.act(dir, { op: 'snapshot' });
    assert.equal(snap.inProgress, 'merge');
    assert.equal(snap.status.branch, 'main');
    assert.equal(snap.gitignore, false);
    assert.match(snap.graph, /ours/);
    await g.act(dir, { op: 'abort', what: 'merge' });
    assert.equal(await g.act(dir, { op: 'in-progress' }), null);
    // .gitignore through the server: appended, its line endings kept.
    assert.deepEqual(await g.act(dir, { op: 'ignore', patterns: ['*.log', 'build/'] }), { added: ['*.log', 'build/'], already: 0 });
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*.log\nbuild/\n');
    assert.equal((await g.act(dir, { op: 'snapshot' })).gitignore, true);
    // read: a file as it is now, never one outside the repository (a link out is refused).
    assert.equal(await g.act(dir, { op: 'read', path: '.gitignore' }), '*.log\nbuild/\n');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'outside\n');
    fs.symlinkSync(path.join(base, 'secret.txt'), path.join(dir, 'link-out'));
    await assert.rejects(g.act(dir, { op: 'read', path: 'link-out' }), /Not a file of this repository/);
    // A backup, a step that loses work, and undo brings it back.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'not committed\n');
    const before = gitHere(dir, 'rev-parse', 'HEAD').trim();
    const backup = await g.act(dir, { op: 'backup', label: 'git reset --hard HEAD~1' });
    assert.equal(backup.head, before);
    await g.act(dir, { op: 'reset', mode: 'hard', rev: 'HEAD~1' });
    assert.notEqual(gitHere(dir, 'rev-parse', 'HEAD').trim(), before);
    const listed = await g.act(dir, { op: 'backups' });
    assert.equal(listed[0].id, backup.id);
    await g.act(dir, { op: 'undo', id: backup.id });
    assert.equal(gitHere(dir, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'not committed\n');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'tracker-editor-backups.json')), 'listed in the .git folder there');
  } finally {
    await s.done();
  }
});

test('over SSH: one change staged, making a repository, a folder reached through a link keeps its name', { skip }, async () => {
  const { dir } = repoWithRemote();
  const s = await overSsh({ shell: SHELLS.find((x) => x.endsWith('zsh')) ?? '/bin/sh' });
  try {
    const { g } = s;
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'one\nTWO\nthree\nfour\n');
    const index = (await g.indexBytes(file)).bytes.toString();
    const staged = gitStatus.stageBlock(index, 'one\nTWO\nthree\nfour\n', 2);
    await g.setIndexBytes(file, Buffer.from(staged));
    assert.equal(gitHere(dir, 'show', ':a.txt'), 'one\nTWO\nthree\n');
    const st = await g.status(dir);
    assert.deepEqual([st.staged['a.txt'], st.unstaged['a.txt']], ['M', 'M']);
    // git init there.
    const fresh = tmp('git-init-there-');
    const info = await g.info(fresh);
    assert.deepEqual([info.installed, info.root], [true, null]);
    assert.match(info.version, /^\d+\.\d+/);
    assert.deepEqual(await g.init(fresh, { branch: 'trunk' }), { root: fresh, branch: 'trunk' });
    await assert.rejects(g.init(fresh, { branch: 'main' }), /a Git repository already/);
    await assert.rejects(g.init(path.join(fresh, 'x'), { branch: 'bad name' }), /Not a branch name/);
    // A folder through a link (a home folder linked elsewhere): the repository is named as the page names it.
    const linkBase = tmp('git-link-');
    fs.symlinkSync(path.dirname(dir), path.join(linkBase, 'linked'));
    const viaLink = path.join(linkBase, 'linked', path.basename(dir));
    assert.equal(await g.repoOf(viaLink), viaLink);
    assert.equal((await g.status(viaLink)).root, viaLink);
    assert.equal((await g.headBytes(path.join(viaLink, 'a.txt'))).rel, 'a.txt');
  } finally {
    await s.done();
  }
});

test('over SSH: blame of the editor’s text (an unsaved line not committed yet), a commit’s details, the file at a commit', { skip }, async () => {
  const { dir } = repoWithRemote();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  gitHere(dir, 'commit', '-q', '-am', 'Shout two\n\nLouder.');
  const s = await overSsh();
  try {
    const { g } = s;
    const root = await g.repoOf(dir);
    const text = Buffer.from('one\nTWO\nthree\nfour, not saved\n');
    const b = await g.blame(root, 'a.txt', text);
    assert.equal(b.lines.length, 4);
    const who = b.lines.map((h) => (b.commits[h].uncommitted ? 'new' : b.commits[h].summary));
    assert.deepEqual(who, ['first', 'Shout two', 'first', 'new']);
    assert.deepEqual(b.me, { name: 't', email: 't@example.org' });
    assert.deepEqual(await g.blame(root, 'a.txt', text, { known: { hash: b.hash, head: b.head } }), { same: true, hash: b.hash, head: b.head });
    const info = await g.commitInfo(root, b.lines[1]);
    assert.equal(info.message, 'Shout two\n\nLouder.');
    assert.deepEqual(info.files, [{ status: 'M', path: 'a.txt' }]);
    assert.equal((await g.fileAt(root, info.parents[0], 'a.txt')).toString(), 'one\ntwo\nthree\n');
    assert.equal((await g.fileAt(root, info.hash, 'a.txt')).toString(), 'one\nTWO\nthree\n');
    assert.equal(await g.fileAt(root, info.hash, 'missing.txt'), null);
  } finally {
    await s.done();
  }
});

test('over SSH: git missing there: null, and info says so with the command that installs it', { skip: skip || (!BUSYBOX && 'no busybox here (a PATH without git)') }, async () => {
  // A PATH with sh and the usual tools but no git (busybox's applets), and an apk.
  const bb = tmp('ssh-nogit-');
  for (const name of spawnSync(BUSYBOX, ['--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) fs.symlinkSync(BUSYBOX, path.join(bb, name));
  fs.writeFileSync(path.join(bb, 'apk'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const hasOwnGit = ['/usr/local/bin/git', '/opt/homebrew/bin/git', '/snap/bin/git'].some((p) => fs.existsSync(p));
  const s = await overSsh({ env: { PATH: bb } });
  try {
    const { dir } = repoWithRemote();
    if (hasOwnGit) return; // the script's usual places would find it
    assert.equal(await s.g.status(dir), null);
    assert.equal(s.g.missing, true);
    const info = await s.g.info(dir);
    assert.equal(info.installed, false);
    assert.equal(info.install.manager, 'apk');
    assert.match(info.install.command, /^(sudo )?apk add git$/);
    await assert.rejects(s.g.init(tmp('nogit-init-')), /not installed on build-box/);
  } finally {
    await s.done();
  }
});

test('over SSH: the connection dropping mid-command is said at once, never a hang; then it connects again', { skip }, async () => {
  const { dir } = repoWithRemote();
  // A git that takes its time there (a big repository, a slow disk).
  const bin = tmp('slow-git-');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep 6\nexec "${GIT}" "$@"\n`, { mode: 0o755 });
  const s = await overSsh({ env: { PATH: `${bin}:${process.env.PATH}` } });
  try {
    const { g, srv, remote, id, events } = s;
    await remote.connect(id);
    const t0 = Date.now();
    const pending = g.status(dir).then(
      () => 'answered',
      (err) => err,
    );
    await sleep(800);
    srv.dropAll();
    const err = await pending;
    assert.ok(err instanceof Error && err.lost === true, String(err?.message ?? err));
    assert.ok(Date.now() - t0 < 4000, `said in ${Date.now() - t0} ms`);
    assert.equal(remote.isConnected(id), false);
    assert.ok(events.some((e) => e.id === id && e.state === 'disconnected'));
    // Not connected now: asked not to connect, it says so at once.
    await assert.rejects(remote.runArgs(id, 'echo hi', [], { connect: false }), (e) => e.offline === true && /not connected/.test(e.message));
    // A command that does not answer is stopped at its time limit.
    const t1 = Date.now();
    await assert.rejects(remote.runArgs(id, 'sleep 20', [], { timeout: 700 }), (e) => e.timedOut === true);
    assert.ok(Date.now() - t1 < 4000);
    // The server is still there: the next command connects again and answers.
    const r = await remote.runArgs(id, 'printf %s "$(arg "$1")"', ['back']);
    assert.equal(r.stdout.toString(), 'back');
  } finally {
    await s.done();
  }
});

test('over SSH: a server that cannot be reached is offline; an FTP server has no shell for Git', { skip }, async () => {
  let data = {};
  const remote = createRemote({ store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) }, secrets: { get: () => 'x', set: () => {} }, askHostKey: async () => true });
  // Nothing listens there.
  const free = await startSshServer();
  const port = free.port;
  await free.close();
  const conn = remote.saveConnection({ protocol: 'sftp', name: 'gone', host: '127.0.0.1', port, user: 'u', auth: 'password' });
  await assert.rejects(remote.runArgs(conn.id, 'echo x'), (e) => e.offline === true && /Nothing answers/.test(e.message));
  const ftp = remote.saveConnection({ protocol: 'ftp', name: 'files', host: '127.0.0.1', port: 21, user: 'u' });
  await assert.rejects(remote.runArgs(ftp.id, 'echo x'), (e) => e.noShell === true && /FTP server: Git needs a shell/.test(e.message));
});

test('a Windows SSH server: Git does not run there, and says why (never taken for "no repository")', { skip }, async () => {
  // SFTP gives a Windows server's paths as /C:/…
  const srv = await startSshServer({ sftpServer: null, home: '/C:/Users/tester' });
  let data = {};
  const remote = createRemote({ store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) }, secrets: { get: (_id, kind) => (kind === 'password' ? srv.password : ''), set: () => {} }, askHostKey: async () => true });
  const conn = remote.saveConnection({ protocol: 'sftp', name: 'win-box', host: '127.0.0.1', port: srv.port, user: srv.user, auth: 'password' });
  const g = gitWith((script, args, opts) => remote.runArgs(conn.id, script, args, opts), 'win-box');
  try {
    await assert.rejects(g.status('/C:/Users/tester/app'), (err) => err.unusable === true && /win-box runs Windows: Git runs there only on Linux and macOS servers/.test(err.message));
    await assert.rejects(g.info('/C:/Users/tester/app'), (err) => err.unusable === true);
    assert.deepEqual(srv.execs, [], 'nothing was run there');
  } finally {
    remote.disconnectAll();
    await srv.close();
  }
});

// ---- In a place: the fake docker -------------------------------------------------------------

function fakeDocker({ busybox = false } = {}) {
  const root = tmp('git-place-');
  const bin = path.join(root, 'bin');
  const app = path.join(root, 'ctr', 'app');
  const home = path.join(root, 'ctr', 'home');
  for (const d of [bin, app, home]) fs.mkdirSync(d, { recursive: true });
  let Path;
  if (busybox) {
    Path = path.join(root, 'bb');
    fs.mkdirSync(Path);
    for (const name of spawnSync(BUSYBOX, ['--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)) fs.symlinkSync(BUSYBOX, path.join(Path, name));
  }
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`, { mode: 0o755 });
  const statePath = path.join(root, 'docker.json');
  fs.writeFileSync(statePath, JSON.stringify({ containers: [{ Name: 'web-1', Image: busybox ? 'alpine' : 'node:22', State: 'running', WorkingDir: app, Home: home, ...(Path ? { Path } : {}) }] }));
  const tool = { program: path.join(bin, 'docker'), env: { ...process.env, ...IDENTITY, FAKE_DOCKER_STATE: statePath } };
  let data = {};
  const remote = createRemote({ store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) }, secrets: { get: () => '', set: () => {} }, askHostKey: async () => false, placeTools: places.createPlaceTools({ docker: tool, wsl: null }) });
  const conn = remote.saveConnection({ protocol: 'docker', container: 'web-1' });
  return { root, app, Path, remote, id: conn.id, g: gitWith((script, args, opts) => remote.runArgs(conn.id, script, args, opts), 'web-1 (Docker)') };
}

test('in a Docker container (the fake docker): status, HEAD and a commit with its git', { skip }, async () => {
  const p = fakeDocker();
  try {
    gitHere(p.app, 'init', '-q', '-b', 'main');
    gitHere(p.app, 'config', 'user.name', 't');
    gitHere(p.app, 'config', 'user.email', 't@example.org');
    fs.writeFileSync(path.join(p.app, 'server.js'), 'const port = 3000;\n');
    gitHere(p.app, 'add', '.');
    gitHere(p.app, 'commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(p.app, 'server.js'), 'const port = 8080;\n');
    const st = await p.g.status(p.app);
    assert.deepEqual([st.root, st.branch, st.files], [p.app, 'main', { 'server.js': 'M' }]);
    assert.equal((await p.g.headBytes(path.join(p.app, 'server.js'))).bytes.toString(), 'const port = 3000;\n');
    await p.g.act(p.app, { op: 'stage-all' });
    await p.g.act(p.app, { op: 'commit', message: 'Port 8080 in the container' });
    assert.equal(gitHere(p.app, 'log', '-1', '--format=%s').trim(), 'Port 8080 in the container');
    assert.equal(toUri(p.id, st.root), `remote://${p.id}${p.app}`);
  } finally {
    p.remote.disconnectAll();
  }
});

test('busybox only (an Alpine container): the scripts run with its sh; git missing offers apk add git, then works once there', { skip: skip || (!BUSYBOX && 'no busybox here') }, async () => {
  const p = fakeDocker({ busybox: true });
  try {
    gitHere(p.app, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(p.app, 'a b.txt'), 'x\n');
    const hasOwnGit = ['/usr/local/bin/git', '/opt/homebrew/bin/git', '/snap/bin/git'].some((f) => fs.existsSync(f));
    if (!hasOwnGit) {
      assert.equal(await p.g.status(p.app), null);
      fs.writeFileSync(path.join(p.Path, 'apk'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const info = await p.g.info(p.app);
      assert.equal(info.installed, false);
      assert.match(info.install.command, /^(sudo )?apk add git$/);
    }
    // Installed (linked in): busybox's sh runs every script with real git.
    fs.symlinkSync(GIT, path.join(p.Path, 'git'));
    const info = await p.g.info(p.app);
    assert.equal(info.installed, true);
    const st = await p.g.status(p.app);
    assert.deepEqual(st.files, { 'a b.txt': 'U' });
    const runner = shellRunner({ run: (script, args, opts) => p.remote.runArgs(p.id, script, args, opts), where: () => 'web-1' });
    assert.deepEqual(await runner.exists([path.join(p.app, 'a b.txt'), path.join(p.app, 'none')]), [true, false]);
    await runner.writeFile(path.join(p.app, 'w.txt'), Buffer.from('written\n'));
    assert.equal((await runner.readFile(path.join(p.app, 'w.txt'))).bytes.toString(), 'written\n');
    assert.equal(await runner.realpath(p.app), p.app);
  } finally {
    p.remote.disconnectAll();
  }
});

// ---- The words: install commands, Git's errors, the model's picture ---------------------------

test('the command that installs git there: by package manager, root or sudo, the system', () => {
  assert.deepEqual(installCommand({ managers: ['apt-get'], root: true }), { command: 'apt-get update && apt-get install -y git', manager: 'apt-get', asRoot: false });
  assert.deepEqual(installCommand({ managers: ['apt-get'], sudo: true }), { command: 'sudo apt-get update && sudo apt-get install -y git', manager: 'apt-get', asRoot: false });
  assert.deepEqual(installCommand({ managers: ['apt-get'] }), { command: 'apt-get update && apt-get install -y git', manager: 'apt-get', asRoot: true });
  assert.equal(installCommand({ managers: ['dnf', 'yum'], sudo: true }).command, 'sudo dnf install -y git');
  assert.equal(installCommand({ managers: ['apk'], root: true }).command, 'apk add git');
  assert.equal(installCommand({ managers: ['brew'], sudo: true }).command, 'brew install git', 'never sudo for Homebrew');
  assert.equal(installCommand({ os: 'alpine', root: true }).command, 'apk add git', 'by /etc/os-release when no manager is on PATH');
  assert.equal(installCommand({ os: 'rocky', sudo: true }).command, 'sudo dnf install -y git');
  assert.equal(installCommand({ system: 'Darwin' }).command, 'xcode-select --install');
  assert.equal(installCommand({}), null);
  assert.deepEqual(parseInstallProbe('pm/dnf\npm/yum\nuid/1000\nsudo\nos/fedora\nuname/Linux\n'), { managers: ['dnf', 'yum'], root: false, sudo: true, os: 'fedora', system: 'Linux' });
  assert.match(SHELL_PROLOGUE, /^trap 'printf "\\036TE>%s\\n" "\$\?"' EXIT\n/, 'the end mark, whatever happens');
});

test('Git’s errors and the model’s picture say where Git runs', () => {
  const auth = 'fatal: Authentication failed for https://example.org/a.git';
  assert.match(gitStatus.gitError(auth).message, /^Git could not sign in/);
  const there = gitStatus.gitError(auth, '', { place: { kind: 'docker', name: 'web-1' } });
  assert.equal(there.kind, 'auth');
  assert.match(there.message, /^Git on the container web-1 could not sign in/);
  assert.match(gitStatus.gitError('Please tell me who you are', '', { place: { kind: 'wsl', name: 'Ubuntu' } }).message, /^Git on Ubuntu \(WSL\) does not know your name.*in a terminal there/);
  assert.equal(gitStatus.gitError("git: 'switch' is not a git command. See 'git --help'.").kind, 'old');
  assert.match(gitStatus.gitError("git: 'switch' is not a git command.", '', { place: { kind: 'ssh', name: 'old-box' } }).message, /Git on the server old-box is too old/);
  assert.equal(gitStatus.placeWords(null), '');
  const snap = { root: '/srv/app', status: { branch: 'main', staged: {}, unstaged: {} }, branches: { local: [], remote: [] }, place: { kind: 'ssh', name: 'build-box' } };
  assert.match(snapshotText(snap), /^Repository: \/srv\/app\nWhere: on the SSH server build-box\. Every step runs there/);
  assert.doesNotMatch(snapshotText({ ...snap, place: undefined }), /Where:/);
});
