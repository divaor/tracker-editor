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
});
