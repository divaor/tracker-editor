import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { formatDateTime, timeAgo } from '../format.js';
import { Icon } from './icons.js';

/**
 * The versions of the open file, from the data repo's history. Choosing one
 * compares it with the text now (actions.compareVersion), where it can be
 * restored, copied or opened as a new file.
 */
export function HistoryPanel({ target, selected, actions, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    actions.loadVersions(target).then(
      (versions) => !cancelled && setState({ status: 'ready', versions }),
      (err) => !cancelled && setState({ status: 'error', error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [target.key]);
  return html`<aside class="panel history-panel" aria-label="History">
    <div class="panel-head">
      <h2><${Icon} name="history" size=${16} />History</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="muted small">Every version of <strong>${target.name}</strong> synced to your data repo. Pick one to compare it with the text now${target.dirty ? ', including changes not synced yet' : ''}.</p>
      ${state.status === 'loading' && html`<p class="muted small">Loading the history…</p>`}
      ${state.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} />${state.error}</p>`}
      ${state.status === 'ready' && !state.versions.length && html`<p class="muted small">No versions yet: they appear once the file has synced.</p>`}
      <div class="version-list">
        ${state.status === 'ready' &&
        state.versions.map(
          (v, i) => html`<button type="button" key=${v.sha} class="version-row ${selected === v.sha ? 'active' : ''}" onClick=${() => actions.compareVersion(target, v)}>
            <span class="version-date">${formatDateTime(v.date)}${i === 0 ? html` <span class="badge-latest">latest</span>` : ''}</span>
            <span class="version-meta muted small">${v.who || 'Unknown device'} · ${timeAgo(v.date)}</span>
          </button>`,
        )}
      </div>
    </div>
  </aside>`;
}
