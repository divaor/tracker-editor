import { html, useState } from '../../vendor/preact-htm.js';
import { formatDateTime, timeAgo } from '../format.js';
import { store } from '../store.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

/**
 * Deleted files, newest first, to bring back. The text comes from this device
 * when it kept it, otherwise from the data repo (actions.restoreDeleted).
 */
export function TrashDialog({ actions, onClose }) {
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const all = store.trash();
  const files = all.filter((f) => !q || [f.name, f.project, ...f.tags].some((s) => s.toLowerCase().includes(q)));
  const restore = async (file) => {
    setBusy(file.id);
    const ok = await actions.restoreDeleted(file);
    setBusy(null);
    if (ok) onClose();
  };
  return html`<${Modal} title="Trash" onClose=${onClose} className="trash-dialog">
    <p class="muted small">Deleted files stay here for 180 days, on all your devices. Restoring one brings it back where it was.</p>
    ${all.length > 6 && html`<input class="trash-filter" value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder="Filter deleted files" aria-label="Filter deleted files" />`}
    <div class="trash-list">
      ${files.map(
        (f) => html`<div class="trash-row" key=${f.id}>
          <${Icon} name="file" size=${16} />
          <span class="trash-main">
            <span class="trash-name">${f.name}</span>
            <span class="muted small" title=${formatDateTime(f.updatedAt)}>Deleted ${timeAgo(f.updatedAt)}${f.updatedBy ? ` on ${f.updatedBy}` : ''}${f.project ? ` · ${f.project}` : ''}</span>
          </span>
          <button type="button" class="btn sm" disabled=${Boolean(busy)} onClick=${() => restore(f)}>
            <${Icon} name="rotate" size=${14} />${busy === f.id ? 'Restoring…' : 'Restore'}
          </button>
        </div>`,
      )}
      ${!all.length && html`<p class="muted small trash-empty"><${Icon} name="trash" size=${15} />The trash is empty.</p>`}
      ${all.length > 0 && !files.length && html`<p class="muted small trash-empty">No deleted file matches.</p>`}
    </div>
  </${Modal}>`;
}
