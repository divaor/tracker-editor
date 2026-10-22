import { html, useEffect, useReducer, useState } from '../../vendor/preact-htm.js';
import { lastSyncText, mirrors, onMirrors, refreshMirrors } from '../mirrors.js';
import { timeAgo } from '../format.js';
import { server, servers } from '../servers.js';
import { toRemoteUri } from '../where.js';
import { Check, Field, Modal, Segmented, toast } from './components.js';
import { Icon } from './icons.js';

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
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

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
  return { tone: 'pending', text: 'Not synced yet' };
}

/** Sets up (or changes) a mirror: a server folder and a folder here kept the same. */
export function MirrorDialog({ draft = {}, actions, onClose }) {
  const editing = Boolean(draft.id);
  const [form, setForm] = useState(() => ({ mode: 'both', auto: true, exclude: DEFAULT_EXCLUDE, remote: '/', local: '', ...draft }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
      actions.syncMirror(saved.id);
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
  return html`<${Modal} title=${editing ? 'Mirror' : 'Keep a server folder on this computer'} wide className="mirror-dialog" onClose=${onClose}
    footer=${html`${editing && html`<button type="button" class="btn ghost danger" onClick=${remove}><${Icon} name="trash" size=${15} />Remove the mirror</button>`}
      <span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!form.conn || !form.local || busy} onClick=${save}><${Icon} name="sync" size=${15} />Save and sync now</button>`}>
    <p class="muted small">The two folders are kept the same: what changes in one goes to the other. Files deleted here go only after you say so; files deleted on the server go to the Recycle Bin here.</p>
    <div class="field-grid">
      <${Field} label="Server">
        <select value=${form.conn ?? ''} onChange=${(e) => set({ conn: e.currentTarget.value })}>
          <option value="" disabled>Choose a server</option>
          ${servers().map((c) => html`<option key=${c.id} value=${c.id}>${c.name}</option>`)}
        </select>
      </${Field}>
      <${Field} label="Folder on the server">
        <input value=${form.remote} spellcheck="false" placeholder="/var/www/site" onInput=${(e) => set({ remote: e.currentTarget.value })} />
      </${Field}>
      <div class="field span-2"><span>Folder on this computer</span>
        <div class="row-input">
          <input value=${form.local} readonly placeholder="Choose or make a folder" title=${form.local} />
          <button type="button" class="btn sm" onClick=${choose}>Choose…</button>
        </div>
      </div>
      <div class="field span-2"><span>Direction</span>
        <${Segmented} options=${MODES} value=${form.mode} label="Direction" onChange=${(mode) => set({ mode })} />
        <small class="muted">${MODE_HINTS[form.mode]}</small>
      </div>
      <${Field} label="Leave out" hint="Names or patterns, separated by commas" wide>
        <input value=${form.exclude} spellcheck="false" onInput=${(e) => set({ exclude: e.currentTarget.value })} />
      </${Field}>
      <${Check} checked=${form.auto} label="Keep them the same automatically" hint="While the server is connected: every minute, and a moment after you change something here."
        onChange=${(auto) => set({ auto })} />
    </div>
    ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
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
  return html`<${Modal} title="Mirrors" wide className="mirrors-dialog" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    ${!list.length && html`<p class="muted">No mirrors yet. In Folders, on a server, choose “Keep this folder on this computer…”.</p>`}
    <ul class="mirror-list" role="list">
      ${list.map((m) => {
        const st = mirrorState(m);
        return html`<li key=${m.id} class="mirror-item">
          <div class="mirror-pair">
            <span class="kind-remote"><${Icon} name="server" size=${14} />${server(m.conn)?.name ?? 'Server'}: ${m.remote}</span>
            <span class="mirror-arrow" title=${MODES.find((x) => x.id === m.mode)?.label}>${m.mode === 'download' ? '→' : m.mode === 'upload' ? '←' : '⇄'}</span>
            <span class="kind-disk"><${Icon} name="disk" size=${14} />${m.local}</span>
          </div>
          <div class="mirror-meta">
            <span class="mirror-state tone-${st.tone}">${st.text}</span>
            ${m.last && lastSyncText(m.last) && html`<span class="muted small">Last: ${lastSyncText(m.last)}</span>`}
            ${m.auto && html`<span class="muted small">· automatic</span>`}
          </div>
          <div class="mirror-actions">
            ${m.state === 'waiting' && html`<button type="button" class="btn sm primary" onClick=${() => actions.reviewMirror(m.id)}>Review</button>`}
            <button type="button" class="btn sm" disabled=${m.state === 'syncing'} onClick=${() => actions.syncMirror(m.id)}><${Icon} name="sync" size=${14} />Sync now</button>
            <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.showFolder(m.local))}><${Icon} name="folder" size=${14} />Here</button>
            <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.showFolder(toRemoteUri(m.conn, m.remote)))}><${Icon} name="server" size=${14} />On the server</button>
            <button type="button" class="btn ghost sm" onClick=${() => actions.editMirror(m)}><${Icon} name="edit" size=${14} />Edit</button>
          </div>
        </li>`;
      })}
    </ul>
  </${Modal}>`;
}

/** Over the list in Folders, inside a mirrored folder: what it is kept the same as, and how it stands. */
export function MirrorBar({ found, actions }) {
  useMirrors();
  const m = mirrors().find((x) => x.id === found.mirror.id) ?? found.mirror;
  const st = mirrorState(m);
  const other = found.side === 'local' ? `${server(m.conn)?.name ?? 'Server'}: ${m.remote}` : m.local;
  return html`<div class="mirror-bar tone-${st.tone}" role="status">
    <span class="mirror-arrow" aria-hidden="true">${m.mode === 'download' ? (found.side === 'local' ? '←' : '→') : m.mode === 'upload' ? (found.side === 'local' ? '→' : '←') : '⇄'}</span>
    <span class="mirror-bar-text" title=${`Kept the same as ${other}`}>
      ${found.side === 'local'
        ? html`<span>Mirror of <strong>${server(m.conn)?.name ?? 'the server'}</strong> ${m.remote}</span>`
        : html`<span>Mirrored here as <strong>${baseName(m.local)}</strong></span>`}
      <span class="muted small">${st.text}</span>
    </span>
    ${m.state === 'waiting'
      ? html`<button type="button" class="btn sm primary" onClick=${() => actions.reviewMirror(m.id)}>Review</button>`
      : html`<button type="button" class="icon-btn sm" aria-label="Sync now" title="Sync now" disabled=${m.state === 'syncing'} onClick=${() => actions.syncMirror(m.id)}><${Icon} name="sync" size=${15} /></button>`}
    <button type="button" class="icon-btn sm" aria-label="Mirror settings" title="Mirror settings" onClick=${() => actions.editMirror(m)}><${Icon} name="settings" size=${15} /></button>
  </div>`;
}
