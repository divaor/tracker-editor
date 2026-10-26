import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { createCompareView } from '../editor.js';
import { resolvedTheme } from '../settings.js';
import { Icon } from './icons.js';

const NARROW = '(max-width: 860px)';

/**
 * Two texts compared, in place of the editor: side by side on wide screens,
 * one text with the changes marked on phones. `compare` is { left, right,
 * name, language, actions }, where left/right are { label, text, detail? } (`detail`:
 * where the file is, e.g. its folder) and actions [{ label, icon, run, primary? }]
 * sit in the bar (e.g. "Restore this version").
 */
export function CompareView({ compare, settings, onClose }) {
  const el = useRef(null);
  const api = useRef(null);
  const [changes, setChanges] = useState(null);
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useLayoutEffect(() => {
    api.current = createCompareView(el.current, {
      left: compare.left.text,
      right: compare.right.text,
      name: compare.name,
      language: compare.language,
      dark: resolvedTheme(settings.theme) === 'dark',
      unified: narrow,
      wrap: settings.wordWrap || narrow,
    });
    setChanges(api.current.changes());
    return () => api.current.destroy();
  }, [compare, narrow]);
  return html`<div class="compare ${narrow ? 'unified' : ''}" role="region" aria-label="Compare">
    <div class="compare-bar">
      <span class="muted small compare-count">${changes === 0 ? 'No differences' : changes ? `${changes} change${changes === 1 ? '' : 's'}` : ''}</span>
      <button type="button" class="icon-btn sm" aria-label="Previous change" title="Previous change" disabled=${!changes} onClick=${() => api.current?.previous()}><${Icon} name="chevronDown" size=${16} class="up" /></button>
      <button type="button" class="icon-btn sm" aria-label="Next change" title="Next change" disabled=${!changes} onClick=${() => api.current?.next()}><${Icon} name="chevronDown" size=${16} /></button>
      <span class="spacer" />
      ${(compare.actions ?? []).map(
        (a) => html`<button type="button" key=${a.label} class="btn sm ${a.primary ? 'primary' : ''}" title=${a.label} aria-label=${a.label} onClick=${a.run}><${Icon} name=${a.icon} size=${14} /><span class="label">${a.label}</span></button>`,
      )}
      <button type="button" class="icon-btn sm" aria-label="Close the comparison" title="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="compare-heads">
      ${[['old', '−', compare.left], ['new', '+', compare.right]].map(
        ([side, mark, s]) => html`<span class="compare-side ${side}" key=${side} title=${s.detail ? `${s.label}\n${s.detail}` : s.label}>
          <span class="compare-mark" aria-hidden="true">${mark}</span><span class="compare-label">${s.label}</span>
          ${s.detail && html`<span class="compare-detail"><bdi>${s.detail}</bdi></span>`}
        </span>`,
      )}
    </div>
    <div class="compare-body" ref=${el} />
  </div>`;
}
