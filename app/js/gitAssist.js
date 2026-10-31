// Git with the model (pure: no DOM; the page and the tests use it). The model is given the
// shape of the repository (the snapshot, git.cjs) and answers in words; to look further or to
// change something it writes a ```git-steps block: a JSON list of steps from STEPS below,
// nothing else. The app checks each step, shows the git command it is, runs the looking ones
// and the ones that are easy to undo by itself, asks before the others (a red warning for
// those that rewrite history or throw work away), and backs up before each of them (undo).
// Steps never become a command line: each is an action of git.cjs's `act`, which checks its
// fields again.

// What the model may name (the main process checks the same).
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split('/').includes('..') && !/[\0\r\n]/.test(rel);
const safeBranch = (name) => typeof name === 'string' && name.length > 0 && name.length < 256 && !name.startsWith('-') && !/[\0\r\n\s~^:?*[\\]|\.\.|@\{/.test(name);
const safeRev = (rev) => typeof rev === 'string' && rev.length > 0 && rev.length < 200 && !rev.startsWith('-') && /^[\w./@{}~^+-]+$/.test(rev) && !rev.includes('..');
const safeRange = (range) => typeof range === 'string' && (safeRev(range) || (/^[^.]+\.{2,3}[^.]+$/.test(range) && range.split(/\.{2,3}/).every(safeRev)));
const safeStash = (ref) => typeof ref === 'string' && /^stash@\{\d{1,4}\}$/.test(ref);
const paths = (s) => Array.isArray(s.paths) && s.paths.length > 0 && s.paths.length <= 500 && s.paths.every(safeRel);
const IN_PROGRESS = ['merge', 'rebase', 'cherry-pick', 'revert'];

// How a name shows in a command: as it is, or quoted when the shell would split it.
const q = (word) => (/^[\w./@{}~^:+=%,-]+$/.test(word) ? word : `'${String(word).replace(/'/g, `'\\''`)}'`);
const list = (s) => (s.paths ?? []).map(q).join(' ');
const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';

/**
 * The steps: `look` ones run at once and their output goes back to the model; the others
 * change things. `risk(step)`: 'auto' (runs by itself: easy to undo, or Git refuses when it
 * would lose work), 'ask' (asks first), 'danger' (asks with a warning: rewrites history or
 * throws work away). `backup`: a backup is taken first (Undo). `check(step)`: '' or what is wrong.
 * `fields` is what the model is told the step takes.
 */
export const STEPS = {
  // ---- Looking ----
  log: { look: true, fields: '{ "range"?: "main..feature" | "HEAD", "all"?: true, "count"?: 30, "paths"?: ["src/a.js"] }', check: (s) => (s.range != null && !safeRange(s.range) ? 'range' : s.paths != null && !paths(s) ? 'paths' : ''), cmd: (s) => `git log --graph --oneline${s.all ? ' --all' : ''}${s.count ? ` -n ${Number(s.count)}` : ''}${s.range ? ` ${s.range}` : ''}${s.paths ? ` -- ${list(s)}` : ''}`, text: () => 'Look at the commits' },
  show: { look: true, fields: '{ "rev": "abc1234" }', check: (s) => (safeRev(s.rev) ? '' : 'rev'), cmd: (s) => `git show --stat --patch ${s.rev}`, text: (s) => `Look at commit ${s.rev}` },
  diff: { look: true, fields: '{ "staged"?: true, "from"?: "main", "to"?: "HEAD", "stat"?: true, "paths"?: [...] }', check: (s) => ([s.from, s.to].some((r) => r != null && !safeRange(r)) ? 'from/to' : s.paths != null && !paths(s) ? 'paths' : ''), cmd: (s) => `git diff${s.stat ? ' --stat' : ''}${s.staged ? ' --cached' : ''}${s.from ? ` ${s.from}` : ''}${s.to ? ` ${s.to}` : ''}${s.paths ? ` -- ${list(s)}` : ''}`, text: (s) => (s.staged ? 'Look at what is staged' : s.from ? `Compare ${s.from}${s.to ? ` with ${s.to}` : ' with your files'}` : 'Look at your changes') },
  'file-at': { look: true, fields: '{ "rev": "HEAD~1", "path": "src/a.js" }', check: (s) => (!safeRev(s.rev) ? 'rev' : !safeRel(s.path) ? 'path' : ''), cmd: (s) => `git show ${s.rev}:${q(s.path)}`, text: (s) => `Read ${s.path} at ${s.rev}` },
  read: { look: true, fields: '{ "path": ".gitignore" }  (a file as it is now)', check: (s) => (safeRel(s.path) ? '' : 'path'), cmd: (s) => `cat ${q(s.path)}`, text: (s) => `Read ${s.path}` },
  reflog: { look: true, fields: '{ "ref"?: "main", "count"?: 30 }', check: (s) => (s.ref != null && !safeRev(s.ref) ? 'ref' : ''), cmd: (s) => `git reflog${s.ref ? ` ${s.ref}` : ''}${s.count ? ` -n ${Number(s.count)}` : ''}`, text: () => 'Look at where HEAD has been (the reflog)' },
  backups: { look: true, fields: '{}', check: () => '', cmd: () => '(Tracker Editor’s backups)', text: () => 'Look at the backups taken before earlier steps' },
  // ---- Easy to undo: they run by themselves ----
  stage: { fields: '{ "paths": [...] }', risk: () => 'auto', check: (s) => (paths(s) ? '' : 'paths'), cmd: (s) => `git add -A -- ${list(s)}`, text: (s) => `Stage ${s.paths.join(', ')}` },
  'stage-all': { fields: '{}', risk: () => 'auto', check: () => '', cmd: () => 'git add -A', text: () => 'Stage all the changes' },
  unstage: { fields: '{ "paths": [...] }', risk: () => 'auto', check: (s) => (paths(s) ? '' : 'paths'), cmd: (s) => `git restore --staged -- ${list(s)}`, text: (s) => `Unstage ${s.paths.join(', ')} (the files keep their changes)` },
  'unstage-all': { fields: '{}', risk: () => 'auto', check: () => '', cmd: () => 'git reset', text: () => 'Unstage everything (the files keep their changes)' },
  stash: { fields: '{ "message"?: "...", "untracked"?: true }', risk: () => 'auto', check: () => '', cmd: (s) => `git stash push${s.untracked ? ' --include-untracked' : ''}${s.message ? ` -m ${q(s.message)}` : ''}`, text: (s) => `Put the changes aside (stash)${s.message ? `: “${s.message}”` : ''}` },
  fetch: { fields: '{}', risk: () => 'auto', check: () => '', cmd: () => 'git fetch --all --prune', text: () => 'Fetch what is new on the remote (your files do not change)' },
  'create-branch': { fields: '{ "name": "fix/login", "from"?: "main" }', risk: () => 'auto', check: (s) => (!safeBranch(s.name) ? 'name' : s.from != null && !safeBranch(s.from) ? 'from' : ''), cmd: (s) => `git switch -c ${s.name}${s.from ? ` ${s.from}` : ''}`, text: (s) => `Make the branch ${s.name}${s.from ? ` from ${s.from}` : ''} and switch to it` },
  switch: { fields: '{ "name": "main", "track"?: true  (track: a remote branch like "origin/x") }', risk: () => 'auto', check: (s) => (safeBranch(s.name) ? '' : 'name'), cmd: (s) => `git switch ${s.track ? '--track ' : ''}${s.name}`, text: (s) => `Switch to ${s.name}` },
  ignore: { fields: '{ "patterns": ["*.log", "node_modules/"] }', risk: () => 'auto', check: (s) => (Array.isArray(s.patterns) && s.patterns.length > 0 && s.patterns.length <= 50 && s.patterns.every((p) => typeof p === 'string' && p.trim() && p.length <= 200 && !/[\r\n\0]/.test(p)) ? '' : 'patterns'), cmd: (s) => `echo ${s.patterns.map(q).join(' ')} >> .gitignore`, text: (s) => `Add ${s.patterns.join(', ')} to .gitignore` },
  // ---- Asked first ----
  commit: { fields: '{ "message": "Subject\\n\\nBody", "amend"?: true }', riskText: 'ask (amend: danger)', risk: (s) => (s.amend ? 'danger' : 'ask'), backup: (s) => Boolean(s.amend), check: (s) => (typeof s.message === 'string' && (s.message.trim() || s.amend) ? '' : 'message'), cmd: (s) => `git commit${s.amend ? ' --amend' : ''}${s.message?.trim() ? ` -m ${q(firstLine(s.message))}${s.message.trim().includes('\n') ? ' …' : ''}` : ' --no-edit'}`, text: (s) => (s.amend ? `Rewrite the last commit${s.message?.trim() ? `: “${firstLine(s.message)}”` : ''}` : `Commit: “${firstLine(s.message)}”`) },
  pull: { fields: '{ "how"?: "merge" | "rebase"  (none: only when it can just move forward) }', risk: () => 'ask', backup: () => true, check: (s) => (s.how == null || ['merge', 'rebase'].includes(s.how) ? '' : 'how'), cmd: (s) => `git pull ${{ merge: '--no-rebase', rebase: '--rebase' }[s.how] ?? '--ff-only'}`, text: (s) => `Pull the remote’s commits${s.how === 'rebase' ? ', putting yours on top' : s.how === 'merge' ? ', merging them' : ''}` },
  push: { fields: '{ "force"?: true  (only --force-with-lease), "remote"?: "origin" }', riskText: 'ask (force: danger)', risk: (s) => (s.force ? 'danger' : 'ask'), check: (s) => (s.remote != null && !/^[A-Za-z0-9._-]{1,100}$/.test(s.remote) ? 'remote' : ''), cmd: (s) => `git push${s.force ? ' --force-with-lease' : ''}`, text: (s) => (s.force ? 'Push over the remote branch (replacing its commits)' : 'Push to the remote'), final: true },
  merge: { fields: '{ "rev": "feature", "how"?: "ff-only" | "no-ff" | "squash" }', risk: () => 'ask', backup: () => true, check: (s) => (!safeRev(s.rev) ? 'rev' : s.how != null && !['ff-only', 'no-ff', 'squash'].includes(s.how) ? 'how' : ''), cmd: (s) => `git merge${s.how ? ` --${s.how}` : ''} ${s.rev}`, text: (s) => `Merge ${s.rev} into the current branch` },
  revert: { fields: '{ "rev": "abc1234" }', risk: () => 'ask', backup: () => true, check: (s) => (safeRev(s.rev) ? '' : 'rev'), cmd: (s) => `git revert --no-edit ${s.rev}`, text: (s) => `Undo commit ${s.rev} with a new commit (history stays)` },
  'cherry-pick': { fields: '{ "rev": "abc1234" }', risk: () => 'ask', backup: () => true, check: (s) => (safeRev(s.rev) ? '' : 'rev'), cmd: (s) => `git cherry-pick ${s.rev}`, text: (s) => `Copy commit ${s.rev} onto this branch` },
  'stash-apply': { fields: '{ "ref": "stash@{0}" }', risk: () => 'ask', backup: () => true, check: (s) => (safeStash(s.ref) ? '' : 'ref'), cmd: (s) => `git stash apply ${s.ref}`, text: (s) => `Bring back the changes of ${s.ref} (kept in the stash)` },
  'stash-pop': { fields: '{ "ref": "stash@{0}" }', risk: () => 'ask', backup: () => true, check: (s) => (safeStash(s.ref) ? '' : 'ref'), cmd: (s) => `git stash pop ${s.ref}`, text: (s) => `Bring back the changes of ${s.ref} and drop it from the stash` },
  tag: { fields: '{ "name": "v1.2.0", "rev"?: "HEAD", "message"?: "..." }', risk: () => 'ask', check: (s) => (!safeBranch(s.name) ? 'name' : s.rev != null && !safeRev(s.rev) ? 'rev' : ''), cmd: (s) => `git tag${s.message ? ' -a' : ''} ${s.name}${s.rev ? ` ${s.rev}` : ''}`, text: (s) => `Tag ${s.rev ?? 'this commit'} as ${s.name}` },
  abort: { fields: '{ "what": "merge" | "rebase" | "cherry-pick" | "revert" }', risk: () => 'ask', backup: () => true, check: (s) => (IN_PROGRESS.includes(s.what) ? '' : 'what'), cmd: (s) => `git ${s.what} --abort`, text: (s) => `Abort the ${s.what} (back to before it started)` },
  continue: { fields: '{ "what": "merge" | "rebase" | "cherry-pick" | "revert" }', risk: () => 'ask', backup: () => true, check: (s) => (IN_PROGRESS.includes(s.what) ? '' : 'what'), cmd: (s) => (s.what === 'merge' ? 'git commit --no-edit' : `git ${s.what} --continue`), text: (s) => `Go on with the ${s.what} (the conflicts are fixed and staged)` },
  untrack: { fields: '{ "paths": [...] }  (out of Git, kept on disk)', risk: () => 'ask', check: (s) => (paths(s) ? '' : 'paths'), cmd: (s) => `git rm -r --cached -- ${list(s)}`, text: (s) => `Stop tracking ${s.paths.join(', ')} (the files stay on disk)` },
  'rename-branch': { fields: '{ "to": "new-name", "from"?: "old-name" }', risk: () => 'ask', backup: () => true, keep: (s) => (s.from ? [s.from] : []), check: (s) => (!safeBranch(s.to) ? 'to' : s.from != null && !safeBranch(s.from) ? 'from' : ''), cmd: (s) => `git branch -m ${s.from ? `${s.from} ` : ''}${s.to}`, text: (s) => `Rename ${s.from ?? 'this branch'} to ${s.to}` },
  // ---- Rewrites history or throws work away: asked with a warning ----
  rebase: { fields: '{ "onto": "main" }', risk: () => 'danger', backup: () => true, check: (s) => (safeRev(s.onto) ? '' : 'onto'), cmd: (s) => `git rebase ${s.onto}`, text: (s) => `Rebase this branch onto ${s.onto} (its commits are rewritten)` },
  'rebase-skip': { fields: '{}', risk: () => 'danger', backup: () => true, check: () => '', cmd: () => 'git rebase --skip', text: () => 'Skip the commit the rebase stopped at (its changes are dropped)' },
  reset: { fields: '{ "mode": "soft" | "mixed" | "hard", "rev": "HEAD~1" }', riskText: 'ask (hard: danger)', risk: (s) => (s.mode === 'hard' ? 'danger' : 'ask'), backup: () => true, check: (s) => (!['soft', 'mixed', 'hard'].includes(s.mode) ? 'mode' : !safeRev(s.rev) ? 'rev' : ''), cmd: (s) => `git reset --${s.mode} ${s.rev}`, text: (s) => (s.mode === 'hard' ? `Move this branch to ${s.rev} and throw away every change not committed` : s.mode === 'soft' ? `Move this branch to ${s.rev}, keeping the changes staged` : `Move this branch to ${s.rev}, keeping the changes in your files`) },
  'delete-branch': { fields: '{ "name": "old", "force"?: true  (force: even when not merged) }', risk: () => 'danger', backup: () => true, keep: (s) => [s.name], check: (s) => (safeBranch(s.name) ? '' : 'name'), cmd: (s) => `git branch ${s.force ? '-D' : '-d'} ${s.name}`, text: (s) => `Delete the branch ${s.name}${s.force ? ', even if it is not merged' : ''}` },
  restore: { fields: '{ "paths": [...], "from"?: "HEAD~2" }', risk: () => 'danger', backup: () => true, check: (s) => (!paths(s) ? 'paths' : s.from != null && !safeRev(s.from) ? 'from' : ''), cmd: (s) => `git restore ${s.from ? `--source=${s.from} --staged ` : ''}--worktree -- ${list(s)}`, text: (s) => `Throw away the changes to ${s.paths.join(', ')}${s.from ? ` (back to ${s.from})` : ''}` },
  'stash-drop': { fields: '{ "ref": "stash@{0}" }', risk: () => 'danger', check: (s) => (safeStash(s.ref) ? '' : 'ref'), cmd: (s) => `git stash drop ${s.ref}`, text: (s) => `Throw away ${s.ref} from the stash` },
  undo: { fields: '{ "id": "<a backup’s id>" }', risk: () => 'danger', check: (s) => (typeof s.id === 'string' && /^[a-z0-9]{4,40}$/.test(s.id) ? '' : 'id'), cmd: (s) => `(back to Tracker Editor’s backup ${s.id})`, text: (s) => `Go back to the backup ${s.id} (its branch, commit and changes)` },
};

/** Ops whose step needs the working tree saved first (they change files on disk). */
export const CHANGES_FILES = new Set(['switch', 'create-branch', 'stash', 'stash-apply', 'stash-pop', 'pull', 'merge', 'rebase', 'rebase-skip', 'reset', 'revert', 'cherry-pick', 'restore', 'abort', 'continue', 'undo']);

/**
 * One step from the model → { step, look, risk, cmd, text, backup, keep, problem }: its op
 * must be known and its fields right (`problem` says what is not).
 */
export function describeStep(raw) {
  const step = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const def = STEPS[step.op];
  if (!def) return { step, problem: `“${String(step.op ?? '?')}” is not a step the editor can do` };
  const bad = def.check(step);
  if (bad) return { step, problem: `${step.op}: “${bad}” is missing or not allowed` };
  return {
    step,
    look: Boolean(def.look),
    risk: def.look ? 'look' : def.risk(step),
    cmd: def.cmd(step),
    text: def.text(step),
    why: typeof step.why === 'string' ? step.why.slice(0, 300) : '',
    backup: Boolean(def.backup?.(step)),
    keep: def.keep?.(step) ?? [],
    final: Boolean(def.final),
  };
}

/** A step as the action git.cjs `act` takes (its own fields only). */
export function toAction(step) {
  const { op, why: _why, ...rest } = step;
  if (op === 'create-branch') return { op: 'switch', name: rest.name, create: true, ...(rest.from ? { from: rest.from } : {}) };
  return { op, ...rest };
}

/**
 * The model's reply → { text (the words, the steps' block taken out), steps (described),
 * problems }. The steps are in ```git-steps fences (a JSON list, or one step); a ```json one
 * whose list holds steps counts too.
 */
export function parsePlan(reply) {
  const text = String(reply ?? '');
  const fence = /```[ \t]*(git-steps|json)?[^\n]*\n([\s\S]*?)```/g;
  const steps = [];
  const problems = [];
  let words = text;
  for (const m of text.matchAll(fence)) {
    const lang = m[1] ?? '';
    let parsed;
    try {
      parsed = JSON.parse(m[2]);
    } catch {
      if (lang === 'git-steps') problems.push('The steps were not valid JSON.');
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (lang !== 'git-steps' && !items.every((x) => x && typeof x === 'object' && typeof x.op === 'string')) continue;
    words = words.replace(m[0], '');
    for (const item of items.slice(0, 20)) {
      const d = describeStep(item);
      if (d.problem) problems.push(d.problem);
      else steps.push(d);
    }
  }
  return { text: words.replace(/\n{3,}/g, '\n\n').trim(), steps, problems };
}

const rows = (items, fn) => (items.length ? items.map(fn).join('\n') : '(none)');

/** The snapshot (git.cjs) in words, for the model. */
export function snapshotText(snap) {
  if (!snap) return 'Not a Git repository.';
  const s = snap.status ?? {};
  const files = (map) => Object.entries(map ?? {}).slice(0, 200);
  const staged = files(s.staged);
  const unstaged = files(s.unstaged);
  const b = snap.branches ?? { local: [], remote: [] };
  return [
    `Repository: ${snap.root}`,
    `On branch: ${s.branch || '(none)'}${s.upstream ? `, following ${s.upstream} (${s.ahead ?? 0} to push, ${s.behind ?? 0} to pull)` : s.branch && s.branch !== 'detached' ? ', not on a remote yet' : ''}`,
    snap.inProgress ? `IN PROGRESS: a ${snap.inProgress} stopped halfway (conflicts are files marked C).` : '',
    `Who commits: name ${snap.identity?.name ? 'set' : 'NOT set'}, email ${snap.identity?.email ? 'set' : 'NOT set'}`,
    `.gitignore: ${snap.gitignore ? 'present' : 'none'}`,
    '',
    `Staged (${staged.length}):`,
    rows(staged, ([f, c]) => `  ${c} ${f}`),
    `Not staged (${unstaged.length}; U = new, not in Git; C = conflict):`,
    rows(unstaged, ([f, c]) => `  ${c} ${f}`),
    '',
    'Local branches:',
    rows(b.local, (x) => `  ${x.current ? '*' : ' '} ${x.name}${x.upstream ? ` → ${x.upstream}` : ''}${x.ahead || x.behind ? ` (↑${x.ahead} ↓${x.behind})` : ''}${x.gone ? ' (gone on the remote)' : ''} · ${x.when}`),
    'Remote branches:',
    rows(b.remote.slice(0, 40), (x) => `  ${x.name} · ${x.when}`),
    `Remotes: ${snap.remotes?.length ? snap.remotes.join('; ') : '(none)'}`,
    `Tags (newest): ${snap.tags?.length ? snap.tags.join('; ') : '(none)'}`,
    'Stash:',
    rows(snap.stashes ?? [], (x) => `  ${x.ref}: ${x.message} · ${x.when}`),
    '',
    'Recent commits, all branches (git log --graph --all):',
    snap.graph?.trim() || '(no commits yet)',
    '',
    'Reflog (where HEAD was):',
    snap.reflog?.trim() || '(none)',
    'Backups the editor took before earlier steps (undo with their id):',
    rows(snap.backups ?? [], (x) => `  ${x.id}: before “${x.label}” · ${x.at} · ${x.branch || 'detached'} at ${String(x.head).slice(0, 8)}${x.changes ? ' + changes not committed' : ''}`),
  ]
    .filter((l) => l !== '')
    .join('\n')
    .replace(/\n(Staged|Local branches|Recent commits)/g, '\n\n$1');
}

const stepList = () =>
  Object.entries(STEPS)
    .map(([op, d]) => `- ${op} ${d.fields}${d.look ? ' — looks' : ` — ${d.riskText ?? d.risk({})}`}`)
    .join('\n');

/** The system message: what the model is for, how to look and act, what it cannot do. */
export function gitSystem() {
  return `You help someone with Git in Tracker Editor, a text editor. Many people find Git confusing and some have damaged their repositories: explain plainly and briefly (Markdown), say what each step does and why, prefer the safe way, and never guess about the repository: look first.

Every question comes with a snapshot of the repository (status, branches, recent commits on all branches, stash, reflog, backups).

To look further, or to do something, end your answer with ONE block like this:
\`\`\`git-steps
[{ "op": "log", "range": "main..feature", "why": "see what feature adds" }]
\`\`\`
Each step is an object with "op", its fields, and a short "why". Only these steps exist:
${stepList()}

How steps run:
- Looking steps (log, show, diff, file-at, read, reflog, backups) run at once and their output comes back to you. Put them in a block of their own; actions in the same block are not run. You may look several times.
- "auto" steps run by themselves; "ask" and "danger" ones wait for the person to click Run (danger ones with a warning). Before ask and danger steps the editor saves a backup (the commit, the changes not committed, every branch), so they can be undone; a push cannot be undone from here.
- Steps run in order and stop at the first that fails or is skipped; then the results come back to you so you can explain or fix.
- Several steps in one block are fine when they belong together (stash, switch, pull, stash-pop).

Be careful:
- Do not rewrite commits that are already pushed to a shared branch (rebase, amend, reset) unless the person asks; then say why it needs a force push, and only push with "force": true (it is --force-with-lease).
- Before reset --hard, restore, rebase-skip or stash-drop, say exactly what will be lost.
- To recover lost work, look at the reflog and the backups; "undo" with a backup's id goes back to it; "create-branch" from a commit in the reflog saves a lost commit.
- Conflicts: say which files, what the markers <<<<<<< ======= >>>>>>> mean; the person fixes them in the editor; then stage them and "continue" (or "abort").
- Write commit messages in the commit step: a short subject (under 72 characters, in the imperative), a blank line, then the why if useful.
- You cannot run an interactive rebase, edit Git's settings, sign in, or delete untracked files: give the commands for a terminal instead (a \`\`\`sh block), and say what they do. To squash commits, use reset with "mode": "soft" and a new commit.
- Answer questions that need no step without a block.`;
}

/** The messages for one turn: the system, the turns so far, the question with a fresh snapshot. */
export function gitMessages(question, snap, history = []) {
  return [
    { role: 'system', content: gitSystem() },
    ...history,
    { role: 'user', content: `${question}\n\n<repository>\n${snapshotText(snap)}\n</repository>` },
  ];
}

/** What came of the steps, for the model's next turn. */
export function resultsMessage(results) {
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.cmd} — ${r.outcome === 'ok' ? 'done' : r.outcome === 'skipped' ? 'skipped by the person' : r.outcome === 'stopped' ? 'not run (stopped before it)' : 'FAILED'}`;
    const body = String(r.output ?? '').trim();
    return body ? `${head}\n\`\`\`\n${body.length > 20_000 ? `${body.slice(0, 20_000)}\n…` : body}\n\`\`\`` : head;
  });
  return `Results of the steps:\n${lines.join('\n')}`;
}

/** Git's answer to a step as text for the model and the page. */
export function outputOf(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && ('stdout' in result || 'stderr' in result)) return [result.stdout, result.stderr].map((t) => String(t ?? '').trim()).filter(Boolean).join('\n');
  return JSON.stringify(result, null, 1);
}

/** Writing a commit message from what is staged: the diff (cut to `budget`), the stat, the last subjects (their style). */
export function commitMessageMessages({ diff, stat = '', subjects = [], hint = '', budget = 24_000 }) {
  const cut = String(diff ?? '').length > budget ? `${String(diff).slice(0, budget)}\n… (the rest of the diff left out)` : String(diff ?? '');
  return [
    {
      role: 'system',
      content:
        'You write Git commit messages. Answer with the message only: no fences, no quotes, no lead-in. A subject line under 72 characters in the imperative ("Add…", "Fix…"), then, when the change needs it, a blank line and a short body saying what and why (wrapped at 72). Follow the style of the repository’s recent subjects (a prefix like "feat:" only if they use one).',
    },
    {
      role: 'user',
      content: `${hint ? `What I did: ${hint}\n\n` : ''}Recent subjects in this repository:\n${subjects.slice(0, 15).map((s) => `- ${s}`).join('\n') || '(none)'}\n\nStaged files:\n${stat || '(see the diff)'}\n\nThe staged diff:\n${cut}`,
    },
  ];
}

/** The model's commit message, without fences, quotes or "Commit message:". */
export function cleanCommitMessage(reply) {
  let t = String(reply ?? '').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fenced) t = fenced[1].trim();
  t = t.replace(/^(here(?:'|’)s|here is)[^\n]*:\s*\n+/i, '').replace(/^(suggested )?commit message:\s*/i, '');
  if (/^(["'“]).*(["'”])$/s.test(t) && !t.slice(1, -1).includes('\n\n')) t = t.slice(1, -1);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

