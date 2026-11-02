import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { createMergeEditor } from '../editor.js';
import { childPath, choicePlan, compareListings, copyPlan, countStates, folderChoices, nextDifference, PRESET_HINTS, PRESET_LABELS, presetChoices, setChoice, SHOW, SHOW_LABELS, STATE_LABELS, SYNC_PRESETS, toCheck, treeRows, withChecks } from '../folderCompare.js';
import { formatBytes, formatDateTime, shortDate } from '../format.js';
import { pathName, sideName, sideWhere } from '../compares.js';
import { getSettings, resolvedTheme, saveSettings } from '../settings.js';
import { diskKey } from '../store.js';
import { onTransfers, running } from '../transfers.js';
import { connIcon, isRemotePath, remoteParts } from '../where.js';
import { server } from '../servers.js';
import { isAndroidApp } from '../platform.js';
import { FileIcon } from './fileIcon.js';
import { binName } from './folders.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';
import { Modal } from './components.js';
import { Splitter } from './splitter.js';
import { PanesTab } from './twoPanes.js';
import { GitHistoryTab } from './gitHistory.js';
import { SidewaysButton, usePhoneLayout } from './phone.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const sideOf = (s) => s?.path ?? s?.key ?? `text:${s?.label ?? ''}`;

/**
 * Two texts compared and edited (a files comparison, or the lower half of a folders one):
 * `left` / `right` are sides ({ key } of a file, or { text, label, detail }). Each side is
 * read through `actions.readCompareSide` and saved through `actions.saveCompareSide`.
 * `onSaved(side)` after a save; `onDirty({ left, right })` when unsaved edits come or go.
 */
export function FileCompare({ left, right, settings, actions, onSaved, onDirty, onSwap, extra = null, names = null }) {
  const el = useRef(null);
  const api = useRef(null);
  const base = useRef({ left: '', right: '' });
  const [sides, setSides] = useState(null); // { left: { text, info, readOnly, savable }, right } | { error }
  const [dirty, setDirty] = useState({ left: false, right: false });
  const [pos, setPos] = useState({ index: -1, count: 0 });
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(null);
  const theme = resolvedTheme(settings.theme);
  // On a phone held upright: one text with the changes marked (the left side's lines removed in place).
  const unified = usePhoneLayout();
  // The texts now, edits too: kept when the editor is made again (another layout, theme, wrap).
  const texts = useRef(null);
  useEffect(() => {
    let stale = false;
    setSides(null);
    Promise.all([actions.readCompareSide(left), actions.readCompareSide(right)]).then(
      ([l, r]) => !stale && setSides({ left: l, right: r }),
      (err) => !stale && setSides({ error: message(err) }),
    );
    return () => {
      stale = true;
    };
  }, [sideOf(left), sideOf(right), reload]);
  useEffect(() => onDirty?.(dirty), [dirty.left, dirty.right]);
  useLayoutEffect(() => {
    if (!sides || sides.error || !el.current) return;
    if (texts.current?.from !== sides) {
      texts.current = { from: sides, left: sides.left.text, right: sides.right.text };
      base.current = { left: sides.left.text, right: sides.right.text };
      setDirty({ left: false, right: false });
    }
    api.current = createMergeEditor(el.current, {
      left: texts.current.left,
      right: texts.current.right,
      name: names?.right ?? sideName(right),
      dark: theme === 'dark',
      unified,
      wrap: Boolean(settings.wordWrap) || unified,
      readOnly: { left: sides.left.readOnly, right: sides.right.readOnly },
      onChange: (side, text) => {
        texts.current[side] = text;
        setDirty((d) => (d[side] === (text !== base.current[side]) ? d : { ...d, [side]: text !== base.current[side] }));
      },
      onCursor: setPos,
    });
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, [sides, theme, settings.wordWrap, unified]);

  const save = async (side) => {
    const desc = side === 'left' ? left : right;
    const text = api.current?.text(side);
    if (text == null) return;
    setSaving(side);
    try {
      const info = await actions.saveCompareSide(desc, text, sides[side].info);
      if (!info) return;
      sides[side].info = info;
      base.current[side] = text;
      texts.current[side] = text;
      setDirty((d) => ({ ...d, [side]: false }));
      onSaved?.(side);
    } finally {
      setSaving(null);
    }
  };
  const refresh = () => {
    if ((dirty.left || dirty.right) && !confirm('Read both again? Your edits here that are not saved go.')) return;
    setReload((n) => n + 1);
  };
  const count = pos.count;
  const where = count === 0 ? 'No differences' : pos.index >= 0 ? `Change ${pos.index + 1} of ${count}` : `${count} change${count === 1 ? '' : 's'}`;
  const head = (side) => {
    const s = side === 'left' ? left : right;
    const state = sides?.[side];
    const name = names?.[side] ?? sideName(s);
    return html`<div class="ccmp-side ${side}" title=${[name, sideWhere(s)].filter(Boolean).join('\n')}>
      <span class="ccmp-name">${name}</span>
      ${dirty[side] && html`<span class="tab-dot" title="Not saved" />`}
      <span class="ccmp-where"><bdi>${names?.[`${side}Where`] ?? sideWhere(s)}</bdi></span>
      <span class="spacer" />
      ${state?.readOnly && html`<span class="muted small">read-only</span>`}
      ${state && !state.readOnly && state.savable &&
      html`<button type="button" class="btn sm ${dirty[side] ? 'primary' : 'ghost'}" disabled=${!dirty[side] || saving === side} onClick=${() => save(side)}
        title=${`Save the ${side} side (${state.saveLabel ?? 'to its file'})`}><${Icon} name="save" size=${14} /><span class="label">${saving === side ? 'Saving…' : 'Save'}</span></button>`}
      ${state && !state.savable && html`<button type="button" class="btn ghost sm" onClick=${() => actions.copyText(api.current?.text(side) ?? '')} title="Copy this side's text"><${Icon} name="copy" size=${14} /><span class="label">Copy</span></button>`}
    </div>`;
  };
  const moreItems = () => [
    { label: 'Copy the whole left side to the right', icon: 'arrowRight', disabled: !sides || sides.right?.readOnly, run: () => api.current?.copyAll(true) },
    { label: 'Copy the whole right side to the left', icon: 'arrowLeft', disabled: !sides || sides.left?.readOnly, run: () => api.current?.copyAll(false) },
    { separator: true },
    onSwap && { label: 'Swap the sides', icon: 'rotate', run: onSwap },
    { label: 'Read both again', icon: 'sync', run: refresh },
    left?.key && { label: `Open ${names?.left ?? sideName(left)} in a tab`, icon: 'file', run: () => actions.openCompareSide(left) },
    right?.key && { label: `Open ${names?.right ?? sideName(right)} in a tab`, icon: 'file', run: () => actions.openCompareSide(right) },
  ];
  return html`<div class="ccmp ${unified ? 'unified' : ''}" role="region" aria-label="Files compared">
    <div class="ccmp-bar">
      ${extra}
      <span class="muted small ccmp-count" aria-live="polite">${sides && !sides.error ? where : ''}</span>
      <button type="button" class="icon-btn sm" aria-label="Previous change" title="Previous change (Alt+↑)" disabled=${!count} onClick=${() => api.current?.previous()}><${Icon} name="chevronDown" size=${16} class="up" /></button>
      <button type="button" class="icon-btn sm" aria-label="Next change" title="Next change (Alt+↓)" disabled=${!count} onClick=${() => api.current?.next()}><${Icon} name="chevronDown" size=${16} /></button>
      <span class="ccmp-gap" />
      <button type="button" class="btn ghost sm" disabled=${pos.index < 0 || sides?.right?.readOnly} title="Copy the change at the cursor to the right (Alt+→)" onClick=${() => api.current?.copyHere(true)}>
        <span class="label">Copy</span><${Icon} name="arrowRight" size=${14} /></button>
      <button type="button" class="btn ghost sm" disabled=${pos.index < 0 || sides?.left?.readOnly} title="Copy the change at the cursor to the left (Alt+←)" onClick=${() => api.current?.copyHere(false)}>
        <${Icon} name="arrowLeft" size=${14} /><span class="label">Copy</span></button>
      <span class="spacer" />
      <${MenuButton} label="More" items=${moreItems} />
    </div>
    <div class="ccmp-heads">${head('left')}${head('right')}</div>
    ${unified && html`<p class="ccmp-legend muted small"><span class="was">Left: lines in red</span><span class="now">Right: the text, changes in green</span></p>`}
    ${sides?.error && html`<p class="notice error ccmp-note" role="alert"><${Icon} name="alert" size=${15} /><span>${sides.error}</span></p>`}
    ${!sides && html`<p class="muted small ccmp-note">Reading…</p>`}
    <div class="ccmp-body" ref=${el} hidden=${!sides || Boolean(sides.error)} />
  </div>`;
}

/** A files comparison in its tab. */
function FilesTab({ id, record, settings, actions }) {
  return html`<${FileCompare} key=${id} left=${record.left} right=${record.right} settings=${settings} actions=${actions}
    onDirty=${(d) => actions.compareDirty(id, d.left || d.right)}
    onSwap=${() => actions.updateCompare(id, { left: record.right, right: record.left })}
    extra=${html`<${SaveStar} id=${id} record=${record} actions=${actions} />`} />`;
}

/** ☆: saves the comparison (or shows it is saved). */
function SaveStar({ id, record, actions }) {
  const saved = actions.savedCompareOf(record);
  return html`<button type="button" class="icon-btn sm ccmp-star ${saved ? 'on' : ''}" aria-pressed=${Boolean(saved)} disabled=${!actions.canSaveCompare(`c:${id}`) && !saved}
    title=${saved ? `Saved as “${saved.name}”: click to rename or remove` : 'Save this comparison (to open it again later)'} aria-label=${saved ? 'Saved comparison' : 'Save this comparison'}
    onClick=${() => actions.saveCompare(`c:${id}`)}><${Icon} name="star" size=${16} /></button>`;
}

// ---- Folders ---------------------------------------------------------------------

const MARKS = { same: '=', changed: '≠', left: '◧', right: '◨', unsure: '…', kind: '≠' };
const sizeOf = (s) => (s && !s.dir ? formatBytes(s.size) : '');
const dateOf = (s) => (s?.mtimeMs ? formatDateTime(new Date(s.mtimeMs).toISOString()) : '');
const many = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
/** The side a row is only on ('left' / 'right'), or null when it is on both. */
const onlyOn = (e) => (e.left && !e.right ? 'left' : e.right && !e.left ? 'right' : null);
// What one call to the main process takes (it refuses more than 5,000 paths at once).
const CHUNK = 2000;
const chunks = (list) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** A folder's name with where it is, for the heads: on a server, the server's name. */
const rootWhere = (p) => (isRemotePath(p) ? `${server(remoteParts(p).id)?.name ?? 'Server'}: ${remoteParts(p).path}` : p);

/**
 * Two folders compared in a tab: one aligned tree (left file | state | right file), the
 * differences by default; a file picked shows below, compared (or alone, when it is on one
 * side). Copies go either way, and syncing picks for each difference which way it goes (or
 * that it stays). Same-size files with another date are compared byte for byte in the
 * background; what is found is kept while their sizes and dates stay, so reading both
 * folders again (after a copy) checks only what changed, and the ones being checked wait
 * behind one "Checking…" row instead of all showing for a moment.
 */
function FoldersTab({ id, record, settings, actions }) {
  const left = record.left.path;
  const right = record.right.path;
  const [scan, setScan] = useState(null); // { left, right } | { error }
  const [scanning, setScanning] = useState(true);
  const [checked, setChecked] = useState({}); // withChecks: { rel: { key, same } }
  const [failed, setFailed] = useState(() => new Set()); // checks that could not run this time: shown as not known
  const [checking, setChecking] = useState(null); // { done, total }
  const [expanded, setExpanded] = useState(() => new Set(record.expanded ?? []));
  const [selected, setSelected] = useState(() => new Set());
  const [cursor, setCursor] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  // Syncing: the preset and the person's own choices on top ({ preset, overrides: Map }), and the plan being confirmed.
  const [sync, setSync] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [tick, setTick] = useState(0);
  const [split, setSplit] = useState(() => getSettings().compareSplit || 0.45);
  // The file compared below has edits not saved: asked before another one takes its place.
  const lowerDirty = useRef(false);
  const leaveFile = () => !lowerDirty.current || confirm('The file below has changes that are not saved. Leave them?');
  const tree = useRef(null);
  const body = useRef(null);
  const show = record.show ?? 'diff';
  const opts = { all: Boolean(record.all), hidden: settings.showHidden !== false };
  // A phone held upright: one tree, each name once, both sides' size and date under it.
  const phone = usePhoneLayout();

  // Both folders listed (again after copies, saves, Refresh). Until the new listing comes, the
  // rows read before stay; what the content checks found stays with it (checkKey).
  useEffect(() => {
    let stale = false;
    setScanning(true);
    actions
      .compareScan(left, right, opts)
      .then(
        (s) => !stale && (setScan(s), setFailed(new Set())),
        (err) => !stale && setScan({ error: message(err) }),
      )
      .finally(() => !stale && setScanning(false));
    return () => {
      stale = true;
    };
  }, [left, right, tick, opts.all, opts.hidden]);
  // A copy to or from a server ends in the background: list again.
  useEffect(() => onTransfers((_jobs, job) => job && !running(job) && setTick((t) => t + 1)), []);

  const entries = useMemo(() => (scan && !scan.error ? compareListings(scan.left, scan.right, { checked }) : new Map()), [scan, checked]);
  // The files whose contents are being compared (or about to be): left out of the differences
  // meanwhile (most turn out the same), behind one "Checking…" row. The one at the cursor stays.
  const pending = useMemo(() => new Set(toCheck(entries).filter((r) => !failed.has(r))), [entries, failed]);
  const hide = useMemo(() => {
    if (show !== 'diff' || !pending.size) return null;
    if (!cursor || !pending.has(cursor)) return pending;
    const out = new Set(pending);
    out.delete(cursor);
    return out;
  }, [pending, show, cursor]);
  const rows = useMemo(() => treeRows(entries, { expanded, show, hideUnsure: hide }), [entries, expanded, show, hide]);
  const counts = useMemo(() => countStates(entries), [entries]);
  const choices = useMemo(() => (sync ? presetChoices(entries, sync.preset, sync.overrides) : null), [entries, sync]);
  const folderWays = useMemo(() => (choices ? folderChoices(choices) : null), [choices]);
  const plan = useMemo(() => (choices ? choicePlan(entries, choices) : null), [entries, choices]);

  // Same size, another date: compared byte for byte, a few at a time; each answer is kept
  // (with both sides' size and date) as it comes.
  useEffect(() => {
    if (!scan || scan.error) return;
    const list = toCheck(entries);
    if (!list.length) return setChecking(null);
    const of = entries;
    let stale = false;
    (async () => {
      const found = {};
      for (let i = 0; i < list.length && !stale; i += 20) {
        setChecking({ done: i, total: list.length });
        try {
          const part = await actions.compareSame(left, right, list.slice(i, i + 20));
          if (stale) return;
          Object.assign(found, part);
          // Those it could not tell stay "different" (to be looked at).
          setChecked((c) => withChecks(c, of, part));
        } catch {
          break;
        }
      }
      if (stale) return;
      setChecking(null);
      const missed = list.filter((r) => !(r in found));
      if (missed.length) setFailed(new Set(missed));
    })();
    return () => {
      stale = true;
    };
  }, [scan]);

  const remember = (patch) => actions.updateCompare(id, patch, { silent: true });
  const toggle = (rel, open = !expanded.has(rel)) => {
    const next = new Set(expanded);
    if (open) next.add(rel);
    else next.delete(rel);
    setExpanded(next);
    remember({ expanded: [...next].slice(0, 300) });
  };
  // Opens the folders down to `rel`, so it shows.
  const reveal = (rel) => {
    const next = new Set(expanded);
    for (let p = rel; p.includes('/'); ) {
      p = p.slice(0, p.lastIndexOf('/'));
      next.add(p);
    }
    setExpanded(next);
  };
  const pick = (rel, ev) => {
    if (rel !== cursor && !leaveFile()) return;
    if (ev?.ctrlKey || ev?.metaKey) {
      const next = new Set(selected);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      setSelected(next);
    } else if (ev?.shiftKey && cursor) {
      const a = rows.findIndex((r) => r.rel === cursor);
      const b = rows.findIndex((r) => r.rel === rel);
      setSelected(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.rel)));
    } else setSelected(new Set([rel]));
    setCursor(rel);
  };
  const go = (step) => {
    // The next difference among everything under open or closed folders: its folders open.
    const all = treeRows(entries, { expanded: new Set([...entries.values()].filter((e) => e.dir).map((e) => e.rel)), show, hideUnsure: hide });
    const rel = nextDifference(all, cursor, step);
    if (!rel || !leaveFile()) return;
    reveal(rel);
    setSelected(new Set([rel]));
    setCursor(rel);
  };
  useEffect(() => {
    if (cursor) tree.current?.querySelector(`[data-rel="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rows]);

  const picked = [...selected].filter((r) => entries.has(r));
  const copy = async (from) => {
    const to = from === 'left' ? 'right' : 'left';
    const { copy: list, same } = copyPlan(entries, picked, from);
    if (!list.length) return setNote({ text: same ? 'Those are the same on both sides already.' : `Nothing to copy: ${picked.length === 1 ? 'it is' : 'they are'} not on the ${from}.` });
    const replaced = list.filter((r) => entries.get(r)?.[to]).length;
    if (replaced && !confirm(`Copy ${list.length} item${list.length === 1 ? '' : 's'} to the ${to}? ${replaced} there ${replaced === 1 ? 'is' : 'are'} replaced (${forGoodOn(record[to].path) ? `on ${forGoodOn(record[to].path)}: for good` : `the old ones go to ${binName()}`}).`)) return;
    setBusy('copy');
    setNote(null);
    try {
      const r = await actions.compareCopy(record[from].path, record[to].path, list);
      setNote({ text: r?.transfer ? `Copying ${list.length} item${list.length === 1 ? '' : 's'} to the ${to} (see Transfers).` : `Copied ${list.length} item${list.length === 1 ? '' : 's'} to the ${to}.` });
      if (!r?.transfer) setTick((t) => t + 1);
    } catch (err) {
      setNote({ text: message(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  // ---- Syncing: a choice per difference, then all of them at once ----
  const startSync = (preset = 'newer') => setSync({ preset, overrides: new Map() });
  /** A row's choice ('right', 'left', 'skip' or 'delete'): for every row picked when it is one of them. */
  const choose = (rel, way) => {
    const rels = selected.has(rel) && selected.size > 1 ? picked : [rel];
    setSync((s) => s && { ...s, overrides: setChoice(s.overrides, entries, rels, way) });
  };
  const runSync = async (p) => {
    setConfirming(null);
    setBusy('sync');
    setNote(null);
    let background = false;
    const copied = p.toRight.length + p.toLeft.length;
    const deleted = p.deleteLeft.length + p.deleteRight.length;
    try {
      for (const part of chunks(p.toRight)) background = Boolean((await actions.compareCopy(left, right, part))?.transfer) || background;
      for (const part of chunks(p.toLeft)) background = Boolean((await actions.compareCopy(right, left, part))?.transfer) || background;
      for (const part of chunks(p.deleteLeft)) await actions.compareRemove(left, part);
      for (const part of chunks(p.deleteRight)) await actions.compareRemove(right, part);
      setSync(null);
      setNote({
        text: background
          ? `Syncing: ${[copied && `${many(copied, 'item')} to copy`, deleted && `${many(deleted, 'item')} deleted`].filter(Boolean).join(', ')}. Copies to and from the server go on in the background (see Transfers).`
          : `Synced: ${[copied && `${many(copied, 'item')} copied`, deleted && `${many(deleted, 'item')} deleted`].filter(Boolean).join(', ')}.`,
      });
    } catch (err) {
      setNote({ text: message(err), error: true });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  const current = cursor && entries.get(cursor);
  const fileSide = (side) => current?.[side] && !current[side].dir && { key: diskKey(childPath(record[side].path, current.rel)) };
  const lowerNames = current && { left: current.name, right: current.name, leftWhere: current.left ? childPath(left, current.rel) : '', rightWhere: current.right ? childPath(right, current.rel) : '' };

  const keyDown = (e) => {
    const at = rows.findIndex((r) => r.rel === cursor);
    const row = rows[at];
    // Syncing: Alt+→ / Alt+← / Alt+- / Alt+Delete set what happens to the rows picked.
    if (sync && e.altKey && !e.ctrlKey && !e.metaKey) {
      const way = e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowLeft' ? 'left' : e.code === 'Minus' || e.code === 'NumpadSubtract' ? 'skip' : e.key === 'Delete' || e.key === 'Backspace' ? 'delete' : null;
      if (way) {
        e.preventDefault();
        const rels = picked.length ? picked : cursor ? [cursor] : [];
        if (rels.length) setSync((s) => s && { ...s, overrides: setChoice(s.overrides, entries, rels, way) });
        return;
      }
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      return go(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) pick(next.rel, e.shiftKey ? { shiftKey: true } : null);
    } else if (e.key === 'ArrowRight' && row?.dir) {
      e.preventDefault();
      toggle(row.rel, true);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.dir && expanded.has(row.rel)) toggle(row.rel, false);
      else if (row.parent) pick(row.parent);
    } else if (e.key === 'Enter' && row) {
      e.preventDefault();
      if (row.dir) toggle(row.rel);
      else if (row.left && row.right) actions.compareFiles({ key: diskKey(childPath(left, row.rel)) }, { key: diskKey(childPath(right, row.rel)) });
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(rows.map((r) => r.rel)));
    }
  };

  const cell = (e, side) => {
    const s = e[side];
    if (!s) return html`<div class="fcmp-cell ${side} absent" />`;
    return html`<div class="fcmp-cell ${side}">
      <span class="fcmp-indent" style=${{ width: `${e.depth * 16}px` }} />
      ${s.dir
        ? html`<button type="button" class="fcmp-twist ${expanded.has(e.rel) ? 'open' : ''}" tabindex="-1" aria-label=${expanded.has(e.rel) ? 'Close' : 'Open'} onClick=${(ev) => (ev.stopPropagation(), toggle(e.rel))}><${Icon} name="chevronRight" size=${13} /></button><${Icon} name="folder" size=${15} class="fcmp-icon" />`
        : html`<span class="fcmp-twist" /><${FileIcon} name=${e.name} size=${15} plain=${settings.fileIcons === false} />`}
      <span class="fcmp-name">${e.name}</span>
      <span class="fcmp-size">${sizeOf(s)}</span>
      <span class="fcmp-date">${dateOf(s)}</span>
    </div>`;
  };
  // On a phone: the name once, then each side's size and date (or that it is not there).
  const both = (e) => {
    const s = e.left ?? e.right;
    const side = (key, mark) => {
      const x = e[key];
      const text = !x ? 'not here' : x.dir ? 'folder' : [sizeOf(x), shortDate(x.mtimeMs)].filter(Boolean).join(' · ');
      return html`<span class="fcmp-side ${key} ${x ? '' : 'absent'}" title=${x ? `${key === 'left' ? 'Left' : 'Right'}: ${[sizeOf(x), dateOf(x)].filter(Boolean).join(', ')}` : `Not on the ${key}`}>${mark} ${text}</span>`;
    };
    return html`<div class="fcmp-cell one">
      <span class="fcmp-indent" style=${{ width: `${e.depth * 14}px` }} />
      ${s.dir
        ? html`<button type="button" class="fcmp-twist ${expanded.has(e.rel) ? 'open' : ''}" tabindex="-1" aria-label=${expanded.has(e.rel) ? 'Close' : 'Open'} onClick=${(ev) => (ev.stopPropagation(), toggle(e.rel))}><${Icon} name="chevronRight" size=${13} /></button><${Icon} name="folder" size=${15} class="fcmp-icon" />`
        : html`<span class="fcmp-twist" /><${FileIcon} name=${e.name} size=${15} plain=${settings.fileIcons === false} />`}
      <span class="fcmp-lines">
        <span class="fcmp-name">${e.name}</span>
        ${!(s.dir && e.left && e.right) && html`<span class="fcmp-sides">${side('left', '◧')}${side('right', '◨')}</span>`}
      </span>
    </div>`;
  };
  const row = (e) => {
    // Syncing: the row's choice (a unit's own, or what the units inside a folder do), else its state.
    const unit = Boolean(choices?.has(e.rel));
    const way = !choices ? null : unit ? choices.get(e.rel) : e.dir && e.left && e.right ? (folderWays.get(e.rel) ?? null) : null;
    const one = unit ? onlyOn(e) : null;
    const goes = way === 'right' || way === 'left';
    const wayClass = way == null ? '' : `way-${way} ${goes ? (one === way ? `del-${way}` : `to-${way}`) : ''}`;
    const mid =
      way == null
        ? html`<div class="fcmp-mark" title=${STATE_LABELS[e.state]}>${MARKS[e.state]}</div>`
        : html`<${ChoiceControl} rel=${e.rel} name=${e.name} value=${way} one=${one} folder=${!unit} phone=${phone} onChoose=${choose} />`;
    return html`<div key=${e.rel} data-rel=${e.rel} role="treeitem" aria-selected=${selected.has(e.rel)} aria-level=${e.depth + 1} aria-expanded=${e.dir ? expanded.has(e.rel) : undefined}
      class="fcmp-row state-${e.state} ${wayClass} ${phone ? 'one' : ''} ${selected.has(e.rel) ? 'selected' : ''} ${cursor === e.rel ? 'cursor' : ''}"
      onClick=${(ev) => pick(e.rel, ev)}
      onDblClick=${() => (e.dir ? toggle(e.rel) : e.left && e.right && actions.compareFiles({ key: diskKey(childPath(left, e.rel)) }, { key: diskKey(childPath(right, e.rel)) }))}>
      ${phone ? html`${both(e)}${mid}` : html`${cell(e, 'left')}${mid}${cell(e, 'right')}`}
    </div>`;
  };

  const total = counts.changed + counts.left + counts.right + counts.kind + counts.unsure;
  const chip = (state, n) => n > 0 && html`<span class="fcmp-chip state-${state}" title=${STATE_LABELS[state]}>${MARKS[state]} ${n}</span>`;
  const head = (side) => {
    const p = record[side].path;
    return html`<div class="fcmp-head ${side} ${isRemotePath(p) ? 'kind-remote' : 'kind-disk'}" title=${p}>
      ${phone && html`<span class="fcmp-head-mark">${side === 'left' ? '◧' : '◨'}</span>`}
      <${Icon} name=${isRemotePath(p) ? connIcon(server(remoteParts(p).id)) : 'folder'} size=${15} />
      <span class="fcmp-head-name">${pathName(p)}</span>
      <span class="fcmp-head-where"><bdi>${rootWhere(p)}</bdi></span>
      <span class="spacer" />
      <button type="button" class="icon-btn xs" title=${`Compare another folder on the ${side}`} aria-label=${`Change the ${side} folder`}
        onClick=${() => leaveFile() && actions.pickCompareFolder({ id, side })}><${Icon} name="edit" size=${13} /></button>
    </div>`;
  };
  const moreItems = () => [
    { label: 'Swap the sides', icon: 'rotate', run: () => (setSync(null), actions.updateCompare(id, { left: record.right, right: record.left })) },
    { label: 'Make the right like the left…', icon: 'arrowRight', hint: 'Syncing, with every difference going to the right and what is only on the right deleted: change any of it first', disabled: !entries.size, run: () => startSync('mirror-right') },
    { label: 'Make the left like the right…', icon: 'arrowLeft', hint: 'Syncing, with every difference going to the left and what is only on the left deleted: change any of it first', disabled: !entries.size, run: () => startSync('mirror-left') },
    { separator: true },
    { label: 'Include .git, node_modules…', checked: Boolean(record.all), run: () => actions.updateCompare(id, { all: !record.all }) },
    { label: 'Show hidden files', checked: settings.showHidden !== false, run: () => saveSettings({ showHidden: !(getSettings().showHidden !== false) }) },
    { label: 'Open both folders in Folders', icon: 'folderOpen', run: () => actions.showSections?.([left, right], right) },
  ];
  // What syncing does now: "→ 12 (3 replace) · ← 4 · ✕ 2 · 5 skipped".
  const todo = plan ? plan.toRight.length + plan.toLeft.length + plan.deleteLeft.length + plan.deleteRight.length : 0;
  const summary =
    plan &&
    html`${plan.toRight.length > 0 && html`<span class="fcmp-sum to" title="Copied to the right">→ ${plan.toRight.length}${plan.replaceRight ? ` (${plan.replaceRight} replace)` : ''}</span>`}
    ${plan.toLeft.length > 0 && html`<span class="fcmp-sum to" title="Copied to the left">← ${plan.toLeft.length}${plan.replaceLeft ? ` (${plan.replaceLeft} replace)` : ''}</span>`}
    ${plan.deleteLeft.length + plan.deleteRight.length > 0 && html`<span class="fcmp-sum del" title=${`Deleted: ${plan.deleteLeft.length} on the left, ${plan.deleteRight.length} on the right`}>✕ ${plan.deleteLeft.length + plan.deleteRight.length}</span>`}
    ${plan.skipped > 0 && html`<span class="fcmp-sum skip">${plan.skipped} skipped</span>`}
    ${!todo && !plan.skipped && html`<span class="muted small">Nothing differs.</span>`}`;

  const startSplit = useRef(split);
  return html`<div class="fcmp ${phone ? 'phone' : ''} ${sync ? 'syncing' : ''}" role="region" aria-label="Folders compared" style=${{ '--fcmp-split': `${(split * 100).toFixed(1)}%` }} ref=${body}>
    <div class="ccmp-bar fcmp-bar">
      <${SaveStar} id=${id} record=${record} actions=${actions} />
      <${SidewaysButton} />
      <button type="button" class="icon-btn sm" aria-label="Two panes" title="Two panes: browse both folders side by side and copy or move files between them"
        onClick=${() => leaveFile() && (actions.compareDirty(id, false), actions.updateCompare(id, { mode: 'panes' }))}><${Icon} name="panes" size=${16} /></button>
      <select class="fcmp-show" aria-label="Show" value=${show} onChange=${(e) => actions.updateCompare(id, { show: e.currentTarget.value })}>
        ${SHOW.map((s) => html`<option value=${s}>${SHOW_LABELS[s]}</option>`)}
      </select>
      <span class="fcmp-chips" aria-live="polite">
        ${scanning
          ? html`<span class="fcmp-busy muted small"><span class="spinner" aria-hidden="true" />Reading both folders…</span>`
          : scan?.error
            ? ''
            : total === 0 && !checking
              ? html`<span class="muted small">The same on both sides</span>`
              : html`${chip('changed', counts.changed + counts.kind)}${chip('left', counts.left)}${chip('right', counts.right)}${chip('unsure', counts.unsure)}`}
        ${checking && html`<span class="fcmp-busy muted small"><span class="spinner" aria-hidden="true" />Checking contents… ${checking.done} of ${checking.total}</span>`}
      </span>
      <span class="fcmp-break" />
      <button type="button" class="icon-btn sm" aria-label="Previous difference" title="Previous difference (Alt+↑)" disabled=${!total} onClick=${() => go(-1)}><${Icon} name="chevronDown" size=${16} class="up" /></button>
      <button type="button" class="icon-btn sm" aria-label="Next difference" title="Next difference (Alt+↓)" disabled=${!total} onClick=${() => go(1)}><${Icon} name="chevronDown" size=${16} /></button>
      <span class="ccmp-gap" />
      ${!sync &&
      html`<button type="button" class="btn ghost sm" disabled=${!picked.length || Boolean(busy)} title="Copy what is picked to the right" onClick=${() => copy('left')}><span class="label">Copy</span><${Icon} name="arrowRight" size=${14} /></button>
        <button type="button" class="btn ghost sm" disabled=${!picked.length || Boolean(busy)} title="Copy what is picked to the left" onClick=${() => copy('right')}><${Icon} name="arrowLeft" size=${14} /><span class="label">Copy</span></button>`}
      <button type="button" class="btn ${sync ? '' : 'ghost'} sm fcmp-sync-btn" aria-pressed=${Boolean(sync)} disabled=${!sync && (!entries.size || Boolean(busy))}
        title=${sync ? 'Leave syncing (the choices are forgotten)' : 'Sync: pick for each difference which way it goes (or that it stays), then apply them all at once'}
        onClick=${() => (sync ? setSync(null) : startSync())}><${Icon} name="replace" size=${14} /><span class="label">Sync…</span></button>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Read both folders again" title="Read both folders again" disabled=${scanning} onClick=${() => setTick((t) => t + 1)}><${Icon} name="sync" size=${15} /></button>
      <${MenuButton} label="More" items=${moreItems} />
    </div>
    ${sync &&
    html`<div class="fcmp-syncbar" role="toolbar" aria-label="Sync">
      <${PresetButton} preset=${sync.preset} changed=${sync.overrides.size > 0} onPick=${(p) => setSync({ preset: p, overrides: new Map() })} />
      <span class="fcmp-sums" aria-live="polite" title="Click ← – → between the sides of a row (with several rows picked: all of them), or Alt+← / Alt+- / Alt+→, Alt+Delete for what is on one side only">${summary}</span>
      <span class="spacer" />
      <button type="button" class="btn ghost sm" onClick=${() => setSync(null)}>Cancel</button>
      <button type="button" class="btn primary sm" disabled=${!todo || Boolean(busy)} onClick=${() => setConfirming(plan)}>${busy === 'sync' ? 'Syncing…' : 'Apply…'}</button>
    </div>`}
    <div class="fcmp-heads">${head('left')}${!phone && html`<div class="fcmp-mark" />`}${head('right')}</div>
    ${note && html`<p class="notice ${note.error ? 'error' : ''} fcmp-note" role="status"><${Icon} name=${note.error ? 'alert' : 'info'} size=${15} /><span>${note.text}</span>
      <button type="button" class="icon-btn xs" aria-label="Close" onClick=${() => setNote(null)}><${Icon} name="x" size=${13} /></button></p>`}
    ${scan?.error && html`<p class="notice error fcmp-note" role="alert"><${Icon} name="alert" size=${15} /><span>${scan.error}</span></p>`}
    <div class="fcmp-tree" role="tree" aria-label="Both folders" aria-multiselectable="true" tabindex="0" ref=${tree} onKeyDown=${keyDown} aria-busy=${scanning || Boolean(checking)}>
      ${!scan && scanning && html`<p class="fcmp-loading" role="status"><span class="spinner" aria-hidden="true" />Reading both folders…</p>`}
      ${hide && html`<p class="fcmp-loading" role="status"><span class="spinner" aria-hidden="true" />Checking ${many(hide.size, 'file')} with the same size and another date…</p>`}
      ${rows.map(row)}
      ${!scanning && scan && !scan.error && !rows.length && !hide && html`<p class="muted small fcmp-empty">${show === 'diff' ? 'No differences: everything is the same on both sides.' : 'Nothing to show here.'}</p>`}
    </div>
    <${Splitter} orientation="horizontal" label="Resize the file comparison" className="fcmp-splitter"
      onStart=${() => (startSplit.current = split)}
      onMove=${(d) => setSplit(Math.min(0.85, Math.max(0.15, startSplit.current + d / Math.max(1, body.current?.clientHeight ?? 1))))}
      onEnd=${() => saveSettings({ compareSplit: Number(split.toFixed(3)) })}
      onReset=${() => (setSplit(0.45), saveSettings({ compareSplit: 0 }))} />
    <div class="fcmp-file">
      ${!current
        ? html`<p class="muted small fcmp-hint">Pick a file to compare it here. Double-click opens it in a tab of its own.</p>`
        : current.dir || current.state === 'kind'
          ? html`<p class="muted small fcmp-hint">${current.state === 'kind' ? STATE_LABELS.kind : `${current.name}: ${STATE_LABELS[current.state]}`}. Pick a file inside to compare it.</p>`
          : current.left && current.right
            ? html`<${FileCompare} key=${current.rel} left=${fileSide('left')} right=${fileSide('right')} settings=${settings} actions=${actions} names=${lowerNames} onSaved=${() => setTick((t) => t + 1)}
                onDirty=${(d) => ((lowerDirty.current = d.left || d.right), actions.compareDirty(id, lowerDirty.current))} />`
            : html`<${OneSide} key=${current.rel} side=${current.left ? 'left' : 'right'} file=${fileSide(current.left ? 'left' : 'right')} name=${current.name} actions=${actions} settings=${settings}
                onCopy=${() => (setSelected(new Set([current.rel])), copy(current.left ? 'left' : 'right'))} />`}
    </div>
    ${confirming && html`<${SyncConfirm} plan=${confirming} record=${record} entries=${entries} onRun=${runSync} onClose=${() => setConfirming(null)} />`}
  </div>`;
}

/**
 * A row's choice while syncing: ← · – · → (on one side only: copy it to the other side, or
 * ✕ delete it where it is). `value` is 'right', 'left', 'skip' or 'mixed' (a folder whose
 * insides go both ways); `one` the side the row is only on; `folder` a folder on both sides
 * (its choice goes to everything inside it). On a phone: one button with the choice, a tap
 * opens the three.
 */
function ChoiceControl({ rel, name, value, one, folder, phone, onChoose }) {
  const [at, setAt] = useState(null);
  const owner = useRef(null);
  // [what it sets, the value it shows as pressed, its mark, its words]
  const ways = [
    one === 'left'
      ? ['delete', 'left', '✕', `Delete ${name} on the left`]
      : ['left', 'left', '←', folder ? `What differs in ${name}: to the left` : one ? `Copy ${name} to the left` : `Copy the right ${name} to the left (it replaces the left one)`],
    ['skip', 'skip', '–', folder ? `Skip what differs in ${name}` : `Skip ${name}: leave it as it is`],
    one === 'right'
      ? ['delete', 'right', '✕', `Delete ${name} on the right`]
      : ['right', 'right', '→', folder ? `What differs in ${name}: to the right` : one ? `Copy ${name} to the right` : `Copy the left ${name} to the right (it replaces the right one)`],
  ];
  const stop = (ev) => ev.stopPropagation();
  if (phone) {
    const now = ways.find((w) => w[1] === value);
    return html`<div class="fcmp-mark fcmp-choice one" onClick=${stop} onDblClick=${stop}>
      <button type="button" ref=${owner} class="fcmp-choice-btn way-${value} ${now?.[0] === 'delete' ? 'del' : ''}" aria-haspopup="menu" aria-expanded=${Boolean(at)}
        title=${now ? now[3] : 'Mixed: some to the left, some to the right'} aria-label=${`What happens to ${name}: ${now ? now[3] : 'mixed'}`}
        onClick=${(ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.right, y: r.bottom + 4, right: true });
        }}>${now ? now[2] : '⋯'}</button>
      ${at && html`<${Menu} at=${at} owner=${owner} label=${`What happens to ${name}`} onClose=${() => setAt(null)}
        items=${ways.map((w) => ({ key: `${w[0]}:${w[1]}`, label: w[3], checked: value === w[1], danger: w[0] === 'delete', run: () => onChoose(rel, w[0]) }))} />`}
    </div>`;
  }
  return html`<div class="fcmp-mark fcmp-choice ${value === 'mixed' ? 'mixed' : ''}" role="group" aria-label=${`What happens to ${name}`} title=${value === 'mixed' ? 'Mixed: some go to the left, some to the right' : undefined} onDblClick=${stop}>
    ${ways.map(
      (w) => html`<button type="button" key=${`${w[0]}:${w[1]}`} class="fcmp-way ${w[0] === 'delete' ? 'del' : w[0] === 'skip' ? 'skip' : 'go'} ${value === w[1] ? 'on' : ''}" tabindex="-1" aria-pressed=${value === w[1]} title=${w[3]} aria-label=${w[3]}
        onClick=${(ev) => (stop(ev), onChoose(rel, w[0]))}>${w[2]}</button>`,
    )}
  </div>`;
}

/** The preset menu of the sync bar: fills in every choice at once (the person's own go). */
function PresetButton({ preset, changed, onPick }) {
  const [at, setAt] = useState(null);
  const owner = useRef(null);
  return html`<button type="button" ref=${owner} class="btn sm fcmp-preset" aria-haspopup="menu" aria-expanded=${Boolean(at)} title=${`${PRESET_HINTS[preset]}${changed ? ' (then changed by you)' : ''}. Click to fill in every choice another way.`}
      onClick=${(ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        setAt(at ? null : { x: r.left, y: r.bottom + 4 });
      }}>
      <span class="label">${PRESET_LABELS[preset]}</span>${changed && html`<span class="fcmp-preset-own">· your choices</span>`}<${Icon} name="chevronDown" size=${12} />
    </button>
    ${at && html`<${Menu} at=${at} owner=${owner} label="Fill in every choice" onClose=${() => setAt(null)}
      items=${SYNC_PRESETS.map((p) => ({ key: p, label: PRESET_LABELS[p], checked: p === preset && !changed, danger: p.startsWith('mirror-'), run: () => onPick(p) }))} />`}`;
}

/** A file only on one side: its text, with a copy to the other side. */
function OneSide({ side, file, name, actions, settings, onCopy }) {
  const [text, setText] = useState(null);
  useEffect(() => {
    actions.readCompareSide(file).then((s) => setText(s.text), (err) => setText({ error: message(err) }));
  }, [file.key]);
  const other = side === 'left' ? 'right' : 'left';
  return html`<div class="ccmp one-side">
    <div class="ccmp-bar">
      <span class="ccmp-name">${name}</span><span class="muted small">only on the ${side}</span>
      <span class="spacer" />
      <button type="button" class="btn sm" onClick=${onCopy}>${side === 'left' ? html`<span class="label">Copy to the right</span><${Icon} name="arrowRight" size=${14} />` : html`<${Icon} name="arrowLeft" size=${14} /><span class="label">Copy to the left</span>`}</button>
      <button type="button" class="btn ghost sm" onClick=${() => actions.openCompareSide(file)}><${Icon} name="file" size=${14} /><span class="label">Open</span></button>
    </div>
    ${text?.error ? html`<p class="notice error ccmp-note"><${Icon} name="alert" size=${15} /><span>${text.error}</span></p>` : html`<pre class="ccmp-plain ${settings.wordWrap ? 'wrap' : ''}" aria-label=${`${name}, not on the ${other}`}>${text ?? 'Reading…'}</pre>`}
  </div>`;
}

// What a copy replaces, or a sync deletes, is gone for good on a server and on a phone (the
// Android app has no Recycle Bin); here it goes to the Recycle Bin (the Trash).
const forGoodOn = (path) => (isRemotePath(path) ? 'a server' : isAndroidApp() ? 'the phone' : '');

/** Before a sync runs: what is copied each way (and what that replaces), what is deleted where. */
function SyncConfirm({ plan, record, entries, onRun, onClose }) {
  const list = (rels) => html`<ul class="fcmp-plan">${rels.slice(0, 200).map((r) => html`<li key=${r}><${Icon} name=${entries.get(r)?.dir ? 'folder' : 'file'} size=${13} /><span>${r}</span></li>`)}${rels.length > 200 && html`<li class="muted">…and ${rels.length - 200} more</li>`}</ul>`;
  const old = (side) => (forGoodOn(record[side].path) ? `deleted for good (on ${forGoodOn(record[side].path)})` : `moved to ${binName()}`);
  const copies = plan.toRight.length + plan.toLeft.length;
  const deletes = plan.deleteLeft.length + plan.deleteRight.length;
  const label = [copies && `Copy ${copies}`, deletes && `${copies ? 'delete' : 'Delete'} ${deletes}`].filter(Boolean).join(' and ');
  const copied = (to, rels, replaced) =>
    rels.length > 0 &&
    html`<p><strong>${to === 'right' ? '→' : '←'} ${many(rels.length, 'item')} copied to the ${to}</strong>${replaced ? `: ${replaced} of them replace${replaced === 1 ? 's' : ''} what is there (the old ${replaced === 1 ? 'one is' : 'ones are'} ${old(to)})` : ''}.</p>${list(rels)}`;
  const removed = (side, rels) => rels.length > 0 && html`<p class="fcmp-del-note"><strong>✕ ${many(rels.length, 'item')} deleted on the ${side}</strong> (${old(side)}).</p>${list(rels)}`;
  return html`<${Modal} title="Sync the two folders" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn ${deletes ? 'danger-solid' : 'primary'}" onClick=${() => onRun(plan)}>${label}</button>`}>
    ${copied('right', plan.toRight, plan.replaceRight)}
    ${copied('left', plan.toLeft, plan.replaceLeft)}
    ${removed('left', plan.deleteLeft)}
    ${removed('right', plan.deleteRight)}
    ${plan.skipped > 0 && html`<p class="muted small">${many(plan.skipped, 'difference')} left as ${plan.skipped === 1 ? 'it is' : 'they are'}.</p>`}
  </${Modal}>`;
}

/** A comparison in its tab: two files or two folders. */
export function CompareTab({ id, record, settings, actions }) {
  if (!record) return null;
  // A repository's or a file's Git history (ui/gitHistory.js).
  if (record.mode === 'history') return html`<${GitHistoryTab} key=${`${id}:history`} id=${id} record=${record} settings=${settings} actions=${actions} />`;
  if (record.mode === 'panes')
    return html`<${PanesTab} key=${`${id}:panes`} id=${id} record=${record} settings=${settings} actions=${actions} star=${html`<${SaveStar} id=${id} record=${record} actions=${actions} />`} />`;
  return record.mode === 'folders'
    ? html`<${FoldersTab} key=${`${id}:${record.left.path}:${record.right.path}`} id=${id} record=${record} settings=${settings} actions=${actions} />`
    : html`<${FilesTab} id=${id} record=${record} settings=${settings} actions=${actions} />`;
}
