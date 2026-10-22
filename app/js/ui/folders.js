import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { canDragOut, draggedPaths, draggedTab, dropped, isOwnDrop, onDragOutEnd, startDragOut } from '../dragOut.js';
import { baseName, breadcrumbs, filterEntries, FOLDER_SORTS, isImageName, opensInEditor, parentOf, quotePath, rangeOf, renameRange, rootOf, selectionSummary, sortEntries } from '../folders.js';
import { formatBytes, timeAgo } from '../format.js';
import { saveSettings } from '../settings.js';
import { diskKey } from '../store.js';
import { Modal, toast } from './components.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';

const PLACES = [
  { id: 'documents', label: 'Documents' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'home', label: 'Home' },
];

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const fail = (err) => toast(message(err), { kind: 'error', timeout: 8000 });
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || p;
const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
const binName = () => (window.desktop?.platform === 'win32' ? 'the Recycle Bin' : 'the Trash');

// Cut or copied in this view (kept while you move between folders): { op: 'cut' | 'copy', paths, text }.
// `text` (the paths) also goes on the system clipboard; a paste whose text differs came from elsewhere.
let clip = null;

/** Moving files to the Recycle Bin: asked first, since the editor cannot bring them back. */
function DeleteDialog({ entries, onConfirm, onClose }) {
  const names = entries.slice(0, 6).map((e) => e.name);
  return html`<${Modal} title="Delete" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary danger" onClick=${onConfirm}><${Icon} name="trash" size=${15} />Move to ${binName().replace('the ', '')}</button>`}>
    <p>Move ${entries.length === 1 ? html`<strong>${entries[0].name}</strong>` : count(entries.length, 'item')} to ${binName()}?</p>
    ${entries.length > 1 && html`<ul class="delete-list">${names.map((n) => html`<li key=${n}>${n}</li>`)}${entries.length > names.length && html`<li class="muted">and ${entries.length - names.length} more</li>`}</ul>`}
    <p class="muted small">You can restore ${entries.length === 1 ? 'it' : 'them'} from there.</p>
  </${Modal}>`;
}

/** The name field of a new or renamed entry, in its row: Enter or leaving it keeps the name, Escape cancels. */
function NameField({ initial, dir = false, label, onDone, onCancel }) {
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
  const [listing, setListing] = useState(null); // { dir, entries, truncated, error? }
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
  const list = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  const pendingSelect = useRef(null); // a path to select once the folder is read (the one you came up from)
  const dir = settings.folder;
  const root = roots && rootOf(dir, roots);

  const refreshRoots = () => bridge.roots().then(setRoots);
  useEffect(() => {
    refreshRoots();
    bridge.places().then(setPlaces, () => {});
  }, []);
  // The folder shown: the last one (picked from the menu, the list may be behind), or the first
  // picked when it is gone or was forgotten.
  useEffect(() => {
    if (!roots || root || (!roots.length && !dir)) return;
    let stale = false;
    bridge.roots().then((fresh) => {
      if (stale) return;
      if (!fresh.length) return roots.length && setRoots(fresh);
      if (!rootOf(dir, fresh)) saveSettings({ folder: fresh[0] });
      setRoots(fresh);
    });
    return () => {
      stale = true;
    };
  }, [roots, root, dir]);
  const load = async (target = dir) => {
    try {
      const next = await bridge.list(target);
      setListing(next);
      const present = new Set(next.entries.map((e) => e.path));
      if (pendingSelect.current && present.has(pendingSelect.current)) {
        select([pendingSelect.current]);
        pendingSelect.current = null;
      } else setSelected((s) => (Array.from(s).every((p) => present.has(p)) ? s : new Set(Array.from(s).filter((p) => present.has(p)))));
    } catch (err) {
      setListing({ dir: target, entries: [], error: message(err) });
    }
  };
  useEffect(() => {
    if (root) load(dir);
  }, [dir, root]);
  // The folder is watched while shown, and read again when the window comes back.
  useEffect(() => {
    if (!root) return;
    bridge.watch(dir).catch(() => {});
    const off = bridge.onChanged((change) => change.dir === dir && load(dir));
    const onFocus = () => load(dir);
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      bridge.watch(null).catch(() => {});
      window.removeEventListener('focus', onFocus);
    };
  }, [dir, root]);
  useEffect(() => onDragOutEnd(() => setDropTarget(null)), []);

  const entries = sortEntries(filterEntries(listing?.dir === dir ? listing.entries : [], { query: filter, hidden: settings.showHidden }), settings.folderSort);
  const order = entries.map((e) => e.path);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const chosen = () => entries.filter((e) => selected.has(e.path));
  const targets = () => {
    const picked = chosen();
    return picked.length ? picked : cursor && byPath.get(cursor) ? [byPath.get(cursor)] : [];
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
  useEffect(() => {
    const onCopy = (e) => {
      if (!inList() || !targets().length) return;
      e.preventDefault();
      setClip(e.type === 'cut' ? 'cut' : 'copy', targets(), (text) => e.clipboardData.setData('text/plain', text));
    };
    const onPaste = (e) => {
      if (!inList()) return;
      e.preventDefault();
      pasteInto(dir, { files: [...(e.clipboardData?.files ?? [])], text: e.clipboardData?.getData('text/plain') ?? '' });
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  });

  // ---- Moving around ----

  const go = (target) => {
    setFilter('');
    setCreating(null);
    setRenaming(null);
    setSelected(new Set());
    setCursor(null);
    setAnchor(null);
    saveSettings({ folder: target });
    list.current?.focus();
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
  const select = (paths, { at = paths[paths.length - 1] ?? null, keepAnchor = false } = {}) => {
    setSelected(new Set(paths));
    setCursor(at);
    if (!keepAnchor) setAnchor(at);
  };

  // ---- Opening ----

  const openOutside = (e) => bridge.openExternal(e.path).catch(fail);
  const openEntry = async (e, { many = false } = {}) => {
    if (e.dir) return go(e.path);
    if (!opensInEditor(e.name)) return openOutside(e);
    const problem = await actions.openDiskPath(e.path, { report: false });
    // Not text after all: its own program.
    if (problem && /not a text file/i.test(problem)) return openOutside(e);
    if (problem) toast(`${e.name}: ${problem}`, { kind: 'error' });
    else if (!many) list.current?.focus();
  };
  const openSelected = () => {
    const items = targets();
    if (items.length === 1) return openEntry(items[0]);
    for (const e of items.filter((x) => !x.dir).slice(0, 20)) openEntry(e, { many: true });
  };

  // ---- Changing things (each with Undo where it can be undone) ----

  // After a change: the list read again, open tabs following what moved, what changed here selected.
  const after = async ({ moves = [], made = [] }, done, undo) => {
    await load(dir);
    if (moves.length) actions.followDiskMoves(moves);
    const here = [...moves.map((m) => m.to), ...made].filter((p) => dirOf(p) === dir);
    if (here.length) select(here);
    if (done) toast(done, undo ? { action: { label: 'Undo', run: undo }, timeout: 8000 } : {});
  };
  const create = async ({ kind, name, text }) => {
    setCreating(null);
    try {
      const path = kind === 'folder' ? await bridge.newFolder(dir, name) : await bridge.newFile(dir, name, { text: text ?? '' });
      await load(dir);
      select([path]);
      if (kind === 'file' && opensInEditor(name)) await actions.openDiskPath(path);
      list.current?.focus();
    } catch (err) {
      fail(err);
      setCreating({ kind, name, text });
    }
  };
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
  const moveTo = async (paths, target) => {
    try {
      const moves = await bridge.move(paths, target);
      if (!moves.length) return;
      await after({ moves }, `Moved ${count(moves.length, 'item')} to ${baseName(target)}`, async () => {
        const back = [];
        for (const m of moves) back.push(...(await bridge.move([m.to], dirOf(m.from)).catch((err) => (fail(err), []))));
        after({ moves: back });
      });
    } catch (err) {
      fail(err);
    }
  };
  const copyTo = async (paths, target) => {
    try {
      const copies = await bridge.copy(paths, target);
      await after({ made: copies.map((c) => c.to) }, `Copied ${count(copies.length, 'item')}${target === dir ? '' : ` to ${baseName(target)}`}`, () =>
        bridge.trash(copies.map((c) => c.to)).then(() => load(dir), fail),
      );
    } catch (err) {
      fail(err);
    }
  };
  const copyIn = async (files, target) => {
    try {
      const copies = await bridge.copyIn(files, target);
      await after({ made: copies.map((c) => c.to) }, `Added ${count(copies.length, 'item')}${target === dir ? '' : ` to ${baseName(target)}`}`, () =>
        bridge.trash(copies.map((c) => c.to)).then(() => load(dir), fail),
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
      await load(dir);
      toast(`Moved ${count(gone.length, 'item')} to ${binName()}`);
    } catch (err) {
      fail(err);
      load(dir);
    }
    list.current?.focus();
  };
  function setClip(op, items, write) {
    const paths = items.map((e) => e.path);
    clip = { op, paths, text: paths.join('\n') };
    write(clip.text);
    setClipVersion((v) => v + 1);
    toast(`${op === 'cut' ? 'Cut' : 'Copied'} ${count(paths.length, 'item')}. Ctrl+V pastes ${paths.length === 1 ? 'it' : 'them'} in a folder.`, { timeout: 2500 });
  }
  const clipFromMenu = (op) => targets().length && setClip(op, targets(), (text) => navigator.clipboard.writeText(text).catch(() => {}));
  /** Files from another app are copied in; what was cut or copied here is moved or copied; plain text becomes a new file. */
  async function pasteInto(target, { files = [], text = '' }) {
    if (files.length) return copyIn(files, target);
    if (clip && (!text || text === clip.text)) {
      const { op, paths } = clip;
      if (op === 'cut') {
        clip = null;
        setClipVersion((v) => v + 1);
        return moveTo(paths, target);
      }
      return copyTo(paths, target);
    }
    if (text.trim()) {
      if (target !== dir) go(target);
      return setCreating({ kind: 'file', name: 'Pasted text.txt', text });
    }
    toast('Nothing to paste. Copy files here or in your file explorer first.');
  }
  // The Paste button and menu: the same as Ctrl+V, through the system's paste.
  const paste = () => {
    list.current?.focus();
    claimSelection();
    bridge.paste().catch(fail);
  };

  // ---- Dragging ----

  const dragPaths = (e) => (selected.has(e.path) ? order.filter((p) => selected.has(p)) : [e.path]);
  const onDragStart = (ev, e) => {
    ev.preventDefault();
    if (!canDragOut()) return;
    const paths = dragPaths(e);
    if (!selected.has(e.path)) select([e.path]);
    // To the desktop, a folder, a terminal or the Claude app as the files themselves; onto a folder here, moved.
    startDragOut(null, { paths });
  };
  const acceptDrag = (ev, target) => {
    const types = ev.dataTransfer?.types ?? [];
    if (!types.includes('Files') && !draggedPaths().length) return;
    if (draggedPaths().includes(target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = ev.ctrlKey || !draggedPaths().length || draggedTab() ? 'copy' : 'move';
    setDropTarget(target);
  };
  const onDrop = (ev, target) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropTarget(null);
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
    if (key === 'Enter') return handled(), openSelected();
    if (key === 'Backspace' || (key === 'ArrowUp' && ev.altKey)) {
      handled();
      const up = parentOf(dir, root);
      if (up) {
        pendingSelect.current = dir;
        go(up);
      }
      return;
    }
    if (key === 'Delete') return handled(), targets().length && setConfirm(targets());
    if (key === 'F2') return handled(), targets().length === 1 && setRenaming(targets()[0].path);
    if (key === 'F5') return handled(), load(dir);
    if (mod && key.toLowerCase() === 'a') return handled(), select(order, { at: cursor ?? order[0] });
    if (mod && !ev.shiftKey && !ev.altKey && (key.toLowerCase() === 'c' || key.toLowerCase() === 'x')) return handled(), clipFromMenu(key.toLowerCase() === 'x' ? 'cut' : 'copy');
    // Ctrl+V goes on to the browser's paste, which brings the files copied in other apps.
    if (mod && key.toLowerCase() === 'v') return claimSelection();
    if (mod && ev.shiftKey && key.toLowerCase() === 'n') return handled(), setCreating({ kind: 'folder', name: 'New folder' });
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
    { label: 'New file', icon: 'filePlus', run: () => setCreating({ kind: 'file', name: 'New file.txt' }) },
    { label: 'New folder (Ctrl+Shift+N)', icon: 'folderPlus', run: () => setCreating({ kind: 'folder', name: 'New folder' }) },
    { label: 'Paste (Ctrl+V)', icon: 'clipboard', run: paste },
    { separator: true },
    ...sortItems,
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', run: () => saveSettings({ showHidden: !settings.showHidden }) },
    { label: 'Refresh (F5)', icon: 'rotate', run: () => load(dir) },
    { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(dir) },
    { label: 'Open in the file explorer', icon: 'external', run: () => bridge.openExternal(dir).catch(fail) },
  ];
  const entryItems = () => {
    const items = targets();
    const one = items.length === 1 ? items[0] : null;
    const files = items.filter((e) => !e.dir);
    const images = files.filter((e) => isImageName(e.name));
    return [
      { label: one?.dir ? 'Open' : 'Open (Enter)', icon: one?.dir ? 'folderOpen' : 'file', run: openSelected },
      one && !one.dir && { label: 'Open with its program', icon: 'external', run: () => openOutside(one) },
      images.length && images.length === items.length && { label: `Text from ${images.length === 1 ? 'the image' : `${images.length} images`}…`, icon: 'scan', run: () => actions.readImageFiles(images.map((e) => e.path), dir) },
      { separator: true },
      { label: 'Cut (Ctrl+X)', icon: 'scissors', run: () => clipFromMenu('cut') },
      { label: 'Copy (Ctrl+C)', icon: 'copy', run: () => clipFromMenu('copy') },
      one?.dir && { label: 'Paste into this folder', icon: 'clipboard', disabled: !clip, run: () => clip && pasteInto(one.path, {}) },
      { label: 'Duplicate', icon: 'copy', run: () => copyTo(items.map((e) => e.path), dir) },
      one && { label: 'Rename (F2)', icon: 'edit', run: () => setRenaming(one.path) },
      { label: 'Delete (Del)', icon: 'trash', danger: true, run: () => setConfirm(items) },
      { separator: true },
      { label: one ? 'Copy path' : 'Copy paths', icon: 'copy', run: () => (one ? actions.copyPath(one.path) : navigator.clipboard.writeText(items.map((e) => e.path).join('\n')).then(() => toast('Paths copied'))) },
      { label: one ? 'Copy for Claude (the path)' : 'Copy for Claude (the paths)', icon: 'claude', run: () => navigator.clipboard.writeText(items.map((e) => quotePath(e.path)).join(' ')).then(() => toast('On the clipboard: paste it into Claude')) },
      files.length && files.length === items.length && files.every((e) => opensInEditor(e.name)) && { label: 'Copy into my files (synced)', icon: 'filePlus', run: () => files.forEach((e) => actions.copyToFiles(e.path)) },
      one && { label: 'Show in the file explorer', icon: 'external', run: () => actions.showOnDisk(one.path) },
    ];
  };
  const rootItems = () => [
    ...roots.map((r) => ({ label: r, icon: 'folder', checked: r === root, run: () => go(r) })),
    { separator: true },
    { label: 'Open another folder…', icon: 'folderOpen', run: () => pick(parentOf(dir, root) ?? root) },
    ...PLACES.filter((p) => places[p.id] && !roots.includes(places[p.id])).map((p) => ({ label: `Pick in ${p.label}…`, run: () => pick(places[p.id]) })),
    { separator: true },
    ...sortItems,
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : `Show hidden files${hiddenCount ? ` (${hiddenCount} here)` : ''}`, icon: 'eye', run: () => saveSettings({ showHidden: !settings.showHidden }) },
    { label: 'Show this folder in the file explorer', icon: 'external', run: () => actions.showOnDisk(dir) },
    { label: `Forget ${baseName(root)}`, icon: 'x', run: () => forget(root) },
  ];

  // ---- The view ----

  if (!roots) return html`<div class="file-list" />`;
  if (!roots.length) {
    return html`<div class="folders-empty">
      <p>Browse a folder on this computer and open its files here, like in a file explorer.</p>
      <p class="muted small">They are edited in place and are not synced. "Copy into my files" makes a copy that syncs.</p>
      <button type="button" class="btn primary" onClick=${() => pick()}><${Icon} name="folderOpen" size=${16} />Open a folder…</button>
      <div class="folder-places">
        <span class="muted small">Start in</span>
        ${PLACES.filter((p) => places[p.id]).map(
          (p) => html`<button type="button" key=${p.id} class="btn ghost sm" title=${`Pick a folder, starting in ${places[p.id]}`} onClick=${() => pick(places[p.id])}>${p.label}</button>`,
        )}
      </div>
    </div>`;
  }
  if (!root) return html`<div class="file-list" />`;

  const crumbs = breadcrumbs(dir, root);
  const up = parentOf(dir, root);
  const hiddenCount = (listing?.entries ?? []).filter((e) => e.hidden).length;
  const some = targets().length > 0;
  const tool = (label, icon, run, disabled = false) =>
    html`<button type="button" class="icon-btn sm" aria-label=${label} title=${label} disabled=${disabled} onClick=${run}><${Icon} name=${icon} size=${16} /></button>`;
  const dropProps = (target) => ({
    onDragOver: (ev) => acceptDrag(ev, target),
    onDragLeave: (ev) => !ev.currentTarget.contains(ev.relatedTarget) && setDropTarget((t) => (t === target ? null : t)),
    onDrop: (ev) => onDrop(ev, target),
  });
  const row = (e) => {
    const key = diskKey(e.path);
    const isSelected = selected.has(e.path);
    return html`<div key=${e.path} data-path=${e.path} role="option" aria-selected=${isSelected} id=${`row-${order.indexOf(e.path)}`}
      class="folder-row ${e.dir ? 'is-dir' : ''} ${isSelected ? 'selected' : ''} ${cursor === e.path ? 'cursor' : ''} ${activeKey === key ? 'active' : ''} ${e.hidden ? 'hidden-entry' : ''} ${clip?.op === 'cut' && clip.paths.includes(e.path) ? 'is-cut' : ''} ${dropTarget === e.path ? 'drop-target' : ''}"
      title=${e.path} draggable=${renaming !== e.path}
      onDragStart=${(ev) => onDragStart(ev, e)}
      ...${e.dir ? dropProps(e.path) : {}}
      onClick=${(ev) => {
        ev.stopPropagation();
        list.current?.focus();
        if (ev.shiftKey) select(rangeOf(order, anchor ?? e.path, e.path), { at: e.path, keepAnchor: true });
        else if (ev.ctrlKey || ev.metaKey) {
          const next = new Set(selected);
          next.has(e.path) ? next.delete(e.path) : next.add(e.path);
          setSelected(next);
          setCursor(e.path);
          setAnchor(e.path);
        } else select([e.path]);
      }}
      onDblClick=${(ev) => {
        ev.stopPropagation();
        openEntry(e);
      }}
      onContextMenu=${(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!selected.has(e.path)) select([e.path]);
        setMenu({ entry: e, at: { x: ev.clientX, y: ev.clientY } });
      }}>
      <${Icon} name=${e.dir ? 'folder' : isImageName(e.name) ? 'image' : 'file'} size=${15} />
      ${renaming === e.path
        ? html`<${NameField} initial=${e.name} dir=${e.dir} label=${`New name for ${e.name}`} onDone=${(name) => rename(e, name)} onCancel=${() => (setRenaming(null), list.current?.focus())} />`
        : html`<span class="folder-name">${e.name}</span>`}
      ${openKeys.includes(key) && html`<span class="tab-dot open-dot" title="Open in a tab" />`}
      <span class="spacer" />
      ${!e.dir && renaming !== e.path && html`<span class="muted small folder-meta" title=${new Date(e.mtimeMs).toLocaleString()}>${formatBytes(e.size)} · ${timeAgo(new Date(e.mtimeMs).toISOString())}</span>`}
    </div>`;
  };

  return html`
    <div class="folders-head">
      <div class="folders-root">
        <button type="button" class="btn ghost sm folders-root-name ${dropTarget === root ? 'drop-target' : ''}" title=${root} onClick=${() => go(root)} ...${dropProps(root)}><${Icon} name="folder" size=${15} /><span>${baseName(root)}</span></button>
        <span class="spacer" />
        ${tool('Up one folder (Backspace)', 'arrowUp', () => go(up), !up)}
        ${tool('Refresh (F5)', 'rotate', () => load(dir))}
        <${MenuButton} label="Folders" items=${rootItems} />
      </div>
      <div class="folders-tools" role="toolbar" aria-label="Files">
        ${tool('New file', 'filePlus', () => setCreating({ kind: 'file', name: 'New file.txt' }))}
        ${tool('New folder (Ctrl+Shift+N)', 'folderPlus', () => setCreating({ kind: 'folder', name: 'New folder' }))}
        <span class="tools-sep" />
        ${tool('Cut (Ctrl+X)', 'scissors', () => clipFromMenu('cut'), !some)}
        ${tool('Copy (Ctrl+C)', 'copy', () => clipFromMenu('copy'), !some)}
        ${tool('Paste (Ctrl+V)', 'clipboard', paste)}
        <span class="tools-sep" />
        ${tool('Rename (F2)', 'edit', () => setRenaming(targets()[0].path), targets().length !== 1)}
        ${tool('Delete (Del)', 'trash', () => setConfirm(targets()), !some)}
      </div>
      ${crumbs.length > 1 &&
      html`<nav class="crumbs" aria-label="Folder path">
        ${crumbs.map(
          (c, i) => html`${i > 0 && html`<span class="crumb-sep" key=${`s${i}`}>›</span>`}<button type="button" key=${c.path} class="crumb ${i === crumbs.length - 1 ? 'current' : ''} ${dropTarget === c.path ? 'drop-target' : ''}"
            aria-current=${i === crumbs.length - 1 ? 'location' : undefined} title=${c.path} onClick=${() => go(c.path)} ...${i < crumbs.length - 1 ? dropProps(c.path) : {}}>${c.name}</button>`,
        )}
      </nav>`}
      <div class="sidebar-filter">
        <${Icon} name="search" size=${15} />
        <input value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder=${`Filter ${baseName(dir)}`} aria-label="Filter this folder"
          onKeyDown=${(e) => e.key === 'ArrowDown' && (e.preventDefault(), list.current?.focus(), order[0] && select([order[0]]))} />
      </div>
    </div>
    <div class="file-list folder-list ${dropTarget === dir ? 'drop-target' : ''}" role="listbox" aria-multiselectable="true" tabindex="0" ref=${list}
      aria-label=${`Files in ${baseName(dir)}`} aria-activedescendant=${cursor && order.includes(cursor) ? `row-${order.indexOf(cursor)}` : undefined}
      onKeyDown=${onKeyDown}
      onFocus=${claimSelection}
      onClick=${() => setSelected(new Set())}
      onContextMenu=${(ev) => {
        ev.preventDefault();
        setSelected(new Set());
        setMenu({ entry: null, at: { x: ev.clientX, y: ev.clientY } });
      }}
      ...${dropProps(dir)}>
      ${creating &&
      html`<div class="folder-row creating">
        <${Icon} name=${creating.kind === 'folder' ? 'folder' : 'file'} size=${15} />
        <${NameField} key=${`${creating.kind}:${creating.name}`} initial=${creating.name} dir=${creating.kind === 'folder'} label=${creating.kind === 'folder' ? 'New folder name' : 'New file name'}
          onDone=${(name) => create({ ...creating, name })} onCancel=${() => (setCreating(null), list.current?.focus())} />
      </div>`}
      ${listing?.error && html`<p class="error-text small empty-list">${listing.error}</p>`}
      ${entries.map(row)}
      ${listing?.dir === dir && !listing.error && !entries.length && !creating &&
      html`<p class="muted small empty-list">${filter ? 'Nothing here matches.' : hiddenCount && !settings.showHidden ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty. Drop or paste files here.'}</p>`}
      ${listing?.truncated && html`<p class="muted small empty-list">Showing the first ${listing.entries.length.toLocaleString()} entries. Filter to find the others, or open a folder inside.</p>`}
    </div>
    <div class="sidebar-foot folders-foot">
      <span class="muted small folders-status" aria-live="polite">${selectionSummary(entries, selected, formatBytes)}</span>
      <span title="Files on this computer: edited in place, not synced. Copy into my files makes a synced copy."><${Icon} name="cloudOff" size=${15} /></span>
    </div>
    ${menu && html`<${Menu} items=${menu.entry ? entryItems() : backgroundItems()} at=${menu.at} label=${menu.entry?.name ?? baseName(dir)} onClose=${() => setMenu(null)} />`}
    ${confirm && html`<${DeleteDialog} entries=${confirm} onConfirm=${() => remove(confirm)} onClose=${() => (setConfirm(null), list.current?.focus())} />`}
  `;
}
