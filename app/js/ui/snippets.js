import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { quickOpen } from '../search.js';
import { fillSnippet, snippetFields, usesBuiltin } from '../snippets.js';
import { store } from '../store.js';
import { toast } from './components.js';
import { Icon } from './icons.js';

/**
 * Pick a snippet (files marked as snippets), fill its fields, then insert it at
 * the cursor, copy it, or type it into another window. `selection` is what was
 * selected when the picker opened, for {{selection}}.
 */
export function SnippetPicker({ selection = '', actions, onClose }) {
  // Found by name or by their first line (`item` is what quickOpen also matches).
  const snippets = store
    .live()
    .filter((f) => f.snippet)
    .sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1))
    .map((f) => ({ ...f, item: store.text(f.id).split('\n')[0].slice(0, 60) }));
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState(null);
  const list = quickOpen(snippets, query, 60);
  const input = useRef(null);
  useEffect(() => setIndex(0), [query]);
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
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open snippet-picker" role="dialog" aria-label="Insert a snippet">
      ${chosen
        ? html`<${SnippetForm} file=${chosen} selection=${selection} actions=${actions} onBack=${() => setChosen(null)} onClose=${onClose} />`
        : html`<div class="quick-title">Insert a snippet</div>
          <input value=${query} ref=${input} placeholder="Type part of a snippet's name…" aria-label="Snippet name"
            onInput=${(e) => setQuery(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex(Math.min(index + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex(Math.max(index - 1, 0));
              } else if (e.key === 'Enter' && list[index]) {
                e.preventDefault();
                setChosen(list[index]);
              }
            }} />
          <div class="quick-list" role="listbox">
            ${list.map(
              (f, i) => html`<button type="button" key=${f.id} role="option" aria-selected=${i === index} class="quick-row ${i === index ? 'active' : ''}"
                onMouseEnter=${() => setIndex(i)} onClick=${() => setChosen(f)}>
                <${Icon} name="snippet" size=${15} /><span class="quick-name">${f.name}</span>
                <span class="muted small quick-item">${f.item}</span>
              </button>`,
            )}
            ${!list.length &&
            html`<p class="muted small quick-empty">${snippets.length ? 'No snippet matches.' : html`No snippets yet. Select some text and choose <strong>⋯ → Save as snippet</strong>, or mark a file as a snippet in its menu. Write <code>{{name}}</code> where a value changes.`}</p>`}
          </div>`}
    </div>
  </div>`;
}

function SnippetForm({ file, selection, actions, onBack, onClose }) {
  const source = store.text(file.id);
  const fields = useMemo(() => snippetFields(source), [source]);
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, ''])));
  const [clipboard, setClipboard] = useState('');
  const first = useRef(null);
  const insertButton = useRef(null);
  useEffect(() => {
    if (usesBuiltin(source, 'clipboard')) navigator.clipboard?.readText?.().then(setClipboard, () => {});
  }, []);
  useLayoutEffect(() => (first.current ?? insertButton.current)?.focus(), []);
  const filled = fillSnippet(source, values, { clipboard, selection });
  const run = (fn) => {
    onClose();
    fn();
  };
  const insert = () => run(() => actions.insertText(filled.text, filled.cursor));
  const copy = () => run(() => navigator.clipboard.writeText(filled.text).then(() => toast(`Copied “${file.name}”`), () => toast('Could not copy', { kind: 'error' })));
  const typeOut = () => run(() => actions.typeOut({ text: filled.text, what: 'snippet' }));
  return html`<form class="snippet-form" onSubmit=${(e) => (e.preventDefault(), insert())}>
    <div class="quick-title snippet-head">
      <button type="button" class="icon-btn sm" aria-label="Back to the snippets" onClick=${onBack}><${Icon} name="arrowRight" size=${15} class="flip" /></button>
      <span>${file.name}</span>
    </div>
    ${fields.length > 0 &&
    html`<div class="snippet-fields">
      ${fields.map(
        (f, i) => html`<label class="field" key=${f.name}><span>${f.name}</span>
          <input value=${values[f.name]} placeholder=${f.default} ref=${i === 0 ? first : undefined} spellcheck=${false}
            onInput=${(e) => setValues({ ...values, [f.name]: e.currentTarget.value })} /></label>`,
      )}
    </div>`}
    <pre class="snippet-preview" aria-label="Result">${filled.text}</pre>
    <div class="snippet-actions">
      <button type="submit" class="btn primary sm" ref=${insertButton}><${Icon} name="filePlus" size=${14} />Insert</button>
      <button type="button" class="btn sm" onClick=${copy}><${Icon} name="copy" size=${14} />Copy</button>
      ${window.desktop?.typing && html`<button type="button" class="btn sm" onClick=${typeOut}><${Icon} name="keyboard" size=${14} />Type into another window</button>`}
      <span class="spacer" />
      <button type="button" class="btn ghost sm" onClick=${() => run(() => actions.openFile(file.id))}><${Icon} name="edit" size=${14} />Edit snippet</button>
    </div>
  </form>`;
}
