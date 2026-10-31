// Git in the folders view, the editor and the Git panel: what `git status` says about each
// file (staged or not), which lines of a file changed since the last commit, the branches and
// stashes, the blocks a change can be staged by, and Git's messages in words. Pure: the main
// process runs git, the Node tests use these.

/**
 * `git status --porcelain=v2 --branch -z` → { branch, upstream, ahead, behind, files, staged,
 * unstaged } (files: path inside the repository → 'M' modified, 'A' added, 'D' deleted, 'R'
 * renamed, 'U' untracked, 'C' in conflict; staged: what the next commit takes; unstaged: what
 * changed since, untracked files included, as 'U').
 */
export function parseStatus(out) {
  const records = out.split('\0');
  const result = { branch: '', upstream: '', ahead: 0, behind: 0, files: {}, staged: {}, unstaged: {} };
  const split = (path, xy) => {
    if (xy[0] !== '.') result.staged[path] = codeOf(`${xy[0]}.`);
    if (xy[1] !== '.') result.unstaged[path] = codeOf(`.${xy[1]}`);
  };
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith('# branch.head ')) result.branch = r.slice(14) === '(detached)' ? 'detached' : r.slice(14);
    else if (r.startsWith('# branch.upstream ')) result.upstream = r.slice(18);
    else if (r.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) [result.ahead, result.behind] = [Number(m[1]), Number(m[2])];
    } else if (r.startsWith('1 ')) {
      const parts = r.split(' ');
      const path = parts.slice(8).join(' ');
      result.files[path] = codeOf(parts[1]);
      split(path, parts[1]);
    } else if (r.startsWith('2 ')) {
      const parts = r.split(' ');
      const path = parts.slice(9).join(' ');
      result.files[path] = 'R';
      split(path, parts[1]);
      if (result.staged[path]) result.staged[path] = 'R';
      i++; // the original path follows
    } else if (r.startsWith('u ')) {
      const path = r.split(' ').slice(10).join(' ');
      result.files[path] = 'C';
      result.unstaged[path] = 'C';
    } else if (r.startsWith('? ')) {
      result.files[r.slice(2)] = 'U';
      result.unstaged[r.slice(2)] = 'U';
    }
  }
  return result;
}

// XY: the index and the working tree; what you would notice first is the working tree's.
function codeOf(xy) {
  const [x, y] = xy;
  const s = y !== '.' ? y : x;
  if (s === 'A' || x === 'A') return 'A';
  if (s === 'D') return 'D';
  if (s === 'R' || s === 'C') return 'R';
  return 'M';
}

/** True when the commit would take something: a file staged and none left in conflict. */
export const canCommit = (status) => Boolean(status) && Object.keys(status.staged ?? {}).length > 0 && !Object.values(status.files ?? {}).includes('C');

export const GIT_LABELS = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'New, not in Git yet', C: 'In conflict' };

/**
 * The status of `rel` (a path inside the repository, with "/"): its own code, or for a
 * folder 'dot' when something inside it changed. null when nothing did.
 */
export function statusOf(files, rel, dir = false) {
  if (!dir) return files[rel] ?? null;
  const prefix = rel ? `${rel}/` : '';
  let found = null;
  for (const p in files) {
    if (!p.startsWith(prefix) || files[p] === 'D') continue;
    if (files[p] === 'C') return 'C';
    found = 'dot';
  }
  return found;
}

/**
 * Which lines of `now` changed since `before` (texts with "\n"): [{ kind: 'added' |
 * 'modified', from, to } (1-based lines of `now`), { kind: 'deleted', at } (lines removed
 * after line `at`, 0 = at the start)]. null when the texts are too different to tell fast.
 */
export function lineChanges(before, now, { maxEdits = 4000 } = {}) {
  const a = before.split('\n');
  const b = now.split('\n');
  // Same start and end are skipped first.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const edits = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!edits) return null;
  // Runs of removed and added lines; a removal next to an addition is a modification.
  const out = [];
  let i = 0;
  while (i < edits.length) {
    if (edits[i].op === '=') {
      i++;
      continue;
    }
    let removed = 0;
    let firstAdded = -1;
    let added = 0;
    let atB = edits[i].b;
    while (i < edits.length && edits[i].op !== '=') {
      if (edits[i].op === '-') removed++;
      else {
        if (firstAdded === -1) firstAdded = edits[i].b;
        added++;
      }
      atB = edits[i].op === '+' ? edits[i].b + 1 : atB;
      i++;
    }
    if (added && removed) out.push({ kind: 'modified', from: start + firstAdded + 1, to: start + firstAdded + added });
    else if (added) out.push({ kind: 'added', from: start + firstAdded + 1, to: start + firstAdded + added });
    else out.push({ kind: 'deleted', at: start + atB });
  }
  return out;
}

// Myers' diff of two line lists: [{ op: '=' | '-' | '+', a, b }] (a, b: indexes before the
// step), or null past `maxEdits`.
function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const v = new Map([[1, 0]]);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) return null;
  // Back through the trace for the edit path.
  const steps = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push({ op: '=', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) steps.push({ op: '+', a: x, b: y - 1 });
      else steps.push({ op: '-', a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

/**
 * The blocks two texts differ by (texts with "\n"): [{ aFrom, aTo, bFrom, bTo }], 0-based line
 * indexes, ends excluded (aFrom === aTo: lines only added; bFrom === bTo: only removed). null
 * when they are too different to tell fast.
 */
export function diffBlocks(before, now, { maxEdits = 4000 } = {}) {
  const a = before.split('\n');
  const b = now.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const edits = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!edits) return null;
  const out = [];
  let ia = start;
  let ib = start;
  let i = 0;
  while (i < edits.length) {
    if (edits[i].op === '=') {
      ia++;
      ib++;
      i++;
      continue;
    }
    const block = { aFrom: ia, aTo: ia, bFrom: ib, bTo: ib };
    while (i < edits.length && edits[i].op !== '=') {
      if (edits[i].op === '-') ia++;
      else ib++;
      i++;
    }
    block.aTo = ia;
    block.bTo = ib;
    out.push(block);
  }
  return out;
}

/**
 * Staging one change: the block of `now` (the file as edited) at `line` (1-based) taken into
 * `index` (the text staged), the rest left as staged: the new staged text, or null when no
 * change of `now` against `index` is there (it is staged already, or none). A removal counts on
 * the line its mark is on: the one before, or line 1.
 */
export function stageBlock(index, now, line) {
  const blocks = diffBlocks(index, now);
  if (!blocks) return null;
  const at = line - 1;
  const block = blocks.find((k) => (k.bFrom === k.bTo ? Math.max(0, k.bFrom - 1) === at : k.bFrom <= at && at < k.bTo));
  if (!block) return null;
  const a = index.split('\n');
  const b = now.split('\n');
  return [...a.slice(0, block.aFrom), ...b.slice(block.bFrom, block.bTo), ...a.slice(block.aTo)].join('\n');
}

/**
 * `git for-each-ref --format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(HEAD)
 * refs/heads refs/remotes` → { local: [{ name, current, upstream, ahead, behind, when }], remote:
 * [{ name, remote, branch, when }] } (a remote's HEAD left out; remote branches a local one tracks too).
 */
export function parseBranches(out) {
  const local = [];
  const remote = [];
  for (const line of String(out).split('\n')) {
    if (!line.trim()) continue;
    const [ref, upstream = '', track = '', when = '', head = ''] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
      const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
      local.push({ name: ref.slice(11), current: head.trim() === '*', upstream, ahead, behind, gone: /gone/.test(track), when });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (name.endsWith('/HEAD')) continue;
      const slash = name.indexOf('/');
      remote.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), when });
    }
  }
  return { local, remote };
}

/** `git stash list --format=%gd%x00%s%x00%cr` → [{ ref ('stash@{0}'), message, when }]. */
export function parseStashes(out) {
  return String(out)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [ref, message = '', when = ''] = l.split('\0');
      return { ref, message: message.replace(/^On [^:]+: /, '').replace(/^WIP on [^:]+: /, 'Work in progress: '), when };
    });
}

/** A branch name Git would take for a new branch (git check-ref-format --branch, roughly). */
export function branchNameProblem(name) {
  const n = String(name ?? '');
  if (!n.trim()) return 'Give it a name.';
  if (/\s/.test(n)) return 'No spaces: use - or / (feature/login).';
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock') || n === '@') return 'It cannot start with - or /, nor end with /, . or .lock.';
  if (/\.\.|\/\/|@\{|[~^:?*[\\\x00-\x1f\x7f]/.test(n) || /(^|\/)\./.test(n)) return 'It cannot have .., //, @{, a part starting with ".", or any of ~ ^ : ? * [ \\.';
  return '';
}

/**
 * What a Git command said when it failed, for a person: { kind, message, detail } (`detail`:
 * Git's own last lines). Kinds: 'auth' (signing in), 'identity' (no name and email), 'diverged'
 * (a pull that cannot just move forward), 'rejected' (a push the remote refused: pull first),
 * 'conflict' (files in conflict, or local changes a switch or pull would overwrite), 'nothing'
 * (nothing to commit), 'noupstream' (a branch not on the remote, pulled), 'noremote', 'other'.
 */
export function gitError(stderr = '', stdout = '') {
  const text = `${stderr}\n${stdout}`;
  const lines = String(stderr || stdout)
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/.test(l) && !/^(remote: )?(Counting|Compressing|Enumerating|Receiving|Resolving|Writing|Total|Unpacking) /.test(l));
  const detail = lines.slice(-6).join('\n');
  const is = (re) => re.test(text);
  if (is(/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|Host key verification failed|HTTP Basic: Access denied|returned error: 403/i))
    return { kind: 'auth', message: 'Git could not sign in to the remote. Set up a credential helper (Git Credential Manager on Windows, the keychain on macOS) or an SSH key with its agent running, then try again.', detail };
  if (is(/Please tell me who you are|empty ident|unable to auto-detect email/i))
    return { kind: 'identity', message: 'Git does not know your name and email yet: run git config --global user.name "Your Name" and git config --global user.email you@example.com in a terminal, then commit again.', detail };
  if (is(/Not possible to fast-forward|divergent branches|have diverged/i))
    return { kind: 'diverged', message: 'Your branch and the remote both have new commits: pull by merging them or by rebasing yours on top.', detail };
  if (is(/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i))
    return { kind: 'rejected', message: 'The remote has commits you do not have yet: pull first, then push.', detail };
  if (is(/would be overwritten|CONFLICT|unmerged files|fix conflicts|Merge conflict|could not apply/i))
    return { kind: 'conflict', message: is(/would be overwritten/i) ? 'Your changes to some files would be overwritten: commit or stash them first.' : 'Some files are in conflict: fix them, stage them, then commit (or abort).', detail };
  if (is(/There is no tracking information for the current branch/i))
    return { kind: 'noupstream', message: 'This branch is not on the remote yet, so there is nothing to pull: Push sends it there (and follows it from then on).', detail };
  if (is(/nothing to commit|no changes added to commit|nothing added to commit/i)) return { kind: 'nothing', message: 'Nothing to commit: stage some changes first.', detail };
  if (is(/No configured push destination|does not appear to be a git repository|no upstream|No remote repository specified|has no upstream branch/i))
    return { kind: 'noremote', message: 'This repository has no remote to push to or pull from.', detail };
  return { kind: 'other', message: lines.at(-1) ?? 'Git failed.', detail };
}
