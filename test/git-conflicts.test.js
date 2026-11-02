// Git's merge conflicts (gitConflicts.js, pure): finding the blocks, resolving one, the words for
// each operation, the kinds in `git status`, and the model's messages; then the Git panel's ops
// (git.cjs act: conflict-take, conflict-remove, conflict-sides) on real repositories with a merge
// conflict, a rebase conflict and a modify/delete conflict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CONFLICT_KINDS, conflictCount, conflictKind, conflictWords, findConflicts, hasConflictMarkers, mergeMessages, resolutionText, resolveAll, resolveConflict } from '../app/js/gitConflicts.js';
import { parseStatus } from '../app/js/gitStatus.js';
import * as gitStatus from '../app/js/gitStatus.js';

const require = createRequire(import.meta.url);
const { createGit } = require('../electron/git.cjs');

const TWO = ['top', '<<<<<<< HEAD', 'mine 1', 'mine 2', '=======', 'theirs 1', '>>>>>>> feature', 'middle', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> feature', 'end', ''].join('\n');

test('findConflicts: two blocks, their sections, labels and lines', () => {
  const { conflicts, broken } = findConflicts(TWO);
  assert.deepEqual(broken, []);
  assert.equal(conflicts.length, 2);
  const [a, b] = conflicts;
  assert.equal(TWO.slice(a.start, a.end), '<<<<<<< HEAD\nmine 1\nmine 2\n=======\ntheirs 1\n>>>>>>> feature\n');
  assert.equal(TWO.slice(a.ours.from, a.ours.to), 'mine 1\nmine 2\n');
  assert.equal(TWO.slice(a.theirs.from, a.theirs.to), 'theirs 1\n');
  assert.equal(a.base, null);
  assert.deepEqual(a.labels, { ours: 'HEAD', base: '', theirs: 'feature' });
  assert.deepEqual(a.lines, { start: 2, base: 0, sep: 5, end: 7 });
  assert.equal(b.index, 1);
  assert.equal(TWO.slice(b.ours.from, b.ours.to), 'a\n');
  assert.equal(conflictCount(TWO), 2);
  assert.ok(hasConflictMarkers(TWO));
  assert.ok(!hasConflictMarkers('no markers\n=======\n'));
});

test('findConflicts: diff3 and zdiff3 bases, CRLF, empty sides, a block at the very end', () => {
  const diff3 = ['<<<<<<< HEAD', 'x = 2', '||||||| merged common ancestors', 'x = 1', '=======', 'x = 3', '>>>>>>> topic', ''].join('\n');
  const [c] = findConflicts(diff3).conflicts;
  assert.equal(diff3.slice(c.base.from, c.base.to), 'x = 1\n');
  assert.equal(c.labels.base, 'merged common ancestors');
  assert.equal(diff3.slice(c.theirs.from, c.theirs.to), 'x = 3\n');
  // CRLF: markers still found, sections keep their line endings.
  const crlf = diff3.replace(/\n/g, '\r\n');
  const [d] = findConflicts(crlf).conflicts;
  assert.equal(crlf.slice(d.ours.from, d.ours.to), 'x = 2\r\n');
  assert.equal(resolveConflict(crlf, d, 'theirs').insert, 'x = 3\r\n');
  // A side left empty (one side deleted the lines).
  const empty = '<<<<<<< HEAD\n=======\nkept\n>>>>>>> b\n';
  const [e] = findConflicts(empty).conflicts;
  assert.equal(e.ours.from, e.ours.to);
  assert.equal(resolveConflict(empty, e, 'ours').insert, '');
  assert.equal(resolveConflict(empty, e, 'both').insert, 'kept\n');
  // The end marker on the last line without a line break: what replaces it has none either.
  const last = 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b';
  const [f] = findConflicts(last).conflicts;
  assert.equal(f.end, last.length);
  assert.equal(resolveConflict(last, f, 'theirs').insert, 'y');
  assert.equal(resolveConflict(last, f, 'both').insert, 'x\ny');
});

test('findConflicts: plain text that only looks like markers, and broken blocks', () => {
  // A Markdown heading's underline and a quote: no conflict.
  assert.deepEqual(findConflicts('Title\n=======\n\n>>>>>>> not one\n').conflicts, []);
  // Markers must be 7 characters then a space or the end: longer runs are text (inner markers of a
  // recursive merge use more).
  assert.deepEqual(findConflicts('<<<<<<<< x\na\n=======\nb\n>>>>>>> y\n').conflicts, []);
  // Never closed.
  const open = 'a\n<<<<<<< HEAD\nx\n=======\ny\n';
  assert.deepEqual(findConflicts(open), { conflicts: [], broken: [{ line: 2, reason: 'unfinished' }] });
  // A start inside a block: the outer one is broken, a later whole one still found.
  const nested = ['<<<<<<< HEAD', 'x', '<<<<<<< HEAD', 'y', '=======', 'z', '>>>>>>> b', 'tail', '<<<<<<< HEAD', 'p', '=======', 'q', '>>>>>>> b', ''].join('\n');
  const got = findConflicts(nested);
  assert.deepEqual(got.broken, [{ line: 1, reason: 'nested' }]);
  assert.equal(got.conflicts.length, 2, 'the inner block and the later one');
  // `=======` inside the incoming side is text (a heading in the lines that conflict).
  const heading = '<<<<<<< HEAD\nTitle\n-----\n=======\nTitle\n=======\n>>>>>>> b\n';
  const [h] = findConflicts(heading).conflicts;
  assert.equal(heading.slice(h.theirs.from, h.theirs.to), 'Title\n=======\n');
});

test('resolving: each way, both orders, the base, none, and all at once', () => {
  const [a] = findConflicts(TWO).conflicts;
  const apply = (how) => {
    const c = resolveConflict(TWO, a, how);
    return TWO.slice(0, c.from) + c.insert + TWO.slice(c.to);
  };
  assert.ok(apply('ours').startsWith('top\nmine 1\nmine 2\nmiddle\n'));
  assert.ok(apply('theirs').startsWith('top\ntheirs 1\nmiddle\n'));
  assert.ok(apply('both').startsWith('top\nmine 1\nmine 2\ntheirs 1\nmiddle\n'));
  assert.ok(apply('both-theirs-first').startsWith('top\ntheirs 1\nmine 1\nmine 2\nmiddle\n'));
  assert.ok(apply('none').startsWith('top\nmiddle\n'));
  assert.equal(conflictCount(apply('ours')), 1, 'the other block stays');
  assert.equal(resolveAll(TWO, 'theirs'), 'top\ntheirs 1\nmiddle\nb\nend\n');
  assert.equal(resolveAll(TWO, 'ours'), 'top\nmine 1\nmine 2\nmiddle\na\nend\n');
  assert.equal(resolutionText({ ours: 'a\n', base: 'o\n', theirs: 'b\n' }, 'base'), 'o\n');
  // A side whose last line has no break (only at the text's end) still joins on its own line.
  assert.equal(resolutionText({ ours: 'a', theirs: 'b' }, 'both'), 'a\nb');
  assert.throws(() => resolutionText({}, 'sideways'), /Not a way/);
});

test('words for each operation: a rebase swaps who is who; a stash says so', () => {
  assert.equal(conflictWords('merge').title, 'Merge conflict');
  assert.match(conflictWords('rebase').current, /rebasing onto/);
  assert.match(conflictWords('rebase').incoming, /your commit/);
  assert.match(conflictWords('cherry-pick').incoming, /picked/);
  assert.match(conflictWords('revert').incoming, /undone/);
  assert.match(conflictWords(null, { ours: 'Updated upstream', theirs: 'Stashed changes' }).incoming, /stashed/);
  assert.equal(conflictWords(null).current, '');
});

test('the kinds in git status, kept by parseStatus with their XY', () => {
  // porcelain v2 -z: a 'u' line per file in conflict.
  const line = (xy, p) => `u ${xy} N... 100644 100644 100644 100644 aaa bbb ccc ${p}`;
  const out = ['# branch.head main', line('UU', 'src/app.js'), line('DU', 'gone in mine.txt'), line('AA', 'new.md'), '1 .M N... 100644 100644 100644 ddd eee README.md', ''].join('\0');
  const s = parseStatus(out);
  assert.deepEqual(s.conflicts, { 'src/app.js': 'UU', 'gone in mine.txt': 'DU', 'new.md': 'AA' });
  assert.equal(s.files['src/app.js'], 'C');
  assert.equal(s.unstaged['gone in mine.txt'], 'C');
  assert.equal(s.files['README.md'], 'M');
  assert.deepEqual(conflictKind('UU').choices, ['ours', 'theirs']);
  assert.deepEqual(conflictKind('UD').choices, ['keep', 'delete']);
  assert.deepEqual(conflictKind('DD').choices, ['delete']);
  assert.equal(conflictKind('??').label, 'In conflict');
  assert.ok(Object.keys(CONFLICT_KINDS).length === 7);
});

test('the model is asked for the merged lines alone, with the sides, the base and the lines around', () => {
  const [system, user] = mergeMessages({ name: 'app.js', op: 'rebase', labels: { ours: 'HEAD', theirs: 'abc123 (Fix it)', base: 'base' }, before: 'one\ntwo\n', after: 'three\n', ours: 'x = 2\n', base: 'x = 1\n', theirs: 'x = 3\n```\n', language: 'JavaScript' });
  assert.equal(system.role, 'system');
  assert.match(user.content, /File: app\.js/);
  assert.match(user.content, /Conflict while rebasing/);
  assert.match(user.content, /rebasing onto/);
  assert.match(user.content, /Current side \(HEAD\):\n```javascript\nx = 2\n```/);
  assert.match(user.content, /Common ancestor \(base\)/);
  // A side holding ``` gets a longer fence, so it stays whole.
  assert.match(user.content, /Incoming side \(abc123 \(Fix it\)\):\n````javascript\nx = 3\n```\n````/);
  assert.match(user.content, /Lines before the conflict:[\s\S]*two/);
  assert.match(user.content, /one fenced code block/);
  const noBase = mergeMessages({ name: 'a.txt', ours: 'a\n', theirs: 'b\n' })[1].content;
  assert.ok(!/Common ancestor/.test(noBase));
});

// ---- The ops on real repositories ----

const GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const skip = !GIT && 'needs git';
const ident = { GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.org' };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflicts-'));
  const git = (...args) => execFileSync(GIT, args, { cwd: dir, env: { ...process.env, ...ident, GIT_EDITOR: 'true' }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const tryGit = (...args) => spawnSync(GIT, args, { cwd: dir, env: { ...process.env, ...ident, GIT_EDITOR: 'true' }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 't@example.org');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  return { dir, git, tryGit, write, read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8') };
}
const tool = () => createGit({ parseStatus, parse: gitStatus });

test("a merge conflict: the panel's kinds, each side's text, use one side for a whole file, then continue", { skip }, async () => {
  const r = repo();
  r.write('app.js', 'const a = 1;\nconst b = 2;\n');
  r.write('notes.md', '# Notes\nfirst\n');
  r.git('add', '.');
  r.git('commit', '-q', '-m', 'base');
  r.git('switch', '-q', '-c', 'feature');
  r.write('app.js', 'const a = 10;\nconst b = 2;\n');
  r.write('notes.md', '# Notes\nfeature\n');
  r.git('commit', '-q', '-am', 'feature');
  r.git('switch', '-q', 'main');
  r.write('app.js', 'const a = 100;\nconst b = 2;\n');
  r.write('notes.md', '# Notes\nmain\n');
  r.git('commit', '-q', '-am', 'main');
  assert.notEqual(r.tryGit('merge', 'feature').status, 0, 'the merge stops on conflicts');
  const git = tool();
  const status = await git.status(r.dir);
  assert.deepEqual(status.conflicts, { 'app.js': 'UU', 'notes.md': 'UU' });
  assert.equal(await git.act(r.dir, { op: 'in-progress' }), 'merge');
  const sides = await git.act(r.dir, { op: 'conflict-sides', path: 'app.js' });
  assert.equal(sides.base.toString('utf8'), 'const a = 1;\nconst b = 2;\n');
  assert.equal(sides.ours.toString('utf8'), 'const a = 100;\nconst b = 2;\n');
  assert.equal(sides.theirs.toString('utf8'), 'const a = 10;\nconst b = 2;\n');
  // The working file holds the markers.
  assert.equal(conflictCount(r.read('app.js')), 1);
  // Use the incoming side for notes.md: checked out from :3: and staged.
  await git.act(r.dir, { op: 'conflict-take', paths: ['notes.md'], side: 'theirs' });
  assert.equal(r.read('notes.md'), '# Notes\nfeature\n');
  let now = await git.status(r.dir);
  assert.deepEqual(now.conflicts, { 'app.js': 'UU' });
  // app.js resolved by hand (the editor), then marked resolved with the stage op.
  r.write('app.js', resolveAll(r.read('app.js'), 'ours'));
  await git.act(r.dir, { op: 'stage', paths: ['app.js'] });
  now = await git.status(r.dir);
  assert.deepEqual(now.conflicts, {});
  await git.act(r.dir, { op: 'continue', what: 'merge' });
  assert.equal(await git.act(r.dir, { op: 'in-progress' }), null);
  assert.equal(r.git('log', '-1', '--format=%P').trim().split(' ').length, 2, 'a merge commit with two parents');
  assert.equal(r.read('app.js'), 'const a = 100;\nconst b = 2;\n');
  // Paths are checked: nothing outside the repository, no other side.
  await assert.rejects(git.act(r.dir, { op: 'conflict-take', paths: ['../x'], side: 'ours' }), /Not files of this repository/);
  await assert.rejects(git.act(r.dir, { op: 'conflict-take', paths: ['app.js'], side: 'both' }), /Not a side/);
  await assert.rejects(git.act(r.dir, { op: 'conflict-sides', path: '/etc/passwd' }), /Not a file of this repository/);
});

test('a rebase conflict: "current" is the branch rebased onto, "incoming" your commit; continue finishes it', { skip }, async () => {
  const r = repo();
  r.write('config.txt', 'port = 80\n');
  r.git('add', '.');
  r.git('commit', '-q', '-m', 'base');
  r.git('switch', '-q', '-c', 'mine');
  r.write('config.txt', 'port = 8080\n');
  r.git('commit', '-q', '-am', 'mine: 8080');
  r.git('switch', '-q', 'main');
  r.write('config.txt', 'port = 443\n');
  r.git('commit', '-q', '-am', 'main: 443');
  r.git('switch', '-q', 'mine');
  assert.notEqual(r.tryGit('rebase', 'main').status, 0);
  const git = tool();
  assert.equal(await git.act(r.dir, { op: 'in-progress' }), 'rebase');
  const [c] = findConflicts(r.read('config.txt')).conflicts;
  // Git's own labels: HEAD is main's commit, the incoming one is mine's.
  assert.equal(r.read('config.txt').slice(c.ours.from, c.ours.to), 'port = 443\n');
  assert.match(c.labels.theirs, /mine: 8080/);
  const sides = await git.act(r.dir, { op: 'conflict-sides', path: 'config.txt' });
  assert.equal(sides.ours.toString('utf8'), 'port = 443\n', ':2: is the branch rebased onto');
  assert.equal(sides.theirs.toString('utf8'), 'port = 8080\n', ':3: is your commit');
  // Use "incoming" (your commit) for the file, then continue the rebase (no editor opens).
  await git.act(r.dir, { op: 'conflict-take', paths: ['config.txt'], side: 'theirs' });
  await git.act(r.dir, { op: 'continue', what: 'rebase' });
  assert.equal(await git.act(r.dir, { op: 'in-progress' }), null);
  assert.equal(r.read('config.txt'), 'port = 8080\n');
  assert.equal(r.git('log', '--format=%s', '-2').trim(), 'mine: 8080\nmain: 443');
});

test('a modify/delete conflict: keep the file, or delete it', { skip }, async () => {
  for (const choice of ['keep', 'delete']) {
    const r = repo();
    r.write('old.txt', 'one\n');
    r.write('stay.txt', 'x\n');
    r.git('add', '.');
    r.git('commit', '-q', '-m', 'base');
    r.git('switch', '-q', '-c', 'feature');
    r.git('rm', '-q', 'old.txt');
    r.git('commit', '-q', '-m', 'remove old.txt');
    r.git('switch', '-q', 'main');
    r.write('old.txt', 'one, changed\n');
    r.git('commit', '-q', '-am', 'change old.txt');
    assert.notEqual(r.tryGit('merge', 'feature').status, 0);
    const git = tool();
    const status = await git.status(r.dir);
    assert.deepEqual(status.conflicts, { 'old.txt': 'UD' }, 'changed on the current side, deleted on the incoming');
    const sides = await git.act(r.dir, { op: 'conflict-sides', path: 'old.txt' });
    assert.equal(sides.theirs, null, 'no incoming side for a file it deleted');
    assert.equal(sides.ours.toString('utf8'), 'one, changed\n');
    if (choice === 'keep') await git.act(r.dir, { op: 'stage', paths: ['old.txt'] });
    else await git.act(r.dir, { op: 'conflict-remove', paths: ['old.txt'] });
    assert.deepEqual((await git.status(r.dir)).conflicts, {});
    await git.act(r.dir, { op: 'continue', what: 'merge' });
    assert.equal(fs.existsSync(path.join(r.dir, 'old.txt')), choice === 'keep', choice);
  }
});
