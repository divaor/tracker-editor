// Git in the folders view and the editor: what `git status` says about each file, and which
// lines of a file changed since the last commit. Pure: the main process runs git, the Node
// tests use these.

/**
 * `git status --porcelain=v2 --branch -z` → { branch, upstream, ahead, behind, files }
 * (files: path inside the repository → 'M' modified, 'A' added, 'D' deleted, 'R' renamed,
 * 'U' untracked, 'C' in conflict).
 */
export function parseStatus(out) {
  const records = out.split('\0');
  const result = { branch: '', upstream: '', ahead: 0, behind: 0, files: {} };
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
      result.files[parts.slice(8).join(' ')] = codeOf(parts[1]);
    } else if (r.startsWith('2 ')) {
      const parts = r.split(' ');
      result.files[parts.slice(9).join(' ')] = 'R';
      i++; // the original path follows
    } else if (r.startsWith('u ')) {
      result.files[r.split(' ').slice(10).join(' ')] = 'C';
    } else if (r.startsWith('? ')) result.files[r.slice(2)] = 'U';
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
