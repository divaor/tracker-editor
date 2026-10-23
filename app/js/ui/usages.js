import { html, useMemo } from '../../vendor/preact-htm.js';
import { usages } from '../codeNav.js';
import { Icon } from './icons.js';

const AROUND = 48; // characters of the line shown before the name

/**
 * Where a name is used in the open file (Shift+F12), its declarations marked: click one
 * to go there. "Edit all together" selects every one; "Find in all files" looks further.
 */
export function UsagesPanel({ word, name, fileKey, text, actions, onClose }) {
  const list = useMemo(() => usages(text, word, { limit: 2000 }), [text, word]);
  const declared = list.filter((u) => u.declaration).length;
  return html`<aside class="panel usages-panel" aria-label="Usages">
    <div class="panel-head">
      <h2><${Icon} name="code" size=${16} />Usages</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="usages-word"><code>${word}</code></p>
      <p class="muted small">${list.length === 1 ? 'Once' : `${list.length.toLocaleString()} times`} in ${name}${declared ? ` · declared ${declared === 1 ? 'once' : `${declared} times`}` : ' · not declared here'}</p>
      <div class="usages-actions">
        <button type="button" class="btn sm" disabled=${!list.length} onClick=${() => actions.selectOccurrences(word, null, fileKey)} title="Select every one, to type a new name for all (F2)">Edit all together</button>
        <button type="button" class="btn ghost sm" onClick=${() => actions.findEverywhere(word)}><${Icon} name="search" size=${14} />Find in all files</button>
      </div>
      <nav class="usages-list" aria-label=${`Where ${word} is used`}>
        ${list.map((u) => {
          const at = u.column - 1;
          const start = Math.max(0, at - AROUND);
          return html`<button type="button" key=${u.from} class="outline-row usage-row ${u.declaration ? 'declaration' : ''}" onClick=${() => actions.revealRange(u.from, u.to, fileKey)} title=${`Line ${u.line}`}>
            <span class="usage-line">${u.line}</span>
            <span class="usage-text">${start ? '…' : ''}${u.text.slice(start, at).trimStart()}<mark>${word}</mark>${u.text.slice(at + word.length, at + word.length + 120)}</span>
            ${u.declaration && html`<span class="usage-kind">declared</span>`}
          </button>`;
        })}
        ${!list.length && html`<p class="muted small">Not in this file any more.</p>`}
      </nav>
    </div>
  </aside>`;
}
