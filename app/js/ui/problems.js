import { html } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';

/** "2 problems", "1 error, 1 warning": for the status bar and the panel. */
export function problemsSummary(list) {
  const errors = list.filter((p) => p.severity === 'error').length;
  const warnings = list.length - errors;
  if (!list.length) return 'No problems';
  return [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ');
}

/**
 * The problems found in the open file as you type (Ctrl+Shift+M): click one to go there;
 * F8 / Shift+F8 go to the next and the one before.
 */
export function ProblemsPanel({ name, fileKey, problems, actions, onClose }) {
  const list = problems?.list ?? [];
  const checked = Boolean(problems);
  return html`<aside class="panel problems-panel" aria-label="Problems">
    <div class="panel-head">
      <h2><${Icon} name="alert" size=${16} />Problems</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="muted small">${checked ? `${problemsSummary(list)} in ${name}${list.length ? ' · F8 goes to the next one, Shift+F8 to the one before' : ''}` : `${name} is not checked: problems show for JSON, YAML, XML, HTML, CSS and code (JavaScript, TypeScript, Python, Go, Java, PHP, C, C++, Rust).`}</p>
      <nav class="problems-list" aria-label=${`Problems in ${name}`}>
        ${list.map(
          (p, i) => html`<button type="button" key=${`${p.from}-${i}`} class="outline-row problem-row ${p.severity}" onClick=${() => actions.revealRange(p.from, p.to, fileKey)} title=${`Line ${p.line}, column ${p.column}`}>
            <${Icon} name=${p.severity === 'error' ? 'xCircle' : 'alert'} size=${14} class="problem-icon" />
            <span class="problem-message">${p.message}</span>
            <span class="problem-where">Ln ${p.line}, Col ${p.column}</span>
          </button>`,
        )}
        ${checked && !list.length && html`<p class="muted small problems-none"><${Icon} name="check" size=${14} />Nothing wrong found.</p>`}
      </nav>
    </div>
  </aside>`;
}
