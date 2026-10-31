import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { canDragOut, draggedPaths, draggedTab, dropped, isOwnDrop, onDragOutEnd, startDragOut } from '../dragOut.js';
import { baseName, breadcrumbs, folderLabel, placeLabel, FOLDER_SORTS, isImageName, modeString, moveSectionTo, nameMatcher, opensHere, opensInEditor, parentOf, peekKind, pushRecent, quotePath, rangeOf, renameRange, replaceSection, rootOf, selectionSummary, sortsUp, toggleFavorite, topmost, treeRows, withCurrent } from '../folders.js';
import { formatBytes, timeAgo } from '../format.js';
import { getSettings, isLocal, saveSettings } from '../settings.js';
import { diskKey } from '../store.js';
import { server, servers, serverStatus } from '../servers.js';
import { isRemotePath, KINDS, protocolName, remoteParts, remoteRoot } from '../where.js';
import { isAndroidApp } from '../platform.js';
import { ClearButton, dismissToast, Modal, toast } from './components.js';
import { mirrorOf } from '../mirrors.js';
import { MirrorBar } from './mirrors.js';
import { Icon } from './icons.js';
import { FileIcon } from './fileIcon.js';
import { Menu, MenuButton } from './menu.js';
import { FileViewer, PeekPane } from './folderPreview.js';
import { Splitter } from './splitter.js';
import { onTransfers, running } from '../transfers.js';
import { gitCodeOf, gitOf, onGitState, refreshGit, stageStateOf } from '../gitState.js';
import { GIT_LABELS } from '../gitStatus.js';
import { folderGroupOf } from '../tabViews.js';

// "Git: branch main, 2 ahead … · 3 changed files" for a folder's branch chip.
const branchTitle = (g) => {
  const changed = Object.keys(g.files).length;
  const sync = [g.ahead && `${g.ahead} to push`, g.behind && `${g.behind} to pull`].filter(Boolean).join(', ');
  return `Git: branch ${g.branch}${g.upstream ? ` (${g.upstream}${sync ? `: ${sync}` : ''})` : ''} · ${changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'nothing changed'} since the last commit`;
};

// What a folder's header carries when it is dragged to another place in the order.
const SECTION_DRAG = 'text/x-folder-section';

const PLACES = [
  { id: 'documents', label: 'Documents' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'home', label: 'Home' },
];

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const fail = (err) => toast(message(err), { kind: 'error', timeout: 8000 });
// How long a closed folder is held under a drag before it opens.
const SPRING_MS = 800;
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || p;
const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
// A date for the Modified column: the day and time this year, the day before.
const shortDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
// "this computer", or "this device" in the Android app.
const hereName = () => KINDS.disk.label.toLowerCase();
export const binName = () => (window.desktop?.platform === 'win32' ? 'the Recycle Bin' : 'the Trash');

// Cut or copied in this view (kept while you move between folders): { op: 'cut' | 'copy', paths, text }.
// `text` (the paths) also goes on the system clipboard; a paste whose text differs came from elsewhere.
let clip = null;

/** Moving files to the Recycle Bin: asked first, since the editor cannot bring them back. */
export function DeleteDialog({ entries, onConfirm, onClose }) {
  const names = entries.slice(0, 6).map((e) => e.name);
  const what = entries.length === 1 ? html`<strong>${entries[0].name}</strong>` : count(entries.length, 'item');
  // Servers have no Recycle Bin, nor has a phone: deleting there is for good.
  const onServer = isRemotePath(entries[0]?.path) && server(remoteParts(entries[0].path).id);
  const forGood = onServer || isAndroidApp();
  return html`<${Modal} title="Delete" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary danger" onClick=${onConfirm}><${Icon} name="trash" size=${15} />${forGood ? 'Delete for good' : `Move to ${binName().replace('the ', '')}`}</button>`}>
    <p>${onServer ? html`Delete ${what} from <strong>${onServer.name}</strong>?` : forGood ? html`Delete ${what} from this device?` : html`Move ${what} to ${binName()}?`}</p>
    ${entries.length > 1 && html`<ul class="delete-list">${names.map((n) => html`<li key=${n}>${n}</li>`)}${entries.length > names.length && html`<li class="muted">and ${entries.length - names.length} more</li>`}</ul>`}
    <p class="muted small">${onServer ? 'Files deleted on a server cannot be brought back from here.' : forGood ? 'Android has no Trash for these files: they cannot be brought back.' : `You can restore ${entries.length === 1 ? 'it' : 'them'} from there.`}</p>
  </${Modal}>`;
}

/** Names already where files are being copied or moved: Replace, Keep both or Skip, for all of them. */
export function ExistsDialog({ names, target, onChoose, onClose }) {
  const onServer = isRemotePath(target);
  const shown = names.slice(0, 8);
  return html`<${Modal} title="Already there" onClose=${onClose} className="exists-dialog"
    footer=${html`<button type="button" class="btn ghost" onClick=${onClose}>Cancel</button><span class="spacer" />
      <button type="button" class="btn" onClick=${() => onChoose('skip')} title="Leave out the ones with these names">Skip</button>
      <button type="button" class="btn" onClick=${() => onChoose('keep')} title="The new ones get a number: name (2)">Keep both</button>
      <button type="button" class="btn primary" onClick=${() => onChoose('replace')}>Replace</button>`}>
    <p>${names.length === 1 ? html`<strong>${names[0]}</strong> is` : `${names.length} items with these names are`} already in <strong>${baseName(onServer ? remoteParts(target).path || '/' : target)}</strong>.</p>
    ${names.length > 1 && html`<ul class="delete-list">${shown.map((n) => html`<li key=${n}>${n}</li>`)}${names.length > shown.length && html`<li class="muted">and ${names.length - shown.length} more</li>`}</ul>`}
    <p class="muted small">Replace: the ones there ${onServer ? 'are deleted from the server for good' : isAndroidApp() ? 'are deleted for good' : `go to ${binName()}`}. Keep both: the new ones get a number, as “name (2)”. Skip: those are left out.</p>
  </${Modal}>`;
}

/** The name field of a new or renamed entry, in its row: Enter or leaving it keeps the name, Escape cancels. */
export function NameField({ initial, dir = false, label, onDone, onCancel }) {
  const input = useRef(null);
  const settled = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    el.focus();
    el.setSelectionRange(...renameRange(initial, dir));
  }, []);
  const finish = (keep) => {
    if (settled.current) return;
    settled.current = true;
    const name = input.current.value.trim();
    keep && name ? onDone(name) : onCancel();
  };
  return html`<input ref=${input} class="folder-name-input" defaultValue=${initial} aria-label=${label} spellcheck="false"
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    }}
    onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}
    onBlur=${() => finish(true)} />`;
}

// A file to show in the tree (revealInFolders), taken by the view when it shows or at once.
let pendingReveal = null;

/** Shows the file at `path` in the folders view: the folders above it opened, the file picked. */
export function revealInFolders(path) {
  pendingReveal = path;
  window.dispatchEvent(new CustomEvent('folders:reveal'));
}

/**
 * The folders view of the sidebar (desktop): folders picked in the system
 * dialog, browsed and changed like a file explorer. Text files open as tabs on
 * disk (edited in place, never synced unless copied into your files); other
 * files open with their own program.
 */
export function FoldersView({ settings, activeKey, openKeys, actions }) {
  const bridge = window.desktop.folders;
  const [roots, setRoots] = useState(null);
  const [places, setPlaces] = useState({});
  const [listings, setListings] = useState(() => new Map()); // each folder shown → { dir, entries, truncated, error? }
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [cursor, setCursor] = useState(null); // the row the keyboard is on
  const [anchor, setAnchor] = useState(null); // where Shift+click starts
  const [creating, setCreating] = useState(null); // { kind: 'file' | 'folder', name, text? }
  const [renaming, setRenaming] = useState(null); // path
  const [menu, setMenu] = useState(null); // { entry (null: the folder itself), at }
  const [confirm, setConfirm] = useState(null); // entries to delete
  const [dropTarget, setDropTarget] = useState(null);
  const [, setClipVersion] = useState(0);
  // The tree: folders opened in place (their chevron) and what they hold, as listed.
  const [viewing, setViewing] = useState(null); // the file shown large (Space)
  const peekDrag = useRef({ start: 0, height: 0 });
  const [exists, setExists] = useState(null); // { names, target, run }: asked before a copy or move
  const [expanded, setExpanded] = useState(() => new Set());
  const [children, setChildren] = useState(() => new Map()); // folder → entries (or { error })
  const list = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  const pendingSelect = useRef(null); // a path to select once the folder is read (the one you came up from)
  // Your folders, and the servers set up here (each from its top folder).
  const serverRoots = servers().map((c) => remoteRoot(c.id));
  const rootFor = (p) => (roots ? rootOf(p, [...roots, ...serverRoots]) : null);
  // The folders shown, side by side as roots of the tree (`folder` is the current one; a new
  // current one takes the place of the one before). Those that can be shown are `live`.
  const prevFolder = useRef(settings.folder);
  const sections = withCurrent(settings.folderSections, settings.folder, prevFolder.current);
  const sectionsKey = sections.join('\n');
  // (Kept from the settings as they are now: this render's may be older.)
  useEffect(() => {
    const fresh = getSettings();
    const now = withCurrent(fresh.folderSections, fresh.folder, prevFolder.current);
    prevFolder.current = fresh.folder;
    if (now.join('\n') !== (fresh.folderSections ?? []).join('\n')) saveSettings({ folderSections: now });
  }, [sectionsKey, settings.folder]);
  const live = roots ? sections.filter((s) => rootFor(s)) : [];
  const liveKey = live.join('\n');
  const multi = live.length > 1;
  const collapsed = new Set(multi ? (settings.folderCollapsed ?? []) : []);
  const sectionOf = (p) => (p ? rootOf(p, live) : null);
  // The keyboard (or a click) in another folder shown: that one becomes the current one.
  // (From the settings as they are now: a double click may have gone into a folder since.)
  useEffect(() => {
    if (!multi || !cursor) return;
    const fresh = getSettings();
    const s = rootOf(cursor, withCurrent(fresh.folderSections, fresh.folder));
    if (s && s !== fresh.folder) saveSettings({ folder: s });
  }, [cursor, liveKey]);
  // The folder worked in: the one the keyboard is in, or the current one.
  const dir = (multi && sectionOf(cursor)) || (live.includes(settings.folder) ? settings.folder : (live[0] ?? settings.folder));
  const listing = listings.get(dir) ?? null;
  const root = rootFor(dir);
  const remote = isRemotePath(root);
  const conn = remote ? server(remoteParts(root).id) : null;
  const connState = conn ? serverStatus(conn.id) : null;
  const rootName = (r) => (isRemotePath(r) ? (server(remoteParts(r).id)?.name ?? 'Server') : folderLabel(r));
  const internalDrag = useRef(null); // paths dragged within a folder on a server
  // Terminals: in the editor on SSH servers, the system's terminal app for folders here (none on FTP).
  const terminalFor = (p) => (isRemotePath(p) ? server(remoteParts(p).id)?.protocol === 'sftp' : Boolean(bridge.terminal));
  const hasTerminal = terminalFor(dir);
  // Mirrors: a folder on a server kept on this computer; inside one, its bar and its settings.
  const mirrored = mirrorOf(dir);
  const mirrorItem = (path) => {
    if (!window.desktop?.mirrors) return null;
    const found = mirrorOf(path);
    if (found) return { label: 'Mirror settings…', icon: 'sync', run: () => actions.editMirror(found.mirror) };
    return isRemotePath(path) ? { label: 'Keep on this computer (mirror)…', icon: 'sync', run: () => actions.newMirror({ conn: remoteParts(path).id, remote: remoteParts(path).path }) } : null;
  };

  // Not reachable (the Android app's file access did not start): said, with Try again.
  const [unreachable, setUnreachable] = useState(null);
  const refreshRoots = () =>
    bridge.roots().then(
      (list) => (setRoots(list), setUnreachable(null)),
      (err) => setUnreachable(String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')),
    );
  useEffect(() => {
    refreshRoots();
    bridge.places().then(setPlaces, () => {});
  }, []);
  // The folders shown: those whose picked folder is gone or was forgotten close (the first
  // picked one shows when none is left).
  useEffect(() => {
    if (!roots) return;
    const lost = sections.filter((s) => !isRemotePath(s) && !rootOf(s, roots));
    if (!lost.length && (root || (!roots.length && !settings.folder) || isRemotePath(settings.folder))) return;
    let stale = false;
    bridge.roots().then((fresh) => {
      if (stale) return;
      const now = getSettings();
      const open = withCurrent(now.folderSections, now.folder);
      const keep = open.filter((s) => isRemotePath(s) || rootOf(s, fresh));
      if (keep.length !== open.length || !keep.includes(now.folder)) {
        const folder = keep.includes(now.folder) ? now.folder : (keep[0] ?? fresh[0] ?? '');
        saveSettings({ folderSections: keep.length ? keep : folder ? [folder] : [], folder });
      }
      if (fresh.join('\n') !== roots.join('\n')) setRoots(fresh);
    });
    return () => {
      stale = true;
    };
  }, [roots, sectionsKey, settings.folder, root]);
  // The folders opened in place (inside the ones shown) are read again with them.
  const loadOpen = async (which, open = expanded) => {
    const inside = [...open].filter((p) => which.some((s) => p !== s && rootOf(p, [s])));
    const lists = await Promise.all(inside.map((p) => bridge.list(p).then((l) => [p, l.entries], (err) => [p, { error: message(err) }])));
    setChildren((m) => {
      const next = new Map(m);
      for (const [p, entries] of lists) next.set(p, entries);
      return next;
    });
    return lists.flatMap(([, entries]) => (Array.isArray(entries) ? entries : []));
  };
  /** Reads the folders shown again (`only`: just that one), with the folders opened inside them. */
  const load = async (only = null) => {
    const which = only && live.includes(only) ? [only] : live;
    if (!which.length) return;
    const [lists, deeper] = await Promise.all([Promise.all(which.map((s) => bridge.list(s).catch((err) => ({ dir: s, entries: [], error: message(err) })))), loadOpen(which)]);
    setListings((m) => {
      const next = new Map(m);
      which.forEach((s, i) => next.set(s, lists[i]));
      return next;
    });
    refreshGit(which.filter((s) => !isRemotePath(s)), { force: true });
    const present = new Set([...lists.flatMap((l) => l.entries), ...deeper].map((e) => e.path));
    const read = (p) => which.some((s) => rootOf(p, [s]));
    if (pendingSelect.current && present.has(pendingSelect.current)) {
      select([pendingSelect.current]);
      pendingSelect.current = null;
    } else setSelected((sel) => (Array.from(sel).every((p) => !read(p) || present.has(p)) ? sel : new Set(Array.from(sel).filter((p) => !read(p) || present.has(p)))));
  };
  useEffect(() => {
    if (live.length) load();
  }, [liveKey]);
  // Git (folders on this computer): rows colored by what changed since the last commit.
  const [, setGitVersion] = useState(0);
  useEffect(() => onGitState(() => setGitVersion((v) => v + 1)), []);
  const gitOn = (p) => (isRemotePath(p) ? null : gitCodeOf(rootOf(p, live) ?? dir, p, false));
  // The folders shown are watched, and read again when the window comes back.
  useEffect(() => {
    if (!live.length) return;
    bridge.watch(live).catch(() => {});
    const off = bridge.onChanged((change) => live.includes(change.dir) && load(change.dir));
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      bridge.watch(null).catch(() => {});
      window.removeEventListener('focus', onFocus);
    };
  }, [liveKey]);
  useEffect(() => onDragOutEnd(() => setDropTarget(null)), []);
  // Changed elsewhere in the app (permissions in Properties): read again.
  useEffect(() => {
    const reload = () => live.length && load();
    window.addEventListener('folders:reload', reload);
    return () => window.removeEventListener('folders:reload', reload);
  }, [liveKey]);
  // A transfer that ends (in the background): what it changed is read again.
  useEffect(() => onTransfers((_jobs, job) => job && !running(job) && live.length && load()), [liveKey, expanded]);
  // A server that connects again: its folders are read again.
  const serverStates = live.filter(isRemotePath).map((s) => `${s}:${serverStatus(remoteParts(s).id).state}`).join('\n');
  useEffect(() => {
    for (const s of live) if (isRemotePath(s) && serverStatus(remoteParts(s).id).state === 'connected' && listings.get(s)?.error) load(s);
  }, [serverStates]);

  // The filter looks in the folders inside too (in the main process, a moment after typing):
  // what it finds shows under its folders, opened for it (`shut`: ones closed meanwhile).
  const [deep, setDeep] = useState(null); // { key, query, found, folders, truncated, searching }
  const [deepTick, setDeepTick] = useState(0);
  const [shut, setShut] = useState(() => new Set());
  useEffect(() => {
    const query = filter.trim();
    setShut(new Set());
    if (!query || !live.length || !bridge.findNames) return setDeep(null);
    // While it looks, what was found for the last letters stays (the rows are filtered anyway).
    setDeep((d) => ({ ...(d?.key === liveKey ? d : { found: [], folders: [], truncated: false }), key: liveKey, query, searching: true }));
    let stale = false;
    const timer = setTimeout(async () => {
      const results = await Promise.all(live.map((s) => bridge.findNames(`folders-filter:${s}`, s, query, { hidden: settings.showHidden }).catch(() => null)));
      if (!stale)
        setDeep({ key: liveKey, query, found: results.flatMap((r) => r?.found ?? []), folders: results.flatMap((r) => r?.folders ?? []), truncated: results.some((r) => r?.truncated), searching: false });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [filter, liveKey, settings.showHidden, deepTick]);
  const deepOn = Boolean(filter.trim() && deep?.key === liveKey);
  const shown = new Set(expanded);
  const treeChildren = new Map([...children].filter(([, v]) => Array.isArray(v)));
  if (deepOn) {
    for (const { entry, parent } of [...deep.folders, ...deep.found]) {
      if (live.includes(parent)) continue; // their listings have those
      const list = treeChildren.get(parent) ?? [];
      if (!list.some((e) => e.path === entry.path)) treeChildren.set(parent, [...list, entry]);
      shown.add(parent);
    }
    for (const p of shut) shown.delete(p);
  }
  // Each folder shown with its tree (none for one collapsed to its header; while filtering,
  // its header says how many match in it).
  const passes = nameMatcher(filter);
  const sectionRows = live.map((s) => {
    const all = collapsed.has(s) && !filter.trim()
      ? []
      : treeRows(listings.get(s)?.entries ?? [], {
          expanded: shown,
          children: treeChildren,
          query: filter,
          hidden: settings.showHidden,
          sort: settings.folderSort,
          reverse: settings.folderSortReverse,
        });
    return { dir: s, rows: collapsed.has(s) ? [] : all, matches: filter.trim() ? all.filter((r) => passes(r.entry.name)).length : 0 };
  });
  const rows = sectionRows.flatMap((x) => x.rows);
  const entries = rows.map((r) => r.entry);
  const order = entries.map((e) => e.path);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const depthOf = new Map(rows.map((r) => [r.entry.path, r.depth]));
  const chosen = () => entries.filter((e) => selected.has(e.path));
  // What an action works on: the selection (a folder with what is inside it once), or the row the keyboard is on.
  const targets = () => {
    const picked = chosen();
    if (!picked.length) return cursor && byPath.get(cursor) ? [byPath.get(cursor)] : [];
    const top = new Set(topmost(picked.map((e) => e.path)));
    return picked.filter((e) => top.has(e.path));
  };
  useLayoutEffect(() => {
    if (cursor) list.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // Copy, cut and paste: the system's clipboard events while the list has the focus
  // (Ctrl+V and the Edit menu), so files copied in other apps can be pasted.
  const inList = () => list.current?.contains(document.activeElement) && !document.activeElement.matches('input');
  // The browser runs Paste (and the Edit menu's Copy and Cut) only where the page's text
  // selection is, so it is kept in the list while the list has the focus.
  const claimSelection = () => {
    const sel = getSelection();
    if (list.current && !list.current.contains(sel.anchorNode)) sel.collapse(list.current, 0);
  };
  // The handlers see this render's state even when the event comes before the next render's
  // effects (a key pressed right after a click).
  const now = useRef({});
  useEffect(() => {
    const onCopy = (e) => {
      const { inList, targets, setClip } = now.current;
      if (!inList() || !targets().length) return;
      e.preventDefault();
      setClip(e.type === 'cut' ? 'cut' : 'copy', targets(), (text) => e.clipboardData.setData('text/plain', text));
    };
    const onPaste = async (e) => {
      if (!now.current.inList()) return;
      e.preventDefault();
      // Where it goes: the folder worked in when Ctrl+V was pressed.
      const target = now.current.workDir();
      const files = [...(e.clipboardData?.files ?? [])];
      const text = e.clipboardData?.getData('text/plain') ?? '';
      // What was cut or copied here, when the clipboard still holds it (as files, or as their paths);
      // files in the paste that are not those came from another app. A copy made a moment ago is
      // waited for first.
      const mine = clip;
      await mine?.ready;
      const same = files.length ? files.map((f) => f.name).sort().join('\n') === (mine?.paths ?? []).map(baseName).sort().join('\n') : true;
      const asText = !files.length && (!text || text.replace(/\r\n/g, '\n') === mine?.text);
      const ours = Boolean(mine) && same && (mine.system ? (await bridge.clipOurs().catch(() => false)) || asText : asText);
      if (mine && !ours && clip === mine) clip = null;
      now.current.pasteInto(target, { files, text, ours });
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  // ---- Moving around ----

  /** Opens a folder in place (its contents under it) or closes it. */
  const toggleOpen = async (path, open = !shown.has(path)) => {
    if (deepOn)
      setShut((s) => {
        const next = new Set(s);
        if (open) next.delete(path);
        else for (const p of shown) if (p === path || rootOf(p, [path])) next.add(p);
        return next;
      });
    const next = new Set(expanded);
    if (!open) {
      // Closing a folder closes the ones inside it too.
      for (const p of next) if (p === path || rootOf(p, [path])) next.delete(p);
      setExpanded(next);
      if (cursor && cursor !== path && rootOf(cursor, [path])) select([path]);
      return;
    }
    next.add(path);
    setExpanded(next);
    try {
      const listed = await bridge.list(path);
      setChildren((m) => new Map(m).set(path, listed.entries));
    } catch (err) {
      setChildren((m) => new Map(m).set(path, { error: message(err) }));
      fail(err);
    }
  };

  /** Shows `target` in place of the folder `from` (the one worked in). */
  const go = (target, from = dir) => {
    if (target !== from) saveSettings({ folderRecent: pushRecent(settings.folderRecent, target) });
    setFilter('');
    setCreating(null);
    setRenaming(null);
    setSelected(new Set());
    setCursor(null);
    setAnchor(null);
    saveSettings({ folder: target, folderSections: replaceSection(sections, from, target), folderCollapsed: (settings.folderCollapsed ?? []).filter((p) => p !== target) });
    list.current?.focus();
  };

  // ---- Several folders side by side ----

  /** Opens `path` beside the folders shown (a server's top folder connects first). */
  const openBeside = (path) => actions.showInFolders(path, { beside: true });
  const closeSection = (s) => {
    const next = sections.filter((x) => x !== s);
    if (!next.length) return;
    const at = live.indexOf(s);
    const folder = settings.folder !== s && next.includes(settings.folder) ? settings.folder : (live.filter((x) => x !== s)[Math.max(0, at - 1)] ?? next[0]);
    if (cursor && rootOf(cursor, [s])) setCursor(null);
    setSelected((sel) => new Set([...sel].filter((p) => !rootOf(p, [s]))));
    saveSettings({ folderSections: next, folder, folderCollapsed: (settings.folderCollapsed ?? []).filter((p) => p !== s) });
  };
  const setCollapsed = (list) => saveSettings({ folderCollapsed: list });
  const toggleCollapsed = (s) => {
    if (collapsed.has(s)) return setCollapsed([...collapsed].filter((p) => p !== s));
    if (cursor && rootOf(cursor, [s])) setCursor(null);
    setSelected((sel) => new Set([...sel].filter((p) => !rootOf(p, [s]))));
    setCollapsed([...collapsed, s]);
  };
  /** One folder open, the others collapsed to their headers. */
  const onlySection = (s) => (setCollapsed(live.filter((x) => x !== s)), focusSection(s));
  /** The folder worked in: its header stands out, the path above is its own. */
  const focusSection = (s) => {
    if (cursor && !rootOf(cursor, [s])) setCursor(null);
    if (settings.folder !== s) saveSettings({ folder: s });
    list.current?.focus();
  };
  // A header dragged to another place in the order (a drag of its own: files are never in it).
  const [reorder, setReorder] = useState(null); // { path, over, after }
  const reorderAt = useRef(null);
  const isSectionDrag = (ev) => (ev.dataTransfer?.types ?? []).includes(SECTION_DRAG);
  const startSectionDrag = (ev, d) => {
    ev.stopPropagation();
    ev.dataTransfer.setData(SECTION_DRAG, d);
    ev.dataTransfer.effectAllowed = 'move';
    reorderAt.current = { path: d, over: null, after: false };
    setReorder(reorderAt.current);
  };
  const endSectionDrag = () => ((reorderAt.current = null), setReorder(null));
  // Ended anywhere (dropped elsewhere, Escape): no line left behind.
  useEffect(() => {
    const end = () => reorderAt.current && endSectionDrag();
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragend', end);
      window.removeEventListener('drop', end);
    };
  }, []);
  /** Over a folder shown (or the space after the last one, `d` null): before or after it, by the pointer. */
  const overSection = (ev, d) => {
    const at = reorderAt.current;
    if (!at) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = 'move';
    let over = d;
    let after = true;
    if (d) {
      // Over a header: its halves; over a folder's files: the halves of the whole folder.
      const r = (ev.target.closest?.('.root-head') ?? ev.currentTarget.closest('.root-section') ?? ev.currentTarget).getBoundingClientRect();
      after = ev.clientY > r.top + r.height / 2;
    } else over = live.at(-1);
    if (at.over === over && at.after === after) return;
    reorderAt.current = { ...at, over, after };
    setReorder(reorderAt.current);
  };
  const dropSection = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const at = reorderAt.current;
    endSectionDrag();
    if (!at?.over || at.over === at.path) return;
    const now = getSettings();
    const next = moveSectionTo(withCurrent(now.folderSections, now.folder), at.path, at.over, at.after);
    saveSettings({ folderSections: next });
  };
  const moveSection = (s, by) => {
    const at = sections.indexOf(s);
    const to = Math.max(0, Math.min(sections.length - 1, at + by));
    if (at === -1 || to === at) return;
    const next = sections.filter((x) => x !== s);
    next.splice(to, 0, s);
    saveSettings({ folderSections: next });
  };
  const pick = async (defaultPath) => {
    if (await actions.openFolder(defaultPath)) {
      setFilter('');
      refreshRoots();
    }
  };
  const forget = async (folder) => {
    await bridge.forget(folder);
    refreshRoots();
  };
  // In the tree: the folder being worked in. An opened folder that is picked, or the folder
  // of what is picked inside an opened one; otherwise the folder shown.
  const workDir = () => {
    const e = cursor && byPath.get(cursor);
    if (!e) return dir;
    if (e.dir && shown.has(e.path)) return e.path;
    const parent = dirOf(e.path);
    return !live.includes(parent) && shown.has(parent) ? parent : (sectionOf(e.path) ?? dir);
  };
  // The folder all of `items` are in (several folders: the one shown).
  const folderOf = (items) => {
    const parents = new Set(items.map((e) => dirOf(e.path ?? e)));
    return parents.size === 1 ? [...parents][0] : dir;
  };
  const select = (paths, { at = paths[paths.length - 1] ?? null, keepAnchor = false } = {}) => {
    setSelected(new Set(paths));
    setCursor(at);
    if (!keepAnchor) setAnchor(at);
  };
  // Touch screens: a tap opens, as in a phone's file manager; Select (in the long press menu)
  // makes taps pick instead, until nothing is picked.
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (picking && !selected.size) setPicking(false);
  }, [picking, selected]);

  // A file to show (revealInFolders): once its folder is shown and read, the folders between
  // it and the file open and the file is picked (the filter is cleared).
  const [reveal, setReveal] = useState(null);
  useEffect(() => {
    const take = () => {
      if (!pendingReveal) return;
      setReveal(pendingReveal);
      pendingReveal = null;
    };
    take();
    window.addEventListener('folders:reveal', take);
    return () => window.removeEventListener('folders:reveal', take);
  }, []);
  useEffect(() => {
    const section = reveal && sectionOf(reveal);
    if (!section || !listings.get(section)) return;
    const target = reveal;
    setReveal(null);
    setFilter('');
    (async () => {
      const chain = [];
      for (let d = dirOf(target); d !== section && d !== dirOf(d) && rootOf(d, [section]); d = dirOf(d)) chain.unshift(d);
      const read = await Promise.all(chain.map(async (d) => [d, await bridge.list(d).then((r) => r.entries, (err) => ({ error: message(err) }))]));
      setChildren((m) => new Map([...m, ...read]));
      setExpanded((e) => new Set([...e, ...chain]));
      select([target]);
    })();
  }, [reveal, liveKey, listings]);

  // ---- Opening ----

  const openOutside = (e) => bridge.openExternal(e.path).catch(fail);
  // Pictures show large here and documents (PDFs, e-books, Word…) open in a tab, unless the setting says their program.
  const here = settings.folderMediaOpens !== 'program';
  const inViewer = (e) => !e.dir && here && peekKind(e.name) === 'image';
  /** Opens a file or folder; `outside` opens a picture or document with its program even when they show here. */
  const openEntry = async (e, { many = false, outside = false } = {}) => {
    if (e.dir) return go(e.path, sectionOf(e.path) ?? dir);
    if (!outside && inViewer(e)) return setViewing(e.path);
    if (peekKind(e.name) === 'doc' && (outside || !here)) return openOutside(e);
    if (!opensHere(e.name)) return openOutside(e);
    const problem = await actions.openDiskPath(e.path, { report: false });
    // Not text after all: its own program.
    if (problem && /not a text file/i.test(problem)) return openOutside(e);
    if (problem) toast(`${e.name}: ${problem}`, { kind: 'error' });
    else if (!many) list.current?.focus();
  };
  // Text from a picture (the viewer's and the preview's button), saved next to it if wanted.
  const readText = (e) => actions.readImageFiles([e.path], dirOf(e.path));
  const openSelected = () => {
    const items = targets();
    if (items.length === 1) return openEntry(items[0]);
    const files = items.filter((x) => !x.dir).slice(0, 20);
    // Several pictures: the first shows large (the arrows go through the rest); the others open.
    const shown = files.find(inViewer);
    for (const e of files.filter((x) => !inViewer(x))) openEntry(e, { many: true });
    if (shown) setViewing(shown.path);
  };

  // ---- Changing things (each with Undo where it can be undone) ----

  // After a change: the list read again, open tabs following what moved, what changed here selected.
  // A change made here: the filter looks in the folders inside again.
  const lookAgain = () => filter.trim() && setDeepTick((t) => t + 1);
  const after = async ({ moves = [], made = [] }, done, undo) => {
    await load();
    lookAgain();
    if (moves.length) actions.followDiskMoves(moves);
    const here = [...moves.map((m) => m.to), ...made].filter((p) => live.includes(dirOf(p)) || shown.has(dirOf(p)));
    if (here.length) select(here);
    if (done) toast(done, undo ? { action: { label: 'Undo', run: undo }, timeout: 8000 } : {});
  };
  const create = async ({ kind, name, text, in: where = dir }) => {
    setCreating(null);
    try {
      const path = kind === 'folder' ? await bridge.newFolder(where, name) : await bridge.newFile(where, name, { text: text ?? '' });
      await load();
      lookAgain();
      select([path]);
      if (kind === 'file' && opensInEditor(name)) await actions.openDiskPath(path);
      list.current?.focus();
    } catch (err) {
      fail(err);
      setCreating({ kind, name, text, in: where });
    }
  };
  const startCreating = (kind) => setCreating({ kind, name: kind === 'folder' ? 'New folder' : 'New file.txt', in: workDir() });
  const rename = async (e, name) => {
    setRenaming(null);
    list.current?.focus();
    if (name === e.name) return;
    try {
      const to = await bridge.rename(e.path, name);
      await after({ moves: [{ from: e.path, to }] }, `Renamed to ${name}`, async () => {
        const back = await bridge.rename(to, e.name).catch(fail);
        if (back) after({ moves: [{ from: to, to: back }] });
      });
    } catch (err) {
      fail(err);
    }
  };
  // Names already in `target` are asked about first (Replace / Keep both / Skip); `run(onExists)` does it.
  const askExisting = async (names, target, run) => {
    const taken = names.length ? await bridge.existing(target, names).catch(() => []) : [];
    if (!taken.length) return run('keep');
    setExists({ names: taken, target, run });
  };
  const elsewhere = (paths, target) => paths.filter((p) => dirOf(p) !== target).map(baseName);
  const moveTo = (paths, target, onGo) => askExisting(elsewhere(paths, target), target, (onExists) => (onGo?.(), moveNow(paths, target, onExists)));
  const copyTo = (paths, target) => askExisting(elsewhere(paths, target), target, (onExists) => copyNow(paths, target, onExists));
  // Copies next to the originals, in each one's own folder.
  const duplicate = async (items) => {
    const byFolder = new Map();
    for (const e of items) byFolder.set(dirOf(e.path), [...(byFolder.get(dirOf(e.path)) ?? []), e.path]);
    for (const [folder, paths] of byFolder) await copyNow(paths, folder, 'keep');
  };
  const copyIn = (files, target) => askExisting([...files].map((f) => f.name).filter(Boolean), target, (onExists) => copyInNow(files, target, onExists));
  const moveNow = async (paths, target, onExists) => {
    try {
      if (paths.every((p) => dirOf(p) === target)) return toast(`${paths.length === 1 ? baseName(paths[0]) : count(paths.length, 'item')} ${paths.length === 1 ? 'is' : 'are'} already in ${baseName(target)}.`);
      const moves = await bridge.move(paths, target, { onExists });
      if (moves.transfer) return; // To or from a server: in the background (the Transfers card).
      if (!moves.length) return onExists === 'skip' && toast('Nothing was moved: those are there already.');
      await after({ moves }, `Moved ${count(moves.length, 'item')} to ${baseName(target)}`, async () => {
        const back = [];
        for (const m of moves) back.push(...(await bridge.move([m.to], dirOf(m.from)).catch((err) => (fail(err), []))));
        after({ moves: back });
      });
    } catch (err) {
      fail(err);
    }
  };
  const copyNow = async (paths, target, onExists) => {
    try {
      const copies = await bridge.copy(paths, target, { onExists });
      if (copies.transfer) return;
      if (!copies.length) return toast('Nothing was copied: those are there already.');
      await after({ made: copies.map((c) => c.to) }, `Copied ${count(copies.length, 'item')}${target === dir ? '' : ` to ${baseName(target)}`}`, () =>
        bridge.trash(copies.map((c) => c.to)).then(() => load(), fail),
      );
    } catch (err) {
      fail(err);
    }
  };
  const copyInNow = async (files, target, onExists) => {
    try {
      const copies = await bridge.copyIn(files, target, { onExists });
      if (copies.transfer) return;
      if (!copies.length) return toast('Nothing was added: those are there already.');
      await after({ made: copies.map((c) => c.to) }, `Added ${count(copies.length, 'item')}${target === dir ? '' : ` to ${baseName(target)}`}`, () =>
        bridge.trash(copies.map((c) => c.to)).then(() => load(), fail),
      );
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (doomed) => {
    setConfirm(null);
    try {
      const gone = await bridge.trash(doomed.map((e) => e.path));
      actions.closeDiskPaths(gone);
      lookAgain();
      await load();
      toast(isRemotePath(doomed[0]?.path) || isAndroidApp() ? `Deleted ${count(gone.length, 'item')}` : `Moved ${count(gone.length, 'item')} to ${binName()}`);
    } catch (err) {
      fail(err);
      load();
    }
    list.current?.focus();
  };
  // `write(text)` puts the paths on the clipboard as text. Files here then go there as files too
  // (with their paths as text), so the file explorer can paste them; that comes a moment later,
  // after the copy event's own text.
  // `write(text)` puts the paths on the clipboard as text at once (they stay there when the next
  // step fails). Files here then go there as files too (with their paths as text), so the file
  // explorer can paste them; `ready` settles when that is done, and a paste here waits for it.
  function setClip(op, items, write) {
    const paths = items.map((e) => e.path);
    const mine = { op, paths, text: paths.join('\n'), ready: Promise.resolve() };
    clip = mine;
    const written = Promise.resolve(write(mine.text)).catch(() => {});
    if (!paths.some(isRemotePath) && bridge.clipFiles) {
      // After the copy event's own text, so that does not win.
      mine.ready = written
        .then(() => new Promise((r) => setTimeout(r, 30)))
        .then(() => bridge.clipFiles(paths, op))
        .then((ok) => (mine.system = Boolean(ok)), () => (mine.system = false));
    }
    setClipVersion((v) => v + 1);
    toast(`${op === 'cut' ? 'Cut' : 'Copied'} ${count(paths.length, 'item')}. Ctrl+V pastes ${paths.length === 1 ? 'it' : 'them'} in a folder.`, { timeout: 2500 });
  }
  const clipFromMenu = (op) => targets().length && setClip(op, targets(), (text) => navigator.clipboard.writeText(text));
  /** Files from another app are copied in; what was cut or copied here is moved or copied; plain text becomes a new file. */
  async function pasteInto(target, { files = [], text = '', ours = Boolean(clip) && !files.length && (!text || text === clip.text) }) {
    if (ours && clip) {
      const { op, paths } = clip;
      if (op === 'cut') {
        const cut = clip;
        // Forgotten only when the move happens (Cancel in the "Already there" question keeps it).
        return moveTo(paths, target, () => {
          if (clip === cut) clip = null;
          setClipVersion((v) => v + 1);
        });
      }
      return copyTo(paths, target);
    }
    if (files.length) return copyIn(files, target);
    if (text.trim()) return setCreating({ kind: 'file', name: 'Pasted text.txt', text, in: target });
    toast('Nothing to paste. Copy files here or in your file explorer first.');
  }
  // The Paste button and menu: the same as Ctrl+V, through the system's paste.
  const paste = () => {
    list.current?.focus();
    claimSelection();
    bridge.paste().catch(fail);
  };

  now.current = { inList, targets, setClip, workDir, pasteInto };

  // ---- Zip, compare ----

  const zipSelected = async (items) => {
    toast(`Compressing ${items.length === 1 ? items[0].name : count(items.length, 'item')}…`, { key: 'zip', timeout: 600000 });
    try {
      const made = await bridge.zip(items.map((e) => e.path), folderOf(items));
      dismissToast('zip');
      await after({ made: [made] }, `Made ${baseName(made)}`, () => bridge.trash([made]).then(() => load(), fail));
    } catch (err) {
      dismissToast('zip');
      fail(err);
    }
  };
  const extract = async (e) => {
    toast(`Extracting ${e.name}…`, { key: 'zip', timeout: 600000 });
    try {
      const got = await bridge.unzip(e.path);
      dismissToast('zip');
      await after({ made: [got.folder] }, `Extracted ${count(got.files, 'file')} into ${baseName(got.folder)}${got.skipped.length ? ` (${count(got.skipped.length, 'unsafe name')} left out)` : ''}`, () =>
        bridge.trash([got.folder]).then(() => load(), fail),
      );
    } catch (err) {
      dismissToast('zip');
      fail(err);
    }
  };

  // ---- Dragging ----

  // While something is dragged over the list, bands at its top and bottom scroll it:
  // faster nearer the edge, and on while the pointer rests there (browsers repeat
  // dragover about every 350 ms). They show only on a side that can scroll.
  const DRAG_ZONE = 56;
  const [dragZones, setDragZones] = useState(null); // { up, down, active: -1 | 0 | 1 }
  const autoScroll = useRef({ speed: 0, frame: 0, last: 0, idle: 0 });
  const stopAutoScroll = () => {
    const a = autoScroll.current;
    cancelAnimationFrame(a.frame);
    clearTimeout(a.idle);
    autoScroll.current = { speed: 0, frame: 0, last: 0, idle: 0 };
    setDragZones(null);
  };
  useEffect(() => {
    window.addEventListener('dragend', stopAutoScroll);
    window.addEventListener('drop', stopAutoScroll);
    return () => {
      window.removeEventListener('dragend', stopAutoScroll);
      window.removeEventListener('drop', stopAutoScroll);
      stopAutoScroll();
    };
  }, []);
  const onListDragOver = (ev) => {
    const el = list.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const up = el.scrollTop > 0;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const pull = (d) => (d < DRAG_ZONE ? 3 + ((DRAG_ZONE - Math.max(0, d)) / DRAG_ZONE) ** 2 * 24 : 0);
    const speed = up && ev.clientY - r.top < DRAG_ZONE ? -pull(ev.clientY - r.top) : down && r.bottom - ev.clientY < DRAG_ZONE ? pull(r.bottom - ev.clientY) : 0;
    const a = autoScroll.current;
    a.speed = speed;
    a.last = performance.now();
    clearTimeout(a.idle);
    a.idle = setTimeout(stopAutoScroll, 700);
    const active = Math.sign(speed);
    setDragZones((z) => (z && z.up === up && z.down === down && z.active === active ? z : { up, down, active }));
    if (speed && !a.frame) {
      const step = () => {
        const cur = autoScroll.current;
        if (!cur.speed || performance.now() - cur.last > 700 || !list.current) return void (cur.frame = 0);
        list.current.scrollTop += cur.speed;
        cur.frame = requestAnimationFrame(step);
      };
      a.frame = requestAnimationFrame(step);
    }
  };
  // A closed folder held under a drag opens in place, so the drop can go deeper.
  useEffect(() => {
    // A folder shown, collapsed to its header: it opens.
    if (dropTarget && collapsed.has(dropTarget)) {
      const timer = setTimeout(() => toggleCollapsed(dropTarget), SPRING_MS);
      return () => clearTimeout(timer);
    }
    const e = dropTarget && !live.includes(dropTarget) ? byPath.get(dropTarget) : null;
    if (!e?.dir || shown.has(e.path)) return undefined;
    const timer = setTimeout(() => toggleOpen(e.path, true), SPRING_MS);
    return () => clearTimeout(timer);
  }, [dropTarget]);

  const dragPaths = (e) => (selected.has(e.path) ? topmost(order.filter((p) => selected.has(p))) : [e.path]);
  const onDragStart = (ev, e) => {
    const paths = dragPaths(e);
    if (!selected.has(e.path)) select([e.path]);
    // On a server: moved onto folders here (other apps cannot take them from there).
    if (isRemotePath(e.path)) {
      internalDrag.current = paths;
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData('text/x-folder-paths', JSON.stringify(paths));
      return;
    }
    ev.preventDefault();
    if (!canDragOut()) return;
    // To the desktop, a folder, a terminal or the Claude app as the files themselves; onto a folder here, moved.
    startDragOut(null, { paths });
  };
  const acceptDrag = (ev, target) => {
    const types = ev.dataTransfer?.types ?? [];
    const inside = internalDrag.current;
    if (!types.includes('Files') && !draggedPaths().length && !inside) return;
    if (draggedPaths().includes(target) || inside?.includes(target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = ev.ctrlKey || (!draggedPaths().length && !inside) || draggedTab() ? 'copy' : 'move';
    setDropTarget(target);
  };
  const onDrop = (ev, target) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropTarget(null);
    const inside = internalDrag.current;
    internalDrag.current = null;
    if (inside) return inside.includes(target) ? null : ev.ctrlKey ? copyTo(inside, target) : moveTo(inside, target);
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (isOwnDrop(ev.dataTransfer)) {
      const tab = draggedTab();
      const paths = draggedPaths();
      dropped();
      // A tab: a copy of it is saved here. Files from this view: moved (Ctrl: copied).
      if (tab) return copyIn(files, target);
      if (paths.includes(target)) return;
      return ev.ctrlKey ? copyTo(paths, target) : moveTo(paths, target);
    }
    if (files.length) copyIn(files, target);
  };

  // ---- Keys ----

  const onKeyDown = (ev) => {
    if (ev.target.matches('input')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key;
    const at = order.indexOf(cursor);
    const moveCursor = (to) => {
      const next = order[Math.max(0, Math.min(order.length - 1, to))];
      if (!next) return;
      if (ev.shiftKey) select(rangeOf(order, anchor ?? next, next), { at: next, keepAnchor: true });
      else if (mod) setCursor(next);
      else select([next]);
    };
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if ((key === 'ArrowRight' || key === 'ArrowLeft') && !mod && !ev.altKey && cursor && byPath.get(cursor)) {
      handled();
      const e = byPath.get(cursor);
      if (key === 'ArrowRight') {
        if (e.dir && !shown.has(e.path)) toggleOpen(e.path, true);
        else if (e.dir && order[at + 1] && depthOf.get(order[at + 1]) > depthOf.get(e.path)) select([order[at + 1]]);
      } else if (e.dir && shown.has(e.path)) toggleOpen(e.path, false);
      else if (depthOf.get(e.path) > 0) select([dirOf(e.path)]);
      return;
    }
    if (key === 'ArrowDown') return handled(), moveCursor(at === -1 ? 0 : at + 1);
    if (key === 'ArrowUp' && !ev.altKey) return handled(), moveCursor(at === -1 ? 0 : at - 1);
    if (key === 'Home') return handled(), moveCursor(0);
    if (key === 'End') return handled(), moveCursor(order.length - 1);
    if (key === 'PageDown') return handled(), moveCursor(at + 10);
    if (key === 'PageUp') return handled(), moveCursor(at - 10);
    if (key === ' ' && mod && cursor) {
      handled();
      const next = new Set(selected);
      next.has(cursor) ? next.delete(cursor) : next.add(cursor);
      return setSelected(next);
    }
    if (key === 'Enter' && ev.altKey) return handled(), targets().length === 1 && actions.showProperties(targets()[0].path);
    // Space: the file large, over the window (arrows for the others), like Quick Look.
    if (key === ' ' && !mod && cursor && byPath.get(cursor) && !byPath.get(cursor).dir) return handled(), setViewing(cursor);
    if (key === 'Enter') return handled(), openSelected();
    if (key === 'Backspace' || (key === 'ArrowUp' && ev.altKey)) {
      handled();
      const up = parentOf(dir, root);
      if (up) {
        pendingSelect.current = dir;
        go(up, dir);
      }
      return;
    }
    if (key === 'Delete') return handled(), targets().length && setConfirm(targets());
    if (key === 'F2') return handled(), targets().length === 1 && setRenaming(targets()[0].path);
    if (key === 'F5') return handled(), load();
    if (mod && key.toLowerCase() === 'a') return handled(), select(order, { at: cursor ?? order[0] });
    if (mod && !ev.shiftKey && !ev.altKey && (key.toLowerCase() === 'c' || key.toLowerCase() === 'x')) return handled(), clipFromMenu(key.toLowerCase() === 'x' ? 'cut' : 'copy');
    // Ctrl+V goes on to the browser's paste, which brings the files copied in other apps.
    if (mod && key.toLowerCase() === 'v') return claimSelection();
    if (mod && ev.shiftKey && key.toLowerCase() === 'n') return handled(), startCreating('folder');
    // Find in the folder selected, or the one shown.
    if (mod && ev.shiftKey && key.toLowerCase() === 'f') return handled(), actions.findInFolder(targets().length === 1 && targets()[0].dir ? targets()[0].path : dir);
    if (key === 'Escape') {
      if (clip?.op === 'cut') {
        clip = null;
        setClipVersion((v) => v + 1);
      } else setSelected(new Set());
      return handled();
    }
    // Typing a name goes to it.
    if (key.length === 1 && !mod && !ev.altKey && key !== ' ') {
      handled();
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 800 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
      const from = typed.current.text.length > 1 ? Math.max(at, 0) : at + 1;
      const hit = [...order.slice(from), ...order.slice(0, from)].find((p) => byPath.get(p).name.toLowerCase().startsWith(typed.current.text));
      if (hit) select([hit]);
    }
  };

  // ---- Menus ----

  const sortItems = FOLDER_SORTS.map((s) => ({ label: `Sort by ${s.label.toLowerCase()}`, checked: (settings.folderSort || 'name') === s.id, run: () => saveSettings({ folderSort: s.id }) }));
  const backgroundItems = () => [
    { label: 'New file', icon: 'filePlus', run: () => startCreating('file') },
    { label: 'New folder (Ctrl+Shift+N)', icon: 'folderPlus', run: () => startCreating('folder') },
    { label: 'Paste (Ctrl+V)', icon: 'clipboard', run: paste },
    { label: 'Find in this folder… (Ctrl+Shift+F)', icon: 'search', run: () => actions.findInFolder(dir) },
    window.desktop?.compare && { label: 'Compare with another folder…', icon: 'compare', run: () => actions.compareFolders(dir) },
    window.desktop?.compare && { label: 'Open in two panes…', icon: 'panes', hint: 'This folder and another side by side in a tab, to copy and move files between them', run: () => actions.twoPanes(dir) },
    { separator: true },
    ...sortItems,
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', run: () => saveSettings({ showHidden: !settings.showHidden }) },
    remote && { label: settings.showPermissions ? 'Hide permissions' : 'Show permissions', icon: 'lock', run: () => saveSettings({ showPermissions: !settings.showPermissions }) },
    { label: 'Refresh (F5)', icon: 'rotate', run: () => load() },
    { label: 'Properties of this folder', icon: 'info', run: () => actions.showProperties(dir) },
    { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(dir) },
    hasTerminal && { label: 'Open a terminal here', icon: 'terminal', run: () => actions.terminalHere(dir) },
    !isRemotePath(dir) && bridge.terminal && { label: 'Open in the system’s terminal', icon: 'external', run: () => actions.systemTerminalHere(dir) },
    mirrorItem(dir),
    !remote && !isAndroidApp() && { label: 'Open in the file explorer', icon: 'external', run: () => bridge.openExternal(dir).catch(fail) },
  ];
  const entryItems = () => {
    const items = targets();
    const one = items.length === 1 ? items[0] : null;
    const remote = items.some((e) => isRemotePath(e.path));
    const files = items.filter((e) => !e.dir);
    const images = files.filter((e) => isImageName(e.name));
    // Git: files with changes to stage, or staged ones to leave out of the next commit.
    const states = remote ? [] : files.map((e) => stageStateOf(rootOf(e.path, live) ?? dir, e.path)).filter(Boolean);
    const toStage = states.filter((st) => st.unstaged);
    const toUnstage = states.filter((st) => st.staged);
    const stageFiles = async (list, op) => {
      const r = await actions.gitRun(folderOf(files), { op, paths: list.map((st) => st.rel) });
      if (!r.ok) toast(r.error.message, { kind: 'error', timeout: 9000 });
    };
    return [
      touchScreen() && !picking && { label: 'Select', icon: 'check', hint: 'Then tap others to pick them too', run: () => setPicking(true) },
      { label: one?.dir ? 'Open' : 'Open (Enter)', icon: one?.dir ? 'folderOpen' : 'file', run: openSelected },
      one && !one.dir && { label: 'View it large (Space)', icon: 'fullscreen', run: () => setViewing(one.path) },
      one && !one.dir && { label: 'Open with its program', icon: 'external', run: () => openOutside(one) },
      one && !one.dir && ['M', 'R'].includes(gitOn(one.path)) && opensInEditor(one.name) && { label: 'Compare with the last commit (Git)', icon: 'branch', run: () => actions.compareWithHead(one.path) },
      toStage.length > 0 && { label: toStage.length === 1 ? 'Stage (Git)' : `Stage ${toStage.length} files (Git)`, icon: 'plus', hint: 'Take into the next commit', run: () => stageFiles(toStage, 'stage') },
      toUnstage.length > 0 && { label: toUnstage.length === 1 ? 'Unstage (Git)' : `Unstage ${toUnstage.length} files (Git)`, icon: 'undo', hint: 'Leave out of the next commit', run: () => stageFiles(toUnstage, 'unstage') },
      images.length && images.length === items.length && { label: `Text from ${images.length === 1 ? 'the image' : `${images.length} images`}…`, icon: 'scan', run: () => actions.readImageFiles(images.map((e) => e.path), folderOf(images)) },
      files.length === 2 && items.length === 2 && files.every((e) => opensInEditor(e.name)) && { label: 'Compare the two', icon: 'compare', run: () => actions.compareDiskFiles(files[0].path, files[1].path) },
      window.desktop?.compare && items.length === 2 && items.every((e) => e.dir) && { label: 'Compare the two folders', icon: 'compare', run: () => actions.compareFolders(items[0].path, items[1].path) },
      window.desktop?.compare && one?.dir && { label: 'Compare with another folder…', icon: 'compare', run: () => actions.compareFolders(one.path) },
      window.desktop?.compare && items.length === 2 && items.every((e) => e.dir) && { label: 'Open the two in two panes', icon: 'panes', run: () => actions.twoPanes(items[0].path, items[1].path) },
      window.desktop?.compare && one?.dir && { label: 'Open in two panes…', icon: 'panes', hint: 'This folder and another side by side in a tab, to copy and move files between them', run: () => actions.twoPanes(one.path) },
      // A terminal in the folder (a file's: the folder it is in), in the editor or the system's app.
      one && terminalFor(one.path) && { label: one.dir ? 'Open a terminal here' : 'Open a terminal in its folder', icon: 'terminal', run: () => actions.terminalHere(one.dir ? one.path : dirOf(one.path)) },
      one && !remote && bridge.terminal && { label: 'Open in the system’s terminal', icon: 'external', run: () => actions.systemTerminalHere(one.dir ? one.path : dirOf(one.path)) },
      { separator: true },
      { label: 'Cut (Ctrl+X)', icon: 'scissors', run: () => clipFromMenu('cut') },
      { label: 'Copy (Ctrl+C)', icon: 'copy', run: () => clipFromMenu('copy') },
      one?.dir && { label: 'Paste into this folder', icon: 'clipboard', disabled: !clip, run: () => clip && pasteInto(one.path, {}) },
      { label: 'Duplicate', icon: 'copy', run: () => duplicate(items) },
      one && { label: 'Rename (F2)', icon: 'edit', run: () => setRenaming(one.path) },
      { label: 'Delete (Del)', icon: 'trash', danger: true, run: () => setConfirm(items) },
      { separator: true },
      !remote && { label: one ? `Compress to ${one.dir ? one.name : one.name.replace(/\.[^.]+$/, '') || one.name}.zip` : `Compress ${count(items.length, 'item')} to a zip`, icon: 'archive', run: () => zipSelected(items) },
      !remote && one && !one.dir && /\.zip$/i.test(one.name) && { label: 'Extract into a new folder', icon: 'archive', run: () => extract(one) },
      { label: one ? 'Copy path' : 'Copy paths', icon: 'copy', run: () => (one ? actions.copyPath(one.path) : navigator.clipboard.writeText(items.map((e) => e.path).join('\n')).then(() => toast('Paths copied'))) },
      !remote && { label: one ? 'Copy for Claude (the path)' : 'Copy for Claude (the paths)', icon: 'claude', run: () => navigator.clipboard.writeText(items.map((e) => quotePath(e.path)).join(' ')).then(() => toast('On the clipboard: paste it into Claude')) },
      files.length && files.length === items.length && files.every((e) => opensInEditor(e.name)) && { label: isLocal() ? 'Copy into my files' : 'Copy into my files (synced)', icon: 'filePlus', run: () => files.forEach((e) => actions.copyToFiles(e.path)) },
      one && !remote && window.desktop?.disk?.show && { label: 'Show in the file explorer', icon: 'external', run: () => actions.showOnDisk(one.path) },
      one && { label: 'Properties (Alt+Enter)', icon: 'info', run: () => actions.showProperties(one.path) },
      one?.dir && { label: 'Find in this folder…', icon: 'search', run: () => actions.findInFolder(one.path) },
      one?.dir && mirrorItem(one.path),
      one?.dir && !live.includes(one.path) && { label: 'Open beside (another root in the tree)', icon: 'columns', run: () => openBeside(one.path) },
      one?.dir && { label: (settings.folderFavorites ?? []).includes(one.path) ? 'Remove from favorites' : 'Add to favorites', icon: 'star', run: () => saveSettings({ folderFavorites: toggleFavorite(settings.folderFavorites, one.path) }) },
    ];
  };
  const favoriteItems = (p) => [
    { label: 'Open', icon: 'folderOpen', run: () => go(p) },
    { label: 'Open beside (another root in the tree)', icon: 'columns', run: () => openBeside(p) },
    { label: 'Remove from favorites', icon: 'x', run: () => saveSettings({ folderFavorites: toggleFavorite(settings.folderFavorites, p) }) },
    { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(p) },
  ];
  const rootItems = () => [
    ...roots.map((r) => ({ label: placeLabel(r), hint: placeLabel(r) === r ? undefined : r, icon: 'folder', checked: r === root, run: () => go(r) })),
    ...servers().map((c) => ({ label: `${c.name} (${protocolName(c.protocol)} · ${c.host})`, icon: 'server', checked: remoteRoot(c.id) === root, run: () => actions.openServer(c.id) })),
    { separator: true },
    { label: 'Folders side by side…', icon: 'columns', hint: 'Several of these next to each other, here or on servers', run: () => actions.sideBySide() },
    { label: 'Open another folder…', icon: 'folderOpen', run: () => pick(remote ? undefined : (parentOf(dir, root) ?? root)) },
    { label: 'Connect to a server…', icon: 'server', run: () => actions.editServer() },
    !isAndroidApp() && { label: 'Servers from your SSH config…', icon: 'server', run: () => actions.importSshConfig() },
    window.desktop?.mirrors && { label: 'Mirrors…', icon: 'sync', run: () => actions.showMirrors() },
    window.desktop?.compare && { label: 'Compare this folder with another…', icon: 'compare', run: () => actions.compareFolders(dir) },
    window.desktop?.compare && { label: 'Two panes…', icon: 'panes', hint: 'This folder and another side by side in a tab, to copy and move files between them (like WinSCP)', run: () => actions.twoPanes(dir) },
    (settings.savedCompares ?? []).length > 0 && { label: 'Saved comparisons…', icon: 'star', run: () => actions.showSavedCompares() },
    ...(remote ? [] : PLACES.filter((p) => places[p.id] && !roots.includes(places[p.id])).map((p) => ({ label: `Pick in ${p.label}…`, run: () => pick(places[p.id]) }))),
    { separator: true },
    ...sortItems,
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : `Show hidden files${hiddenCount ? ` (${hiddenCount} here)` : ''}`, icon: 'eye', run: () => saveSettings({ showHidden: !settings.showHidden }) },
    remote && { label: settings.showPermissions ? 'Hide permissions' : 'Show permissions', icon: 'lock', run: () => saveSettings({ showPermissions: !settings.showPermissions }) },
    ...(remote
      ? [
          conn?.protocol === 'sftp' && { label: 'Open a terminal', icon: 'terminal', run: () => actions.terminalHere(dir) },
          { label: `Edit ${conn?.name ?? 'this server'}…`, icon: 'edit', run: () => actions.editServer(conn) },
          connState?.state === 'connected'
            ? { label: 'Disconnect', icon: 'x', run: () => window.desktop.remote.disconnect(conn.id) }
            : { label: 'Connect', icon: 'server', run: () => actions.openServer(conn.id) },
        ]
      : [
          window.desktop?.disk?.show && { label: 'Show this folder in the file explorer', icon: 'external', run: () => actions.showOnDisk(dir) },
          { label: `Forget ${folderLabel(root)}`, icon: 'x', run: () => forget(root) },
        ]),
  ];

  // A folder shown beside others: its header's menu.
  const sectionItems = (s) => {
    const up = parentOf(s, rootFor(s));
    const at = live.indexOf(s);
    const expandFor = () => collapsed.has(s) && toggleCollapsed(s);
    return [
      collapsed.has(s) ? { label: 'Expand', icon: 'chevronDown', run: () => toggleCollapsed(s) } : { label: 'Collapse', icon: 'chevronRight', run: () => toggleCollapsed(s) },
      { label: 'Show only this one (collapse the others)', icon: 'eye', run: () => onlySection(s) },
      { label: 'Expand all', disabled: !collapsed.size, run: () => setCollapsed([]) },
      { label: 'Collapse all', run: () => setCollapsed(live) },
      { separator: true },
      up && { label: 'Up one folder', icon: 'arrowUp', run: () => go(up, s) },
      { label: 'Refresh', icon: 'rotate', run: () => load(s) },
      { label: 'New file here', icon: 'filePlus', run: () => (expandFor(), setCreating({ kind: 'file', name: 'New file.txt', in: s })) },
      { label: 'New folder here', icon: 'folderPlus', run: () => (expandFor(), setCreating({ kind: 'folder', name: 'New folder', in: s })) },
      { label: 'Paste here', icon: 'clipboard', disabled: !clip, run: () => clip && pasteInto(s, {}) },
      { label: 'Find in this folder…', icon: 'search', run: () => actions.findInFolder(s) },
      window.desktop?.compare && { label: 'Compare with another folder…', icon: 'compare', run: () => actions.compareFolders(s) },
      window.desktop?.compare && live.length === 2 && { label: `Compare with ${folderLabel(live.find((x) => x !== s))}`, icon: 'compare', run: () => actions.compareFolders(s, live.find((x) => x !== s)) },
      window.desktop?.compare && { label: 'Open in two panes…', icon: 'panes', run: () => actions.twoPanes(s) },
      window.desktop?.compare && live.length === 2 && { label: `Two panes with ${folderLabel(live.find((x) => x !== s))}`, icon: 'panes', run: () => actions.twoPanes(s, live.find((x) => x !== s)) },
      terminalFor(s) && { label: 'Open a terminal here', icon: 'terminal', run: () => actions.terminalHere(s) },
      { label: 'Properties', icon: 'info', run: () => actions.showProperties(s) },
      { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(s) },
      { separator: true },
      { label: 'Only its tabs', icon: 'eye', hint: 'The tab bar shows the tabs of this folder', run: () => actions.showFolderTabs(s) },
      { label: 'Its tabs: link to a project, color…', icon: 'tag', run: () => actions.folderGroup(folderGroupOf(s).folder) },
      { separator: true },
      at > 0 && { label: 'Move up', icon: 'arrowUp', run: () => moveSection(s, -1) },
      at < live.length - 1 && { label: 'Move down', icon: 'arrowUp', run: () => moveSection(s, 1) },
      { label: 'Close here (it stays where it is)', icon: 'x', run: () => closeSection(s) },
    ];
  };

  // ---- The view ----

  if (!roots && unreachable) {
    return html`<div class="folders-empty">
      <p class="notice error-text"><${Icon} name="alert" size=${15} />${unreachable}</p>
      <p class="form-actions">
        <button type="button" class="btn primary" onClick=${refreshRoots}><${Icon} name="rotate" size=${15} />Try again</button>
        ${window.desktop?.android?.sendLog && html`<button type="button" class="btn" onClick=${() => window.desktop.android.sendLog()}>Send a log</button>`}
      </p>
    </div>`;
  }
  // Waiting for the file access (the Android app's starts with the app): said after a moment.
  if (!roots) return html`<div class="folders-empty"><p class="muted small waiting">${isAndroidApp() ? 'Starting the file access…' : 'Loading…'}</p></div>`;
  if (!root) {
    return html`<div class="folders-empty">
      <p>Browse a folder on ${hereName()}, or one on a server, and open its files here, like in a file explorer.</p>
      <p class="muted small">${isLocal() ? 'They are edited where they are. "Copy into my files" puts a copy with your notes.' : 'They are edited in place and are not synced. "Copy into my files" makes a copy that syncs.'}</p>
      <button type="button" class="btn primary" onClick=${() => pick()}><${Icon} name="folderOpen" size=${16} />Open a folder…</button>
      <div class="folder-places">
        <span class="muted small">Start in</span>
        ${PLACES.filter((p) => places[p.id]).map(
          (p) => html`<button type="button" key=${p.id} class="btn ghost sm" title=${`Pick a folder, starting in ${places[p.id]}`} onClick=${() => pick(places[p.id])}>${p.label}</button>`,
        )}
      </div>
      <div class="folders-servers">
        ${roots.map((r) => html`<button type="button" key=${r} class="btn ghost sm" title=${r} onClick=${() => go(r)}><${Icon} name="folder" size=${15} />${folderLabel(r)}</button>`)}
        ${servers().map((c) => html`<button type="button" key=${c.id} class="btn ghost sm" title=${`${protocolName(c.protocol)} · ${c.user ? `${c.user}@` : ''}${c.host}`} onClick=${() => actions.openServer(c.id)}><${Icon} name="server" size=${15} />${c.name}</button>`)}
        <button type="button" class="btn sm" onClick=${() => actions.editServer()}><${Icon} name="server" size=${15} />Connect to a server…</button>
      </div>
    </div>`;
  }

  const crumbs = breadcrumbs(dir, root);
  const up = parentOf(dir, root);
  // The preview's file: the one the keyboard is on, or the only one selected.
  const peekEntry = (cursor && byPath.get(cursor)) || (selected.size === 1 ? (byPath.get([...selected][0]) ?? null) : null);
  const peekHeight = Math.max(120, settings.folderPreviewHeight || 260);
  // Favorites and recent folders (here or on servers), by their name and where they are.
  const favorites = settings.folderFavorites ?? [];
  const favorite = favorites.includes(dir);
  const recent = (settings.folderRecent ?? []).filter((p) => p !== dir);
  const toggleFav = (p) => saveSettings({ folderFavorites: toggleFavorite(favorites, p) });
  const placeName = (p) => (isRemotePath(p) && !remoteParts(p).path.replace(/\/+$/, '') ? (server(remoteParts(p).id)?.name ?? 'Server') : isRemotePath(p) ? baseName(remoteParts(p).path || '/') : folderLabel(p));
  const placeHint = (p) => (isRemotePath(p) ? `${server(remoteParts(p).id)?.name ?? 'Server'}: ${remoteParts(p).path || '/'}` : p);
  const hiddenCount = live.reduce((n, d) => n + (listings.get(d)?.entries ?? []).filter((e) => e.hidden).length, 0);
  const some = targets().length > 0;
  const tool = (label, icon, run, disabled = false) =>
    html`<button type="button" class="icon-btn sm" aria-label=${label} title=${label} disabled=${disabled} onClick=${run}><${Icon} name=${icon} size=${16} /></button>`;
  const dropProps = (target) => ({
    onDragOver: (ev) => acceptDrag(ev, target),
    onDragLeave: (ev) => !ev.currentTarget.contains(ev.relatedTarget) && setDropTarget((t) => (t === target ? null : t)),
    onDrop: (ev) => onDrop(ev, target),
  });
  // A folder shown takes files (moved into it) and other folders' headers (put before or after it).
  const sectionDropProps = (target) => ({
    ...dropProps(target),
    onDragOver: (ev) => (isSectionDrag(ev) ? overSection(ev, target) : acceptDrag(ev, target)),
    onDrop: (ev) => (isSectionDrag(ev) ? dropSection(ev) : onDrop(ev, target)),
  });
  const listDropProps = {
    ...dropProps(dir),
    onDragOver: (ev) => (isSectionDrag(ev) ? overSection(ev, null) : acceptDrag(ev, dir)),
    onDrop: (ev) => (isSectionDrag(ev) ? dropSection(ev) : onDrop(ev, dir)),
  };
  const details = settings.folderView === 'details';
  const perms = live.some(isRemotePath) && settings.showPermissions;
  const row = ({ entry: e, depth, expanded: open }) => {
    const key = diskKey(e.path);
    const git = isRemotePath(e.path) ? null : gitCodeOf(rootOf(e.path, live) ?? dir, e.path, e.dir);
    const isSelected = selected.has(e.path);
    const twisty = e.dir
      ? html`<button type="button" class="tree-twisty ${open ? 'open' : ''}" tabindex="-1" aria-label=${open ? `Close ${e.name}` : `Open ${e.name} here`}
          onClick=${(ev) => (ev.stopPropagation(), toggleOpen(e.path))} onDblClick=${(ev) => ev.stopPropagation()}><${Icon} name="chevronRight" size=${13} /></button>`
      : html`<span class="tree-twisty none" />`;
    const name = renaming === e.path
      ? html`<${NameField} initial=${e.name} dir=${e.dir} label=${`New name for ${e.name}`} onDone=${(n) => rename(e, n)} onCancel=${() => (setRenaming(null), list.current?.focus())} />`
      : html`<span class="folder-name">${e.name}</span>`;
    const children_ = children.get(e.path);
    return html`<div key=${e.path} data-path=${e.path} role="option" aria-selected=${isSelected} id=${`row-${order.indexOf(e.path)}`}
      aria-level=${depth + 1} aria-expanded=${e.dir ? open : undefined} style=${{ '--depth': depth }}
      class="folder-row ${git ? `git-${git}` : ''} ${details ? 'with-columns' : ''} ${e.dir ? 'is-dir' : ''} ${isSelected ? 'selected' : ''} ${cursor === e.path ? 'cursor' : ''} ${activeKey === key ? 'active' : ''} ${e.hidden ? 'hidden-entry' : ''} ${clip?.op === 'cut' && clip.paths.includes(e.path) ? 'is-cut' : ''} ${dropTarget === e.path ? 'drop-target' : ''} ${dropTarget && !live.includes(dropTarget) && dirOf(e.path) === dropTarget ? 'drop-inside' : ''}"
      title=${isRemotePath(e.path) ? `${remoteParts(e.path).path}${e.mode !== undefined ? `\n${modeString(e.mode, e.dir)}${e.owner ? ` ${e.owner}` : ''}${e.group ? ` ${e.group}` : ''}` : ''}` : e.path} draggable=${renaming !== e.path}
      onDragStart=${(ev) => onDragStart(ev, e)}
      onDragEnd=${() => (internalDrag.current = null)}
      ...${dropProps(e.dir ? e.path : dirOf(e.path))}
      onClick=${(ev) => {
        ev.stopPropagation();
        list.current?.focus();
        if (ev.shiftKey) select(rangeOf(order, anchor ?? e.path, e.path), { at: e.path, keepAnchor: true });
        else if (ev.ctrlKey || ev.metaKey || (picking && touchScreen())) {
          const next = new Set(selected);
          next.has(e.path) ? next.delete(e.path) : next.add(e.path);
          setSelected(next);
          setCursor(e.path);
          setAnchor(e.path);
        } else {
          const again = selected.size === 1 && selected.has(e.path);
          select([e.path]);
          // A tap opens, except a file while the preview shows: it shows there, and a second tap opens it.
          if (touchScreen() && (e.dir || !settings.folderPreview || again)) openEntry(e);
        }
      }}
      onDblClick=${(ev) => {
        ev.stopPropagation();
        if (!touchScreen()) openEntry(e);
      }}
      onContextMenu=${(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!selected.has(e.path)) select([e.path]);
        setMenu({ entry: e, at: { x: ev.clientX, y: ev.clientY } });
      }}>
      <span class="folder-cell-name">
        ${twisty}
        ${e.dir ? html`<${Icon} name=${open ? 'folderOpen' : 'folder'} size=${15} />` : html`<${FileIcon} name=${e.name} size=${16} plain=${settings.fileIcons === false} />`}
        ${name}
        ${openKeys.includes(key) && html`<span class="tab-dot open-dot" title="Open in a tab" />`}
        ${git && html`<span class="git-badge git-${git}" title=${git === 'dot' ? 'Changed files inside (Git)' : `${GIT_LABELS[git]} (Git)`}>${git === 'dot' ? '' : git}</span>`}
        ${open && children_?.error && html`<span class="error-text small" title=${children_.error}>(cannot read it)</span>`}
      </span>
      ${details
        ? html`<span class="folder-cell size">${e.dir ? '' : formatBytes(e.size)}</span>
            <span class="folder-cell date" title=${e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : ''}>${e.mtimeMs ? shortDate(e.mtimeMs) : ''}</span>
            ${perms && html`<code class="folder-cell perms" title=${`${e.owner ?? ''} ${e.group ?? ''}`.trim()}>${e.mode !== undefined ? modeString(e.mode, e.dir) : ''}</code>`}`
        : html`<span class="spacer" />
            ${!e.dir && renaming !== e.path && html`<span class="muted small folder-meta" title=${e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : ''}>${formatBytes(e.size)}${e.mtimeMs ? ` · ${timeAgo(new Date(e.mtimeMs).toISOString())}` : ''}</span>`}
            ${perms && e.mode !== undefined && renaming !== e.path && html`<code class="folder-perms" title=${`${e.owner ?? ''} ${e.group ?? ''}`.trim()}>${modeString(e.mode, e.dir)}</code>`}`}
    </div>`;
  };
  // Details: column headers that sort (again: the other way).
  const sortBy = (id) => saveSettings(settings.folderSort === id ? { folderSortReverse: !settings.folderSortReverse } : { folderSort: id, folderSortReverse: false });
  const header = (id, label, cls) => {
    const on = (settings.folderSort || 'name') === id;
    const up = sortsUp(id, settings.folderSortReverse);
    return html`<button type="button" class="folder-col ${cls} ${on ? 'on' : ''}" aria-sort=${on ? (up ? 'ascending' : 'descending') : 'none'} title=${`Sort by ${label.toLowerCase()}`} onClick=${() => sortBy(id)}>
      <span>${label}</span>${on && html`<${Icon} name="arrowUp" size=${12} class=${up ? '' : 'down'} />`}
    </button>`;
  };
  // What a folder shown holds: a new file being named, an error, its rows, or why there are none.
  const creatingRow = () => html`<div class="folder-row creating">
    ${creating.kind === 'folder' ? html`<${Icon} name="folder" size=${15} />` : html`<${FileIcon} name=${creating.name} size=${16} plain=${settings.fileIcons === false} />`}
    ${creating.in && creating.in !== dir && html`<span class="creating-in muted small" title=${creating.in}>in ${baseName(creating.in)}/</span>`}
    <${NameField} key=${`${creating.kind}:${creating.name}`} initial=${creating.name} dir=${creating.kind === 'folder'} label=${`${creating.kind === 'folder' ? 'New folder name' : 'New file name'}${creating.in && creating.in !== dir ? ` in ${baseName(creating.in)}` : ''}`}
      onDone=${(name) => create({ ...creating, name })} onCancel=${() => (setCreating(null), list.current?.focus())} />
  </div>`;
  const sectionBody = (x) => {
    if (!x) return null;
    const l = listings.get(x.dir);
    const hiddenHere = (l?.entries ?? []).filter((e) => e.hidden).length;
    const makingHere = creating && (sectionOf(creating.in ?? dir) ?? dir) === x.dir;
    return html`
      ${makingHere && creatingRow()}
      ${l?.error &&
      html`<div class="empty-list folders-error">
        <p class="error-text small">${l.error}</p>
        ${isRemotePath(x.dir) && html`<p><button type="button" class="btn sm" onClick=${(e) => (e.stopPropagation(), load(x.dir))}>Try again</button> <button type="button" class="btn ghost sm" onClick=${(e) => (e.stopPropagation(), actions.editServer(server(remoteParts(x.dir).id)))}>Edit the server…</button></p>`}
      </div>`}
      ${!l && !makingHere && html`<p class="muted small empty-list waiting">Reading the folder…</p>`}
      ${x.rows.map(row)}
      ${l && !l.error && !x.rows.length && !makingHere &&
      html`<p class="muted small empty-list">${filter ? (deepOn && deep.searching ? 'Nothing here matches. Looking in the folders inside…' : multi ? 'Nothing in this one matches.' : 'Nothing here or in the folders inside matches.') : hiddenHere && !settings.showHidden ? `Only hidden files here (${hiddenHere}).` : 'This folder is empty. Drop or paste files here.'}</p>`}
      ${l?.truncated && html`<p class="muted small empty-list">Showing the first ${l.entries.length.toLocaleString()} entries. Filter to find the others, or open a folder inside.</p>`}`;
  };
  // Several folders side by side: each under its header, in the color of where it is.
  const sectionHead = (d, matches = 0) => {
    const rem = isRemotePath(d);
    const c = rem ? server(remoteParts(d).id) : null;
    const state = c ? serverStatus(c.id).state : null;
    const shut_ = collapsed.has(d);
    const name = placeName(d);
    // Where it is: the folder holding it (on a server: the server's name first).
    const inside = rem ? remoteParts(d).path.replace(/\/+$/, '') : '';
    const where = rem ? (inside ? `${c?.name ?? 'Server'} · ${inside.slice(0, inside.lastIndexOf('/')) || '/'}` : `${protocolName(c?.protocol)} · ${c?.host ?? ''}`) : dirOf(d);
    return html`<div class="root-head kind-${rem ? 'remote' : 'disk'} ${d === dir ? 'current' : ''} ${dropTarget === d ? 'drop-target' : ''}" data-section=${d}
      title=${`${rem ? `On ${c?.name ?? 'a server'}: ${remoteParts(d).path || '/'}` : `On this computer: ${d}`}\nClick to work here · drag to change the order · right-click for more`}
      draggable="true" onDragStart=${(ev) => startSectionDrag(ev, d)} onDragEnd=${endSectionDrag}
      onClick=${(ev) => {
        ev.stopPropagation();
        if (shut_) toggleCollapsed(d);
        focusSection(d);
      }}
      onDblClick=${(ev) => ev.stopPropagation()}
      onContextMenu=${(ev) => (ev.preventDefault(), ev.stopPropagation(), setMenu({ section: d, at: { x: ev.clientX, y: ev.clientY } }))}
      ...${sectionDropProps(d)}>
      <button type="button" class="tree-twisty ${shut_ ? '' : 'open'}" tabindex="-1" aria-expanded=${!shut_} aria-label=${shut_ ? `Expand ${name}` : `Collapse ${name}`}
        onClick=${(ev) => (ev.stopPropagation(), toggleCollapsed(d))}><${Icon} name="chevronRight" size=${13} /></button>
      <${Icon} name=${rem ? 'server' : 'folder'} size=${15} class="root-head-icon" />
      <span class="root-head-name">${name}</span>
      <span class="root-head-where">${where}</span>
      ${!rem && gitOf(d) && html`<span class="git-branch" title=${branchTitle(gitOf(d))}><${Icon} name="branch" size=${12} />${gitOf(d).branch}</span>`}
      ${rem && html`<span class="conn-dot state-${state}" />`}
      ${shut_ && matches > 0 && html`<span class="root-head-count" title=${`${matches} ${matches === 1 ? 'match' : 'matches'} in it: click to see`}>${matches}</span>`}
      <button type="button" class="icon-btn xs root-head-close" aria-label=${`Close ${name} here`} title="Close it here (nothing is deleted)"
        onClick=${(ev) => (ev.stopPropagation(), closeSection(d))}><${Icon} name="x" size=${13} /></button>
    </div>`;
  };
  // Each folder's header in the color of its tab group, as the tabs from it (unless turned off).
  const groupColor = (d) => (settings.tabColors !== 'off' ? folderGroupOf(d, settings).color : null);
  const sectionView = (x) => {
    const gc = groupColor(x.dir);
    const moving = reorder?.path === x.dir;
    const mark = reorder?.over === x.dir && !moving ? (reorder.after ? 'reorder-after' : 'reorder-before') : '';
    return html`<div key=${x.dir} class="root-section kind-${isRemotePath(x.dir) ? 'remote' : 'disk'} ${x.dir === dir ? 'current' : ''} ${collapsed.has(x.dir) ? 'collapsed' : ''} ${gc ? 'grouped' : ''} ${moving ? 'reordering' : ''} ${mark}"
        style=${gc ? { '--gc': gc } : undefined} role="group" aria-label=${placeName(x.dir)} ...${sectionDropProps(x.dir)}>
      ${sectionHead(x.dir, x.matches)}
      ${!collapsed.has(x.dir) && sectionBody(x)}
    </div>`;
  };
  const columns = details && html`<div class="folder-columns" role="presentation" onClick=${(ev) => ev.stopPropagation()} onContextMenu=${(ev) => ev.stopPropagation()}>
    ${header('name', 'Name', 'name')}${header('size', 'Size', 'size')}${header('modified', 'Modified', 'date')}${perms && html`<span class="folder-col perms">Permissions</span>`}
  </div>`;

  return html`
    <div class="folders-head">
      <div class="folders-root">
        <button type="button" class="btn ghost sm folders-root-name ${remote ? 'kind-remote' : ''} ${dropTarget === root ? 'drop-target' : ''}"
          title=${remote ? `${protocolName(conn?.protocol)} · ${conn?.user ? `${conn.user}@` : ''}${conn?.host} · ${connState?.state === 'connected' ? 'connected' : 'not connected'}` : root} onClick=${() => go(root)} ...${dropProps(root)}>
          <${Icon} name=${remote ? 'server' : 'folder'} size=${15} /><span>${rootName(root)}</span>${remote && html`<span class="conn-dot state-${connState?.state}" />`}
        </button>
        ${!multi && !remote && gitOf(dir) && html`<span class="git-branch" title=${branchTitle(gitOf(dir))}><${Icon} name="branch" size=${12} />${gitOf(dir).branch}</span>`}
        <span class="spacer" />
        ${tool('Up one folder (Backspace)', 'arrowUp', () => go(up), !up)}
        ${tool('Refresh (F5)', 'rotate', () => load())}
        <button type="button" class="icon-btn sm fav-toggle ${favorite ? 'on' : ''}" aria-pressed=${favorite} aria-label=${favorite ? 'Remove this folder from favorites' : 'Add this folder to favorites'}
          title=${favorite ? 'Remove this folder from favorites' : 'Add this folder to favorites'} onClick=${() => toggleFav(dir)}><${Icon} name="star" size=${16} /></button>
        ${recent.length > 0 && html`<${MenuButton} label="Recent folders" icon="clock" items=${() => recent.map((p) => ({ key: p, label: placeName(p), hint: placeHint(p), icon: isRemotePath(p) ? 'server' : 'folder', run: () => go(p) }))} />`}
        ${tool('Folders side by side: add some beside this one (here or on servers), reorder, close', 'columns', () => actions.sideBySide())}
        <${MenuButton} label="Folders" items=${rootItems} />
      </div>
      ${favorites.length > 0 &&
      html`<div class="folders-quick" role="toolbar" aria-label="Favorite folders">
        ${favorites.map(
          (p) => html`<button type="button" key=${p} class="fav-chip ${p === dir ? 'current' : ''} ${isRemotePath(p) ? 'kind-remote' : ''} ${dropTarget === p ? 'drop-target' : ''}" title=${placeHint(p)}
            onClick=${() => go(p)} onContextMenu=${(ev) => (ev.preventDefault(), ev.stopPropagation(), setMenu({ favorite: p, at: { x: ev.clientX, y: ev.clientY } }))} ...${p === dir ? {} : dropProps(p)}>
            <${Icon} name="star" size=${12} /><span>${placeName(p)}</span>
          </button>`,
        )}
      </div>`}
      <div class="folders-tools" role="toolbar" aria-label="Files">
        ${tool('New file', 'filePlus', () => startCreating('file'))}
        ${tool('New folder (Ctrl+Shift+N)', 'folderPlus', () => startCreating('folder'))}
        <span class="tools-sep" />
        ${tool('Cut (Ctrl+X)', 'scissors', () => clipFromMenu('cut'), !some)}
        ${tool('Copy (Ctrl+C)', 'copy', () => clipFromMenu('copy'), !some)}
        ${tool('Paste (Ctrl+V)', 'clipboard', paste)}
        <span class="tools-sep" />
        ${tool('Rename (F2)', 'edit', () => setRenaming(targets()[0].path), targets().length !== 1)}
        ${tool('Delete (Del)', 'trash', () => setConfirm(targets()), !some)}
        <span class="tools-sep" />
        ${tool('Find in this folder (Ctrl+Shift+F)', 'search', () => actions.findInFolder(dir))}
        <span class="spacer" />
        <button type="button" class="icon-btn sm" aria-pressed=${Boolean(settings.folderPreview)} aria-label="Preview" title=${settings.folderPreview ? 'Hide the preview' : 'Preview: the file picked, under the list (Space: large)'}
          onClick=${() => saveSettings({ folderPreview: !settings.folderPreview })}><${Icon} name="eye" size=${16} /></button>
        <button type="button" class="icon-btn sm ${details ? 'on' : ''}" aria-pressed=${details} aria-label="Details (columns)" title=${details ? 'List' : 'Details: size and date in columns, sorted by their headers'}
          onClick=${() => saveSettings({ folderView: details ? 'list' : 'details' })}><${Icon} name="details" size=${16} /></button>
      </div>
      ${(crumbs.length > 1 || multi) &&
      html`<nav class="crumbs ${multi ? `kind-${remote ? 'remote' : 'disk'} of-section` : ''}" aria-label="Folder path">
        ${crumbs.map(
          (c, i) => html`${i > 0 && html`<span class="crumb-sep" key=${`s${i}`}>›</span>`}<button type="button" key=${c.path} class="crumb ${i === crumbs.length - 1 ? 'current' : ''} ${dropTarget === c.path ? 'drop-target' : ''}"
            aria-current=${i === crumbs.length - 1 ? 'location' : undefined} title=${remote ? remoteParts(c.path).path : c.path} onClick=${() => go(c.path)} ...${i < crumbs.length - 1 ? dropProps(c.path) : {}}>${i === 0 ? rootName(root) : c.name}</button>`,
        )}
      </nav>`}
      ${mirrored && html`<${MirrorBar} found=${mirrored} actions=${actions} />`}
      <div class="sidebar-filter">
        <${Icon} name="search" size=${15} />
        <input value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder=${multi ? `Filter the ${live.length} folders` : `Filter ${dir === root ? rootName(root) : baseName(dir)}`} aria-label=${multi ? 'Filter the folders shown' : 'Filter this folder'}
          onKeyDown=${(e) => {
            if (e.key === 'ArrowDown') e.preventDefault(), list.current?.focus(), order[0] && select([order[0]]);
            else if (e.key === 'Escape' && filter) e.preventDefault(), e.stopPropagation(), setFilter('');
          }} />
        <${ClearButton} value=${filter} onClear=${() => setFilter('')} label="Clear the filter" />
      </div>
      ${deepOn && (deep.searching || deep.found.length > 0) && html`<p class="filter-deep muted small" role="status">
        ${deep.searching ? 'Looking in the folders inside…' : `${deep.found.length} ${deep.found.length === 1 ? 'match' : 'matches'} in the folders inside${deep.truncated ? ' (the first ones: type more to narrow it down)' : ''}`}
      </p>`}
    </div>
    <div class="file-list folder-list ${details ? 'details' : ''} ${dropTarget === dir ? 'drop-target' : ''}" role="listbox" aria-multiselectable="true" tabindex="0" ref=${list}
      aria-label=${multi ? `Files in ${live.map(placeName).join(', ')}` : `Files in ${dir === root ? rootName(root) : baseName(dir)}`} aria-activedescendant=${cursor && order.includes(cursor) ? `row-${order.indexOf(cursor)}` : undefined}
      onKeyDown=${onKeyDown}
      onFocus=${claimSelection}
      onClick=${() => setSelected(new Set())}
      onContextMenu=${(ev) => {
        ev.preventDefault();
        setSelected(new Set());
        setMenu({ entry: null, at: { x: ev.clientX, y: ev.clientY } });
      }}
      onDragOverCapture=${onListDragOver}
      onDragLeave=${(ev) => !list.current?.contains(ev.relatedTarget) && setTimeout(() => autoScroll.current.last < performance.now() - 150 && stopAutoScroll(), 200)}
      ...${listDropProps}>
      ${dragZones?.up && html`<div class="drag-zone up ${dragZones.active < 0 ? 'active' : ''}" aria-hidden="true"><div><${Icon} name="arrowUp" size=${15} />Scroll up</div></div>`}
      ${columns}
      ${multi ? sectionRows.map(sectionView) : sectionBody(sectionRows[0])}
      ${dragZones?.down && html`<div class="drag-zone down ${dragZones.active > 0 ? 'active' : ''}" aria-hidden="true"><div><${Icon} name="arrowUp" size=${15} class="turn-down" />Scroll down</div></div>`}
    </div>
    ${settings.folderPreview &&
    html`<${Splitter} orientation="horizontal" className="peek-resize" label="Resize the preview"
        onStart=${() => (peekDrag.current = { start: peekHeight, height: peekHeight })}
        onMove=${(delta) => {
          peekDrag.current.height = Math.round(Math.max(120, Math.min(innerHeight - 260, peekDrag.current.start - delta)));
          list.current?.parentElement?.querySelector('.peek-pane')?.style.setProperty('height', `${peekDrag.current.height}px`);
        }}
        onEnd=${() => saveSettings({ folderPreviewHeight: peekDrag.current.height })}
        onReset=${() => saveSettings({ folderPreviewHeight: 260 })} />
      <${PeekPane} entry=${peekEntry} height=${peekHeight} onOpen=${(e) => openEntry(e)} onOpenOutside=${openOutside} onExpand=${(e) => setViewing(e.path)}
        onReadText=${readText} onClose=${() => saveSettings({ folderPreview: false })} />`}
    ${viewing &&
    html`<${FileViewer} entries=${entries.filter((e) => !e.dir)} path=${viewing}
      onPath=${(p) => (setViewing(p), select([p]))}
      onOpen=${(e) => (setViewing(null), openEntry(e, { outside: peekKind(e.name) === 'image' }))}
      onOpenOutside=${openOutside}
      onReadText=${(e) => (setViewing(null), readText(e))}
      onClose=${() => (setViewing(null), list.current?.focus())} />`}
    <div class="sidebar-foot folders-foot">
      <span class="muted small folders-status" aria-live="polite">${selectionSummary(entries, selected, formatBytes)}</span>
      ${picking && html`<button type="button" class="btn sm" onClick=${() => (setPicking(false), select([]))}>Done</button>`}
      <span class="folders-where ${remote ? 'kind-remote' : 'kind-disk'}" title=${remote ? `On ${conn?.name}: files are saved back to the server${isLocal() ? '' : ', not synced. Copy into my files makes a synced copy'}.` : isLocal() ? `Files on ${hereName()}: edited where they are.` : `Files on ${hereName()}: edited in place, not synced. Copy into my files makes a synced copy.`}>
        <${Icon} name=${remote ? 'server' : 'disk'} size=${14} />
      </span>
    </div>
    ${menu &&
    html`<${Menu} items=${menu.section ? sectionItems(menu.section) : menu.favorite ? favoriteItems(menu.favorite) : menu.entry ? entryItems() : backgroundItems()} at=${menu.at}
      label=${menu.section ? placeName(menu.section) : menu.favorite ? placeName(menu.favorite) : (menu.entry?.name ?? (dir === root ? rootName(root) : baseName(dir)))} onClose=${() => setMenu(null)} />`}
    ${confirm && html`<${DeleteDialog} entries=${confirm} onConfirm=${() => remove(confirm)} onClose=${() => (setConfirm(null), list.current?.focus())} />`}
    ${exists && html`<${ExistsDialog} names=${exists.names} target=${exists.target} onChoose=${(how) => (setExists(null), exists.run(how))} onClose=${() => (setExists(null), list.current?.focus())} />`}
  `;
}
