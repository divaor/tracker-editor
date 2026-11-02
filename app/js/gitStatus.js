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
 * The block (diffBlocks) whose mark in the bar of changed lines is on `line` (1-based): changed
 * or added lines on theirs, a removal on the line before it (line 1 at the start). -1 when none.
 */
export function changeIndexAt(blocks, line) {
  const at = line - 1;
  return (blocks ?? []).findIndex((k) => (k.bFrom === k.bTo ? Math.max(0, k.bFrom - 1) === at : k.bFrom <= at && at < k.bTo));
}

/** The line (1-based) a block's mark is on: its first line, or for a removal the line before it (1 at the start). */
export const markLineOf = (block) => (block.bFrom === block.bTo ? Math.max(1, block.bFrom) : block.bFrom + 1);

/**
 * The bar's changes from diffBlocks' blocks, as lineChanges gives them: [{ kind: 'added' |
 * 'modified', from, to }, { kind: 'deleted', at }] (1-based lines of the edited text).
 */
export const changesOf = (blocks) =>
  blocks.map((k) => (k.bFrom === k.bTo ? { kind: 'deleted', at: k.bFrom } : { kind: k.aFrom === k.aTo ? 'added' : 'modified', from: k.bFrom + 1, to: k.bTo }));

/**
 * Staging one change: the block of `now` (the file as edited) at `line` (1-based) taken into
 * `index` (the text staged), the rest left as staged: the new staged text, or null when no
 * change of `now` against `index` is there (it is staged already, or none). A removal counts on
 * the line its mark is on: the one before, or line 1.
 */
export function stageBlock(index, now, line) {
  const blocks = diffBlocks(index, now);
  if (!blocks) return null;
  const block = blocks[changeIndexAt(blocks, line)];
  if (!block) return null;
  const a = index.split('\n');
  const b = now.split('\n');
  return [...a.slice(0, block.aFrom), ...b.slice(block.bFrom, block.bTo), ...a.slice(block.aTo)].join('\n');
}

/**
 * Reverting one change: the block of `now` (the file as edited) whose mark is on `line` (1-based)
 * put back as it is in `base` (the text at the last commit), the rest left as it is. One change of
 * `now`'s characters, { from, to, insert, block, index } (for the editor to make as one edit, so
 * Ctrl+Z brings it back); null when no change of `now` against `base` is there. `blocks`: the
 * diffBlocks of the two, when known (the bar's own).
 */
export function revertBlock(base, now, line, blocks = diffBlocks(base, now)) {
  if (!blocks) return null;
  const index = changeIndexAt(blocks, line);
  if (index === -1) return null;
  const block = blocks[index];
  const b = now.split('\n');
  const old = base.split('\n').slice(block.aFrom, block.aTo);
  let start = 0;
  const starts = [0];
  for (let k = 0; k < b.length; k++) starts.push((start += b[k].length + 1));
  const done = (from, to, insert) => ({ from, to, insert, block, index });
  if (block.bFrom < block.bTo) {
    // Changed lines get the commit's; added ones go, with the line break after them (at the end: before).
    if (old.length) return done(starts[block.bFrom], starts[block.bTo] - 1, old.join('\n'));
    if (block.bTo < b.length) return done(starts[block.bFrom], starts[block.bTo], '');
    return done(Math.max(0, starts[block.bFrom] - 1), now.length, '');
  }
  // Removed lines come back before the line now in their place (at the end: after the last one).
  if (block.bFrom < b.length) return done(starts[block.bFrom], starts[block.bFrom], `${old.join('\n')}\n`);
  return done(now.length, now.length, `\n${old.join('\n')}`);
}

// ---- Blame: who changed each line, and when ----

/** The commit `git blame` names for lines not committed yet (the editor's text, or the file as it is). */
export const NOT_COMMITTED = '0000000000000000000000000000000000000000';

// A path as Git writes it: as it is, or quoted with C escapes ("caf\303\251.js": octal bytes of UTF-8).
function unquotePath(text) {
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return text;
  const body = text.slice(1, -1);
  const encoder = new TextEncoder();
  const SIMPLE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes = [];
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf('\\', i);
    for (const byte of encoder.encode(at === -1 ? body.slice(i) : body.slice(i, at))) bytes.push(byte);
    if (at === -1) break;
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1, at + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i = at + 4;
    } else {
      const c = body[at + 1] ?? '';
      if (c in SIMPLE) bytes.push(SIMPLE[c]);
      else for (const byte of encoder.encode(c)) bytes.push(byte);
      i = at + 2;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * `git blame --porcelain` → { commits: { hash: { hash, author, mail, time, tz, committer,
 * committerMail, committerTime, summary, previous: { hash, filename } | null, boundary, filename,
 * uncommitted } }, lines: [the commit of each line, in order] }. Times are seconds since 1970,
 * mails without their < >, file names as they are in that commit (relative to the repository's
 * top); `previous` is the commit before it that had the line's file (the side "before" of the
 * commit); `boundary` marks where the history blamed ends (the first commit). The all-zero
 * commit is lines not committed yet (`uncommitted`). Lines' own text is left out.
 */
export function parseBlame(out) {
  const commits = {};
  const lines = [];
  let current = null;
  for (let raw of String(out ?? '').split('\n')) {
    // A line's own text, after its header.
    if (raw.startsWith('\t')) {
      current = null;
      continue;
    }
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    const head = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (head) {
      const hash = head[1];
      current = commits[hash] ??= { hash, author: '', mail: '', time: 0, tz: '', committer: '', committerMail: '', committerTime: 0, summary: '', previous: null, boundary: false, filename: '', uncommitted: /^0+$/.test(hash) };
      lines[Number(head[2]) - 1] = hash;
      continue;
    }
    if (!current) continue;
    const sp = raw.indexOf(' ');
    const key = sp === -1 ? raw : raw.slice(0, sp);
    const value = sp === -1 ? '' : raw.slice(sp + 1);
    if (key === 'author') current.author = value;
    else if (key === 'author-mail') current.mail = value.replace(/^<|>$/g, '');
    else if (key === 'author-time') current.time = Number(value) || 0;
    else if (key === 'author-tz') current.tz = value;
    else if (key === 'committer') current.committer = value;
    else if (key === 'committer-mail') current.committerMail = value.replace(/^<|>$/g, '');
    else if (key === 'committer-time') current.committerTime = Number(value) || 0;
    else if (key === 'summary') current.summary = value;
    else if (key === 'boundary') current.boundary = true;
    else if (key === 'filename') current.filename ||= unquotePath(value);
    else if (key === 'previous' && !current.previous) {
      const at = value.indexOf(' ');
      if (at > 0) current.previous = { hash: value.slice(0, at), filename: unquotePath(value.slice(at + 1)) };
    }
  }
  return { commits, lines: Array.from(lines, (hash) => hash ?? null) };
}

/**
 * A per-line list (blame's commits) after an edit: each block ([{ aFrom, aTo, bFrom, bTo }]:
 * 0-based lines before and after, ends excluded, in order; overlapping ones are joined) has its
 * lines replaced by as many `fill` as it has now (edited lines are not committed); the others
 * keep theirs, moved.
 */
export function remapLines(lines, blocks, fill) {
  const joined = [];
  for (const k of blocks) {
    const last = joined[joined.length - 1];
    if (last && (k.aFrom < last.aTo || k.bFrom < last.bTo)) {
      last.aTo = Math.max(last.aTo, k.aTo);
      last.bTo = Math.max(last.bTo, k.bTo);
    } else joined.push({ ...k, aTo: Math.max(k.aFrom, k.aTo), bTo: Math.max(k.bFrom, k.bTo) });
  }
  const out = [];
  let at = 0;
  for (const k of joined) {
    for (let i = at; i < k.aFrom; i++) out.push(lines[i] ?? null);
    for (let i = k.bFrom; i < k.bTo; i++) out.push(fill);
    at = Math.max(at, k.aTo);
  }
  for (let i = at; i < lines.length; i++) out.push(lines[i]);
  return out;
}

/** How long ago a time (seconds since 1970) was, in words: "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function blameAgo(time, now = Date.now()) {
  const s = Math.max(0, Math.round(now / 1000 - time));
  const say = (n, one, unit) => (n <= 1 ? one : `${n} ${unit} ago`);
  if (s < 45) return 'just now';
  if (s < 45 * 60) return say(Math.round(s / 60), 'a minute ago', 'minutes');
  if (s < 22 * 3600) return say(Math.round(s / 3600), 'an hour ago', 'hours');
  const days = Math.round(s / 86400);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return say(Math.round(days / 7), 'a week ago', 'weeks');
  if (days < 365) return say(Math.round(days / 30.44), 'a month ago', 'months');
  return say(Math.round(days / 365.25), 'a year ago', 'years');
}

/** Who a line's commit is by: "You" (the repository's user.email, or not committed yet), else the author. */
export function blameWho(commit, me = null) {
  if (!commit) return '';
  if (commit.uncommitted) return 'You';
  if (me?.email && commit.mail && commit.mail.toLowerCase() === me.email.toLowerCase()) return 'You';
  return commit.author || commit.mail || 'Someone';
}

/** The words at the end of a line: "You, 3 days ago · Fix the parser", or "You · Not committed yet". */
export function blameLineText(commit, me = null, now = Date.now()) {
  if (!commit) return '';
  if (commit.uncommitted) return 'You · Not committed yet';
  return `${blameWho(commit, me)}, ${blameAgo(commit.time, now)}${commit.summary ? ` · ${commit.summary}` : ''}`;
}

/** How new each commit is among a file's, for the blame column's tint: Map hash → 0 (the oldest) … 1 (the newest). */
export function blameAges(commits) {
  const list = Object.values(commits ?? {}).filter((c) => !c.uncommitted);
  const times = [...new Set(list.map((c) => c.time))].sort((a, b) => a - b);
  const out = new Map();
  for (const c of list) out.set(c.hash, times.length < 2 ? 1 : times.indexOf(c.time) / (times.length - 1));
  return out;
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
 * Where a server's or a place's Git runs, in words ("the server build-box", "the container
 * web-1", "Ubuntu (WSL)"), from { kind: 'ssh'|'docker'|'wsl', name }; '' for this computer.
 */
export const placeWords = (place) => (!place?.name ? '' : place.kind === 'docker' ? `the container ${place.name}` : place.kind === 'wsl' ? `${place.name} (WSL)` : `the server ${place.name}`);

/**
 * What a Git command said when it failed, for a person: { kind, message, detail } (`detail`:
 * Git's own last lines). Kinds: 'auth' (signing in), 'identity' (no name and email), 'diverged'
 * (a pull that cannot just move forward), 'rejected' (a push the remote refused: pull first),
 * 'conflict' (files in conflict, or local changes a switch or pull would overwrite), 'nothing'
 * (nothing to commit), 'noupstream' (a branch not on the remote, pulled), 'noremote', 'old' (a
 * Git without switch and restore, older than 2.23), 'other'. `place` ({ kind, name }): Git ran on
 * a server or in a place, with its own sign-ins and settings, and the words say so.
 */
export function gitError(stderr = '', stdout = '', { place = null } = {}) {
  const text = `${stderr}\n${stdout}`;
  const lines = String(stderr || stdout)
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^hint:/.test(l) && !/^(remote: )?(Counting|Compressing|Enumerating|Receiving|Resolving|Writing|Total|Unpacking) /.test(l));
  const detail = lines.slice(-6).join('\n');
  const is = (re) => re.test(text);
  const there = placeWords(place);
  if (is(/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|Host key verification failed|HTTP Basic: Access denied|returned error: 403/i))
    return {
      kind: 'auth',
      message: there
        ? `Git on ${there} could not sign in to the remote. It signs in as Git does in a terminal there, never asking here: with an SSH key on ${there} (in its agent, or without a passphrase, the remote's host known there) or a credential helper set up there. Set one up there, then try again.`
        : 'Git could not sign in to the remote. Set up a credential helper (Git Credential Manager on Windows, the keychain on macOS) or an SSH key with its agent running, then try again.',
      detail,
    };
  if (is(/Please tell me who you are|empty ident|unable to auto-detect email/i))
    return { kind: 'identity', message: `Git${there ? ` on ${there}` : ''} does not know your name and email yet: run git config --global user.name "Your Name" and git config --global user.email you@example.com in a terminal${there ? ' there' : ''}, then commit again.`, detail };
  if (is(/is not a git command|unknown option [`']porcelain=v2/i))
    return { kind: 'old', message: `Git${there ? ` on ${there}` : ''} is too old for this: switching branches and restoring files need Git 2.23 or newer. Update Git${there ? ' there' : ''}, then try again.`, detail };
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

// ---- Merge requests (pull requests): the page the remote's site opens one on ----

// After a push, GitHub, GitLab, Bitbucket and Azure DevOps print where to open one:
// "remote: Create a pull request for 'x' on GitHub by visiting:\nremote:   https://…/pull/new/x".
const MR_LINK = /https:\/\/[^\s'"<>]+(?:\/pull\/new\/|\/-\/merge_requests\/new|\/merge_requests\/new|\/pull-requests\/new|\/pullrequestcreate|\/compare\/)[^\s'"<>]*/;

/** The merge request link in what a push said ({ url, label }), or null. */
export function mergeRequestLink(text) {
  const url = MR_LINK.exec(String(text ?? ''))?.[0];
  if (!url) return null;
  return { url, label: /merge_requests/.test(url) ? 'merge request' : 'pull request' };
}

/**
 * The page that opens a merge request of `source` into `target` (optional: the site's default
 * branch), from a remote's address (https or SSH, without a password): GitHub, GitLab (also
 * self-hosted ones with "gitlab" in the name), Bitbucket, Azure DevOps. { url, label } or null.
 */
export function mergeRequestUrl(remote, source, target = '') {
  let host = '';
  let repoPath = '';
  const text = String(remote ?? '').trim();
  let m;
  if ((m = /^[\w.-]+@([^:/\s]+):(?!\/)(.+)$/.exec(text))) [host, repoPath] = [m[1], m[2]];
  else if ((m = /^(?:ssh|git|https?):\/\/(?:[^@/\s]*@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(text))) [host, repoPath] = [m[1], m[2]];
  else return null;
  repoPath = repoPath.replace(/\.git$/, '').replace(/\/+$/, '');
  const enc = (b) => encodeURIComponent(b).replace(/%2F/gi, '/');
  if (/(^|\.)dev\.azure\.com$|visualstudio\.com$/.test(host)) {
    // ssh.dev.azure.com:v3/org/project/repo, or dev.azure.com/org/project/_git/repo.
    const parts = repoPath.replace(/^v3\//, '').split('/');
    const [org, project, repo] = parts.includes('_git') ? [parts[0], parts[1], parts[parts.indexOf('_git') + 1]] : parts;
    if (!org || !project || !repo) return null;
    return { url: `https://dev.azure.com/${org}/${project}/_git/${repo}/pullrequestcreate?sourceRef=${enc(source)}${target ? `&targetRef=${enc(target)}` : ''}`, label: 'pull request' };
  }
  if (/github/i.test(host)) return { url: `https://${host}/${repoPath}/compare/${target ? `${enc(target)}...` : ''}${enc(source)}?expand=1`, label: 'pull request' };
  if (/gitlab/i.test(host)) return { url: `https://${host}/${repoPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(source)}${target ? `&merge_request%5Btarget_branch%5D=${encodeURIComponent(target)}` : ''}`, label: 'merge request' };
  if (/bitbucket/i.test(host)) return { url: `https://${host}/${repoPath}/pull-requests/new?source=${encodeURIComponent(source)}${target ? `&dest=${encodeURIComponent(target)}` : ''}`, label: 'pull request' };
  return null;
}

// ---- History: the commits of the history view (git.cjs history, ui/gitHistory.js) ----

/**
 * The refs `git log --decorate=full` names for a commit ("HEAD -> refs/heads/main, tag:
 * refs/tags/v1, refs/remotes/origin/main") → [{ kind, name }]: 'head' (the branch checked out),
 * 'detached' (HEAD on no branch), 'branch', 'remote', 'tag'. A remote's own HEAD is left out.
 */
export function parseRefs(decoration) {
  const refs = [];
  for (const raw of String(decoration ?? '').split(', ')) {
    const part = raw.trim();
    if (!part) continue;
    if (part === 'HEAD') refs.push({ kind: 'detached', name: 'HEAD' });
    else if (part.startsWith('HEAD -> ')) refs.push({ kind: 'head', name: part.slice(8).replace(/^refs\/heads\//, '') });
    else if (part.startsWith('tag: ')) refs.push({ kind: 'tag', name: part.slice(5).replace(/^refs\/tags\//, '') });
    else if (part.startsWith('refs/heads/')) refs.push({ kind: 'branch', name: part.slice(11) });
    else if (part.startsWith('refs/remotes/')) {
      if (!/\/HEAD$/.test(part)) refs.push({ kind: 'remote', name: part.slice(13) });
    } else refs.push({ kind: 'branch', name: part });
  }
  const order = { head: 0, detached: 0, branch: 1, remote: 2, tag: 3 };
  return refs.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * The commits git.cjs's history op asked for: records that start with \x1e, fields split by \x1f
 * (hash, parents, author, mail, author time, committer, commit time, refs, subject), and with a
 * file followed (`--name-status`) its status lines after → [{ hash, parents, author, mail, time,
 * committer, committerTime, refs, subject, path? (the file's name at that commit), status? }].
 */
export function parseHistory(out) {
  const commits = [];
  for (const record of String(out ?? '').split('\x1e')) {
    if (!record.trim()) continue;
    const [head, ...rest] = record.split('\n');
    const f = head.split('\x1f');
    if (f.length < 9 || !/^[0-9a-f]{7,64}$/.test(f[0])) continue;
    const commit = {
      hash: f[0],
      parents: f[1].split(' ').filter(Boolean),
      author: f[2],
      mail: f[3],
      time: Number(f[4]) || 0,
      committer: f[5],
      committerTime: Number(f[6]) || 0,
      refs: parseRefs(f[7]),
      subject: f.slice(8).join('\x1f'),
    };
    // The file followed: its status line names it as it was then (a rename: the new name last).
    const line = rest.find((l) => /^[ACDMRTU]\d*\t/.test(l));
    if (line) {
      const parts = line.split('\t');
      commit.status = parts[0][0];
      commit.path = unquotePath(parts[parts.length - 1]);
      if (commit.status === 'R' || commit.status === 'C') commit.from = unquotePath(parts[1]);
    }
    commits.push(commit);
  }
  return commits;
}
