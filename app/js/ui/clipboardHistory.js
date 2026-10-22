import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { timeAgo } from '../format.js';
import { toast } from './components.js';
import { Icon } from './icons.js';

const history = () => window.desktop?.clipboardHistory;
const firstLine = (text) => text.trim().split('\n')[0].slice(0, 120);

/**
 * The clipboard history (desktop, Ctrl+Shift+V): what you copied anywhere,
 * newest first. Enter inserts the chosen text at the cursor; it can also be
 * copied, opened as a new file or typed into another window.
 */
export function ClipboardHistory({ actions, onClose }) {
  const [entries, setEntries] = useState(null); // null while loading; [] when off or empty
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  const load = async () => {
    const prefs = await window.desktop.prefs.get();
    setEnabled(prefs.clipboard.enabled);
    setEntries(prefs.clipboard.enabled ? await history().list() : []);
  };
  useEffect(() => {
    load();
    return history()?.onChanged(load);
  }, []);
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    input.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setIndex(0), [query]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (entries ?? []).filter((e) => words.every((w) => e.text.toLowerCase().includes(w)));
  const chosen = list[Math.min(index, list.length - 1)];
  const run = (fn) => {
    onClose();
    fn();
  };
  const insert = (e) => run(() => actions.insertText(e.text));
  const copy = (e) => history().copy(e.id).then(() => (onClose(), toast('Copied')));
  const asFile = (e) => run(() => actions.newFile({ text: e.text }));
  const typeOut = (e) => run(() => actions.typeOut({ text: e.text, what: 'clipboard entry' }));

  if (!enabled) {
    return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="quick-open clip-history" role="dialog" aria-label="Clipboard history">
        <div class="quick-title">Clipboard history</div>
        <div class="clip-off">
          <p>Keep what you copy in any app, to paste it again later. It stays on this computer, encrypted, and skips passwords copied from password managers.</p>
          <div class="snippet-actions">
            <button type="button" class="btn primary sm" onClick=${async () => (await window.desktop.prefs.set({ clipboard: { enabled: true } }), load())}>Turn it on</button>
            <button type="button" class="btn ghost sm" onClick=${() => run(actions.showSettings)}>Settings</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open clip-history" role="dialog" aria-label="Clipboard history">
      <div class="quick-title">Clipboard history <span class="muted small">Enter inserts · newest first</span></div>
      <input value=${query} ref=${input} placeholder="Search what you copied…" aria-label="Search the clipboard history"
        onInput=${(e) => setQuery(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex(Math.min(index + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex(Math.max(index - 1, 0));
          } else if (e.key === 'Enter' && chosen) {
            e.preventDefault();
            insert(chosen);
          }
        }} />
      <div class="quick-list" role="listbox" aria-label="Copied texts">
        ${list.map(
          (e, i) => html`<button type="button" key=${e.id} role="option" aria-selected=${e === chosen} class="quick-row clip-row ${e === chosen ? 'active' : ''}"
            onMouseEnter=${() => setIndex(i)} onClick=${() => insert(e)} title="Insert at the cursor">
            ${e.pinned ? html`<${Icon} name="pin" size=${14} />` : html`<${Icon} name="copy" size=${14} />`}
            <span class="quick-name clip-text">${firstLine(e.text) || '(spaces)'}</span>
            <span class="muted small clip-meta">${e.text.includes('\n') ? `${e.text.split('\n').length} lines · ` : ''}${timeAgo(new Date(e.at).toISOString())}</span>
          </button>`,
        )}
        ${entries && !list.length &&
        html`<p class="muted small quick-empty">${entries.length ? 'Nothing copied matches.' : 'Nothing copied yet. Copy some text in any app and it shows up here.'}</p>`}
      </div>
      ${chosen &&
      html`<div class="clip-detail">
        <pre class="snippet-preview" aria-label="The chosen text">${chosen.text.length > 4000 ? `${chosen.text.slice(0, 4000)}…` : chosen.text}</pre>
        <div class="snippet-actions">
          <button type="button" class="btn primary sm" onClick=${() => insert(chosen)}><${Icon} name="filePlus" size=${14} />Insert</button>
          <button type="button" class="btn sm" onClick=${() => copy(chosen)}><${Icon} name="copy" size=${14} />Copy</button>
          <button type="button" class="btn sm" onClick=${() => asFile(chosen)}><${Icon} name="file" size=${14} />New file</button>
          ${window.desktop?.typing && html`<button type="button" class="btn sm" onClick=${() => typeOut(chosen)}><${Icon} name="keyboard" size=${14} />Type into another window</button>`}
          <span class="spacer" />
          <button type="button" class="icon-btn sm ${chosen.pinned ? 'on' : ''}" aria-pressed=${chosen.pinned} title=${chosen.pinned ? 'Unpin' : 'Pin (kept when the list is full or cleared)'} aria-label="Pin"
            onClick=${() => history().pin(chosen.id, !chosen.pinned)}><${Icon} name="pin" size=${15} /></button>
          <button type="button" class="icon-btn sm danger" title="Forget this one" aria-label="Forget this one" onClick=${() => history().remove(chosen.id)}><${Icon} name="trash" size=${15} /></button>
        </div>
      </div>`}
      <div class="clip-foot">
        <span class="muted small">Kept on this computer only${entries?.length ? ` · ${entries.length} item${entries.length === 1 ? '' : 's'}` : ''}</span>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" disabled=${!entries?.some((e) => !e.pinned)} onClick=${() => history().clear()}>Clear (keeps pinned)</button>
      </div>
    </div>
  </div>`;
}
