import { html, useState } from '../../vendor/preact-htm.js';
import { compareName, sideName, sideWhere } from '../compares.js';
import { getSettings, saveSettings } from '../settings.js';
import { store } from '../store.js';
import { newId } from '../tracker-model.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

const saved = () => getSettings().savedCompares ?? [];
const describe = (c) => `${sideName(c.left)} · ${sideWhere(c.left)}\n${sideName(c.right)} · ${sideWhere(c.right)}`;

/** ☆ on a comparison: its name, to keep it in Saved comparisons (or a new name, or Remove). */
export function SaveCompareDialog({ id, actions, onClose }) {
  const record = store.compare(id);
  const existing = actions.savedCompareOf(record);
  const [name, setName] = useState(existing?.name ?? compareName({ ...record, name: '' }));
  if (!record) return null;
  const save = (ev) => {
    ev.preventDefault();
    const clean = name.trim() || compareName({ ...record, name: '' });
    const entry = { id: existing?.id ?? newId(), name: clean, mode: record.mode, left: record.left, right: record.right, show: record.show, all: record.all };
    saveSettings({ savedCompares: existing ? saved().map((x) => (x.id === existing.id ? entry : x)) : [...saved(), entry] });
    store.updateCompare(id, { savedId: entry.id, name: clean });
    actions.toast(existing ? `Saved as “${clean}”.` : `Saved “${clean}”: open it again from the tab list (▾) or Ctrl+Shift+P.`);
    onClose();
  };
  const remove = () => {
    saveSettings({ savedCompares: saved().filter((x) => x.id !== existing.id) });
    store.updateCompare(id, { savedId: null, name: '' });
    actions.toast(`“${existing.name}” is no longer saved (this tab stays open).`);
    onClose();
  };
  return html`<${Modal} title=${existing ? 'Saved comparison' : 'Save this comparison'} onClose=${onClose}
    footer=${html`${existing && html`<button type="button" class="btn ghost danger" onClick=${remove}><${Icon} name="trash" size=${15} />Remove</button>`}<span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="save-compare" class="btn primary"><${Icon} name="star" size=${15} />Save</button>`}>
    <form id="save-compare" class="fields" onSubmit=${save}>
      <label class="field"><span class="field-label">Name</span>
        <input value=${name} autofocus spellcheck="false" onInput=${(e) => setName(e.currentTarget.value)} /></label>
    </form>
    <p class="muted small saved-compare-sides">${describe(record)}</p>
    <p class="muted small">It opens again from the tab list (▾ at the end of the tabs), Ctrl+Shift+P (Open a saved comparison) or Folders’ ⋯, and reads both sides fresh.</p>
  </${Modal}>`;
}

/** The saved comparisons: open one, rename it, or remove it. */
export function SavedComparesDialog({ actions, onClose }) {
  const [list, setList] = useState(saved);
  const [editing, setEditing] = useState(null); // { id, name }
  const write = (next) => (saveSettings({ savedCompares: next }), setList(next));
  return html`<${Modal} title="Saved comparisons" onClose=${onClose} footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    ${!list.length && html`<p class="muted">None left.</p>`}
    <ul class="saved-compares">
      ${list.map(
        (c) => html`<li key=${c.id} class="saved-compare">
          <${Icon} name=${c.mode === 'folders' ? 'folder' : 'file'} size=${15} />
          ${editing?.id === c.id
            ? html`<form class="saved-compare-rename" onSubmit=${(e) => (e.preventDefault(), write(list.map((x) => (x.id === c.id ? { ...x, name: editing.name.trim() || x.name } : x))), setEditing(null))}>
                <input value=${editing.name} autofocus aria-label="Name" onInput=${(e) => setEditing({ id: c.id, name: e.currentTarget.value })} />
                <button type="submit" class="btn sm">Rename</button></form>`
            : html`<button type="button" class="saved-compare-open" title=${describe(c)} onClick=${() => (onClose(), actions.openSavedCompare(c))}>
                <span class="saved-compare-name">${c.name}</span><span class="muted small">${sideName(c.left)} ↔ ${sideName(c.right)}</span></button>`}
          <button type="button" class="icon-btn xs" aria-label=${`Rename ${c.name}`} title="Rename" onClick=${() => setEditing({ id: c.id, name: c.name })}><${Icon} name="edit" size=${13} /></button>
          <button type="button" class="icon-btn xs" aria-label=${`Remove ${c.name}`} title="Remove (the folders and files stay)" onClick=${() => write(list.filter((x) => x.id !== c.id))}><${Icon} name="trash" size=${13} /></button>
        </li>`,
      )}
    </ul>
  </${Modal}>`;
}
