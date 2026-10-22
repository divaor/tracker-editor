import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { renderMarkdown } from '../markdown.js';
import { jsonProblem, parseDelimited } from '../previews.js';
import { toggleChecklistItem } from '../tracker-model.js';
import { Icon } from './icons.js';

const MAX_CHILDREN = 200; // children shown at first in a tree node; "Show more" adds more
const MAX_ROWS = 2000;

// The text a moment after typing stops, so previews don't re-render on every key.
function useSettled(text) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setShown(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  return [shown, setShown];
}

function Problem({ message, line, column, onGoTo }) {
  return html`<div class="notice error preview-problem">
    <${Icon} name="alert" size=${16} /><span>${message}${line ? ` (line ${line}, column ${column})` : ''}</span>
    ${line && onGoTo && html`<button type="button" class="btn sm" onClick=${() => onGoTo(line, column)}>Show in the text</button>`}
  </div>`;
}

/** Rendered Markdown. Ticking a box edits the text. */
function MarkdownPreview({ text, onToggle }) {
  const [shown, setShown] = useSettled(text);
  const onClick = (e) => {
    const box = e.target.closest?.('input.md-check');
    if (!box) return;
    e.preventDefault();
    // Read-only (a file in the folders view): the box stays as it is.
    if (!onToggle) return;
    const index = [...e.currentTarget.querySelectorAll('input.md-check')].indexOf(box);
    const next = toggleChecklistItem(text, index);
    setShown(next);
    onToggle(next);
  };
  return html`<div class="markdown preview-body" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: renderMarkdown(shown) }} />`;
}

/** The page as a browser shows it, in a sandbox: its scripts, forms and links stay off. */
function HtmlPreview({ text, name }) {
  const [shown] = useSettled(text);
  return html`<div class="preview-frame-wrap">
    <p class="preview-note muted small"><${Icon} name="eye" size=${14} />Scripts and links are off in the preview.</p>
    <iframe class="preview-frame" sandbox="" srcdoc=${shown} title=${name} referrerpolicy="no-referrer" />
  </div>`;
}

function SvgPreview({ text, name }) {
  const [shown] = useSettled(text);
  return html`<div class="preview-image"><img alt=${name} src=${`data:image/svg+xml;charset=utf-8,${encodeURIComponent(shown)}`} /></div>`;
}

// ---- Trees (JSON, XML) ---------------------------------------------------------------

function MoreButton({ shown, total, onMore }) {
  return shown < total && html`<button type="button" class="btn link tree-more" onClick=${onMore}>Show ${Math.min(MAX_CHILDREN, total - shown)} more of ${total - shown}</button>`;
}

/** A collapsible branch whose children are only built while it is open. */
function Branch({ label, summary, depth, openDepth, children }) {
  const [open, setOpen] = useState(depth < openDepth);
  return html`<div class="tree-branch">
    <button type="button" class="tree-toggle" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <${Icon} name="chevronDown" size=${13} class=${open ? '' : 'collapsed'} />${label}<span class="tree-summary">${summary}</span>
    </button>
    ${open && html`<div class="tree-children">${children()}</div>`}
  </div>`;
}

function JsonValue({ value }) {
  if (value === null) return html`<span class="j-null">null</span>`;
  if (typeof value === 'string') return html`<span class="j-string">"${value}"</span>`;
  return html`<span class=${`j-${typeof value}`}>${String(value)}</span>`;
}

function JsonNode({ name, value, depth, openDepth }) {
  const [limit, setLimit] = useState(MAX_CHILDREN);
  const key = name !== undefined && html`<span class="j-key">${name}</span><span class="j-colon">: </span>`;
  if (value === null || typeof value !== 'object') return html`<div class="tree-leaf">${key}<${JsonValue} value=${value} /></div>`;
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  const summary = Array.isArray(value) ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]` : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`;
  return html`<${Branch} label=${key} summary=${summary} depth=${depth} openDepth=${openDepth}>${() => html`
    ${entries.slice(0, limit).map(([k, v]) => html`<${JsonNode} key=${k} name=${k} value=${v} depth=${depth + 1} openDepth=${openDepth} />`)}
    <${MoreButton} shown=${Math.min(limit, entries.length)} total=${entries.length} onMore=${() => setLimit(limit + MAX_CHILDREN)} />
  `}<//>`;
}

function TreeToolbar({ onDepth }) {
  return html`<div class="tree-toolbar">
    <button type="button" class="btn ghost sm" onClick=${() => onDepth(Infinity)}>Expand all</button>
    <button type="button" class="btn ghost sm" onClick=${() => onDepth(1)}>Collapse all</button>
  </div>`;
}

function JsonPreview({ text, onGoTo }) {
  const [shown] = useSettled(text);
  const [openDepth, setOpenDepth] = useState(2);
  const [version, setVersion] = useState(0);
  const parsed = useMemo(() => {
    try {
      return { value: JSON.parse(shown) };
    } catch (error) {
      return { error: jsonProblem(shown) ?? { message: error.message } };
    }
  }, [shown]);
  if (parsed.error) return html`<div class="preview-body"><${Problem} message=${`Not valid JSON: ${parsed.error.message}`} line=${parsed.error.line} column=${parsed.error.column} onGoTo=${onGoTo} /></div>`;
  const setDepth = (d) => {
    setOpenDepth(d);
    setVersion(version + 1);
  };
  return html`<div class="preview-body tree">
    <${TreeToolbar} onDepth=${setDepth} />
    <${JsonNode} key=${version} value=${parsed.value} depth=${0} openDepth=${openDepth} />
  </div>`;
}

function XmlNode({ node, depth, openDepth }) {
  const [limit, setLimit] = useState(MAX_CHILDREN);
  if (node.nodeType === 3 || node.nodeType === 4) return html`<div class="tree-leaf x-text">${node.nodeValue.trim()}</div>`;
  if (node.nodeType === 8) return html`<div class="tree-leaf x-comment">${`<!-- ${node.nodeValue.trim()} -->`}</div>`;
  if (node.nodeType === 7) return html`<div class="tree-leaf x-comment">${`<?${node.nodeName} ${node.nodeValue}?>`}</div>`;
  const attrs = [...node.attributes].map((a) => html` <span class="x-attr">${a.name}</span>=<span class="x-value">"${a.value}"</span>`);
  const kids = [...node.childNodes].filter((c) => (c.nodeType === 3 || c.nodeType === 4 ? c.nodeValue.trim() : [1, 7, 8].includes(c.nodeType)));
  const open = html`<span class="x-tag">${'<'}${node.nodeName}</span>${attrs}<span class="x-tag">${kids.length ? '>' : ' />'}</span>`;
  if (!kids.length) return html`<div class="tree-leaf">${open}</div>`;
  // A single bit of text stays on the same line: <name>text</name>.
  if (kids.length === 1 && kids[0].nodeType !== 1 && kids[0].nodeValue.length < 120) {
    return html`<div class="tree-leaf">${open}<span class="x-text">${kids[0].nodeValue.trim()}</span><span class="x-tag">${`</${node.nodeName}>`}</span></div>`;
  }
  const elements = kids.filter((c) => c.nodeType === 1).length;
  return html`<${Branch} label=${open} summary=${`${elements || kids.length} ${elements ? 'element' : 'item'}${(elements || kids.length) === 1 ? '' : 's'}`} depth=${depth} openDepth=${openDepth}>${() => html`
    ${kids.slice(0, limit).map((c, i) => html`<${XmlNode} key=${i} node=${c} depth=${depth + 1} openDepth=${openDepth} />`)}
    <${MoreButton} shown=${Math.min(limit, kids.length)} total=${kids.length} onMore=${() => setLimit(limit + MAX_CHILDREN)} />
  `}<//>`;
}

function XmlPreview({ text }) {
  const [shown] = useSettled(text);
  const [openDepth, setOpenDepth] = useState(3);
  const [version, setVersion] = useState(0);
  const doc = useMemo(() => new DOMParser().parseFromString(shown, 'application/xml'), [shown]);
  const error = doc.querySelector('parsererror');
  if (error) return html`<div class="preview-body"><${Problem} message=${`Not valid XML: ${error.textContent.split('\n').filter(Boolean).slice(0, 2).join(' ')}`} /></div>`;
  const setDepth = (d) => {
    setOpenDepth(d);
    setVersion(version + 1);
  };
  return html`<div class="preview-body tree">
    <${TreeToolbar} onDepth=${setDepth} />
    <${XmlNode} key=${version} node=${doc.documentElement} depth=${0} openDepth=${openDepth} />
  </div>`;
}

function TablePreview({ text, delimiter }) {
  const [shown] = useSettled(text);
  const rows = useMemo(() => parseDelimited(shown, delimiter).filter((r) => r.length > 1 || r[0] !== ''), [shown, delimiter]);
  if (!rows.length) return html`<div class="preview-body muted">No rows yet.</div>`;
  const [head, ...body] = rows;
  return html`<div class="preview-table-wrap">
    <table class="preview-table">
      <thead><tr><th class="row-no">#</th>${head.map((c, i) => html`<th key=${i}>${c}</th>`)}</tr></thead>
      <tbody>${body.slice(0, MAX_ROWS).map((r, i) => html`<tr key=${i}><td class="row-no">${i + 1}</td>${r.map((c, j) => html`<td key=${j}>${c}</td>`)}</tr>`)}</tbody>
    </table>
    ${body.length > MAX_ROWS && html`<p class="muted small preview-note">Showing the first ${MAX_ROWS} of ${body.length} rows.</p>`}
  </div>`;
}

/**
 * The reading view of a file, next to (or, on phones, instead of) the text.
 * kind comes from previewKind(); onToggle(text) edits the text (Markdown
 * checklists); onGoTo(line, column) shows a place in the text.
 */
/**
 * The preview next to the text. `full` fills the editor's place (`onFull` switches);
 * Full screen shows only the preview; `onClose` hides it.
 */
/** The reading view itself, without the pane around it (the folders view shows it too, read-only). */
export function PreviewBody({ kind, text = '', name, onToggle, onGoTo }) {
  if (kind === 'markdown') return html`<${MarkdownPreview} text=${text} onToggle=${onToggle} />`;
  if (kind === 'html') return html`<${HtmlPreview} text=${text} name=${name} />`;
  if (kind === 'svg') return html`<${SvgPreview} text=${text} name=${name} />`;
  if (kind === 'json') return html`<${JsonPreview} text=${text} onGoTo=${onGoTo} />`;
  if (kind === 'xml') return html`<${XmlPreview} text=${text} />`;
  if (kind === 'csv' || kind === 'tsv') return html`<${TablePreview} text=${text} delimiter=${kind === 'tsv' ? '\t' : ','} />`;
  return null;
}

export function Preview({ kind, text = '', name, onToggle, onGoTo, full = false, onFull, onClose }) {
  const pane = useRef(null);
  const body = html`<${PreviewBody} kind=${kind} text=${text} name=${name} onToggle=${onToggle} onGoTo=${onGoTo} />`;
  return html`<div class="preview-pane preview-${kind} ${full ? 'full' : ''}" ref=${pane}>
    <div class="preview-head">
      <${Icon} name="eye" size=${14} /><span class="preview-title">Preview</span><span class="spacer" />
      ${onFull && html`<button type="button" class="icon-btn sm preview-full-btn" aria-pressed=${full} aria-label=${full ? 'Back to the text and preview' : 'Full view'}
        title=${full ? 'Back to the text and preview' : 'Full view: the preview in the editor’s place'} onClick=${onFull}><${Icon} name=${full ? 'narrow' : 'widen'} size=${15} /></button>`}
      ${document.fullscreenEnabled && html`<button type="button" class="icon-btn sm" aria-label="Full screen" title="Full screen (Esc to leave)"
        onClick=${() => (document.fullscreenElement ? document.exitFullscreen() : pane.current.requestFullscreen()).catch(() => {})}><${Icon} name="fullscreen" size=${15} /></button>`}
      ${onClose && html`<button type="button" class="icon-btn sm" aria-label="Close the preview" title="Close the preview" onClick=${onClose}><${Icon} name="x" size=${15} /></button>`}
    </div>
    <div class="preview-scroll">${body}</div>
  </div>`;
}
