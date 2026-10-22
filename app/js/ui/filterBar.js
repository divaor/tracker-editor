import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { ClearButton, Segmented, toast } from './components.js';
import { Icon } from './icons.js';

const MODES = [
  { id: 'show', label: 'Show only' },
  { id: 'hide', label: 'Hide' },
];

/**
 * Filters the lines of the open tab (Alt+L): show only the lines that match,
 * or hide them. Display only: the text stays as it is, line numbers too.
 */
export function FilterBar({ tabKey, actions, onClose }) {
  const initial = actions.lineFilter(tabKey).filter;
  const [pattern, setPattern] = useState(initial?.pattern ?? '');
  const [mode, setMode] = useState(initial?.mode ?? 'show');
  const [regex, setRegex] = useState(initial?.regex ?? false);
  const [caseSensitive, setCaseSensitive] = useState(initial?.caseSensitive ?? false);
  const [stats, setStats] = useState(() => actions.lineFilter(tabKey));
  const [error, setError] = useState('');
  const input = useRef(null);
  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setStats(actions.setLineFilter(tabKey, pattern ? { pattern, mode, regex, caseSensitive } : null));
        setError('');
      } catch (err) {
        setError(err.message);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [pattern, mode, regex, caseSensitive]);
  const close = () => {
    actions.setLineFilter(tabKey, null);
    onClose();
  };
  const lines = () => actions.shownLines(tabKey);
  return html`<div class="filter-bar" role="search" aria-label="Filter lines">
    <${Icon} name="search" size=${15} />
    <${Segmented} small options=${MODES} value=${mode} onChange=${setMode} label="Filter mode" />
    <input ref=${input} value=${pattern} onInput=${(e) => setPattern(e.currentTarget.value)} placeholder=${regex ? 'Regular expression, e.g. ERROR|WARN' : 'Text in the lines, e.g. ERROR'} aria-label="Filter"
      class=${error ? 'invalid' : ''} spellcheck=${false} onKeyDown=${(e) => e.key === 'Escape' && (e.preventDefault(), close())} />
    <${ClearButton} value=${pattern} onClear=${() => setPattern('')} label="Clear the filter" />
    <button type="button" class="icon-btn sm toggle ${caseSensitive ? 'on' : ''}" aria-pressed=${caseSensitive} title="Match case" aria-label="Match case" onClick=${() => setCaseSensitive(!caseSensitive)}>Aa</button>
    <button type="button" class="icon-btn sm toggle ${regex ? 'on' : ''}" aria-pressed=${regex} title="Regular expression" aria-label="Regular expression" onClick=${() => setRegex(!regex)}>.*</button>
    <span class="muted small filter-count">${error || (pattern ? `${stats.shown.toLocaleString()} of ${stats.total.toLocaleString()} lines` : `${stats.total.toLocaleString()} lines`)}</span>
    <span class="spacer" />
    <button type="button" class="btn ghost sm" disabled=${!pattern || !!error} title="Copy the lines shown" onClick=${() => navigator.clipboard.writeText(lines()).then(() => toast('The lines shown are on the clipboard'))}><${Icon} name="copy" size=${14} /><span class="label">Copy</span></button>
    <button type="button" class="btn ghost sm" disabled=${!pattern || !!error} title="A new file with the lines shown" onClick=${() => actions.newFile({ text: lines() })}><${Icon} name="filePlus" size=${14} /><span class="label">New file</span></button>
    <button type="button" class="icon-btn sm" aria-label="Close the filter" title="Close (shows every line)" onClick=${close}><${Icon} name="x" size=${15} /></button>
  </div>`;
}
