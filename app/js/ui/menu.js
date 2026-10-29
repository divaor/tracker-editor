import { html, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';

// Items left out (false) and the separators they leave at the ends or next to each other.
function tidyItems(items) {
  const out = [];
  for (const item of items) {
    if (!item || (item.separator && (!out.length || out.at(-1).separator))) continue;
    out.push(item);
  }
  if (out.at(-1)?.separator) out.pop();
  return out;
}

/**
 * A small menu at a point: { x, y }, or { x, y, right: true } to end at x
 * (under a button at the window's edge), `above: true` to end at y (over the status bar). Fixed, so bars that scroll sideways
 * do not clip it. Items: { label, icon?, run, disabled?, danger?, checked?, hint?, key? },
 * { separator: true } or { heading: true, label, color? }. Closes on a choice, a click elsewhere or Escape.
 */
export function Menu({ items, at, onClose, label = 'Menu', owner, className = '' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const el = ref.current;
    // Inside the window.
    const r = el.getBoundingClientRect();
    const x = at.right ? at.x - r.width : at.x;
    const y = at.above ? at.y - r.height : at.y;
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
    el?.querySelector('button:not(:disabled)')?.focus();
    // A press on the button that opened it is left to the button, which toggles.
    const onDown = (e) => !el.contains(e.target) && !owner?.current?.contains(e.target) && onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...el.querySelectorAll('button:not(:disabled)')];
        const i = buttons.indexOf(document.activeElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return html`<div class="menu ${className}" role="menu" aria-label=${label} ref=${ref} style=${{ left: `${pos.left}px`, top: `${pos.top}px` }}>
    ${tidyItems(items).map((item, i) =>
      item.separator
        ? html`<div class="menu-separator" key=${`s${i}`} role="separator" />`
        : item.heading
          ? html`<div class="menu-heading" key=${item.key ?? `h${i}`} role="presentation">${item.color && html`<span class="view-dot" style=${{ '--gc': item.color }} />`}${item.label}</div>`
          : html`<button type="button" key=${item.key ?? item.label} role="menuitem" class="menu-item ${item.danger ? 'danger' : ''}" disabled=${item.disabled} title=${item.hint}
            onClick=${() => {
              onClose();
              item.run();
            }}>
            ${item.icon ? html`<${Icon} name=${item.icon} size=${15} />` : html`<span class="menu-icon" />`}<span>${item.label}</span>${item.hint && html`<span class="menu-hint">${item.hint}</span>`}${item.checked && html`<${Icon} name="check" size=${14} />`}
          </button>`,
    )}
  </div>`;
}

/** A button that opens a Menu under it. `items` may be a function, called when it opens. */
export function MenuButton({ items, label, icon = 'more', className = 'icon-btn sm' }) {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  const toggle = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(at ? null : { x: r.right, y: r.bottom + 4, right: true });
  };
  return html`<button type="button" ref=${button} class=${className} aria-label=${label} title=${label} aria-haspopup="menu" aria-expanded=${Boolean(at)} onClick=${toggle}>
      <${Icon} name=${icon} size=${16} />
    </button>
    ${at && html`<${Menu} items=${typeof items === 'function' ? items() : items} at=${at} label=${label} owner=${button}
        onClose=${() => {
          setAt(null);
          button.current?.focus();
        }} />`}`;
}
