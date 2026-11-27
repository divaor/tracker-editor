import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { createCompareView } from '../editor.js';
import { resolvedTheme } from '../settings.js';
import { Icon } from './icons.js';
import { DiffOptions, differencesText } from './diffOptions.js';
import { diffOptionsOf } from '../lineDiff.js';

const NARROW = '(max-width: 860px)';

/**
 * Two texts compared, in place of the editor: side by side on wide screens (unless one text is
 * chosen), one text with the changes marked on phones. The bar's choices (whitespace,
 * highlighting, folding, layout) are the comparisons' settings (ui/diffOptions.js). `compare`
 * is { left, right, name, language, actions }, where left/right are { label, text, detail? }
 * (`detail`: where the file is, e.g. its folder) and actions [{ label, icon, run, primary? }]
 * sit in the bar (e.g. "Restore this version").
 */
export function CompareView({ compare, settings, onClose }) {
  const el = useRef(null);
  const api = useRef(null);
  const [changes, setChanges] = useState(null);
  const options = diffOptionsOf(settings);
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const query = matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const unified = narrow || Boolean(settings.compareUnified);
  useLayoutEffect(() => {
    api.current = createCompareView(el.current, {
      left: compare.left.text,
      right: compare.right.text,
      name: compare.name,
      language: compare.language,
      dark: resolvedTheme(settings.theme) === 'dark',
      unified,
      wrap: settings.wordWrap || narrow,
      options,
    });
    setChanges(api.current.changes());
    return () => api.current.destroy();
  }, [compare, unified, options.whitespace, options.highlight, options.collapse]);
  return html`<div class="compare ${unified ? 'unified' : ''}" role="region" aria-label="Compare">
    <div class="compare-bar">
      <span class="muted small compare-count">${changes == null ? '' : differencesText({ index: -1, count: changes })}</span>
      <button type="button" class="icon-btn sm" aria-label="Previous difference" title="Previous difference" disabled=${!changes} onClick=${() => api.current?.previous()}><${Icon} name="chevronDown" size=${16} class="up" /></button>
      <button type="button" class="icon-btn sm" aria-label="Next difference" title="Next difference" disabled=${!changes} onClick=${() => api.current?.next()}><${Icon} name="chevronDown" size=${16} /></button>
      <span class="spacer" />
      <${DiffOptions} settings=${settings} layout=${!narrow} compact />
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
