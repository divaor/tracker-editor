import { html, useMemo } from '../../vendor/preact-htm.js';
import { backlinks, currentEntry, outline, parseLinks, resolveLink } from '../outline.js';
import { store } from '../store.js';
import { Icon } from './icons.js';

/**
 * The open file's outline (headings or symbols, the current one marked), the
 * [[links]] in it, and the files that link to it.
 */
export function OutlinePanel({ name, text, language, fileId, cursorLine, actions, onClose }) {
  const entries = useMemo(() => outline(text, language), [text, language]);
  const links = useMemo(() => {
    const seen = new Map();
    for (const l of parseLinks(text)) if (!seen.has(l.target.toLowerCase())) seen.set(l.target.toLowerCase(), l);
    return [...seen.values()].map((l) => ({ ...l, file: resolveLink(l.target, store.live()) }));
  }, [text]);
  const file = fileId ? store.get(fileId) : null;
  const linked = file ? backlinks(file, store.live(), (f) => store.text(f.id)) : [];
  const at = currentEntry(entries, cursorLine ?? 1);
  return html`<aside class="panel outline-panel" aria-label="Outline">
    <div class="panel-head">
      <h2><${Icon} name="list" size=${16} />Outline</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="muted small outline-name">${name}</p>
      ${entries.length
        ? html`<nav class="outline-list" aria-label="Sections">
            ${entries.map(
              (e, i) => html`<button type="button" key=${`${e.line}-${i}`} class="outline-row ${i === at ? 'active' : ''}" style=${{ paddingLeft: `${8 + (e.level - 1) * 14}px` }}
                onClick=${() => actions.reveal(e.line, 1)} title=${`Line ${e.line}`}>
                <span class="outline-title">${e.title}</span><span class="muted small">${e.line}</span>
              </button>`,
            )}
          </nav>`
        : html`<p class="muted small">No headings here. In Markdown, lines starting with # make sections; in code, classes and functions show up.</p>`}
      <h3 class="outline-sub">Links</h3>
      ${links.length
        ? links.map(
            (l) => html`<button type="button" key=${l.target} class="outline-row link-row ${l.file ? '' : 'missing'}" onClick=${() => actions.openLink(l.target)}
              title=${l.file ? `Open ${l.file.name}` : 'No such file yet: click to create it'}>
              <${Icon} name=${l.file ? 'link' : 'filePlus'} size=${14} /><span class="outline-title">${l.alias || l.target}</span>
            </button>`,
          )
        : html`<p class="muted small">Link another file by writing <code>[[its name]]</code>. Ctrl+click a link to open it.</p>`}
      ${file &&
      html`<h3 class="outline-sub">Linked from</h3>
        ${linked.length
          ? linked.map(
              (b) => html`<button type="button" key=${b.file.id} class="outline-row backlink-row" onClick=${() => actions.openFile(b.file.id, { line: b.line, column: 1 })}>
                <span class="outline-title"><${Icon} name="file" size=${13} /> ${b.file.name}</span>
                <span class="muted small backlink-context">${b.context}</span>
              </button>`,
            )
          : html`<p class="muted small">No file links here yet.</p>`}`}
    </div>
  </aside>`;
}
