// Touch screens: the edit bar that takes the status bar's place while you type (keys a phone
// keyboard lacks, symbols, tools), and the small menu a tap on a line number opens. Their buttons
// never take the focus, so the text keeps it and the keyboard stays up.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { EDIT_SYMBOLS, REPEAT_DELAY, REPEAT_EVERY } from '../editKeys.js';
import { Icon } from './icons.js';

// The row last shown (keys or symbols), for the next time the bar comes up.
let lastRow = 'keys';

const keep = (e) => e.preventDefault();

/** One button of the bar. `repeat`: held down, it presses again and again (the arrows). */
function Key({ label, icon, title, on, repeat, onPress, cls = '' }) {
  const timer = useRef(null);
  const repeated = useRef(false);
  const stop = () => {
    clearTimeout(timer.current);
    clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const down = (e) => {
    e.preventDefault();
    if (!repeat) return;
    repeated.current = false;
    stop();
    timer.current = setTimeout(() => {
      repeated.current = true;
      onPress();
      timer.current = setInterval(onPress, REPEAT_EVERY);
    }, REPEAT_DELAY);
  };
  return html`<button type="button" tabindex="-1" class="edit-key ${cls} ${on ? 'on' : ''}" aria-label=${title ?? label} title=${title ?? label}
    aria-pressed=${on === undefined ? undefined : String(Boolean(on))}
    onPointerDown=${down} onMouseDown=${keep} onPointerUp=${stop} onPointerCancel=${stop} onContextMenu=${keep}
    onClick=${() => {
      if (repeated.current) return void (repeated.current = false);
      onPress();
    }}>
    ${icon && html`<${Icon} name=${icon} size=${17} />`}${label && html`<span>${label}</span>`}
  </button>`;
}

/**
 * The edit bar: one row at a time. Keys (Tab, Ctrl, Select, arrows, Undo, Redo), symbols, or
 * tools (clipboard, selecting, lines, find, save, the model, hiding the keyboard). `save` is
 * the label of Ctrl+S here ('Save', 'Sync') or null.
 */
export function EditBar({ host, actions, save }) {
  const [row, setRow] = useState(lastRow);
  const [select, setSelect] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  useEffect(() => {
    if (row !== 'tools') lastRow = row;
  }, [row]);
  useEffect(() => {
    // The bar took the status bar's place (a little taller): keep the cursor in view.
    requestAnimationFrame(() => host.revealCursor());
    return () => host.armCtrl(null);
  }, []);
  // Where the keyboard covers the page instead of shortening it (iOS), lift the bar above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const place = () => root.style.setProperty('--edit-lift', `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
    place();
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
    return () => {
      vv.removeEventListener('resize', place);
      vv.removeEventListener('scroll', place);
      root.style.removeProperty('--edit-lift');
    };
  }, []);

  const dropCtrl = () => {
    setCtrl(false);
    host.armCtrl(null);
  };
  const toggleCtrl = () => {
    const next = !ctrl;
    setCtrl(next);
    // The next character typed comes with Ctrl too (Ctrl, then a: select all).
    host.armCtrl(next ? () => setCtrl(false) : null);
  };
  // A key as the keyboard would press it; Select works as Shift for moving keys.
  const press = (key, { moves = false } = {}) => {
    host.pressKey({ key, shiftKey: moves && select, ctrlKey: ctrl });
    if (ctrl) dropCtrl();
  };
  const command = (name) => () => {
    if (ctrl) dropCtrl();
    host.run(name);
  };

  const other = row === 'symbols' ? 'keys' : row === 'keys' ? 'symbols' : lastRow === 'keys' ? 'symbols' : 'keys';
  const switcher = html`<${Key} cls="edit-switch" title=${other === 'symbols' ? 'Symbols' : 'Arrows and keys'} icon=${other === 'keys' ? 'keyboard' : null} label=${other === 'symbols' ? '{ }' : null}
    onPress=${() => setRow(other)} />`;
  const moreKey = html`<${Key} cls="edit-switch" title=${row === 'tools' ? 'Back to the keys' : 'More: copy, paste, select, lines, find…'} icon="more" on=${row === 'tools'}
    onPress=${() => setRow(row === 'tools' ? lastRow : 'tools')} />`;

  const tools = [
    { label: 'Copy', icon: 'copy', run: () => actions.editClip('copy') },
    { label: 'Cut', icon: 'scissors', run: () => actions.editClip('cut') },
    { label: 'Paste', icon: 'clipboard', run: () => actions.editClip('paste') },
    { label: 'Select all', run: command('selectAll') },
    { label: 'Select line', run: command('selectLine') },
    { label: 'Find', icon: 'search', run: command('find') },
    save && { label: save, icon: 'save', run: () => actions.saveOrSync() },
    { label: 'Comment', run: command('toggleComment') },
    { label: 'Duplicate', run: command('duplicateLine') },
    { label: 'Delete line', run: command('deleteLine') },
    { label: 'Line up', icon: 'arrowUp', run: command('moveLineUp') },
    { label: 'Line down', icon: 'arrowDown', run: command('moveLineDown') },
    { label: 'Outdent', run: command('indentLess') },
    { label: 'Indent', icon: 'indent', run: command('indentMore') },
    { label: 'Line start', run: () => press('Home', { moves: true }) },
    { label: 'Line end', run: () => press('End', { moves: true }) },
    { label: 'Go to line', run: command('gotoLine') },
    { label: 'Esc', run: () => press('Escape') },
    { label: 'Ask', icon: 'sparkle', run: () => actions.askSelection() },
    { label: 'Hide keyboard', icon: 'keyboardDown', run: () => actions.hideKeyboard() },
  ].filter(Boolean);

  return html`<div class="edit-bar" role="toolbar" aria-label="Edit bar" data-row=${row}>
    ${switcher}
    <div class="edit-row" key=${row} onPointerDown=${(e) => e.target === e.currentTarget && e.preventDefault()}>
      ${row === 'keys' &&
      html`<${Key} label="Tab" title="Tab" onPress=${() => press('Tab')} />
        <${Key} label="Ctrl" title="Ctrl: the next key or letter comes with it (Ctrl, then a: select all)" on=${ctrl} onPress=${toggleCtrl} />
        <${Key} label="Select" title="Select: the arrows select (as Shift does)" on=${select} onPress=${() => setSelect(!select)} />
        <${Key} icon="arrowLeft" title="Left" repeat onPress=${() => press('ArrowLeft', { moves: true })} />
        <${Key} icon="arrowUp" title="Up" repeat onPress=${() => press('ArrowUp', { moves: true })} />
        <${Key} icon="arrowDown" title="Down" repeat onPress=${() => press('ArrowDown', { moves: true })} />
        <${Key} icon="arrowRight" title="Right" repeat onPress=${() => press('ArrowRight', { moves: true })} />
        <${Key} icon="undo" title="Undo" onPress=${command('undo')} />
        <${Key} icon="redo" title="Redo" onPress=${command('redo')} />`}
      ${row === 'symbols' && EDIT_SYMBOLS.map((ch) => html`<${Key} key=${ch} cls="edit-symbol" label=${ch} title=${`Type ${ch}`} onPress=${() => host.typeText(ch)} />`)}
      ${row === 'tools' && tools.map((t) => html`<${Key} key=${t.label} cls="edit-tool" icon=${t.icon} label=${t.label} onPress=${t.run} />`)}
    </div>
    ${moreKey}
  </div>`;
}

/**
 * The menu by a line number: Copy, Cut, Paste, Select all, and under ⋯ a few line tools.
 * `at`: { x, top, bottom } of the line number; it opens above the line when there is room.
 */
export function LineMenu({ at, host, actions, onClose }) {
  const ref = useRef(null);
  const [more, setMore] = useState(false);
  const [pos, setPos] = useState({ left: at.x + 6, top: at.top, hidden: true });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    const above = at.top - r.height - 6;
    const top = above >= 8 ? above : Math.min(at.bottom + 6, innerHeight - r.height - 8);
    setPos({ left: Math.max(8, Math.min(at.x + 6, innerWidth - r.width - 8)), top: Math.max(8, top) });
  }, [more]);
  useEffect(() => {
    // Another line number tapped opens the menu there (the editor says so); anything else closes it.
    const onDown = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.cm-lineNumbers') && onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') e.preventDefault();
      onClose();
    };
    const onScroll = (e) => !ref.current?.contains(e.target) && onClose();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, []);
  const then = (run, { stay = false } = {}) => () => {
    if (!stay) onClose();
    run();
  };
  // Commands here leave the keyboard down on a phone (the text gets no focus).
  const command = (name) => () => host.run(name, { focus: false });
  const items = more
    ? [
        { label: 'Duplicate', run: then(command('duplicateLine')) },
        { label: 'Comment', run: then(command('toggleComment')) },
        { label: 'Delete', run: then(command('deleteLine')) },
        { label: 'Ask', icon: 'sparkle', title: 'Ask the model about these lines', run: then(() => actions.askSelection()) },
      ]
    : [
        { label: 'Copy', icon: 'copy', run: then(() => actions.editClip('copy')) },
        { label: 'Cut', icon: 'scissors', run: then(() => actions.editClip('cut')) },
        { label: 'Paste', icon: 'clipboard', run: then(() => actions.editClip('paste')) },
        { label: 'Select all', run: then(command('selectAll'), { stay: true }) },
      ];
  return html`<div class="line-menu" role="menu" aria-label="Line" ref=${ref} style=${{ left: `${pos.left}px`, top: `${pos.top}px`, visibility: pos.hidden ? 'hidden' : undefined }}>
    ${items.map((item) => html`<button type="button" key=${item.label} role="menuitem" tabindex="-1" class="line-menu-item" title=${item.title ?? item.label}
      onPointerDown=${keep} onMouseDown=${keep} onClick=${item.run}>
      ${item.icon && html`<${Icon} name=${item.icon} size=${15} />`}<span>${item.label}</span>
    </button>`)}
    <button type="button" role="menuitem" tabindex="-1" class="line-menu-item line-menu-more" aria-label=${more ? 'Back' : 'More'} title=${more ? 'Back' : 'More: duplicate, comment, delete, ask'}
      aria-expanded=${String(more)} onPointerDown=${keep} onMouseDown=${keep} onClick=${() => setMore(!more)}>
      <${Icon} name=${more ? 'arrowLeft' : 'more'} size=${15} />
    </button>
  </div>`;
}
