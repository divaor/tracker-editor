// The parts every pick list shares (quick open, the command palette, symbols, snippets, the
// clipboard history): the row the keys move to scrolls into view, the pointer takes the
// selection only when it really moves (rows passing under a still pointer while the list
// scrolls must not take it from the keys), the letters that matched, and the keys in a footer.
import { html, useLayoutEffect, useRef } from '../../vendor/preact-htm.js';
import { stepIndex } from '../quickRows.js';
import { Icon } from './icons.js';

const selectedIn = (list) => list?.querySelector('[aria-selected="true"]');

/**
 * For a list element (`listRef`) whose rows carry `role="option"` and `aria-selected`, with the
 * selection `index` and its setter: `key(e, { empty })` moves it for ↑ ↓ PageUp PageDown (Home
 * End with Ctrl, or alone in an `empty` field) and says whether it took the key; `hover(i)` gives
 * a row's onPointerMove; `reset()` scrolls back to the top (a new query).
 */
export function useListNav(listRef, index, setIndex, count) {
  const byKeys = useRef(false);
  const pointer = useRef(null);
  useLayoutEffect(() => {
    if (!byKeys.current) return;
    byKeys.current = false;
    selectedIn(listRef.current)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  // A page: the rows that fit, less one (the one kept in view).
  const page = () => {
    const list = listRef.current;
    const row = list?.querySelector('[role="option"]');
    return row?.offsetHeight ? Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1) : 8;
  };
  return {
    key(e, { empty = false } = {}) {
      const next = stepIndex(e, index, count, { page: page(), empty });
      if (next === null) return false;
      e.preventDefault();
      // At an end the index stays: bring its row back into view all the same (it may have been scrolled away).
      if (next === index) selectedIn(listRef.current)?.scrollIntoView({ block: 'nearest' });
      else {
        byKeys.current = true;
        setIndex(next);
      }
      return true;
    },
    // The first move only says where the pointer is; then a move to another place picks the row
    // under it. Rows scrolled under a still pointer (and the moves some browsers make up then) do not.
    hover: (i) => (e) => {
      if (e.pointerType === 'touch') return;
      const was = pointer.current;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!was || (was.x === e.clientX && was.y === e.clientY)) return;
      if (i !== index) setIndex(i);
    },
    reset() {
      if (listRef.current) listRef.current.scrollTop = 0;
    },
  };
}

/** `text` with the `ranges` ([[from, to], …], in order) in <mark>. */
export function Marked({ text, ranges }) {
  const s = String(text ?? '');
  if (!ranges?.length) return s;
  const out = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) out.push(s.slice(at, from));
    out.push(html`<mark>${s.slice(from, to)}</mark>`);
    at = to;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/**
 * A section of a pick list: its header (an `icon`, the `label`, the `count`; `tone` a class that
 * colors it), which stays at the top while its rows show, then the rows. No label: the rows alone.
 */
export function ListSection({ label, count, icon = '', tone = '', children }) {
  if (!label) return children;
  return html`<div class="qo-section" role="group" aria-label=${label}>
    <div class="qo-head ${tone}" aria-hidden="true">
      ${icon && html`<${Icon} name=${icon} size=${13} />`}<span class="qo-head-label">${label}</span><span class="qo-count">${count}</span>
    </div>
    ${children}
  </div>`;
}

/** What a pick list shows when it has nothing: an icon, a line, then what to do. */
export function ListEmpty({ icon = 'search', title, children = null }) {
  return html`<div class="qo-empty">
    <span class="qo-empty-icon"><${Icon} name=${icon} size=${20} /></span>
    <p class="qo-empty-title">${title}</p>
    ${children && html`<p class="qo-empty-text">${children}</p>`}
  </div>`;
}

/** A pick list's footer: the keys it takes (`action`: what Enter does), then `children` (quick open's prefixes). */
export function ListFoot({ action = 'open', children = null }) {
  return html`<div class="qo-foot">
    <span class="qo-keys" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>↵</kbd> ${action}</span>
      <span><kbd>Esc</kbd> close</span>
    </span>
    ${children}
  </div>`;
}
