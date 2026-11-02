// Git history (0.49): a comparison tab of mode 'history' (store's c:<id>; app.js
// actions.gitHistory / fileHistory). The commits of a repository newest first, a page at a time,
// with the graph of their branches and merges (gitGraph.js), their branches and tags as chips,
// searched by words or author, for one branch, a folder or one file followed through its renames
// (gitHistory.js builds the requests: git.cjs act `history`). A commit picked shows its message,
// who and when, its parents and the files it changed: each opens as the file before and after it
// (or against the file now). Its menu copies, makes a branch or a tag there, cherry-picks,
// reverts and resets, each asked first and through actions.gitRun (a backup first where history
// moves, so Undo puts it back). Rows are drawn only near the screen (long histories).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { graphRows, linePath, linearRows } from '../gitGraph.js';
import { FILE_STATUS, HISTORY_PAGE, MAX_RELOAD, actionQuestion, chipRef, chipText, chipTitle, commitCount, commitMenu, fileSides, graphShown, historyName, historyRequest, isMerge, lastPart, pathIn, refChips, refLabel, shortHash } from '../gitHistory.js';
import { blameAgo, branchNameProblem } from '../gitStatus.js';
import { shortDate } from '../format.js';
import { getSettings, saveSettings } from '../settings.js';
import { diskKey } from '../store.js';
import { isRemotePath, remoteParts } from '../where.js';
import { server } from '../servers.js';
import { ClearButton, Modal, Segmented, toast } from './components.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';
import { Menu } from './menu.js';
import { Splitter } from './splitter.js';
import { usePhoneLayout } from './phone.js';

// Sizes of a row and of a lane of the graph (px): a phone's rows hold two lines, its lanes are narrower.
const SIZES = { desk: { h: 28, w: 14, lanes: 16 }, phone: { h: 46, w: 10, lanes: 8 } };
const OVERSCAN = 12;
// Commits' details by repository and hash (a commit never changes): the last few hundred.
const infos = new Map();
const remember = (key, value) => {
  infos.delete(key);
  infos.set(key, value);
  while (infos.size > 300) infos.delete(infos.keys().next().value);
};
// A tab's list while another tab is shown (the history comes back where it was): tab id → state.
const memory = new Map();
const when = (time) => (time ? new Date(time * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const message = (err) => String(err?.message ?? err ?? '').replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const copy = async (text, said) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(said, { timeout: 2000 });
  } catch {
    toast('Could not copy here.', { kind: 'error' });
  }
};

/** The graph cell of a row: its lines and its dot (hollow for a merge, ringed for HEAD). */
function GraphCell({ row, size, cols, merge, head }) {
  const pad = Math.round(size.w / 2) + 2;
  const width = pad * 2 + Math.max(0, Math.min(cols, size.lanes) - 1) * size.w;
  const x = pad + row.lane * size.w;
  const y = size.h / 2;
  const r = size === SIZES.phone ? 3.5 : 4;
  return html`<svg class="ghist-graph" width=${width} height=${size.h} viewBox=${`0 0 ${width} ${size.h}`} aria-hidden="true">
    ${row.lines.map((l) => html`<path class=${`g-c${l.color}`} d=${linePath(l, { w: size.w, h: size.h, pad })} />`)}
    ${head && html`<circle class=${`g-c${row.color} ghist-head-ring`} cx=${x} cy=${y} r=${r + 3} />`}
    <circle class=${`g-c${row.color} ${merge ? 'ghist-dot merge' : 'ghist-dot'}`} cx=${x} cy=${y} r=${r} />
  </svg>`;
}

/** A row's branches and tags: chips (a click shows that ref's history), the rest in "+N". */
function RefChips({ refs, onPick, max = 3 }) {
  const { shown, rest } = refChips(refs, max);
  if (!shown.length) return null;
  return html`<span class="ghist-chips">
    ${shown.map(
      (c) => html`<button type="button" class=${`ghist-chip ${c.kind}`} title=${`${chipTitle(c)} · click: its history alone`}
        onClick=${(e) => (e.stopPropagation(), onPick(chipRef(c)))}>${c.kind === 'tag' ? html`<${Icon} name="tag" size=${11} />` : c.kind === 'remote' ? html`<${Icon} name="cloud" size=${11} />` : c.kind === 'detached' ? null : html`<${Icon} name="branch" size=${11} />`}<span>${chipText(c)}</span></button>`,
    )}
    ${rest.length > 0 && html`<span class="ghist-chip more" title=${rest.map(chipTitle).join('\n')}>+${rest.length}</span>`}
  </span>`;
}

/**
 * The history tab: `record` { root, ref, query, folder, file, rel, name } (gitHistory.js);
 * `actions.gitLook` reads (history, commit-info, changed-since, file-text), `actions.gitRun` changes.
 */
export function GitHistoryTab({ id, record, actions }) {
  const phone = usePhoneLayout();
  const size = phone ? SIZES.phone : SIZES.desk;
  const sig = JSON.stringify([record.root, record.ref ?? '', record.query ?? '', record.folder ?? '', record.rel ?? '']);
  const kept = memory.get(id);
  const restore = kept?.sig === sig ? kept : null;
  const empty = { commits: [], rows: [], state: null, width: 1, more: false, head: '', branch: '', root: record.root, loading: true, error: null, none: false };
  const [data, setData] = useState(() => restore?.data ?? empty);
  const [selected, setSelected] = useState(restore?.selected ?? null);
  const [details, setDetails] = useState(null); // { hash, info } | { hash, error } | { hash, loading }
  const [filesMode, setFilesMode] = useState(restore?.filesMode ?? 'commit');
  const [nowFiles, setNowFiles] = useState(null); // { hash, files, more } | { hash, error } | { hash, loading }
  const [menu, setMenu] = useState(null); // { at, commit }
  const [refMenu, setRefMenu] = useState(null);
  const [asking, setAsking] = useState(null); // actionQuestion
  const [naming, setNaming] = useState(null); // { kind: 'branch'|'tag', commit, switchTo }
  const [busy, setBusy] = useState(null);
  const [search, setSearch] = useState(record.query ?? '');
  const [pathText, setPathText] = useState(record.folder ?? '');
  const [branches, setBranches] = useState(null);
  const [view, setView] = useState({ top: restore?.top ?? 0, height: 600 });
  const [split, setSplit] = useState(() => getSettings().historySplit || 0.58);
  const list = useRef(null);
  const body = useRef(null);
  const refButton = useRef(null);
  const startSplit = useRef(0);
  const seq = useRef(0);
  const now = useRef({});
  now.current = { data, selected, filesMode, view };
  const graph = graphShown(record);
  const root = data.root || record.root;
  const commits = data.commits;
  const index = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits]);
  const current = selected != null && index.has(selected) ? commits[index.get(selected)] : null;
  const cols = Math.max(1, data.width);

  /** Reads the first page (`keep`: as many as are listed now, the selection kept), or the next page. */
  const load = async ({ more = false, keep = false } = {}) => {
    const mine = ++seq.current;
    const d = now.current.data;
    const skip = more ? d.commits.length : 0;
    const limit = more ? HISTORY_PAGE : keep ? Math.min(MAX_RELOAD, Math.max(HISTORY_PAGE, d.commits.length)) : HISTORY_PAGE;
    setData((x) => ({ ...x, loading: !more && !keep, loadingMore: more, refreshing: keep }));
    // A server not connected now is not connected by showing its history (as the Git panel: Connect).
    if (!more && isRemotePath(record.root)) {
      const st = await window.desktop?.git?.status?.(record.root).catch(() => null);
      if (mine !== seq.current) return;
      if (st?.offline) return setData((x) => ({ ...x, loading: false, loadingMore: false, refreshing: false, error: { kind: 'offline', message: `${server(remoteParts(record.root).id)?.name ?? 'The server'} is not connected.`, detail: '' } }));
    }
    const r = await actions.gitLook(record.root, historyRequest(record, { skip, limit }));
    if (mine !== seq.current) return;
    if (!r.ok) return setData((x) => ({ ...x, loading: false, loadingMore: false, refreshing: false, error: r.error, ...(more ? {} : { commits: [], rows: [], state: null, more: false }) }));
    const res = r.result ?? {};
    const page = res.commits ?? [];
    const made = graph ? graphRows(page, more ? d.state : null) : { rows: linearRows(page, { more: res.more, first: !more }), state: null, width: 1 };
    const next = {
      commits: more ? [...d.commits, ...page] : page,
      rows: more ? [...d.rows, ...made.rows] : made.rows,
      state: made.state,
      width: more ? Math.max(d.width, made.width) : made.width,
      more: Boolean(res.more),
      head: res.head ?? '',
      branch: res.branch ?? '',
      root: res.root ?? record.root,
      none: Boolean(res.empty),
      loading: false,
      loadingMore: false,
      refreshing: false,
      error: null,
    };
    setData(next);
    // The commit checked out (else the newest) is picked: at first, and when the one picked is gone from the list.
    if (!more && !next.commits.some((c) => c.hash === now.current.selected)) {
      const pick = next.commits.find((c) => c.hash === next.head) ?? next.commits[0];
      setSelected(pick?.hash ?? null);
    }
  };

  // Reads again when what is asked changes; keeps the place when the tab comes back.
  const mounted = useRef(false);
  useEffect(() => {
    if (restore && !mounted.current) load({ keep: true });
    else {
      if (mounted.current && list.current) list.current.scrollTop = 0;
      load();
    }
    mounted.current = true;
    // What was typed stays as typed (a space at its end too) while it says the same.
    if ((record.query ?? '') !== search.trim()) setSearch(record.query ?? '');
    if ((record.folder ?? '') !== pathText.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')) setPathText(record.folder ?? '');
  }, [sig]);
  // Git changed (a command here, the Git panel, a commit elsewhere seen on focus): read again, the place kept.
  useEffect(() => {
    let last = Date.now();
    const again = () => {
      last = Date.now();
      nowCache.current.clear();
      setNowTick((n) => n + 1);
      load({ keep: true });
    };
    const onFocus = () => Date.now() - last > 2000 && again();
    window.addEventListener('git:changed', again);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('git:changed', again);
      window.removeEventListener('focus', onFocus);
    };
  }, [sig]);
  // Remembered while another tab is shown.
  useEffect(() => () => {
    const n = now.current;
    memory.set(id, { sig, data: { ...n.data, loading: false, loadingMore: false, refreshing: false }, selected: n.selected, filesMode: n.filesMode, top: n.view.top });
    if (memory.size > 20) memory.delete(memory.keys().next().value);
  }, [sig]);
  // The list's height (rows are drawn only near the screen); its place when it comes back.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (restore?.top) el.scrollTop = restore.top;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.focus({ preventScroll: true });
    return () => ro.disconnect();
  }, []);
  // The next page when the end of the list comes near.
  useEffect(() => {
    if (data.more && !data.loading && !data.loadingMore && !data.error && view.top + view.height > commits.length * size.h - 10 * size.h) load({ more: true });
  }, [view.top, view.height, commits.length, data.more, data.loading, data.loadingMore]);

  // The commit picked: its details (asked once per repository and commit).
  const pickedHash = selected;
  useEffect(() => {
    if (!pickedHash) return setDetails(null);
    const key = `${root}\n${pickedHash}`;
    if (infos.has(key)) return setDetails({ hash: pickedHash, info: infos.get(key) });
    let stale = false;
    setDetails({ hash: pickedHash, loading: true });
    const t = setTimeout(async () => {
      const r = await actions.gitLook(record.root, { op: 'commit-info', hash: pickedHash });
      if (stale) return;
      if (r.ok && r.result) remember(key, r.result);
      setDetails(r.ok && r.result ? { hash: pickedHash, info: r.result } : { hash: pickedHash, error: r.ok ? 'This commit could not be read.' : r.error.message });
    }, 60);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [pickedHash, root]);
  // Against the files now: what differs between the commit and the working tree (kept per commit
  // until Git or the files change: `nowTick`).
  const nowCache = useRef(new Map());
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (filesMode !== 'now' || !pickedHash) return;
    const known = nowCache.current.get(pickedHash);
    if (known) return setNowFiles({ hash: pickedHash, ...known });
    let stale = false;
    setNowFiles({ hash: pickedHash, loading: true });
    actions.gitLook(record.root, { op: 'changed-since', hash: pickedHash }).then((r) => {
      const got = r.ok ? { ...r.result } : { error: r.error.message };
      if (r.ok) nowCache.current.set(pickedHash, got);
      if (!stale) setNowFiles({ hash: pickedHash, ...got });
    });
    return () => {
      stale = true;
    };
  }, [filesMode, pickedHash, nowTick]);

  // ---- Choosing what is shown ----
  const setRecord = (patch) => {
    const next = { ...record, ...patch };
    actions.updateCompare(id, { ...patch, name: historyName(next, lastPart(root)) });
  };
  // Typing searches a moment later; Enter at once.
  useEffect(() => {
    if ((search ?? '') === (record.query ?? '')) return;
    const t = setTimeout(() => setRecord({ query: search.trim() }), 450);
    return () => clearTimeout(t);
  }, [search]);
  const applyPath = () => {
    const p = pathText.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
    if (p.split('/').includes('..')) return toast('A path inside the repository, without “..”.', { kind: 'error' });
    if (p !== (record.folder ?? '')) setRecord({ folder: p });
  };
  const openRefMenu = async () => {
    const r = refButton.current?.getBoundingClientRect();
    if (refMenu) return setRefMenu(null);
    setRefMenu({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
    if (!branches) {
      const b = await actions.gitLook(record.root, { op: 'branches' });
      setBranches(b.ok ? b.result : { local: [], remote: [] });
    }
  };
  const refItems = () => {
    const pick = (ref) => () => setRecord({ ref });
    const items = [
      { label: 'All branches', icon: 'branch', checked: !record.ref, hint: 'and tags', run: pick('') },
      { label: refLabel('HEAD', data.branch), icon: 'branch', checked: record.ref === 'HEAD', run: pick('HEAD') },
    ];
    const local = branches?.local ?? [];
    const remote = branches?.remote ?? [];
    if (record.ref && record.ref !== 'HEAD' && !local.some((b) => b.name === record.ref) && !remote.some((b) => b.name === record.ref)) items.push({ label: record.ref, checked: true, run: pick(record.ref) });
    if (!branches) items.push({ separator: true }, { label: 'Reading the branches…', disabled: true, run: () => {} });
    if (local.length) items.push({ heading: true, label: 'Branches' }, ...local.map((b) => ({ label: b.name, checked: record.ref === b.name, hint: b.current ? 'checked out' : b.when, run: pick(b.name) })));
    if (remote.length) items.push({ heading: true, label: 'Remote branches' }, ...remote.map((b) => ({ label: b.name, checked: record.ref === b.name, hint: b.when, run: pick(b.name) })));
    return items;
  };

  // ---- Moving in the list ----
  const reveal = (i) => {
    const el = list.current;
    if (!el || i < 0) return;
    const top = i * size.h;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + size.h > el.scrollTop + el.clientHeight) el.scrollTop = top + size.h - el.clientHeight;
  };
  const select = (hash, { show = true } = {}) => {
    setSelected(hash);
    if (show && index.has(hash)) reveal(index.get(hash));
  };
  const keyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    const i = current ? index.get(current.hash) : -1;
    const pageRows = Math.max(1, Math.floor((list.current?.clientHeight ?? 300) / size.h) - 1);
    const go = (to) => {
      e.preventDefault();
      const n = Math.max(0, Math.min(commits.length - 1, to));
      if (commits[n]) select(commits[n].hash);
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'PageDown') go(i + pageRows);
    else if (e.key === 'PageUp') go(i - pageRows);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(commits.length - 1);
    else if (e.key === 'Enter' && current && record.file) {
      e.preventDefault();
      openFileChange(current);
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && current) {
      e.preventDefault();
      const top = (index.get(current.hash) + 1) * size.h - (list.current?.scrollTop ?? 0);
      const box = list.current.getBoundingClientRect();
      setMenu({ at: { x: box.left + 40, y: box.top + Math.min(Math.max(top, 0), box.height) }, commit: current });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && current && !String(getSelection?.() ?? '')) {
      e.preventDefault();
      copy(current.hash, `Copied ${shortHash(current.hash)}`);
    }
  };

  // ---- Files at a commit, opened as a comparison ----
  const read = (side) => (side ? actions.gitLook(record.root, { op: 'file-text', hash: side.hash, path: side.path }) : Promise.resolve({ ok: true, result: null }));
  const byLine = (c) => `${c.author || c.mail}${c.time ? `, ${when(c.time)}` : ''}`;
  /** A file of `commit` before and after it, read-only, in a comparison tab of its own. */
  const openChange = async (commit, file) => {
    const short = shortHash(commit.hash);
    const name = lastPart(file.path);
    const { before, after } = fileSides(commit, file);
    toast(`Reading ${name} at ${short}…`, { key: 'ghist-file', timeout: 15000 });
    const [b, a] = await Promise.all([read(before), read(after)]);
    if (!b.ok || !a.ok) return toast((b.ok ? a : b).error.message, { key: 'ghist-file', kind: 'error' });
    if (b.result?.binary || a.result?.binary) return toast(`${name} is not a text file: there is nothing to compare here.`, { key: 'ghist-file' });
    toast(`${name} before and after ${short}`, { key: 'ghist-file', timeout: 2000 });
    actions.openTextCompare({
      name: `${name} @ ${short}`,
      left: before ? { text: b.result?.text ?? '', label: `Before ${short}`, detail: `${shortHash(before.hash)} · ${before.path}`, readOnly: true } : { text: '', label: `Before ${short} (not there yet)`, detail: `${file.path} came with this commit`, readOnly: true },
      right: after ? { text: a.result?.text ?? '', label: `${short}: ${commit.subject ?? commit.message ?? ''}`.slice(0, 120), detail: `${byLine(commit)} · ${after.path}`, readOnly: true } : { text: '', label: `${short}: deleted`, detail: `${byLine(commit)} · ${file.path} went with this commit`, readOnly: true },
    });
  };
  /** A file as it was at `commit` against the file now (the right side: the file itself, editable). */
  const openAgainstNow = async (commit, file) => {
    const short = shortHash(commit.hash);
    const then = file.status === 'A' ? null : { hash: commit.hash, path: file.from ?? file.path };
    const name = lastPart(file.path);
    const b = await read(then);
    if (!b.ok) return toast(b.error.message, { kind: 'error' });
    if (b.result?.binary) return toast(`${name} is not a text file: there is nothing to compare here.`);
    const left = then ? { text: b.result?.text ?? '', label: `${lastPart(then.path)} @ ${short}`, detail: `${byLine(commit)} · ${then.path}`, readOnly: true } : { text: '', label: `${name} @ ${short} (not there yet)`, detail: `${file.path} came after this commit`, readOnly: true };
    const right = file.status === 'D' ? { text: '', label: `${name} now (deleted)`, detail: 'Not in the files now', readOnly: true } : { key: diskKey(pathIn(root, file.path)) };
    actions.compareFiles(left, right);
  };
  // A file's history: its commit's file (the name it had then).
  const followedFile = (commit) => ({ status: commit.status ?? 'M', path: commit.path ?? record.rel, ...(commit.from ? { from: commit.from } : {}) });
  const openFileChange = (commit) => openChange(commit, followedFile(commit));
  const openFileNow = (commit) => openAgainstNow(commit, { status: commit.status === 'D' ? 'A' : 'M', path: record.rel, ...(commit.path && commit.path !== record.rel ? { from: commit.path } : {}) });

  // ---- Commands ----
  const gitError = (r, backup) =>
    toast(r.error.message, {
      kind: 'error',
      timeout: 12000,
      action: r.error.kind === 'conflict' || /conflict/i.test(r.error.message) ? { label: 'Git panel', run: () => actions.toggleGit(record.root) } : backup ? { label: 'Undo', run: () => undo(backup) } : null,
    });
  const undo = async (backup) => {
    const r = await actions.gitRun(record.root, { op: 'undo', id: backup.id });
    if (!r.ok) return gitError(r);
    toast('Put back as it was before.', { timeout: 4000 });
  };
  const runQuestion = async (q) => {
    setAsking(null);
    setBusy(q.confirm);
    try {
      let backup = null;
      if (q.backup) {
        const b = await actions.gitRun(record.root, { op: 'backup', label: q.title.replace(/\?$/, '') });
        if (!b.ok) return toast(`Nothing was done: no backup could be made first (${b.error.message}).`, { kind: 'error', timeout: 10000 });
        backup = b.result;
      }
      const r = await actions.gitRun(record.root, q.action);
      if (!r.ok) return gitError(r, backup);
      const done = { 'cherry-pick': 'Cherry-picked', revert: 'Reverted', reset: 'Reset' }[q.action.op] ?? 'Done';
      toast(`${done}: ${q.title.replace(/^\S+\s/, '').replace(/\?$/, '')}.`, { timeout: 10000, ...(backup ? { action: { label: 'Undo', run: () => undo(backup) } } : {}) });
    } finally {
      setBusy(null);
    }
  };
  const runName = async ({ kind, commit, name, message: tagMessage, switchTo }) => {
    setNaming(null);
    setBusy(kind);
    try {
      const action =
        kind === 'tag' ? { op: 'tag', name, rev: commit.hash, ...(tagMessage ? { message: tagMessage } : {}) } : switchTo ? { op: 'switch', create: true, name, from: commit.hash } : { op: 'branch-at', name, rev: commit.hash };
      const r = await actions.gitRun(record.root, action);
      if (!r.ok) return gitError(r);
      toast(kind === 'tag' ? `Tagged ${shortHash(commit.hash)} as ${name}` : switchTo ? `On ${name} now, a new branch at ${shortHash(commit.hash)}` : `Made the branch ${name} at ${shortHash(commit.hash)}`, { timeout: 5000 });
    } finally {
      setBusy(null);
    }
  };
  const runItem = (item, commit) => {
    switch (item) {
      case 'copy-hash':
        return copy(commit.hash, `Copied ${shortHash(commit.hash)}`);
      case 'copy-subject':
        return copy(commit.subject ?? '', 'Copied the message’s first line');
      case 'file-change':
        return openFileChange(commit);
      case 'file-now':
        return openFileNow(commit);
      case 'compare-now':
        select(commit.hash);
        nowCache.current.clear();
        setNowTick((n) => n + 1);
        return setFilesMode('now');
      case 'branch':
      case 'switch':
        return setNaming({ kind: 'branch', commit, switchTo: item === 'switch' });
      case 'tag':
        return setNaming({ kind: 'tag', commit });
      default: {
        const q = actionQuestion(item, commit, { branch: data.branch });
        if (q) setAsking(q);
      }
    }
  };
  const menuItems = (commit) => commitMenu(commit, { head: data.head, branch: data.branch, file: Boolean(record.file) }).map((i) => (i.separator ? i : { ...i, run: () => runItem(i.id, commit) }));
  const openMenu = (e, commit) => {
    e.preventDefault();
    select(commit.hash, { show: false });
    setMenu({ at: { x: e.clientX, y: e.clientY }, commit });
  };

  // ---- Rows ----
  const first = Math.max(0, Math.floor(view.top / size.h) - OVERSCAN);
  const last = Math.min(commits.length, Math.ceil((view.top + view.height) / size.h) + OVERSCAN);
  const row = (c, i) => {
    const r = data.rows[i];
    const picked = c.hash === selected;
    const head = c.hash === data.head;
    const chips = html`<${RefChips} refs=${c.refs} max=${phone ? 2 : 3} onPick=${(ref) => setRecord({ ref })} />`;
    return html`<div key=${c.hash} id=${`ghist-${id}-${i}`} role="option" aria-selected=${picked} class=${`ghist-row ${picked ? 'picked' : ''} ${head ? 'at-head' : ''}`}
      style=${`top:${i * size.h}px;height:${size.h}px`} onClick=${() => select(c.hash, { show: false })} onDblClick=${() => record.file && openFileChange(c)} onContextMenu=${(e) => openMenu(e, c)}>
      ${r && html`<${GraphCell} row=${r} size=${size} cols=${graph ? cols : 1} merge=${isMerge(c)} head=${head} />`}
      ${phone
        ? html`<span class="ghist-two">
            <span class="ghist-line">${chips}<span class="ghist-subject" title=${c.subject}>${c.subject}</span></span>
            <span class="ghist-line ghist-sub">${c.author}<span aria-hidden="true">·</span>${shortDate(c.time * 1000)}${record.file && c.path && c.path !== record.rel ? html`<span aria-hidden="true">·</span><span class="ghist-was">${c.path}</span>` : ''}</span>
          </span>`
        : html`<span class="ghist-main">${chips}<span class="ghist-subject" title=${c.subject}>${c.subject}</span>${record.file && c.path && c.path !== record.rel ? html`<span class="ghist-was" title=${`Called ${c.path} then`}>${c.path}</span>` : ''}</span>
          <span class="ghist-author" title=${c.mail ? `${c.author} <${c.mail}>` : c.author}>${c.author}</span>
          <span class="ghist-date" title=${when(c.time)}>${shortDate(c.time * 1000)}</span>
          <span class="ghist-hash">${shortHash(c.hash).slice(0, 7)}</span>`}
      <button type="button" class="icon-btn xs ghist-row-menu" aria-label=${`Commit ${shortHash(c.hash)}: menu`} title="Copy, branch, tag, cherry-pick, revert, reset…"
        onClick=${(e) => {
          e.stopPropagation();
          select(c.hash, { show: false });
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ at: { x: box.right, y: box.bottom + 4, right: true }, commit: c });
        }}><${Icon} name="more" size=${14} /></button>
    </div>`;
  };

  const offline = data.error?.kind === 'offline';
  const reconnect = async () => {
    if (isRemotePath(record.root)) await actions.reconnectServer?.(remoteParts(record.root).id);
    load();
  };
  const title = record.file ? `History of ${lastPart(record.file)}` : `History of ${lastPart(root)}`;
  const searchingNow = Boolean((record.query ?? '').trim());

  return html`<div class=${`ghist ${phone ? 'phone' : ''}`} style=${`--ghist-split:${(split * 100).toFixed(1)}%`}>
    <div class="ghist-bar" role="toolbar" aria-label="History">
      <span class="ghist-title" title=${record.file ? `${record.file}\nFollowed through its renames` : root}><${Icon} name="history" size=${16} /><span>${title}</span></span>
      <button type="button" ref=${refButton} class="btn ghost sm ghist-ref" aria-haspopup="menu" aria-expanded=${Boolean(refMenu)} title="Which commits: every branch, the one checked out, or one branch" onClick=${openRefMenu}>
        <${Icon} name="branch" size=${14} /><span>${refLabel(record.ref, data.branch)}</span><${Icon} name="chevronDown" size=${13} />
      </button>
      <label class="ghist-search">
        <${Icon} name="search" size=${14} />
        <input type="search" value=${search} placeholder="Search messages · author:name" aria-label="Search the commits: words of their messages, author:name"
          onInput=${(e) => setSearch(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && setRecord({ query: search.trim() })} />
        <${ClearButton} value=${search} onClear=${() => (setSearch(''), setRecord({ query: '' }))} label="Clear the search" />
      </label>
      ${record.file
        ? html`<span class="ghist-file-chip" title=${`${record.rel}: its commits, through its renames`}><${FileIcon} name=${lastPart(record.file)} size=${13} /><span>${record.rel}</span>
            <button type="button" class="icon-btn xs" aria-label="Show the whole repository’s history" title="The whole repository’s history" onClick=${() => setRecord({ file: null, rel: null })}><${Icon} name="x" size=${12} /></button></span>`
        : html`<label class="ghist-path">
            <${Icon} name="folder" size=${14} />
            <input type="text" value=${pathText} placeholder="Folder or file" aria-label="Only the commits that changed this folder or file (a path inside the repository)" spellcheck="false"
              onInput=${(e) => setPathText(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && applyPath()} onBlur=${applyPath} />
            <${ClearButton} value=${pathText} onClear=${() => (setPathText(''), setRecord({ folder: '' }))} label="Clear the path" />
          </label>`}
      <span class="spacer" />
      <span class="muted small ghist-count" aria-live="polite">${data.loading ? 'Reading…' : data.error ? '' : commitCount(commits.length, data.more)}</span>
      <button type="button" class="icon-btn sm ghist-reload" aria-label="Read again" title="Read again" disabled=${data.loading} onClick=${() => load({ keep: true })}>
        <${Icon} name="rotate" size=${15} />
      </button>
    </div>
    ${refMenu && html`<${Menu} items=${refItems()} at=${refMenu} label="Which commits" owner=${refButton} filter=${(branches?.local?.length ?? 0) + (branches?.remote?.length ?? 0) > 12} onClose=${() => setRefMenu(null)} />`}
    <div class="ghist-body" ref=${body}>
      <div class="ghist-list" ref=${list} role="listbox" tabindex="0" aria-label="Commits" aria-busy=${data.loading || data.loadingMore}
        aria-activedescendant=${current ? `ghist-${id}-${index.get(current.hash)}` : undefined}
        onScroll=${(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })} onKeyDown=${keyDown}>
        ${data.loading && !commits.length && html`<p class="ghist-note" role="status"><span class="spinner" aria-hidden="true" />Reading the history…</p>`}
        ${offline && html`<div class="ghist-note"><p class="small">${data.error.message}</p><p><button type="button" class="btn sm primary" onClick=${reconnect}><${Icon} name="rotate" size=${14} />Connect</button></p></div>`}
        ${data.error && !offline && html`<p class="notice error ghist-note" role="alert"><${Icon} name="alert" size=${15} /><span>${data.error.message}${data.error.detail ? html`<br /><span class="muted small">${data.error.detail}</span>` : ''}</span></p>`}
        ${!data.loading && !data.error && data.none && html`<div class="ghist-note"><p class="small">No commits yet: make the first one in the Git panel.</p><p><button type="button" class="btn sm" onClick=${() => actions.toggleGit(record.root)}><${Icon} name="branch" size=${14} />Git panel</button></p></div>`}
        ${!data.loading && !data.error && !data.none && !commits.length && html`<p class="muted small ghist-note">${searchingNow ? 'No commit matches the search.' : record.file ? 'No commit has this file yet: it is new, or not in Git.' : record.folder ? 'No commit changed that folder or file.' : 'Nothing to show.'}</p>`}
        <div class="ghist-rows" style=${`height:${commits.length * size.h}px`}>${commits.slice(first, last).map((c, k) => row(c, first + k))}</div>
        ${data.loadingMore && html`<p class="ghist-note ghist-more" role="status"><span class="spinner" aria-hidden="true" />Reading more…</p>`}
      </div>
      <${Splitter} orientation="horizontal" label="Resize the commit’s details" className="ghist-splitter"
        onStart=${() => (startSplit.current = split)}
        onMove=${(d) => setSplit(Math.min(0.85, Math.max(0.2, startSplit.current + d / Math.max(1, body.current?.clientHeight ?? 1))))}
        onEnd=${() => saveSettings({ historySplit: Number(split.toFixed(3)) })}
        onReset=${() => (setSplit(0.58), saveSettings({ historySplit: 0 }))} />
      <${CommitDetails} commit=${current} details=${details && details.hash === selected ? details : null} record=${record} data=${data} busy=${busy}
        filesMode=${filesMode} nowFiles=${nowFiles?.hash === selected ? nowFiles : null}
        setFilesMode=${(m) => {
          // Against the files now is read again each time it is chosen (files change without Git).
          if (m === 'now') (nowCache.current.clear(), setNowTick((n) => n + 1));
          setFilesMode(m);
        }}
        onSelect=${(hash) => select(hash)} onRef=${(ref) => setRecord({ ref })} onMenu=${(at, commit) => setMenu({ at, commit })} onItem=${runItem}
        onOpen=${(commit, file) => (filesMode === 'now' ? openAgainstNow(commit, file) : openChange(commit, file))} onHistory=${(file) => actions.fileHistory(pathIn(root, file.path))}
        onOpenFile=${(file) => actions.openDiskPath(pathIn(root, file.path))} />
    </div>
    ${menu && html`<${Menu} items=${menuItems(menu.commit)} at=${menu.at} label=${`Commit ${shortHash(menu.commit.hash)}`} onClose=${() => (setMenu(null), list.current?.focus({ preventScroll: true }))} />`}
    ${asking && html`<${AskDialog} question=${asking} onRun=${() => runQuestion(asking)} onClose=${() => setAsking(null)} />`}
    ${naming && html`<${NameDialog} kind=${naming.kind} commit=${naming.commit} switchTo=${naming.switchTo} onRun=${runName} onClose=${() => setNaming(null)} />`}
  </div>`;
}

/** The commit picked: its message, who and when, its parents, the files it changed (or that differ from the files now). */
function CommitDetails({ commit, details, record, data, busy, filesMode, setFilesMode, nowFiles, onSelect, onRef, onMenu, onItem, onOpen, onHistory, onOpenFile }) {
  if (!commit) return html`<div class="ghist-details"><p class="muted small ghist-note">${data.commits.length ? 'Pick a commit to see what it changed.' : ''}</p></div>`;
  const info = details?.info;
  const short = shortHash(commit.hash);
  const body = info ? info.message.split('\n').slice(1).join('\n').replace(/^\n+/, '') : '';
  const sameCommitter = !info || (info.committer === info.author && Math.abs((info.committerTime ?? 0) - (info.time ?? 0)) < 120);
  const files = filesMode === 'now' ? nowFiles : info ? { files: info.files, more: info.more } : null;
  // A file's history: the file followed first.
  const followed = record.file ? (commit.path ?? record.rel) : null;
  const list = files?.files ? [...files.files].sort((a, b) => (b.path === followed) - (a.path === followed)) : [];
  const more = files?.more ?? 0;
  return html`<div class="ghist-details" aria-label=${`Commit ${short}`}>
    <div class="ghist-dhead">
      <h3 class="ghist-dsubject">${commit.subject}</h3>
      <${RefChips} refs=${commit.refs} max=${6} onPick=${onRef} />
    </div>
    <p class="ghist-meta small">
      <${Icon} name="person" size=${13} /><strong>${commit.author}</strong>${commit.mail && html`<span class="muted">${` <${commit.mail}>`}</span>`}
      <span class="muted" title=${when(commit.time)}> · ${blameAgo(commit.time)} (${when(commit.time)})</span>
      ${!sameCommitter && html`<span class="muted"> · committed by ${info.committer}, ${blameAgo(info.committerTime)}</span>`}
    </p>
    <p class="ghist-hashline small">
      <code class="ghist-fullhash" title="The commit’s hash">${commit.hash}</code>
      <button type="button" class="icon-btn xs" aria-label="Copy the hash" title="Copy the hash" onClick=${() => copy(commit.hash, `Copied ${short}`)}><${Icon} name="copy" size=${13} /></button>
      ${commit.parents.length > 0 &&
      html`<span class="muted">${commit.parents.length > 1 ? 'parents' : 'parent'}</span>
        ${commit.parents.map((p, i) => html`<button type="button" class="ghist-parent" title=${`${i === 0 ? 'First parent' : 'Merged in'}: show it`} onClick=${() => onSelect(p)}>${shortHash(p).slice(0, 7)}</button>`)}`}
      ${commit.parents.length === 0 && html`<span class="muted">the first commit</span>`}
    </p>
    ${body && html`<pre class="ghist-message">${body}</pre>`}
    ${details?.error && html`<p class="notice error small" role="alert"><${Icon} name="alert" size=${14} /><span>${details.error}</span></p>`}
    <div class="ghist-actions">
      ${record.file && html`<button type="button" class="btn sm primary" onClick=${() => onItem('file-change', commit)}><${Icon} name="compare" size=${14} />Before and after</button>`}
      <button type="button" class="btn ghost sm" disabled=${Boolean(busy)} onClick=${() => onItem('branch', commit)}><${Icon} name="branch" size=${14} />Branch here…</button>
      ${!isMerge(commit) && commit.hash !== data.head && html`<button type="button" class="btn ghost sm" disabled=${Boolean(busy)} onClick=${() => onItem('cherry-pick', commit)}>Cherry-pick…</button>`}
      <button type="button" class="btn ghost sm" disabled=${Boolean(busy)} onClick=${() => onItem('revert', commit)}><${Icon} name="undo" size=${14} />Revert…</button>
      <button type="button" class="icon-btn sm" aria-label="More for this commit" title="More: copy, tag, reset, compare with the files now…"
        onClick=${(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onMenu({ x: box.right, y: box.bottom + 4, right: true }, commit);
        }}><${Icon} name="more" size=${15} /></button>
      ${busy && html`<span class="muted small" role="status"><span class="spinner" aria-hidden="true" />${busy}…</span>`}
    </div>
    <div class="ghist-files-head">
      <${Segmented} small label="Which files" value=${filesMode} onChange=${setFilesMode}
        options=${[
          { id: 'commit', label: info ? `Changed in it (${(info.files.length + (info.more ?? 0)).toLocaleString()})` : 'Changed in it' },
          { id: 'now', label: 'Against the files now' },
        ]} />
    </div>
    ${files?.loading || (!files && !details?.error) ? html`<p class="muted small ghist-note"><span class="spinner" aria-hidden="true" />Reading…</p>` : null}
    ${files?.error && html`<p class="notice error small" role="alert"><${Icon} name="alert" size=${14} /><span>${files.error}</span></p>`}
    ${files?.files && !list.length && html`<p class="muted small ghist-note">${filesMode === 'now' ? 'No file differs: the files now are as they were at this commit.' : 'No files changed (an empty commit, or a merge that took one side).'}</p>`}
    ${list.length > 0 &&
    html`<ul class="ghist-files" aria-label=${filesMode === 'now' ? 'Files that differ now' : 'Files changed'}>
      ${list.map((f) => {
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const label = FILE_STATUS[f.status] ?? f.status;
        return html`<li class=${`ghist-file st-${f.status} ${f.path === followed ? 'followed' : ''}`}>
          <button type="button" class="ghist-file-open" title=${`${f.path} · ${label}${f.from ? ` from ${f.from}` : ''} · ${filesMode === 'now' ? 'click: as it was at this commit against the file now' : 'click: the file before and after this commit'}`} onClick=${() => onOpen(commit, f)}>
            <span class="ghist-st" aria-label=${label}>${f.status}</span>
            <${FileIcon} name=${lastPart(f.path)} size=${14} />
            <span class="ghist-fname">${lastPart(f.path)}</span>
            ${dir && html`<span class="ghist-fdir muted">${dir}</span>`}
            ${f.from && html`<span class="ghist-from muted">← ${f.from}</span>`}
          </button>
          <span class="ghist-file-tools">
            ${f.status !== 'D' && html`<button type="button" class="icon-btn xs" aria-label=${`History of ${lastPart(f.path)}`} title="Its history" onClick=${() => onHistory(f)}><${Icon} name="history" size=${13} /></button>`}
            ${f.status !== 'D' && html`<button type="button" class="icon-btn xs" aria-label=${`Open ${lastPart(f.path)}`} title="Open the file as it is now" onClick=${() => onOpenFile(f)}><${Icon} name="file" size=${13} /></button>`}
          </span>
        </li>`;
      })}
      ${more > 0 && html`<li class="muted small ghist-note">…and ${more.toLocaleString()} more</li>`}
    </ul>`}
  </div>`;
}

/** Asked before a command changes the repository: what it does, and whether a backup comes first. */
function AskDialog({ question, onRun, onClose }) {
  return html`<${Modal} title=${question.title} onClose=${onClose} className="ghist-ask"
    footer=${html`<button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
      <button type="button" class=${`btn ${question.danger ? 'danger' : 'primary'}`} onClick=${onRun}>${question.confirm}</button>`}>
    <p>${question.body}</p>
  </${Modal}>`;
}

/** A new branch (made there, or switched to) or a tag at a commit: its name (and a tag's message). */
function NameDialog({ kind, commit, switchTo = false, onRun, onClose }) {
  const [name, setName] = useState('');
  const [tagMessage, setTagMessage] = useState('');
  const [sw, setSw] = useState(Boolean(switchTo));
  const problem = name ? branchNameProblem(name) : '';
  const short = shortHash(commit.hash);
  const title = kind === 'tag' ? `Tag ${short}` : sw ? `Switch to a new branch at ${short}` : `Create a branch at ${short}`;
  const submit = (e) => {
    e?.preventDefault();
    if (!name.trim() || problem) return;
    onRun({ kind, commit, name: name.trim(), message: tagMessage.trim(), switchTo: sw });
  };
  return html`<${Modal} title=${title} onClose=${onClose} className="ghist-name"
    footer=${html`<button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!name.trim() || Boolean(problem)} onClick=${submit}>${kind === 'tag' ? 'Tag' : sw ? 'Create and switch' : 'Create'}</button>`}>
    <form class="ghist-name-form" onSubmit=${submit}>
      <p class="muted small">At “${commit.subject}” (${short}).</p>
      <label class="field"><span class="field-label">${kind === 'tag' ? 'Tag' : 'Branch'} name</span>
        <input type="text" value=${name} spellcheck="false" autocomplete="off" placeholder=${kind === 'tag' ? 'v1.2.0' : 'feature/login'} onInput=${(e) => setName(e.currentTarget.value)} aria-invalid=${Boolean(problem)} />
      </label>
      ${problem && html`<p class="small error-text" role="alert">${problem}</p>`}
      ${kind === 'tag' &&
      html`<label class="field"><span class="field-label">Message (optional: makes an annotated tag)</span>
        <textarea rows="3" value=${tagMessage} onInput=${(e) => setTagMessage(e.currentTarget.value)} /></label>`}
      ${kind === 'branch' &&
      html`<label class="small ghist-check"><input type="checkbox" checked=${sw} onChange=${(e) => setSw(e.currentTarget.checked)} />
        <span>Switch to it now <span class="muted">(your files become this commit’s; changes not committed come along)</span></span></label>`}
    </form>
  </${Modal}>`;
}
