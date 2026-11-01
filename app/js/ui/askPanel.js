// Find by asking (0.40): the results of a question asked in Ctrl+P (✦ Ask). The model planned the
// search, the editor searched your files, tracker documents, tracker items and the folders shown, and
// the model picked the best with a line on why. Open one (at the line that matched), Open all, Show
// only these (the tab bar's Found view), Ask about these (the model's panel, just these), the ones not
// picked, and encrypted files apart: found by name only, they never went to the model.
import { html, useState } from '../../vendor/preact-htm.js';
import { planWords } from '../askFind.js';
import { Icon } from './icons.js';

const PHASES = {
  planning: 'Working out what to look for…',
  searching: 'Searching your files, documents, items and folders…',
  picking: 'Picking the best…',
};
const ICONS = { synced: 'cloud', doc: 'paperclip', disk: 'disk', item: 'task' };
const kindClass = (r) => (r.kind === 'disk' && r.id.startsWith('d:remote://') ? 'remote' : r.kind === 'item' ? 'item' : r.kind);

function ResultRow({ r, actions }) {
  const line = r.lines?.[0];
  const remoteFile = r.kind === 'disk' && r.id.startsWith('d:remote://');
  return html`<li class=${`ask-row kind-${kindClass(r)}`}>
    <button type="button" class="ask-open" title=${r.kind === 'item' ? 'Open it in the Tracker app' : line ? `Open it at line ${line.line}` : 'Open it'} onClick=${() => actions.openFound(r, line?.line)}>
      <${Icon} name=${remoteFile ? 'server' : (ICONS[r.kind] ?? 'file')} size=${15} />
      <span class="ask-name">${r.name || '(no name)'}</span>
      ${r.from === 'tracker' && html`<span class="ask-badge" title="An item of the Tracker app: it opens there">Tracker</span>`}
      <span class="ask-place">${r.place}</span>
    </button>
    ${r.why && html`<p class="ask-why">${r.why}</p>`}
    ${line &&
    r.kind !== 'item' &&
    html`<button type="button" class="ask-line" title=${`Open it at line ${line.line}`} onClick=${() => actions.openFound(r, line.line)}><span class="ask-line-no">${line.line}</span><code>${line.text}</code></button>`}
  </li>`;
}

/**
 * `run`: { id, question, phase ('planning' | 'searching' | 'picking' | 'done' | 'error'), plan,
 * results, encrypted, more, searched (words), notes, error, listing (a project's files: its view) }.
 */
export function AskPanel({ run, actions, onClose }) {
  const [showMore, setShowMore] = useState(false);
  if (!run) return null;
  const busy = PHASES[run.phase];
  const results = run.results ?? [];
  const tabs = results.filter((r) => r.kind !== 'item');
  return html`<aside class="panel ask-panel" aria-label="Find by asking">
    <div class="panel-head">
      <h2><${Icon} name="sparkle" size=${16} />Find by asking</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Ask again" title="Ask the same again" disabled=${Boolean(busy)} onClick=${() => actions.askFind(run.question)}><${Icon} name="rotate" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body ask-body">
      <p class="ask-question">${run.question}</p>
      ${run.plan && html`<p class="ask-plan muted small" title="What the search looked for">${planWords(run.plan) || 'everything'}</p>`}
      ${busy && html`<p class="git-progress small" role="status"><span class="spinner" aria-hidden="true" />${busy}<button type="button" class="btn link small" onClick=${() => actions.stopAskFind()}>Stop</button></p>`}
      ${run.error && html`<p class="notice error small"><${Icon} name="alert" size=${14} /><span>${run.error}</span></p>`}
      ${(run.notes ?? []).map((n, i) => html`<p class="notice small" key=${i}><${Icon} name="info" size=${14} /><span>${n}</span></p>`)}
      ${run.phase === 'done' && !results.length && !run.encrypted?.length && html`<p class="muted small">Nothing found${run.searched ? ` in ${run.searched}` : ''}. Try other words, or name the project or the folder.</p>`}
      ${results.length > 0 &&
      html`<ol class="ask-results" aria-label="What was found">${results.map((r) => html`<${ResultRow} key=${r.id} r=${r} actions=${actions} />`)}</ol>
        <div class="card-actions ask-actions">
          ${tabs.length > 1 && html`<button type="button" class="btn sm" title="Open them all as tabs" onClick=${() => actions.openFoundAll(tabs)}><${Icon} name="file" size=${13} />Open all (${tabs.length})</button>`}
          ${tabs.length > 0 &&
          html`<button type="button" class="btn sm" title=${run.listing ? `The tab bar shows only ${run.listing.name}'s tabs` : 'Open them and have the tab bar show only these (back: All tabs)'} onClick=${() => actions.showFoundTabs(run)}><${Icon} name="eye" size=${13} />Show only these</button>`}
          <button type="button" class="btn sm" title="Ask the model about just these" onClick=${() => actions.askAboutFound(run)}><${Icon} name="chat" size=${13} />Ask about these</button>
        </div>`}
      ${run.more?.length > 0 &&
      html`<details class="ask-more" open=${showMore} onToggle=${(e) => setShowMore(e.currentTarget.open)}>
        <summary class="small muted">${run.more.length} more that matched, not picked</summary>
        <ol class="ask-results">${run.more.map((r) => html`<${ResultRow} key=${r.id} r=${r} actions=${actions} />`)}</ol>
      </details>`}
      ${run.encrypted?.length > 0 &&
      html`<section class="ask-encrypted" aria-label="Encrypted files">
        <h3 class="small"><${Icon} name="lock" size=${14} />Encrypted files${run.plan?.encrypted ? '' : ' that match by name'}</h3>
        <p class="muted small">Found by name only, on this device: their contents never go to the model, nor their names.</p>
        <ul class="ask-results">${run.encrypted.map((r) => html`<li class="ask-row kind-synced" key=${r.id}>
          <button type="button" class="ask-open" onClick=${() => actions.openFound(r)}><${Icon} name="lock" size=${15} /><span class="ask-name">${r.name}</span><span class="ask-place">${r.place}</span></button>
        </li>`)}</ul>
        <div class="card-actions"><button type="button" class="btn sm" title="Open them and have the tab bar show only these" onClick=${() => actions.showFoundTabs({ ...run, results: run.encrypted, listing: null, label: 'Encrypted files' })}><${Icon} name="lock" size=${13} />Open all as a group</button></div>
      </section>`}
      ${run.phase === 'done' && run.searched && html`<p class="ask-searched muted small">Searched ${run.searched}.</p>`}
    </div>
  </aside>`;
}
