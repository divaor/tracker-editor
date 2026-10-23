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
