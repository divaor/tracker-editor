// The history view's requests and words (ui/gitHistory.js; git.cjs act `history`). A history
// tab is a comparison tab (store's c:<id>) with mode 'history': { root (the repository's top, as
// the page names folders), ref ('' every branch, 'HEAD' the one checked out, or a branch or tag),
// query (the search box: words of the message, author:name or @name), folder (a folder inside
// the repository, its commits only), file + rel (one file, followed through its renames) }.
// Pure (no DOM): test/git-history-view.test.js.

/** Commits read at a time (a page), and at most when the list is read again after a change. */
export const HISTORY_PAGE = 200;
export const MAX_RELOAD = 1000;

/** What each status letter of a commit's files means. */
export const FILE_STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged' };

/**
 * The search box's text → { query (words of the message), author }: "author:ann login",
 * "@ann login", 'author:"Ann Lee" fix'. Line breaks are spaces.
 */
export function parseHistorySearch(text) {
  let rest = String(text ?? '').replace(/[\r\n\t]+/g, ' ');
  let author = '';
  rest = rest.replace(/(?:^|\s)(?:author:|@)(?:"([^"]*)"|(\S+))/i, (_, quoted, plain) => {
    author = (quoted ?? plain ?? '').trim();
    return ' ';
  });
  return { query: rest.replace(/\s+/g, ' ').trim(), author };
}

/** Whether a record searches (its rows stand in one column: they need not join up). */
export const searching = (record) => {
  const s = parseHistorySearch(record?.query);
  return Boolean(s.query || s.author);
};

/** Whether the rows draw as a graph: every branch, one, or a folder (git rewrites parents); not a search, nor a file followed. */
export const graphShown = (record) => !searching(record) && !record?.file;

/** git.cjs's history op for a record: a page from `skip`. */
export function historyRequest(record, { skip = 0, limit = HISTORY_PAGE } = {}) {
  const { query, author } = parseHistorySearch(record?.query);
  const path = record?.file ? record.rel : record?.folder;
  return {
    op: 'history',
    skip,
    limit,
    ...(record?.ref ? { ref: record.ref } : {}),
    ...(query ? { query } : {}),
    ...(author ? { author } : {}),
    ...(path ? { path, ...(record.file ? { follow: true } : {}) } : {}),
  };
}

const slash = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const caseless = (p) => (/^[a-z]:/i.test(p) ? p.toLowerCase() : p);

/** `path` as a path inside the repository `root` ('src/a.js'), '' for the root itself, or null outside it. */
export function relIn(root, path) {
  if (!root || !path) return null;
  const r = slash(root);
  const p = slash(path);
  if (caseless(p) === caseless(r)) return '';
  if (!caseless(p).startsWith(`${caseless(r)}/`)) return null;
  return p.slice(r.length + 1);
}

/** A path inside the repository as the page names it (Windows' backslashes kept for a folder here). */
export function pathIn(root, rel) {
  const base = String(root ?? '');
  if (!rel) return base;
  if (/^[A-Za-z]:|\\/.test(base) && !base.startsWith('remote://')) return `${base.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}`;
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/** The last part of a path ('a.js' of 'src/a.js'). */
export const lastPart = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

/** A history tab's name: "History of a.js", "History · repo", "History · repo/src". */
export function historyName(record, rootName = lastPart(record?.root)) {
  if (record?.file) return `History of ${lastPart(record.file)}`;
  return `History · ${rootName || 'repository'}${record?.folder ? `/${record.folder}` : ''}`;
}

/** What the ref picker says: every branch, the one checked out, or the ref chosen. */
export function refLabel(ref, branch = '') {
  if (!ref) return 'All branches';
  if (ref === 'HEAD') return branch ? `Current branch (${branch})` : 'Current commit (HEAD)';
  return ref;
}

/** A row's ref chips: the first `max`, and the rest (named in the "+N" chip's title). */
export function refChips(refs, max = 3) {
  const list = Array.isArray(refs) ? refs : [];
  // A branch and its remote's twin on the same commit read as one chip: "main ⇅ origin".
  const locals = new Set(list.filter((r) => r.kind === 'head' || r.kind === 'branch').map((r) => r.name));
  const chips = [];
  for (const r of list) {
    if (r.kind === 'remote') {
      const slashAt = r.name.indexOf('/');
      const branch = r.name.slice(slashAt + 1);
      const twin = chips.find((c) => (c.kind === 'head' || c.kind === 'branch') && c.name === branch);
      if (slashAt > 0 && locals.has(branch) && twin) {
        twin.remotes = [...(twin.remotes ?? []), r.name.slice(0, slashAt)];
        continue;
      }
    }
    chips.push({ ...r });
  }
  return { shown: chips.slice(0, max), rest: chips.slice(max) };
}

/** A chip's words: "main", "main ⇅ origin", "v1.2". */
export const chipText = (chip) => `${chip.name}${chip.remotes?.length ? ` ⇅ ${chip.remotes.join(', ')}` : ''}`;

/** A chip's title: what it is, in words. */
export function chipTitle(chip) {
  const twin = chip.remotes?.length ? `, the same as ${chip.remotes.map((r) => `${r}/${chip.name}`).join(' and ')}` : '';
  if (chip.kind === 'head') return `${chip.name}: the branch checked out (HEAD)${twin}`;
  if (chip.kind === 'detached') return 'HEAD: checked out on no branch';
  if (chip.kind === 'branch') return `Branch ${chip.name}${twin}`;
  if (chip.kind === 'remote') return `Remote branch ${chip.name}`;
  return `Tag ${chip.name}`;
}

/** The ref a chip shows the history of when clicked. */
export const chipRef = (chip) => (chip.kind === 'detached' ? 'HEAD' : chip.name);

export const shortHash = (hash) => String(hash ?? '').slice(0, 8);
export const isMerge = (commit) => (commit?.parents?.length ?? 0) > 1;

/**
 * The commit menu for `commit` → items { id, label, hint?, disabled?, danger?, separator? } (the
 * view gives each its `run`). `head`: HEAD's commit; `branch`: the branch checked out ('' when on
 * none); `file`: a file's history (its commit's file).
 */
export function commitMenu(commit, { head = '', branch = '', file = false } = {}) {
  if (!commit) return [];
  const short = shortHash(commit.hash);
  const merge = isMerge(commit);
  const atHead = commit.hash === head;
  const onto = branch || 'HEAD';
  return [
    { id: 'copy-hash', label: 'Copy hash', hint: short },
    { id: 'copy-subject', label: 'Copy the message’s first line' },
    { separator: true },
    file && { id: 'file-change', label: 'This file before and after it', hint: 'Enter' },
    file && { id: 'file-now', label: 'Compare with the file now' },
    !file && { id: 'compare-now', label: 'Compare with the files now', hint: 'what differs since' },
    { separator: true },
    { id: 'branch', label: 'Create a branch here…' },
    { id: 'switch', label: 'Switch to a new branch here…', hint: 'checks it out' },
    { id: 'tag', label: 'Tag it…' },
    { separator: true },
    { id: 'cherry-pick', label: `Cherry-pick onto ${onto}…`, disabled: atHead || merge, hint: merge ? 'a merge: pick its commits' : atHead ? `${onto} is here` : '' },
    { id: 'revert', label: 'Revert it…', hint: merge ? `undoes what the merge brought into ${onto}` : 'a new commit undoing it' },
    { separator: true },
    { id: 'reset-soft', label: `Reset ${onto} to here, keeping the changes staged…`, disabled: atHead },
    { id: 'reset-mixed', label: `Reset ${onto} to here, keeping the changes…`, disabled: atHead },
    { id: 'reset-hard', label: `Reset ${onto} to here, throwing the changes away…`, danger: true, hint: 'after a backup' },
  ].filter(Boolean);
}

/**
 * The question asked before a command changes the repository → { title, body, confirm, danger,
 * backup (a backup first, so Undo can put things back), action (for git.cjs act) }, or null.
 */
export function actionQuestion(id, commit, { branch = '' } = {}) {
  if (!commit) return null;
  const short = shortHash(commit.hash);
  const subject = commit.subject || short;
  const onto = branch || 'HEAD (on no branch)';
  if (id === 'cherry-pick')
    return {
      title: `Cherry-pick ${short}?`,
      body: `“${subject}” is applied to ${onto} as a new commit. The files on disk change; if its changes clash with yours, it stops halfway for you to finish in the Git panel.`,
      confirm: 'Cherry-pick',
      backup: true,
      action: { op: 'cherry-pick', rev: commit.hash },
    };
  if (id === 'revert') {
    const merge = isMerge(commit);
    return {
      title: `Revert ${short}?`,
      body: merge
        ? `A new commit on ${onto} undoes what the merge “${subject}” brought in (its first parent’s side is kept). The commit itself stays in the history.`
        : `A new commit on ${onto} undoes “${subject}”. The commit itself stays in the history.`,
      confirm: 'Revert',
      backup: true,
      action: { op: 'revert', rev: commit.hash, ...(merge ? { mainline: 1 } : {}) },
    };
  }
  const reset = { 'reset-soft': 'soft', 'reset-mixed': 'mixed', 'reset-hard': 'hard' }[id];
  if (reset)
    return {
      title: `Reset ${branch || 'HEAD'} to ${short}?`,
      body:
        reset === 'hard'
          ? `${branch || 'HEAD'} moves back to “${subject}”, and every change in your files since — committed or not — is thrown away. A backup is made first: Undo brings it all back.`
          : `${branch || 'HEAD'} moves back to “${subject}”. The commits after it leave the branch; what they changed stays in your files${reset === 'soft' ? ', staged for the next commit' : ', not staged'}. A backup is made first: Undo puts the branch back.`,
      confirm: reset === 'hard' ? 'Throw away and reset' : 'Reset',
      danger: reset === 'hard',
      backup: true,
      action: { op: 'reset', mode: reset, rev: commit.hash },
    };
  return null;
}

/** What a commit's file opens as: the file before and after it (renames: its name before). */
export function fileSides(commit, file) {
  const parent = commit?.parents?.[0] ?? null;
  const before = file.status === 'A' || !parent ? null : { hash: parent, path: file.from ?? file.path };
  const after = file.status === 'D' ? null : { hash: commit.hash, path: file.path };
  return { before, after };
}

/** How many commits, in words: "1 commit", "200+ commits". */
export const commitCount = (n, more = false) => `${n.toLocaleString()}${more ? '+' : ''} commit${n === 1 && !more ? '' : 's'}`;
