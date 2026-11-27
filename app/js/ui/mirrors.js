import { html, useEffect, useReducer, useState } from '../../vendor/preact-htm.js';
import { lastSyncText, mirror as mirrorById, mirrors, onMirrors, refreshMirrors } from '../mirrors.js';
import { formatBytes, timeAgo } from '../format.js';
import { server, servers } from '../servers.js';
import { remoteParts, toRemoteUri } from '../where.js';
import { getSettings, saveSettings } from '../settings.js';
import { opensInEditor } from '../folders.js';
import { atRisk, checkSentence, leftText, noteOf, stateWords, tickedAtFirst, TIME_SLACK, transferable } from '../mirrorCheck.js';
import { dismissMirrorNote, mirrorNoteFor, onMirrorNotes, sidePath } from '../mirrorFlow.js';
import { Check, Field, Modal, Segmented, toast } from './components.js';
import { Icon } from './icons.js';
import { MenuButton } from './menu.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const DEFAULT_EXCLUDE = '.git, node_modules, .DS_Store, Thumbs.db, desktop.ini, ~$*, *.tmp, *.swp';
const MODES = [
  { id: 'both', label: 'Both ways' },
  { id: 'download', label: 'Server → here' },
  { id: 'upload', label: 'Here → server' },
];
const MODE_HINTS = {
  both: 'Changes on either side go to the other. Changed on both: both are kept.',
  download: 'The server’s changes come here; yours are not sent (the server wins).',
  upload: 'Your changes go to the server; the server’s do not come here.',
};
// Mirrors by hand (0.54): when the two folders are kept the same.
const WHEN = [
  { id: 'hand', label: 'By hand' },
  { id: 'auto', label: 'Sync by itself' },
];
const WHEN_HINTS = {
  hand: 'Upload, download and sync when you ask: right-click files or folders inside it (here or on the server), or use the bar over them in Folders. Each is checked first, and can be undone.',
  auto: 'While the server is connected: every minute, and a moment after you change something here.',
};
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const many = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
/** A file's time: the time today, the day and time this year, the date before. */
const shortWhen = (ms) => {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
const nameOf = (m) => server(m?.conn)?.name ?? 'the server';

/** Rerenders on mirror status changes. */
function useMirrors() {
  const [, rerender] = useReducer((x) => x + 1, 0);
  useEffect(() => onMirrors(rerender), []);
  return mirrors();
}

/** A mirror's state in a few words: syncing 3 of 10, synced 2 minutes ago, needs you, failed. */
export function mirrorState(m) {
  if (m.state === 'syncing') return { tone: 'busy', text: m.progress?.total ? `Syncing… ${m.progress.done} of ${m.progress.total}` : 'Syncing…' };
  if (m.state === 'waiting') return { tone: 'warn', text: `${m.waiting.length} deleted here: delete on the server too?` };
  if (m.state === 'error') return { tone: 'error', text: m.error || 'The last sync failed.' };
  if (m.last) return { tone: 'ok', text: `Synced ${timeAgo(new Date(m.last.at).toISOString())}` };
  if (m.auto === false) return { tone: 'pending', text: 'By hand' };
  return { tone: 'pending', text: 'Not synced yet' };
}

/** The server's folders, to pick the one to mirror (listed as they are opened). */
function RemoteFolderPicker({ conn, start, onPick }) {
  const [at, setAt] = useState(start || '/');
  const [list, setList] = useState(null); // { entries } | { error }
  useEffect(() => {
    let stale = false;
    setList(null);
    window.desktop.folders.list(toRemoteUri(conn, at)).then(
      (l) => !stale && setList({ entries: l.entries.filter((e) => e.dir) }),
      (err) => !stale && setList({ error: message(err) }),
    );
    return () => {
      stale = true;
    };
  }, [conn, at]);
  const up = at === '/' ? null : at.replace(/\/[^/]+\/?$/, '') || '/';
  return html`<div class="mirror-browse" role="group" aria-label="Folders on the server">
    <div class="mirror-browse-head">
      <code title=${at}>${at}</code>
      <span class="spacer" />
      <button type="button" class="btn sm primary" onClick=${() => onPick(at)}>Use this folder</button>
    </div>
    <ul class="mirror-browse-list" role="list">
      ${up !== null && html`<li><button type="button" onClick=${() => setAt(up)}><${Icon} name="arrowUp" size=${14} />Up one folder</button></li>`}
      ${!list
        ? html`<li class="muted small">Listing…</li>`
        : list.error
          ? html`<li class="error-text small">${list.error}</li>`
          : !list.entries.length
            ? html`<li class="muted small">No folders inside</li>`
            : list.entries.map(
                (e) => html`<li key=${e.path}><button type="button" title="Open (double-click: use it)" onClick=${() => setAt(remoteParts(e.path).path)} onDblClick=${() => onPick(remoteParts(e.path).path)}><${Icon} name="folder" size=${14} />${e.name}</button></li>`,
              )}
    </ul>
  </div>`;
}

/**
 * Sets up (or changes) a mirror: a server folder and a folder here kept the same. From a folder
 * here (Mirror on a server…, `draft.local`) a new one is kept by hand at first.
 */
export function MirrorDialog({ draft = {}, actions, onClose }) {
  const editing = Boolean(draft.id);
  const fromHere = !editing && Boolean(draft.local);
  const [form, setForm] = useState(() => ({ mode: 'both', auto: !fromHere, uploadOnSave: false, exclude: DEFAULT_EXCLUDE, remote: '/', local: '', ...draft }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const conn = server(form.conn);
  const choose = async () => {
    const picked = await window.desktop.mirrors.pickLocal(baseName(form.remote) || conn?.name || 'Server files');
    if (picked) set({ local: picked });
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await window.desktop.mirrors.save(form);
      await refreshMirrors();
      onClose();
      if (saved.auto) actions.syncMirror(saved.id);
      else if (!editing) {
        toast(`Mirrored on ${nameOf(saved)}: right-click files or folders inside ${baseName(saved.local)} to upload, download or compare them.`, {
          timeout: 12000,
          actions: [{ label: 'Sync…', run: () => actions.mirrorSyncTab?.(saved.local, { dir: true }) }],
        });
      }
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  const remove = async () => {
    await window.desktop.mirrors.delete(draft.id);
    await refreshMirrors();
    toast('The mirror is removed. Both folders stay as they are.');
    onClose();
  };
  const title = editing ? 'Mirror' : fromHere ? `Mirror ${baseName(form.local)} on a server` : 'Keep a server folder on this computer';
  return html`<${Modal} title=${title} wide className="mirror-dialog" onClose=${onClose}
    footer=${html`${editing && html`<button type="button" class="btn ghost danger" onClick=${remove}><${Icon} name="trash" size=${15} />Remove the mirror</button>`}
      <span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!form.conn || !form.local || busy} onClick=${save}>
        <${Icon} name=${form.auto ? 'sync' : 'check'} size=${15} />${form.auto ? 'Save and sync now' : 'Save'}
      </button>`}>
    <p class="muted small">${form.auto
      ? 'The two folders are kept the same: what changes in one goes to the other. Files deleted here go only after you say so; files deleted on the server go to the Recycle Bin here.'
      : 'Files go between the two folders when you ask: upload, download, compare with the other side, or sync a folder after looking at its differences. Before a file replaces a newer copy you are asked, and each upload or download can be undone.'}</p>
    <div class="field-grid">
      <${Field} label="Server">
        <select value=${form.conn ?? ''} onChange=${(e) => (set({ conn: e.currentTarget.value }), setBrowsing(false))}>
          <option value="" disabled>Choose a server</option>
          ${servers().map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
        </select>
      </${Field}>
      <div class="field"><span>Folder on the server</span>
        <div class="row-input">
          <input value=${form.remote} spellcheck="false" placeholder="/var/www/site" onInput=${(e) => set({ remote: e.currentTarget.value })} />
          <button type="button" class="btn sm" disabled=${!form.conn} aria-expanded=${browsing} onClick=${() => setBrowsing(!browsing)}>Browse…</button>
        </div>
      </div>
      ${browsing && form.conn && html`<div class="field span-2"><${RemoteFolderPicker} conn=${form.conn} start=${form.remote && form.remote !== '/' ? form.remote : conn?.path || '/'} onPick=${(p) => (set({ remote: p }), setBrowsing(false))} /></div>`}
      <div class="field span-2"><span>Folder on this computer</span>
        <div class="row-input">
          <input value=${form.local} readonly placeholder="Choose or make a folder" title=${form.local} />
          <button type="button" class="btn sm" onClick=${choose}>Choose…</button>
        </div>
      </div>
      <div class="field span-2"><span>When</span>
        <${Segmented} options=${WHEN} value=${form.auto ? 'auto' : 'hand'} label="When" onChange=${(w) => set({ auto: w === 'auto' })} />
        <small class="muted">${WHEN_HINTS[form.auto ? 'auto' : 'hand']}</small>
      </div>
      ${form.auto &&
      html`<div class="field span-2"><span>Direction</span>
        <${Segmented} options=${MODES} value=${form.mode} label="Direction" onChange=${(mode) => set({ mode })} />
        <small class="muted">${MODE_HINTS[form.mode]}</small>
      </div>`}
      <${Field} label="Leave out" hint="Names or patterns, separated by commas" wide>
        <input value=${form.exclude} spellcheck="false" onInput=${(e) => set({ exclude: e.currentTarget.value })} />
      </${Field}>
      <${Check} checked=${Boolean(form.uploadOnSave)} label="Upload when I save a file here" hint="A file saved in the editor goes to the server at once, unless the server’s copy changed since they were last the same (then you are asked)."
        onChange=${(uploadOnSave) => set({ uploadOnSave })} />
    </div>
    ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
  </${Modal}>`;
}

/** Deleted here while mirrored: delete on the server too, or bring them back from it. */
export function MirrorDeletesDialog({ mirror: m, actions, onClose }) {
  const names = m.waiting.slice(0, 12);
  const run = async (opts) => {
    onClose();
    await actions.syncMirror(m.id, opts);
  };
  return html`<${Modal} title="Deleted on this computer" className="mirror-deletes" onClose=${onClose}
    footer=${html`<span class="spacer" />
      <button type="button" class="btn" onClick=${() => run({ restore: m.waiting })}><${Icon} name="download" size=${15} />Bring them back here</button>
      <button type="button" class="btn primary danger" onClick=${() => run({ confirmDeletes: m.waiting })}><${Icon} name="trash" size=${15} />Delete on the server</button>`}>
    <p>${m.waiting.length === 1 ? 'This file was' : `These ${m.waiting.length} files were`} deleted in <strong>${m.local}</strong>. Delete ${m.waiting.length === 1 ? 'it' : 'them'} on <strong>${server(m.conn)?.name ?? 'the server'}</strong> too?</p>
    <ul class="delete-list">${names.map((n) => html`<li key=${n}>${n}</li>`)}${m.waiting.length > names.length && html`<li class="muted">and ${m.waiting.length - names.length} more</li>`}</ul>
    <p class="muted small">Files deleted on a server cannot be brought back from here. Until you choose, they stay on the server.</p>
  </${Modal}>`;
}

/** Every mirror, with its state and what can be done with it. */
export function MirrorsDialog({ actions, onClose }) {
  const list = useMirrors();
  const [always, setAlways] = useState(() => getSettings().mirrorConfirm === 'always');
  return html`<${Modal} title="Mirrors" wide className="mirrors-dialog" onClose=${onClose}
    footer=${html`<button type="button" class="btn ghost" onClick=${() => (onClose(), actions.mirrorHistory?.(null))}><${Icon} name="history" size=${15} />Upload and download history</button><span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    ${!list.length && html`<p class="muted">No mirrors yet. In Folders, right-click a folder here → “Mirror on a server…”, or a folder on a server → “Keep on this computer (mirror)…”.</p>`}
    <ul class="mirror-list" role="list">
      ${list.map((m) => {
        const st = mirrorState(m);
        return html`<li key=${m.id} class="mirror-item">
          <div class="mirror-pair">
            <span class="kind-remote"><${Icon} name="server" size=${14} />${server(m.conn)?.name ?? 'Server'}: ${m.remote}</span>
            <span class="mirror-arrow" title=${m.auto === false ? 'By hand' : MODES.find((x) => x.id === m.mode)?.label}>${m.auto === false ? '⇅' : m.mode === 'download' ? '→' : m.mode === 'upload' ? '←' : '⇄'}</span>
            <span class="kind-disk"><${Icon} name="disk" size=${14} />${m.local}</span>
          </div>
          <div class="mirror-meta">
            <span class="mirror-state tone-${st.tone}">${st.text}</span>
            ${m.last && lastSyncText(m.last) && html`<span class="muted small">Last: ${lastSyncText(m.last)}</span>`}
            <span class="muted small">${m.auto ? '· automatic' : ''}${m.uploadOnSave ? '· uploads what you save here' : ''}</span>
          </div>
          <div class="mirror-actions">
            ${m.state === 'waiting' && html`<button type="button" class="btn sm primary" onClick=${() => actions.reviewMirror(m.id)}>Review</button>`}
            ${m.auto
              ? html`<button type="button" class="btn sm" disabled=${m.state === 'syncing'} onClick=${() => actions.syncMirror(m.id)}><${Icon} name="sync" size=${14} />Sync now</button>`
              : html`<button type="button" class="btn sm" onClick=${() => (onClose(), actions.mirrorSyncTab(m.local, { dir: true }))}><${Icon} name="sync" size=${14} />Sync…</button>`}
            <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.mirrorHistory(m.id))}><${Icon} name="history" size=${14} />History</button>
            <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.showFolder(m.local))}><${Icon} name="folder" size=${14} />Here</button>
            <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.showFolder(toRemoteUri(m.conn, m.remote)))}><${Icon} name="server" size=${14} />On the server</button>
            <button type="button" class="btn ghost sm" onClick=${() => actions.editMirror(m)}><${Icon} name="edit" size=${14} />Edit</button>
          </div>
        </li>`;
      })}
    </ul>
    ${list.length > 0 &&
    html`<${Check} checked=${always} label="Ask before every upload and download" hint="Otherwise only when a file would replace a newer copy, or one changed since the two were last the same."
      onChange=${(on) => (setAlways(on), saveSettings({ mirrorConfirm: on ? 'always' : 'risky' }))} />`}
  </${Modal}>`;
}

/** Over the list in Folders, inside a mirrored folder: what it is kept the same as, how it stands, and Upload / Download / Sync. */
export function MirrorBar({ found, actions }) {
  useMirrors();
  const m = mirrors().find((x) => x.id === found.mirror.id) ?? found.mirror;
  const st = mirrorState(m);
  const other = found.side === 'local' ? `${server(m.conn)?.name ?? 'Server'}: ${m.remote}` : m.local;
  const here = found.side === 'local';
  const path = sidePath(m, found.side, found.rel);
  const byHand = Boolean(actions.mirrorItems);
  return html`<div class="mirror-bar tone-${st.tone}" role="status">
    <span class="mirror-arrow" aria-hidden="true">${m.auto === false ? '⇅' : m.mode === 'download' ? (here ? '←' : '→') : m.mode === 'upload' ? (here ? '→' : '←') : '⇄'}</span>
    <span class="mirror-bar-text" title=${`Kept the same as ${other}`}>
      ${here ? html`<span>Mirror of <strong>${server(m.conn)?.name ?? 'the server'}</strong> ${m.remote}</span>` : html`<span>Mirrored here as <strong>${baseName(m.local)}</strong></span>`}
      <span class="muted small">${st.text}</span>
    </span>
    ${m.state === 'waiting'
      ? html`<button type="button" class="btn sm primary" onClick=${() => actions.reviewMirror(m.id)}>Review</button>`
      : m.auto !== false && html`<button type="button" class="icon-btn sm" aria-label="Sync now" title="Sync now" disabled=${m.state === 'syncing'} onClick=${() => actions.syncMirror(m.id)}><${Icon} name="sync" size=${15} /></button>`}
    ${byHand &&
    html`<button type="button" class="icon-btn sm" aria-label=${here ? `Upload this folder to ${nameOf(m)}` : 'Download this folder to this computer'} title=${here ? `Upload this folder to ${nameOf(m)} (checked first)` : 'Download this folder to this computer (checked first)'}
        onClick=${() => (here ? actions.mirrorUpload([path]) : actions.mirrorDownload([path]))}><${Icon} name=${here ? 'upload' : 'download'} size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label=${here ? `Download this folder from ${nameOf(m)}` : 'Upload this folder from this computer'} title=${here ? `Download this folder from ${nameOf(m)} (checked first)` : 'Upload this folder from this computer (checked first)'}
        onClick=${() => (here ? actions.mirrorDownload([path]) : actions.mirrorUpload([path]))}><${Icon} name=${here ? 'download' : 'upload'} size=${15} /></button>
      <${MenuButton} label="More about the mirror" items=${() => [...actions.mirrorItems([path], { dir: true }).slice(2), { separator: true }, { label: 'Mirror settings…', icon: 'settings', run: () => actions.editMirror(m) }]} />`}
    ${!byHand && html`<button type="button" class="icon-btn sm" aria-label="Mirror settings" title="Mirror settings" onClick=${() => actions.editMirror(m)}><${Icon} name="settings" size=${15} /></button>`}
  </div>`;
}

const sideText = (st) => (st ? `${shortWhen(st.mtimeMs)} · ${formatBytes(st.size)}` : 'not there');
const itemOf = (direction) => (r) => ({ rel: r.rel, expect: (direction === 'upload' ? r.there : r.here) ?? null, size: (direction === 'upload' ? r.here : r.there)?.size ?? 0 });
const ROWS_SHOWN = 300;

/**
 * Before an upload or a download where something is at risk (or always, by the setting): what
 * differs, which side is newer, each file to tick (the risky ones not ticked), Compare.
 */
export function TransferDialog({ mirror: m, check, direction, ticked: tickedBefore = null, actions, onClose }) {
  const name = nameOf(m);
  const up = direction === 'upload';
  const going = check.files.filter((r) => transferable(r.state));
  const risky = going.filter((r) => atRisk(r.state));
  const safe = going.filter((r) => !atRisk(r.state));
  const [ticked, setTicked] = useState(() => new Set(tickedBefore ?? going.filter(tickedAtFirst).map((r) => r.rel)));
  const [showSafe, setShowSafe] = useState(!risky.length || safe.length <= 8);
  const [always, setAlways] = useState(() => getSettings().mirrorConfirm === 'always');
  const toggle = (rel, on) =>
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(rel);
      else next.delete(rel);
      return next;
    });
  const setAll = (rows, on) =>
    setTicked((t) => {
      const next = new Set(t);
      for (const r of rows) on ? next.add(r.rel) : next.delete(r.rel);
      return next;
    });
  const chosen = going.filter((r) => ticked.has(r.rel));
  const unkept = chosen.filter((r) => ((up ? r.there : r.here)?.size ?? 0) > 100 * 1024 * 1024);
  const go = () => {
    onClose();
    actions.mirrorRun(m.id, chosen.map(itemOf(direction)), direction);
  };
  // Compared in a tab (under this dialog otherwise): the dialog comes back from the toast, as it was.
  const compareRow = (r) => {
    onClose();
    actions.mirrorCompare(sidePath(m, 'local', r.rel));
    toast(`${baseName(r.rel)}: this computer’s on the left, ${name}’s on the right.`, {
      key: 'mirror-back',
      timeout: 120000,
      action: { label: up ? 'Back to the upload' : 'Back to the download', run: () => actions.mirrorAsk({ mirrorId: m.id, check, direction, ticked: [...ticked] }) },
    });
  };
  const newerSide = (r) => (r.here && r.there && Math.abs(r.here.mtimeMs - r.there.mtimeMs) > TIME_SLACK ? (r.here.mtimeMs > r.there.mtimeMs ? 'here' : 'there') : '');
  const row = (r) => {
    const newer = newerSide(r);
    return html`<li key=${r.rel} class="mt-row ${atRisk(r.state) ? 'risky' : ''}">
      <label class="mt-pick">
        <input type="checkbox" checked=${ticked.has(r.rel)} onChange=${(e) => toggle(r.rel, e.currentTarget.checked)} />
        <span class="mt-name" title=${r.rel}>${r.rel}</span>
      </label>
      <span class="mt-state">${stateWords(r.state, direction, name)}</span>
      <span class="mt-sides">
        <span class=${newer === 'here' ? 'newer' : ''}>Here: ${sideText(r.here)}</span>
        <span class=${newer === 'there' ? 'newer' : ''}>${name}: ${sideText(r.there)}${r.approx ? ' (to the minute)' : ''}</span>
      </span>
      ${r.here && r.there && opensInEditor(r.rel) && html`<button type="button" class="btn ghost sm mt-compare" onClick=${() => compareRow(r)}><${Icon} name="compare" size=${14} />Compare</button>`}
    </li>`;
  };
  const section = (title, rows, hint) => html`<section class="mt-section">
    <div class="mt-head">
      <strong>${title}</strong>
      ${hint && html`<span class="muted small">${hint}</span>`}
      <span class="spacer" />
      <button type="button" class="btn link sm" onClick=${() => setAll(rows, true)}>Tick all</button>
      <button type="button" class="btn link sm" onClick=${() => setAll(rows, false)}>None</button>
    </div>
    <ul class="mt-list" role="list">${rows.slice(0, ROWS_SHOWN).map(row)}${rows.length > ROWS_SHOWN && html`<li class="muted small">and ${rows.length - ROWS_SHOWN} more (${rows.slice(ROWS_SHOWN).filter((r) => ticked.has(r.rel)).length} ticked)</li>`}</ul>
  </section>`;
  const left = leftText(check.counts, direction, name);
  return html`<${Modal} title=${up ? `Upload to ${name}?` : `Download from ${name}?`} wide className="mirror-transfer" onClose=${onClose}
    footer=${html`<span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!chosen.length} onClick=${go}><${Icon} name=${up ? 'upload' : 'download'} size=${15} />${up ? 'Upload' : 'Download'} ${chosen.length}</button>`}>
    <p class="mt-summary">${checkSentence(check.counts, direction, name)}.${left ? html` <span class="muted">${left}.</span>` : ''}</p>
    ${risky.length > 0 &&
    html`<p class="notice warn"><${Icon} name="alert" size=${15} /><span>${risky.length === 1 ? 'One file' : `${risky.length} files`} ${up ? `on ${name}` : 'here'} would be replaced by ${risky.length === 1 ? 'an older copy, or one that does not have its changes' : 'older copies, or ones without their changes'}. ${risky.length === 1 ? 'It is' : 'They are'} not ticked: compare first, then tick what should go.</span></p>`}
    ${risky.length > 0 && section('At risk', risky, `changed ${up ? `on ${name}` : 'here'}, or newer there`)}
    ${safe.length > 0 &&
    (showSafe
      ? section(risky.length ? 'Safe' : 'To copy', safe, `newer ${up ? 'here' : `on ${name}`}, or only ${up ? 'here' : `on ${name}`}`)
      : html`<p class="mt-more"><button type="button" class="btn link" onClick=${() => setShowSafe(true)}>${many(safe.length, 'safe file')} (ticked): show them</button></p>`)}
    ${check.more && html`<p class="muted small">The first 5,000 differences are listed; the rest are not copied this time.</p>`}
    ${check.left?.length > 0 && html`<p class="muted small">Left alone: ${check.left.slice(0, 3).map((l) => `${l.rel || baseName(m.local)} (${l.why})`).join(', ')}${check.left.length > 3 ? ` and ${check.left.length - 3} more` : ''}.</p>`}
    ${unkept.length > 0 && html`<p class="notice"><${Icon} name="info" size=${15} /><span>Undo cannot bring back what ${unkept.length === 1 ? 'one file' : `${unkept.length} files`} over 100 MB replace${unkept.length === 1 ? 's' : ''}: ${up ? 'the old versions on the server are not kept' : 'the old versions here go to the Recycle Bin'}.</span></p>`}
    <p class="muted small">The files they replace are kept for Undo (Upload and download history).</p>
    <${Check} checked=${always} label="Ask before every upload and download" hint="Otherwise only when something is at risk, as here."
      onChange=${(on) => (setAlways(on), saveSettings({ mirrorConfirm: on ? 'always' : 'risky' }))} />
  </${Modal}>`;
}

/** The uploads and downloads made by hand, newest first: their files, Undo, and Compare with the version they replaced. */
export function MirrorHistoryDialog({ id = null, actions, onClose }) {
  const [list, setList] = useState(null); // entries | { error }
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  useMirrors();
  const load = () =>
    window.desktop.mirrors.history(id).then(
      (entries) => (setList(entries), entries[0] && setOpen((o) => (o.size ? o : new Set([entries[0].id])))),
      (err) => setList({ error: message(err) }),
    );
  useEffect(() => {
    load();
  }, [id]);
  const m = id ? mirrorById(id) : null;
  const toggle = (eid) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(eid)) next.delete(eid);
      else next.add(eid);
      return next;
    });
  const undo = async (e) => {
    setBusy(e.id);
    await actions.mirrorUndo([e.id]);
    setBusy('');
    load();
  };
  const entries = Array.isArray(list) ? list : [];
  return html`<${Modal} title=${m ? `Upload and download history: ${baseName(m.local)}` : 'Upload and download history'} wide className="mirror-history" onClose=${onClose}
    footer=${html`<span class="muted small">The last 200 (30 days); old versions up to 1 GB in all, each up to 100 MB.</span><span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    ${list === null && html`<p class="muted">Loading…</p>`}
    ${list?.error && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${list.error}</span></p>`}
    ${Array.isArray(list) && !entries.length && html`<p class="muted">Nothing uploaded or downloaded by hand yet. Right-click a file or folder inside a mirror → Upload or Download.</p>`}
    <ul class="mh-list" role="list">
      ${entries.map((e) => {
        const em = mirrorById(e.mirror);
        const up = e.direction === 'upload';
        const where = em ? nameOf(em) : 'a server';
        return html`<li key=${e.id} class="mh-entry ${e.undone ? 'undone' : ''}">
          <div class="mh-head">
            <button type="button" class="icon-btn sm" aria-expanded=${open.has(e.id)} aria-label=${open.has(e.id) ? 'Hide its files' : 'Show its files'} onClick=${() => toggle(e.id)}><${Icon} name=${open.has(e.id) ? 'chevronDown' : 'chevronRight'} size=${14} /></button>
            <span class="mh-arrow ${up ? 'up' : 'down'}" aria-hidden="true"><${Icon} name=${up ? 'upload' : 'download'} size=${15} /></span>
            <span class="mh-what">
              <span>${up ? 'Uploaded' : 'Downloaded'} ${e.files.length === 1 ? e.files[0].rel : many(e.files.length, 'file')} ${up ? 'to' : 'from'} ${where}</span>
              <span class="muted small" title=${new Date(e.at).toLocaleString()}>${timeAgo(new Date(e.at).toISOString())}${!id && em ? ` · ${baseName(em.local)}` : ''}${e.undone ? ` · undone${e.left.length ? ` (${many(e.left.length, 'file')} left as they were)` : ''}` : ''}</span>
            </span>
            ${!e.undone && em && html`<button type="button" class="btn sm" disabled=${busy === e.id} onClick=${() => undo(e)}><${Icon} name="undo" size=${14} />${busy === e.id ? 'Undoing…' : 'Undo'}</button>`}
          </div>
          ${open.has(e.id) &&
          html`<ul class="mh-files" role="list">
            ${e.files.slice(0, 200).map(
              (f) => html`<li key=${f.rel} class="mh-file">
                <span class="mh-name" title=${f.rel}>${f.rel}</span>
                <span class="muted small">${f.before ? `replaced ${sideText(f.before)}${f.notKept || !f.before.kept ? ' (not kept)' : ''}` : `new ${up ? `on ${where}` : 'here'}`} → ${sideText(f.after)}</span>
                ${f.before?.kept && opensInEditor(f.rel) && em && html`<button type="button" class="btn ghost sm" title="The version it replaced, beside the file now" onClick=${() => (onClose(), actions.mirrorCompareKept(e, f))}><${Icon} name="compare" size=${14} />Compare with the old one</button>`}
              </li>`,
            )}
            ${e.files.length > 200 && html`<li class="muted small">and ${e.files.length - 200} more</li>`}
          </ul>`}
        </li>`;
      })}
    </ul>
  </${Modal}>`;
}

/**
 * Under a mirrored file's bar: the server's copy is newer, or this one changed since the last
 * upload; Compare, Download / Upload, × (until either version changes).
 */
export function MirrorNote({ path, actions }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  useEffect(() => onMirrorNotes(rerender), []);
  useEffect(() => onMirrors(rerender), []);
  const found = mirrorNoteFor(path);
  if (!found) return null;
  const note = noteOf(found.row, { server: nameOf(found.mirror), when: shortWhen, size: formatBytes });
  if (!note) return null;
  const buttons = {
    compare: html`<button type="button" class="btn ghost sm" key="compare" onClick=${() => actions.mirrorCompare(path)}>Compare</button>`,
    download: html`<button type="button" class="btn ${note.tone === 'warn' ? '' : 'ghost'} sm" key="download" onClick=${() => actions.mirrorDownload([path])}><${Icon} name="download" size=${14} />Download</button>`,
    upload: html`<button type="button" class="btn ${note.tone === 'warn' ? 'ghost' : ''} sm" key="upload" onClick=${() => actions.mirrorUpload([path])}><${Icon} name="upload" size=${14} />Upload</button>`,
  };
  return html`<div class="filebar-notice mirror-note ${note.tone === 'warn' ? 'warn' : ''}" role="status">
    <span class="mirror-note-mark" aria-hidden="true">⇅</span><span>${note.text}</span>
    <span class="spacer" />
    ${note.offer.map((o) => buttons[o])}
    <button type="button" class="icon-btn sm" aria-label="Dismiss" title="Hide this until either copy changes" onClick=${() => dismissMirrorNote(path)}><${Icon} name="x" size=${14} /></button>
  </div>`;
}
