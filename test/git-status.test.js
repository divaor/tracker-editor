// Git: `git status` read into codes per file, folders that hold changes, and the lines of a
// file that changed since the last commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineChanges, parseStatus, statusOf } from '../app/js/gitStatus.js';

test('git status, porcelain v2: branch, ahead/behind, a code per file', () => {
  const out = [
    '# branch.oid 1234',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.js',
    '1 A. N... 000000 100644 100644 000 ccc src/new file.js',
    '1 D. N... 100644 000000 000000 ddd 000 old.txt',
    '2 R. N... 100644 100644 100644 eee eee R100 docs/b.md',
    'docs/a.md',
    'u UU N... 100644 100644 100644 100644 f1 f2 f3 merge.txt',
    '? notes/todo.md',
    '',
  ].join('\0');
  const s = parseStatus(out);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.files, { 'src/app.js': 'M', 'src/new file.js': 'A', 'old.txt': 'D', 'docs/b.md': 'R', 'merge.txt': 'C', 'notes/todo.md': 'U' });
  assert.equal(parseStatus('# branch.head (detached)\0').branch, 'detached');
  // Folders: a dot when something inside changed (a conflict says so).
  assert.equal(statusOf(s.files, 'src', true), 'dot');
  assert.equal(statusOf(s.files, 'notes', true), 'dot');
  assert.equal(statusOf(s.files, 'lib', true), null);
  assert.equal(statusOf(s.files, '', true), 'C');
  assert.equal(statusOf(s.files, 'src/app.js'), 'M');
  assert.equal(statusOf(s.files, 'src/other.js'), null);
});

test('changed lines since the last commit', () => {
  const before = 'a\nb\nc\nd\ne\n';
  assert.deepEqual(lineChanges(before, before), []);
  assert.deepEqual(lineChanges(before, 'a\nb\nX\nd\ne\n'), [{ kind: 'modified', from: 3, to: 3 }]);
  assert.deepEqual(lineChanges(before, 'a\nb\nnew1\nnew2\nc\nd\ne\n'), [{ kind: 'added', from: 3, to: 4 }]);
  assert.deepEqual(lineChanges(before, 'a\nd\ne\n'), [{ kind: 'deleted', at: 1 }]);
  assert.deepEqual(lineChanges(before, 'b\nc\nd\ne\n'), [{ kind: 'deleted', at: 0 }]);
  assert.deepEqual(lineChanges(before, 'Z\nb\nc\nd\ne\nf\n'), [{ kind: 'modified', from: 1, to: 1 }, { kind: 'added', from: 6, to: 6 }]);
  assert.deepEqual(lineChanges('', 'x\ny'), [{ kind: 'modified', from: 1, to: 2 }]);
  // Too different: null rather than slow.
  const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
  const other = Array.from({ length: 3000 }, (_, i) => `m${i}`).join('\n');
  assert.equal(lineChanges(big, other, { maxEdits: 100 }), null);
});

test('changed lines: random edits are found exactly', () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: 5 + rand(30) }, () => `w${rand(8)}`);
    const b = [...a];
    for (let e = 0; e < 1 + rand(5); e++) {
      const at = rand(b.length + 1);
      const what = rand(3);
      if (what === 0) b.splice(at, 0, `n${rand(1000)}`);
      else if (what === 1 && b.length > 1) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = `x${rand(1000)}`;
    }
    const changes = lineChanges(a.join('\n'), b.join('\n'));
    assert.ok(changes, 'found');
    // Every line marked added or modified differs from the old text at a matching place,
    // and the unmarked lines are the old ones in order.
    const marked = new Set();
    for (const c of changes) if (c.kind !== 'deleted') for (let l = c.from; l <= c.to; l++) marked.add(l);
    const kept = b.filter((_, i) => !marked.has(i + 1));
    let k = 0;
    for (const line of a) if (k < kept.length && line === kept[k]) k++;
    assert.equal(k, kept.length, `unmarked lines are old ones in order (round ${round})`);
  }
});

test('staged and not staged, apart', async () => {
  const { parseStatus, canCommit } = await import('../app/js/gitStatus.js');
  const out = ['# branch.head main', '1 M. N... 100644 100644 100644 a b both.js', '1 .M N... 100644 100644 100644 a b only-here.js', '1 MM N... 100644 100644 100644 a b both-ways.js', '1 A. N... 000000 100644 100644 0 b added.js', '2 R. N... 100644 100644 100644 a b R100 new name.js', 'old name.js', '? fresh.txt', ''].join('\0');
  const s = parseStatus(out);
  assert.deepEqual(s.staged, { 'both.js': 'M', 'both-ways.js': 'M', 'added.js': 'A', 'new name.js': 'R' });
  assert.deepEqual(s.unstaged, { 'only-here.js': 'M', 'both-ways.js': 'M', 'fresh.txt': 'U' });
  assert.equal(canCommit(s), true);
  assert.equal(canCommit(parseStatus(['# branch.head main', 'u UU N... 100644 100644 100644 100644 a b c x.js', '1 M. N... 100644 100644 100644 a b y.js', ''].join('\0'))), false, 'a file in conflict');
  assert.equal(canCommit(parseStatus('# branch.head main\0? a\0')), false, 'nothing staged');
});

test('one change staged at a time: changes, additions and removals', async () => {
  const { stageBlock, diffBlocks } = await import('../app/js/gitStatus.js');
  const index = 'a\nb\nc\nd\ne\n';
  const now = 'a\nB\nc\ne\nf\n';
  assert.deepEqual(diffBlocks(index, now), [
    { aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 },
    { aFrom: 3, aTo: 4, bFrom: 3, bTo: 3 },
    { aFrom: 5, aTo: 5, bFrom: 4, bTo: 5 },
  ]);
  assert.equal(stageBlock(index, now, 2), 'a\nB\nc\nd\ne\n');
  // d's removal shows on the line before it (c, line 3).
  assert.equal(stageBlock(index, now, 3), 'a\nb\nc\ne\n');
  assert.equal(stageBlock(index, now, 5), 'a\nb\nc\nd\ne\nf\n');
  assert.equal(stageBlock(index, now, 1), null, 'nothing changed there');
  assert.equal(stageBlock(now, now, 2), null);
});

test('branches and stashes as Git lists them', async () => {
  const { parseBranches, parseStashes, branchNameProblem } = await import('../app/js/gitStatus.js');
  const out = ['refs/heads/main\0origin/main\0[ahead 1, behind 2]\x002 hours ago\0*', 'refs/heads/old\0origin/old\0[gone]\x003 weeks ago\0 ', 'refs/remotes/origin/HEAD\0\0\0\0 ', 'refs/remotes/origin/main\0\0\x001 hour ago\0 ', 'refs/remotes/up/feature/x\0\0\x00yesterday\0 ', ''].join('\n');
  const b = parseBranches(out);
  assert.deepEqual(b.local.map((x) => [x.name, x.current, x.ahead, x.behind, x.gone]), [['main', true, 1, 2, false], ['old', false, 0, 0, true]]);
  assert.deepEqual(b.remote.map((x) => [x.name, x.remote, x.branch]), [['origin/main', 'origin', 'main'], ['up/feature/x', 'up', 'feature/x']]);
  assert.deepEqual(parseStashes('stash@{0}\0On main: half done\x005 minutes ago\nstash@{1}\0WIP on main: 1a2b3c first\x00yesterday\n'), [
    { ref: 'stash@{0}', message: 'half done', when: '5 minutes ago' },
    { ref: 'stash@{1}', message: 'Work in progress: 1a2b3c first', when: 'yesterday' },
  ]);
  assert.equal(branchNameProblem('feature/login'), '');
  for (const bad of ['', 'two words', '-x', 'a..b', 'x.lock', 'a/.b', 'a~1', 'ends/']) assert.notEqual(branchNameProblem(bad), '', bad);
});

test('Git’s messages in words', async () => {
  const { gitError } = await import('../app/js/gitStatus.js');
  const kind = (stderr, stdout = '') => gitError(stderr, stdout).kind;
  assert.equal(kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), 'auth');
  assert.equal(kind('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'auth');
  assert.equal(kind('Author identity unknown\n\n*** Please tell me who you are.'), 'identity');
  assert.equal(kind('hint: Diverging branches can\'t be fast-forwarded\nfatal: Not possible to fast-forward, aborting.'), 'diverged');
  assert.equal(kind(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'), 'rejected');
  assert.equal(kind('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt'), 'conflict');
  assert.equal(kind('', 'On branch main\nnothing to commit, working tree clean'), 'nothing');
  assert.equal(kind('fatal: No configured push destination.'), 'noremote');
  assert.equal(kind('There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.'), 'noupstream');
  const other = gitError('remote: Counting objects: 5\nhint: something\nfatal: the disk is full');
  assert.equal(other.kind, 'other');
  assert.equal(other.message, 'fatal: the disk is full');
  // On Windows a refused key names the usual cause: Git's own ssh, without Windows' ssh-agent.
  const denied = 'git@gitlab.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.';
  assert.match(gitError(denied, '', { windows: true }).message, /core\.sshCommand C:\/Windows\/System32\/OpenSSH\/ssh\.exe/);
  assert.doesNotMatch(gitError(denied).message, /sshCommand/, 'not elsewhere');
  assert.doesNotMatch(gitError("fatal: could not read Username for 'https://x': terminal prompts disabled", '', { windows: true }).message, /sshCommand/, 'not for https');
});

// ---- 0.48: reverting one change, the blocks the bar reads, blame's words ----

// Applies a change ({ from, to, insert }) to a text.
const applied = (text, c) => text.slice(0, c.from) + c.insert + text.slice(c.to);

test('reverting one change: the block back as it is at the last commit, the rest left as it is', async () => {
  const { revertBlock, diffBlocks } = await import('../app/js/gitStatus.js');
  const base = 'a\nb\nc\nd\ne\n';
  // Changed lines get the commit's back.
  const changed = 'a\nB\nC\nd\ne\n';
  assert.equal(applied(changed, revertBlock(base, changed, 2)), base);
  assert.equal(applied(changed, revertBlock(base, changed, 3)), base, 'any line of the block');
  assert.deepEqual(revertBlock(base, changed, 2).block, { aFrom: 1, aTo: 3, bFrom: 1, bTo: 3 });
  // Added lines go (with their line break).
  const added = 'a\nb\nnew1\nnew2\nc\nd\ne\n';
  assert.equal(applied(added, revertBlock(base, added, 3)), base);
  assert.equal(revertBlock(base, added, 3).insert, '');
  // Removed lines come back: the mark is on the line before them.
  const removed = 'a\nd\ne\n';
  assert.equal(applied(removed, revertBlock(base, removed, 1)), base);
  assert.equal(revertBlock(base, removed, 2), null, 'nothing changed on the line after');
  assert.equal(revertBlock(base, base, 1), null, 'no change at all');
  assert.equal(revertBlock(base, changed, 5), null, 'an unchanged line');
});

test('reverting at the start and the end of a file, with and without a last line break', async () => {
  const { revertBlock } = await import('../app/js/gitStatus.js');
  const cases = [
    // [base, now, line]
    ['a\nb\nc\n', 'b\nc\n', 1], // first line removed: the mark is on line 1
    ['a\nb\nc\n', 'x\na\nb\nc\n', 1], // a line added at the start
    ['a\nb\nc\n', 'A\nb\nc\n', 1], // the first line changed
    ['a\nb\nc\n', 'a\nb\n', 2], // the last line removed (the text ends with a line break)
    ['a\nb\nc', 'a\nb', 2], // the last line removed (no last line break)
    ['a\nb\n', 'a\nb\nc\n', 3], // a line added at the end
    ['a\nb', 'a\nb\nc', 3], // a line added at the end, no last line break
    ['a\nb', 'a\nB', 2], // the last line changed
    ['x\n', '', 1], // everything removed
    ['', 'x\ny', 1], // everything new
    ['a\nb\nc\n', 'a\nb\nc\nd', 4], // a line added after the last line break
  ];
  for (const [base, now, line] of cases) {
    const change = revertBlock(base, now, line);
    assert.ok(change, `${JSON.stringify(now)} at ${line}`);
    assert.equal(applied(now, change), base, `${JSON.stringify(now)} → ${JSON.stringify(base)}`);
  }
});

test('reverting one of two blocks next to each other leaves the other', async () => {
  const { revertBlock, diffBlocks } = await import('../app/js/gitStatus.js');
  const base = 'one\ntwo\nthree\nfour\nfive\n';
  const now = 'ONE\ntwo\nTHREE\nfour\n';
  const blocks = diffBlocks(base, now);
  assert.equal(blocks.length, 3, 'line 1 changed, line 3 changed, line 5 removed');
  assert.equal(applied(now, revertBlock(base, now, 1, blocks)), 'one\ntwo\nTHREE\nfour\n');
  assert.equal(applied(now, revertBlock(base, now, 3, blocks)), 'ONE\ntwo\nthree\nfour\n');
  assert.equal(applied(now, revertBlock(base, now, 4, blocks)), 'ONE\ntwo\nTHREE\nfour\nfive\n', 'the removal shows on line 4');
  // Back to back: a changed line and lines removed right after it are one block.
  const next = 'one\nTWO\nfive\n';
  assert.deepEqual(diffBlocks(base, next), [{ aFrom: 1, aTo: 4, bFrom: 1, bTo: 2 }]);
  assert.equal(applied(next, revertBlock(base, next, 2)), base);
  // Each block reverted in turn (from the last up) brings the commit's text back.
  let text = 'X\none\ntwo\nthree\nY\nfive\nZ\n';
  for (let guard = 0; guard < 10 && text !== base; guard++) {
    const b = diffBlocks(base, text);
    const last = b[b.length - 1];
    text = applied(text, revertBlock(base, text, last.bFrom === last.bTo ? Math.max(1, last.bFrom) : last.bFrom + 1, b));
  }
  assert.equal(text, base);
});

test('the bar’s changes from the blocks are lineChanges’ own', async () => {
  const { changesOf, diffBlocks, changeIndexAt, markLineOf } = await import('../app/js/gitStatus.js');
  let seed = 11;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: 1 + rand(25) }, () => `w${rand(6)}`);
    const b = [...a];
    for (let e = 0; e < 1 + rand(5); e++) {
      const at = rand(b.length + 1);
      const what = rand(3);
      if (what === 0) b.splice(at, 0, `n${rand(100)}`);
      else if (what === 1 && b.length > 1) b.splice(Math.min(at, b.length - 1), 1);
      else if (b.length) b[Math.min(at, b.length - 1)] = `x${rand(100)}`;
    }
    const before = a.join('\n');
    const now = b.join('\n');
    const blocks = diffBlocks(before, now);
    assert.deepEqual(changesOf(blocks), lineChanges(before, now), `round ${round}`);
    // Every block's mark line finds a block marked there (lines removed before and after the
    // first line share line 1: the first of them).
    blocks.forEach((k, i) => {
      const found = changeIndexAt(blocks, markLineOf(k));
      assert.ok(found !== -1 && found <= i && markLineOf(blocks[found]) === markLineOf(k), `round ${round}, block ${i}`);
    });
  }
});

test('blame moved by an edit: the edited lines are not committed yet, the others keep theirs', async () => {
  const { remapLines } = await import('../app/js/gitStatus.js');
  const lines = ['a', 'b', 'c', 'd'];
  assert.deepEqual(remapLines(lines, [{ aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 }], '0'), ['a', '0', 'c', 'd'], 'a line typed in');
  assert.deepEqual(remapLines(lines, [{ aFrom: 2, aTo: 2, bFrom: 2, bTo: 4 }], '0'), ['a', 'b', '0', '0', 'c', 'd'], 'two lines added');
  assert.deepEqual(remapLines(lines, [{ aFrom: 1, aTo: 3, bFrom: 1, bTo: 1 }], '0'), ['a', 'd'], 'two lines deleted');
  assert.deepEqual(remapLines(lines, [{ aFrom: 0, aTo: 1, bFrom: 0, bTo: 1 }, { aFrom: 3, aTo: 4, bFrom: 3, bTo: 5 }], '0'), ['0', 'b', 'c', '0', '0'], 'two edits');
  // Two cursors on one line: one block.
  assert.deepEqual(remapLines(lines, [{ aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 }, { aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 }], '0'), ['a', '0', 'c', 'd']);
  // The line after the last one (a last line break) typed on.
  assert.deepEqual(remapLines(lines, [{ aFrom: 4, aTo: 5, bFrom: 4, bTo: 5 }], '0'), ['a', 'b', 'c', 'd', '0']);
});

test('blame in words: how long ago, who, the line’s text, how new', async () => {
  const { blameAgo, blameWho, blameLineText, blameAges, NOT_COMMITTED } = await import('../app/js/gitStatus.js');
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  const at = (seconds) => now / 1000 - seconds;
  assert.equal(blameAgo(at(10), now), 'just now');
  assert.equal(blameAgo(at(70), now), 'a minute ago');
  assert.equal(blameAgo(at(5 * 60), now), '5 minutes ago');
  assert.equal(blameAgo(at(3600), now), 'an hour ago');
  assert.equal(blameAgo(at(5 * 3600), now), '5 hours ago');
  assert.equal(blameAgo(at(26 * 3600), now), 'yesterday');
  assert.equal(blameAgo(at(3 * 86400), now), '3 days ago');
  assert.equal(blameAgo(at(15 * 86400), now), '2 weeks ago');
  assert.equal(blameAgo(at(65 * 86400), now), '2 months ago');
  assert.equal(blameAgo(at(400 * 86400), now), 'a year ago');
  assert.equal(blameAgo(at(800 * 86400), now), '2 years ago');
  assert.equal(blameAgo(at(-30), now), 'just now', 'a clock ahead');
  const mine = { hash: 'a'.repeat(40), author: 'Ana Silva', mail: 'Ana@Example.org', time: at(3 * 86400), summary: 'Fix the parser' };
  const theirs = { hash: 'b'.repeat(40), author: 'Bruno Díaz', mail: 'bruno@example.org', time: at(400 * 86400), summary: 'First lines' };
  const me = { name: 'Ana', email: 'ana@example.org' };
  assert.equal(blameWho(mine, me), 'You', 'by the mail, whatever its case');
  assert.equal(blameWho(theirs, me), 'Bruno Díaz');
  assert.equal(blameWho(mine, null), 'Ana Silva');
  assert.equal(blameLineText(mine, me, now), 'You, 3 days ago · Fix the parser');
  assert.equal(blameLineText(theirs, me, now), 'Bruno Díaz, a year ago · First lines');
  assert.equal(blameLineText({ hash: NOT_COMMITTED, uncommitted: true }, me, now), 'You · Not committed yet');
  const ages = blameAges({ [mine.hash]: mine, [theirs.hash]: theirs, [NOT_COMMITTED]: { hash: NOT_COMMITTED, uncommitted: true, time: now / 1000 } });
  assert.equal(ages.get(mine.hash), 1, 'the newest');
  assert.equal(ages.get(theirs.hash), 0, 'the oldest');
  assert.equal(ages.has(NOT_COMMITTED), false);
  assert.equal(blameAges({ [mine.hash]: mine }).get(mine.hash), 1, 'one commit: new');
});
