// Blame (0.48): `git blame --porcelain` read into commits and lines, on output made here by the real
// git program in a repository of two authors: the first commit (the boundary), a later one with
// the commit before it, lines not committed yet given through --contents -, a file with CRLF line
// endings, a renamed file and a quoted name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NOT_COMMITTED, parseBlame } from '../app/js/gitStatus.js';

function repo() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'git-blame-')));
  const run = (args, { env = {}, input } = {}) => execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'Ana Silva']);
  run(['config', 'user.email', 'ana@example.org']);
  run(['config', 'core.autocrlf', 'false']);
  const ana = { GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' };
  const bruno = { GIT_AUTHOR_NAME: 'Bruno Díaz', GIT_AUTHOR_EMAIL: 'bruno@example.org', GIT_AUTHOR_DATE: '2026-10-30T09:00:00+0100', GIT_COMMITTER_DATE: '2026-10-30T09:00:00+0100' };
  return { dir, run, ana, bruno };
}

test('two authors: the first commit is the boundary, the later one names the commit before it', () => {
  const { dir, run, ana, bruno } = repo();
  writeFileSync(path.join(dir, 'a.js'), 'one\ntwo\nthree\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'First lines'], { env: ana });
  writeFileSync(path.join(dir, 'a.js'), 'one\nTWO\nthree\nfour\n');
  run(['commit', '-q', '-am', 'Fix the parser', '-m', 'Longer body.'], { env: bruno });
  const [first, second] = run(['log', '--reverse', '--format=%H']).trim().split('\n');
  const { commits, lines } = parseBlame(run(['blame', '--porcelain', '--', 'a.js']));
  assert.deepEqual(lines, [first, second, first, second]);
  const a = commits[first];
  assert.equal(a.author, 'Ana Silva');
  assert.equal(a.mail, 'ana@example.org');
  assert.equal(a.time, Date.parse('2026-01-01T10:00:00Z') / 1000);
  assert.equal(a.tz, '+0000');
  assert.equal(a.summary, 'First lines');
  assert.equal(a.boundary, true, 'the first commit: where the history blamed ends');
  assert.equal(a.previous, null);
  assert.equal(a.filename, 'a.js');
  assert.equal(a.uncommitted, false);
  const b = commits[second];
  assert.equal(b.author, 'Bruno Díaz', 'UTF-8 names');
  assert.equal(b.mail, 'bruno@example.org');
  assert.equal(b.committer, 'Ana Silva');
  assert.equal(b.tz, '+0100');
  assert.equal(b.summary, 'Fix the parser', 'the first line of the message only');
  assert.equal(b.boundary, false);
  assert.deepEqual(b.previous, { hash: first, filename: 'a.js' });
});

test('the editor’s text through --contents -: lines not committed yet are the all-zero commit', () => {
  const { dir, run, ana, bruno } = repo();
  writeFileSync(path.join(dir, 'a.js'), 'one\ntwo\nthree\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'First lines'], { env: ana });
  writeFileSync(path.join(dir, 'a.js'), 'one\nTWO\nthree\n');
  run(['commit', '-q', '-am', 'Second'], { env: bruno });
  const [first, second] = run(['log', '--reverse', '--format=%H']).trim().split('\n');
  // Not saved: line 3 changed, line 4 added.
  const out = run(['blame', '--porcelain', '--contents', '-', '--', 'a.js'], { input: 'one\nTWO\nthree changed\nfour\n' });
  const { commits, lines } = parseBlame(out);
  assert.deepEqual(lines, [first, second, NOT_COMMITTED, NOT_COMMITTED]);
  assert.equal(commits[NOT_COMMITTED].uncommitted, true);
  assert.deepEqual(commits[NOT_COMMITTED].previous, { hash: second, filename: 'a.js' });
  // A text without its last line break: that line differs too.
  assert.equal(parseBlame(run(['blame', '--porcelain', '--contents', '-', '--', 'a.js'], { input: 'one\nTWO\nthree' })).lines[2], NOT_COMMITTED);
  // As saved: nothing new.
  assert.deepEqual(parseBlame(run(['blame', '--porcelain', '--contents', '-', '--', 'a.js'], { input: 'one\nTWO\nthree\n' })).lines, [first, second, first]);
});

test('CRLF line endings: the text given with the file’s own endings matches what was committed', () => {
  const { dir, run, ana } = repo();
  writeFileSync(path.join(dir, 'w.txt'), 'one\r\ntwo\r\nthree\r\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'CRLF'], { env: ana });
  const head = run(['rev-parse', 'HEAD']).trim();
  const same = parseBlame(run(['blame', '--porcelain', '--contents', '-', '--', 'w.txt'], { input: 'one\r\ntwo\r\nTHREE\r\n' }));
  assert.deepEqual(same.lines, [head, head, NOT_COMMITTED]);
  // The same text with LF endings would differ on every line (why main encodes it as the file is).
  const lf = parseBlame(run(['blame', '--porcelain', '--contents', '-', '--', 'w.txt'], { input: 'one\ntwo\nthree\n' }));
  assert.deepEqual(lf.lines, [NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED]);
  // Output with CRLF (a Windows pipe) reads the same.
  const out = run(['blame', '--porcelain', '--', 'w.txt']);
  assert.deepEqual(parseBlame(out.replace(/\n/g, '\r\n')).lines, [head, head, head]);
  assert.equal(parseBlame(out.replace(/\n/g, '\r\n')).commits[head].summary, 'CRLF');
});

test('a renamed file: older lines name the file as it was called; quoted names are read', () => {
  const { dir, run, ana, bruno } = repo();
  writeFileSync(path.join(dir, 'old.js'), 'alpha\nbeta\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'Start'], { env: ana });
  run(['mv', 'old.js', 'café new.js']);
  writeFileSync(path.join(dir, 'café new.js'), 'alpha\nbeta\ngamma\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'Rename and add'], { env: bruno });
  const [first, second] = run(['log', '--reverse', '--format=%H']).trim().split('\n');
  const { commits, lines } = parseBlame(run(['blame', '--porcelain', '--', 'café new.js']));
  assert.deepEqual(lines, [first, first, second]);
  assert.equal(commits[first].filename, 'old.js', 'the name then');
  // core.quotePath (on by default) writes the name quoted with octal bytes: read back as it is.
  assert.equal(commits[second].filename, 'café new.js');
  assert.equal(parseBlame('1234567890123456789012345678901234567890 1 1 1\nfilename "a\\tb\\"c\\\\d"\n\tx\n').commits['1234567890123456789012345678901234567890'].filename, 'a\tb"c\\d');
});

test('nothing to read, and junk, give nothing', () => {
  assert.deepEqual(parseBlame(''), { commits: {}, lines: [] });
  assert.deepEqual(parseBlame('fatal: no such path\n'), { commits: {}, lines: [] });
  // A line's own text that looks like a header is not one.
  const out = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1\nauthor A\nsummary s\nfilename f\n\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 2 1\n';
  assert.deepEqual(parseBlame(out).lines, ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
});
