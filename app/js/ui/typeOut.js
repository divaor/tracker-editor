import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { formatDuration, typingSeconds } from '../typing.js';
import { Icon } from './icons.js';

/**
 * The countdown before typing into another window, then the progress. `job` is
 * { total, at, delay, typed, what }; `typed` comes from the desktop app where it
 * reports it (Windows), otherwise it is estimated from the time.
 */
export function TypeOutPanel({ job, onStop }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const left = Math.ceil((job.at - now) / 1000);
  const typed = job.typed || Math.min(job.total, Math.max(0, Math.floor((now - job.at) / (job.delay + 3))));
  return html`<div class="type-out" role="status" aria-live="polite">
    <${Icon} name="keyboard" size=${20} />
    ${left > 0
      ? html`<span class="type-out-text"><strong class="type-out-count">${left}</strong> Click into the window to type into. The ${job.what} (${job.total.toLocaleString()} characters, about ${formatDuration(typingSeconds(job.total, job.delay))}) is typed there.</span>`
      : html`<span class="type-out-text">Typing… ${typed.toLocaleString()} of ${job.total.toLocaleString()}. Press Escape there or Stop here to stop.</span>
          <progress max=${job.total} value=${typed} />`}
    <button type="button" class="btn sm" onClick=${onStop}><${Icon} name="stop" size=${14} />${left > 0 ? 'Cancel' : 'Stop'}</button>
  </div>`;
}
