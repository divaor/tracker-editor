import { html } from '../../vendor/preact-htm.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

/** Closing a file on disk that has unsaved edits: save, drop them, or stay. */
export function CloseDiskDialog({ tab, onSave, onDiscard, onClose }) {
  return html`<${Modal} title="Save the changes?" onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn danger" onClick=${onDiscard}>Don't save</button>
      <button type="button" class="btn primary" onClick=${onSave}><${Icon} name="save" size=${15} />Save</button>`}>
    <p><strong>${tab.name}</strong> has changes that are not saved to disk yet.</p>
    <p class="muted small">${tab.path}</p>
  </${Modal}>`;
}

/** Reloading a file on disk over unsaved edits. */
export function ReloadDiskDialog({ tab, onReload, onClose }) {
  return html`<${Modal} title="Reload from disk?" onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn danger" onClick=${onReload}><${Icon} name="rotate" size=${15} />Reload and lose my edits</button>`}>
    <p>The edits you made to <strong>${tab.name}</strong> here are not saved. Reloading shows the file as it is on disk; Ctrl+Z still brings your edits back.</p>
  </${Modal}>`;
}
