// The history view's requests and words (app/js/gitHistory.js): the search box read as words and
// an author, what a tab asks git.cjs for, paths inside the repository, ref chips (a branch and
// its remote's twin as one), the commit menu and the questions asked before a change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionQuestion, chipRef, chipText, chipTitle, commitCount, commitMenu, fileSides, graphShown, historyName, historyRequest, parseHistorySearch, pathIn, refChips, refLabel, relIn } from '../app/js/gitHistory.js';

test('the search box: words of the message, author:name, @name, a quoted author', () => {
  assert.deepEqual(parseHistorySearch('fix login'), { query: 'fix login', author: '' });
  assert.deepEqual(parseHistorySearch('author:ann fix  login'), { query: 'fix login', author: 'ann' });
  assert.deepEqual(parseHistorySearch('fix @bob'), { query: 'fix', author: 'bob' });
  assert.deepEqual(parseHistorySearch('Author:"Ann Lee" parser'), { query: 'parser', author: 'Ann Lee' });
  assert.deepEqual(parseHistorySearch('mail@example.org'), { query: 'mail@example.org', author: '' }, 'an @ inside a word is a word');
  assert.deepEqual(parseHistorySearch('a\nb'), { query: 'a b', author: '' });
  assert.deepEqual(parseHistorySearch(null), { query: '', author: '' });
});

test('what a tab asks for: every branch or one, a search, a folder, a file followed', () => {
  assert.deepEqual(historyRequest({ root: '/r' }), { op: 'history', skip: 0, limit: 200 });
  assert.deepEqual(historyRequest({ root: '/r', ref: 'main', query: 'fix @ann' }, { skip: 200 }), { op: 'history', skip: 200, limit: 200, ref: 'main', query: 'fix', author: 'ann' });
  assert.deepEqual(historyRequest({ root: '/r', folder: 'src' }), { op: 'history', skip: 0, limit: 200, path: 'src' });
  assert.deepEqual(historyRequest({ root: '/r', file: '/r/src/a.js', rel: 'src/a.js', folder: 'x' }, { limit: 50 }), { op: 'history', skip: 0, limit: 50, path: 'src/a.js', follow: true });
  assert.equal(graphShown({ root: '/r' }), true);
  assert.equal(graphShown({ root: '/r', folder: 'src', ref: 'main' }), true);
  assert.equal(graphShown({ root: '/r', query: '@ann' }), false);
  assert.equal(graphShown({ root: '/r', file: '/r/a', rel: 'a' }), false);
});

test('paths inside the repository: here, on Windows (any case), on a server; outside: null', () => {
  assert.equal(relIn('/home/me/repo', '/home/me/repo/src/a.js'), 'src/a.js');
  assert.equal(relIn('/home/me/repo/', '/home/me/repo'), '');
  assert.equal(relIn('/home/me/repo', '/home/me/repository/a.js'), null);
  assert.equal(relIn('C:\\Work\\Repo', 'c:\\work\\repo\\src\\a.js'), 'src/a.js');
  assert.equal(relIn('remote://abc/srv/app', 'remote://abc/srv/app/lib/x.py'), 'lib/x.py');
  assert.equal(relIn('', '/a'), null);
  assert.equal(pathIn('/home/me/repo', 'src/a.js'), '/home/me/repo/src/a.js');
  assert.equal(pathIn('C:\\Work\\Repo\\', 'src/a.js'), 'C:\\Work\\Repo\\src\\a.js');
  assert.equal(pathIn('remote://abc/srv/app', 'lib/x.py'), 'remote://abc/srv/app/lib/x.py');
  assert.equal(pathIn('/r', ''), '/r');
});

test('names: the tab, the ref picker, counts', () => {
  assert.equal(historyName({ root: '/home/me/repo' }), 'History · repo');
  assert.equal(historyName({ root: '/home/me/repo', folder: 'src/lib' }), 'History · repo/src/lib');
  assert.equal(historyName({ root: '/home/me/repo', file: '/home/me/repo/src/a.js', rel: 'src/a.js' }), 'History of a.js');
  assert.equal(refLabel(''), 'All branches');
  assert.equal(refLabel('HEAD', 'main'), 'Current branch (main)');
  assert.equal(refLabel('HEAD', ''), 'Current commit (HEAD)');
  assert.equal(refLabel('v1.2'), 'v1.2');
  assert.equal(commitCount(1), '1 commit');
  assert.equal(commitCount(200, true), '200+ commits');
  assert.equal(commitCount(0), '0 commits');
});

test('ref chips: a branch and its remote twin as one; the rest counted; titles and what a click shows', () => {
  const refs = [
    { kind: 'head', name: 'main' },
    { kind: 'branch', name: 'dev' },
    { kind: 'remote', name: 'origin/main' },
    { kind: 'remote', name: 'upstream/main' },
    { kind: 'remote', name: 'origin/other' },
    { kind: 'tag', name: 'v1' },
  ];
  const { shown, rest } = refChips(refs, 3);
  assert.deepEqual(shown.map(chipText), ['main ⇅ origin, upstream', 'dev', 'origin/other']);
  assert.deepEqual(rest.map(chipText), ['v1']);
  assert.match(chipTitle(shown[0]), /checked out.*origin\/main and upstream\/main/);
  assert.equal(chipTitle({ kind: 'detached', name: 'HEAD' }), 'HEAD: checked out on no branch');
  assert.equal(chipRef({ kind: 'detached', name: 'HEAD' }), 'HEAD');
  assert.equal(chipRef(shown[2]), 'origin/other');
  assert.deepEqual(refChips(undefined), { shown: [], rest: [] });
  // A remote branch with no local twin stays itself.
  assert.deepEqual(refChips([{ kind: 'remote', name: 'origin/x' }]).shown, [{ kind: 'remote', name: 'origin/x' }]);
});

test('the commit menu: what applies to a commit, a merge, HEAD, a file’s history', () => {
  const commit = { hash: 'a'.repeat(40), parents: ['b'.repeat(40)], subject: 'Fix it' };
  const ids = (items) => items.filter((i) => !i.separator).map((i) => i.id);
  const menu = commitMenu(commit, { head: 'c'.repeat(40), branch: 'main' });
  assert.deepEqual(ids(menu), ['copy-hash', 'copy-subject', 'compare-now', 'branch', 'switch', 'tag', 'cherry-pick', 'revert', 'reset-soft', 'reset-mixed', 'reset-hard']);
  assert.equal(menu.find((i) => i.id === 'cherry-pick').label, 'Cherry-pick onto main…');
  assert.equal(menu.find((i) => i.id === 'reset-hard').danger, true);
  const atHead = commitMenu(commit, { head: commit.hash, branch: 'main' });
  for (const id of ['cherry-pick', 'reset-soft', 'reset-mixed']) assert.equal(atHead.find((i) => i.id === id).disabled, true, id);
  assert.ok(!atHead.find((i) => i.id === 'reset-hard').disabled, 'a hard reset to HEAD throws changes away: still offered');
  const merge = commitMenu({ ...commit, parents: ['b', 'c'] }, { branch: '' });
  assert.equal(merge.find((i) => i.id === 'cherry-pick').disabled, true);
  assert.equal(merge.find((i) => i.id === 'cherry-pick').label, 'Cherry-pick onto HEAD…');
  const file = commitMenu(commit, { file: true });
  assert.deepEqual(ids(file).slice(0, 4), ['copy-hash', 'copy-subject', 'file-change', 'file-now']);
  assert.ok(!ids(file).includes('compare-now'));
  assert.deepEqual(commitMenu(null), []);
});

test('the questions before a change: what each does, a backup first, a merge reverted on its first parent', () => {
  const commit = { hash: 'a'.repeat(40), parents: ['b'.repeat(40)], subject: 'Fix it' };
  const pick = actionQuestion('cherry-pick', commit, { branch: 'main' });
  assert.deepEqual(pick.action, { op: 'cherry-pick', rev: commit.hash });
  assert.equal(pick.backup, true);
  assert.match(pick.body, /applied to main/);
  const revert = actionQuestion('revert', commit, { branch: 'main' });
  assert.deepEqual(revert.action, { op: 'revert', rev: commit.hash });
  const revertMerge = actionQuestion('revert', { ...commit, parents: ['b', 'c'] }, { branch: 'main' });
  assert.deepEqual(revertMerge.action, { op: 'revert', rev: commit.hash, mainline: 1 });
  assert.match(revertMerge.body, /first parent/);
  const hard = actionQuestion('reset-hard', commit, { branch: 'main' });
  assert.deepEqual([hard.action, hard.danger, hard.backup], [{ op: 'reset', mode: 'hard', rev: commit.hash }, true, true]);
  assert.match(hard.body, /thrown away/);
  assert.deepEqual(actionQuestion('reset-soft', commit, { branch: 'main' }).action, { op: 'reset', mode: 'soft', rev: commit.hash });
  assert.match(actionQuestion('reset-mixed', commit, {}).title, /^Reset HEAD to aaaaaaaa\?$/);
  assert.equal(actionQuestion('tag', commit), null);
  assert.equal(actionQuestion('revert', null), null);
});

test('a commit’s file before and after: added, deleted, renamed, the first commit', () => {
  const c = { hash: 'h2', parents: ['h1', 'm'] };
  assert.deepEqual(fileSides(c, { status: 'M', path: 'a.js' }), { before: { hash: 'h1', path: 'a.js' }, after: { hash: 'h2', path: 'a.js' } });
  assert.deepEqual(fileSides(c, { status: 'A', path: 'n.js' }), { before: null, after: { hash: 'h2', path: 'n.js' } });
  assert.deepEqual(fileSides(c, { status: 'D', path: 'd.js' }), { before: { hash: 'h1', path: 'd.js' }, after: null });
  assert.deepEqual(fileSides(c, { status: 'R', from: 'old.js', path: 'new.js' }), { before: { hash: 'h1', path: 'old.js' }, after: { hash: 'h2', path: 'new.js' } });
  assert.deepEqual(fileSides({ hash: 'h0', parents: [] }, { status: 'M', path: 'a.js' }), { before: null, after: { hash: 'h0', path: 'a.js' } });
});
