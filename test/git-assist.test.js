// Git with the model, the page's pure side: the steps the model may propose, how risky each
// is, reading its plan out of a reply, the snapshot in words, commit messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeRequestLink, mergeRequestUrl } from '../app/js/gitStatus.js';
import { CHANGES_FILES, EXPLAIN_ONLY, RECIPES, STEPS, cleanCommitMessage, gitGuide, mergeRequestFor, commitMessageMessages, describeStep, gitMessages, gitSystem, outputOf, parsePlan, resultsMessage, snapshotText, toAction } from '../app/js/gitAssist.js';

test('each step the model is offered is one git.cjs knows', () => {
  const source = readFileSync(new URL('../electron/git.cjs', import.meta.url), 'utf8');
  for (const op of Object.keys(STEPS)) {
    if (STEPS[op].page) continue; // done by the page (opening the merge request page)
    const action = toAction({ op, name: 'x' });
    assert.match(source, new RegExp(`case '${action.op}':`), `${op} → ${action.op}`);
  }
  for (const op of CHANGES_FILES) assert.ok(STEPS[op], op);
});

test('how risky a step is: looks, runs by itself, asks, or warns', () => {
  const risk = (step) => describeStep(step).risk;
  assert.equal(risk({ op: 'log', range: 'main..HEAD' }), 'look');
  assert.equal(risk({ op: 'stage', paths: ['a.txt'] }), 'auto');
  assert.equal(risk({ op: 'stash', untracked: true }), 'auto');
  assert.equal(risk({ op: 'create-branch', name: 'fix/x', from: 'main' }), 'auto');
  assert.equal(risk({ op: 'ignore', patterns: ['*.log'] }), 'auto');
  assert.equal(risk({ op: 'commit', message: 'Fix it' }), 'ask');
  assert.equal(risk({ op: 'commit', message: 'Fix it', amend: true }), 'danger');
  assert.equal(risk({ op: 'push' }), 'ask');
  assert.equal(risk({ op: 'push', force: true }), 'danger');
  assert.equal(risk({ op: 'reset', mode: 'soft', rev: 'HEAD~1' }), 'ask');
  assert.equal(risk({ op: 'reset', mode: 'hard', rev: 'HEAD~1' }), 'danger');
  assert.equal(risk({ op: 'rebase', onto: 'main' }), 'danger');
  assert.equal(risk({ op: 'delete-branch', name: 'old' }), 'danger');
  // Backups before the ones that change history or files; the branch a delete takes is kept.
  assert.equal(describeStep({ op: 'stage', paths: ['a'] }).backup, false);
  assert.equal(describeStep({ op: 'merge', rev: 'feature' }).backup, true);
  assert.deepEqual(describeStep({ op: 'delete-branch', name: 'old', force: true }).keep, ['old']);
  assert.equal(describeStep({ op: 'reset', mode: 'hard', rev: 'HEAD~1' }).cmd, 'git reset --hard HEAD~1');
  assert.equal(describeStep({ op: 'commit', message: 'Fix the login\n\nIt broke.' }).cmd, "git commit -m 'Fix the login' …");
  assert.equal(describeStep({ op: 'stage', paths: ['my file.txt'] }).cmd, "git add -A -- 'my file.txt'");
});

test('steps that are not allowed are left out, saying why', () => {
  assert.match(describeStep({ op: 'clean', force: true }).problem, /not a step/);
  assert.match(describeStep({ op: 'show', rev: '--output=/etc/x' }).problem, /rev/);
  assert.match(describeStep({ op: 'stage', paths: ['../outside'] }).problem, /paths/);
  assert.match(describeStep({ op: 'reset', mode: 'keep', rev: 'HEAD' }).problem, /mode/);
  assert.match(describeStep({ op: 'switch', name: 'a b' }).problem, /name/);
  assert.match(describeStep({ op: 'ignore', patterns: ['ok', 'two\nlines'] }).problem, /patterns/);
  assert.match(describeStep(null).problem, /not a step/);
});

test('a reply: the words, and the steps from its block', () => {
  const reply = `Your branch is 2 commits behind. I will stash, pull and bring your changes back.

\`\`\`git-steps
[
  { "op": "stash", "untracked": true, "why": "keep your edits safe" },
  { "op": "pull", "how": "rebase" },
  { "op": "stash-pop", "ref": "stash@{0}" },
  { "op": "clean" }
]
\`\`\`
`;
  const plan = parsePlan(reply);
  assert.equal(plan.text, 'Your branch is 2 commits behind. I will stash, pull and bring your changes back.');
  assert.deepEqual(plan.steps.map((s) => [s.step.op, s.risk]), [['stash', 'auto'], ['pull', 'ask'], ['stash-pop', 'ask']]);
  assert.equal(plan.steps[0].why, 'keep your edits safe');
  assert.equal(plan.problems.length, 1);
  // A ```json block of steps counts; other code blocks stay in the words.
  const json = parsePlan('Look:\n```json\n{ "op": "log", "count": 5 }\n```\nand run this yourself:\n```sh\ngit clean -n\n```');
  assert.deepEqual(json.steps.map((s) => s.step.op), ['log']);
  assert.match(json.text, /git clean -n/);
  assert.deepEqual(parsePlan('```json\n{"name": "x"}\n```').steps, []);
  assert.deepEqual(parsePlan('```git-steps\n[not json\n```').problems, ['The steps were not valid JSON.']);
  assert.deepEqual(parsePlan('Nothing to do.').steps, []);
});

test('a step as git.cjs’s action: the model’s "why" left out, a new branch a switch', () => {
  assert.deepEqual(toAction({ op: 'create-branch', name: 'fix', from: 'main', why: 'x' }), { op: 'switch', name: 'fix', create: true, from: 'main' });
  assert.deepEqual(toAction({ op: 'reset', mode: 'soft', rev: 'HEAD~2', why: 'squash' }), { op: 'reset', mode: 'soft', rev: 'HEAD~2' });
});

test('the snapshot in words, and the messages for a turn', () => {
  const snap = {
    root: '/work/app',
    status: { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, staged: { 'a.js': 'M' }, unstaged: { 'b.js': 'C', 'new.txt': 'U' } },
    graph: '* abc123 (HEAD -> main) Fix · t, 2 hours ago',
    branches: { local: [{ name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 2, when: 'now' }, { name: 'old', current: false, upstream: '', ahead: 0, behind: 0, gone: true, when: 'a year ago' }], remote: [{ name: 'origin/main', when: 'now' }] },
    stashes: [{ ref: 'stash@{0}', message: 'wip', when: 'yesterday' }],
    inProgress: 'merge',
    remotes: ['origin https://github.com/a/b.git'],
    reflog: 'abc123 HEAD@{0} commit: Fix',
    tags: [],
    identity: { name: true, email: false },
    gitignore: false,
    backups: [{ id: 'k1abc', label: 'git rebase main', at: '2026-10-31T10:00:00Z', branch: 'main', head: '0123456789', changes: 'x' }],
  };
  const t = snapshotText(snap);
  assert.match(t, /On branch: main, following origin\/main \(1 to push, 2 to pull\)/);
  assert.match(t, /IN PROGRESS: a merge/);
  assert.match(t, /email NOT set/);
  assert.match(t, /  M a\.js/);
  assert.match(t, /  C b\.js/);
  assert.match(t, /old .*gone on the remote/);
  assert.match(t, /stash@\{0\}: wip/);
  assert.match(t, /k1abc: before “git rebase main”.*\+ changes not committed/);
  assert.equal(snapshotText(null), 'Not a Git repository.');
  const messages = gitMessages('How do I finish this merge?', snap, [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }]);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, gitSystem(), 'the same each time, so it can be cached');
  assert.match(messages[0].content, /- rebase \{ "onto": "main" \} — danger/);
  assert.match(messages[0].content, /--force-with-lease/);
  assert.equal(messages.length, 4);
  assert.match(messages[3].content, /^How do I finish this merge\?\n\n<repository>\nRepository: \/work\/app/);
});

test('what came of the steps goes back to the model', () => {
  const m = resultsMessage([
    { cmd: 'git stash push', outcome: 'ok', output: 'Saved working directory' },
    { cmd: 'git pull --rebase', outcome: 'failed', output: 'CONFLICT (content): Merge conflict in a.txt' },
    { cmd: 'git stash pop stash@{0}', outcome: 'stopped', output: '' },
  ]);
  assert.match(m, /1\. git stash push — done\n```\nSaved working directory\n```/);
  assert.match(m, /2\. git pull --rebase — FAILED\n```\nCONFLICT/);
  assert.match(m, /3\. git stash pop stash@\{0\} — not run/);
  assert.equal(outputOf({ stdout: 'out\n', stderr: 'err' }), 'out\nerr');
  assert.equal(outputOf('text'), 'text');
  assert.equal(outputOf({ added: ['*.log'], already: 0 }), '{\n "added": [\n  "*.log"\n ],\n "already": 0\n}');
});

test('commit messages: from the staged diff in the repository’s style, cleaned of lead-ins', () => {
  const [system, user] = commitMessageMessages({ diff: 'x'.repeat(30_000), stat: ' a.js | 2 +-', subjects: ['feat: add login', 'fix: typo'], budget: 1000 });
  assert.match(system.content, /imperative/);
  assert.match(user.content, /- feat: add login/);
  assert.match(user.content, /the rest of the diff left out/);
  assert.ok(user.content.length < 2000);
  assert.equal(cleanCommitMessage('```\nAdd the login page\n\nUsers can sign in.\n```'), 'Add the login page\n\nUsers can sign in.');
  assert.equal(cleanCommitMessage('Here’s a commit message:\n\nFix the build'), 'Fix the build');
  assert.equal(cleanCommitMessage('Commit message: Fix the build'), 'Fix the build');
  assert.equal(cleanCommitMessage('"Fix the build"'), 'Fix the build');
});

test('moving work off main: a branch moved without switching, a range of commits copied, a merge reverted', () => {
  const move = describeStep({ op: 'move-branch', name: 'main', to: 'origin/main' });
  assert.equal(move.risk, 'ask');
  assert.equal(move.backup, true);
  assert.deepEqual(move.keep, ['main'], 'its old commit is pinned by the backup');
  assert.equal(move.cmd, 'git branch -f main origin/main');
  assert.equal(describeStep({ op: 'cherry-pick', rev: 'origin/main..main' }).cmd, 'git cherry-pick origin/main..main');
  assert.match(describeStep({ op: 'cherry-pick', rev: 'a....b' }).problem, /rev/);
  assert.equal(describeStep({ op: 'revert', rev: 'abc1234', mainline: 1 }).cmd, 'git revert --no-edit -m 1 abc1234');
  assert.match(describeStep({ op: 'revert', rev: 'abc1234', mainline: 3 }).problem, /mainline/);
  const mr = describeStep({ op: 'open-merge-request', source: 'feature/login', target: 'dev' });
  assert.equal(mr.risk, 'auto');
  assert.equal(mr.page, true);
  assert.match(describeStep({ op: 'open-merge-request', source: '--evil' }).problem, /source/);
});

test('the merge request page: from the push’s answer, or built from the remote’s address', () => {
  assert.deepEqual(mergeRequestLink("remote:\nremote: Create a pull request for 'topic' on GitHub by visiting:\nremote:      https://github.com/a/b/pull/new/topic\nremote:\nTo github.com:a/b.git"), { url: 'https://github.com/a/b/pull/new/topic', label: 'pull request' });
  assert.deepEqual(mergeRequestLink('remote: To create a merge request for feat, visit:\nremote:   https://gitlab.com/t/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat\n'), { url: 'https://gitlab.com/t/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat', label: 'merge request' });
  assert.equal(mergeRequestLink('Everything up-to-date'), null);
  assert.equal(mergeRequestUrl('git@github.com:divaor/tracker-editor.git', 'feature/x', 'dev').url, 'https://github.com/divaor/tracker-editor/compare/dev...feature/x?expand=1');
  assert.equal(mergeRequestUrl('https://github.com/a/b', 'f').url, 'https://github.com/a/b/compare/f?expand=1');
  assert.equal(mergeRequestUrl('https://gitlab.example.com/team/app.git', 'feat', 'dev').url, 'https://gitlab.example.com/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat&merge_request%5Btarget_branch%5D=dev');
  assert.equal(mergeRequestUrl('ssh://git@bitbucket.org/team/app.git', 'f', 'dev').url, 'https://bitbucket.org/team/app/pull-requests/new?source=f&dest=dev');
  assert.equal(mergeRequestUrl('git@ssh.dev.azure.com:v3/org/proj/repo', 'f', 'main').url, 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=f&targetRef=main');
  assert.equal(mergeRequestUrl('https://dev.azure.com/org/proj/_git/repo', 'f').url, 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=f');
  assert.equal(mergeRequestUrl('/srv/git/app.git', 'f'), null, 'a folder: no site');
  assert.equal(mergeRequestUrl('https://git.example.org/app.git', 'f'), null, 'a site the editor does not know');
  const snap = { remotes: ['origin git@github.com:a/b.git', 'upstream git@github.com:up/b.git'] };
  assert.equal(mergeRequestFor(snap, { source: 'f', target: 'dev' }).url, 'https://github.com/a/b/compare/dev...f?expand=1');
  assert.equal(mergeRequestFor(snap, { source: 'f', remote: 'upstream' }).url, 'https://github.com/up/b/compare/f?expand=1');
  assert.equal(mergeRequestFor({ remotes: [] }, { source: 'f' }), null);
});

test('worked examples and “only explain”: the model knows the common cases and the editor’s buttons', () => {
  // The two cases people ask most: work moved off main, and a merge request into dev.
  assert.match(RECIPES, /create-branch at HEAD .* then move-branch main to its upstream/);
  assert.match(RECIPES, /open-merge-request with source the branch and target dev/);
  assert.match(RECIPES, /Never push straight to dev when a merge request is asked for/);
  const guide = readFileSync(new URL('../app/help/guide.md', import.meta.url), 'utf8');
  const part = gitGuide(guide);
  assert.match(part, /^### Git: stage, commit/);
  assert.match(part, /### Git with the model/);
  assert.doesNotMatch(part, /^## 3\. Tabs/m, 'stops at the next section');
  const system = gitMessages('How do I open a merge request?', null, [], { explainOnly: true, guide: part });
  assert.match(system[0].content, /The editor's Git panel, as its guide describes it/);
  assert.match(system[0].content, /New branch from main…/);
  assert.ok(system.at(-1).content.includes(EXPLAIN_ONLY));
  assert.doesNotMatch(gitMessages('q', null)[0].content, /as its guide describes it/);
});
