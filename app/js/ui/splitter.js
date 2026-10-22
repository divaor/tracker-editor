import { html } from '../../vendor/preact-htm.js';

/**
 * A handle to drag between two areas ('vertical': a line between left and right).
 * `onMove(delta)` gets the pointer's travel since the drag started, `onEnd()` comes
 * when it is let go; the arrow keys move it by 24px, a double click calls `onReset`.
 */
export function Splitter({ orientation = 'vertical', label, onStart, onMove, onEnd, onReset, className = '' }) {
  const across = orientation === 'vertical';
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = across ? e.clientX : e.clientY;
    onStart?.();
    // Frames (HTML previews) would swallow the pointer while it crosses them.
    document.body.classList.add(across ? 'resizing-x' : 'resizing-y');
    const move = (ev) => onMove((across ? ev.clientX : ev.clientY) - from);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      onEnd?.();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  const key = (e) => {
    const step = { ArrowLeft: -24, ArrowRight: 24, ArrowUp: -24, ArrowDown: 24 }[e.key];
    if (!step || across !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    e.preventDefault();
    onStart?.();
    onMove(step);
    onEnd?.();
  };
  return html`<div class="splitter ${orientation} ${className}" role="separator" tabindex="0" aria-orientation=${orientation} aria-label=${label}
    title=${`${label} (double-click: back to the default)`} onPointerDown=${down} onDblClick=${onReset} onKeyDown=${key} />`;
}
