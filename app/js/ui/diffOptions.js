import { html, useRef, useState } from '../../vendor/preact-htm.js';
import { diffOptionsOf } from '../lineDiff.js';
import { saveSettings } from '../settings.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';

// How two texts are compared and shown (the bars of ui/compareTab.js and ui/compare.js), as
// JetBrains' diff viewer offers it. Kept in settings (lineDiff.js diffOptionsOf reads them).
export const WHITESPACE_LABELS = { exact: 'Do not ignore', trim: 'Trim whitespace', ignore: 'Ignore whitespace' };
const WHITESPACE_HINTS = { exact: 'Every space counts', trim: 'Not at line ends', ignore: 'No space counts' };
export const HIGHLIGHT_LABELS = { words: 'Highlight words', lines: 'Highlight lines', chars: 'Highlight characters', none: 'Do not highlight' };
const HIGHLIGHT_HINTS = { words: 'The words that changed', lines: 'Whole lines only', chars: 'The characters that changed', none: 'Only the bars and ribbons' };

/** "5 differences", "2 of 5 differences" (the cursor in the 2nd), "No differences". */
export const differencesText = ({ index, count }) => (count === 0 ? 'No differences' : `${index >= 0 ? `${index + 1} of ` : ''}${count.toLocaleString()} difference${count === 1 ? '' : 's'}`);

function Choice({ name, icon, value, labels, hints, onPick }) {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  return html`<button type="button" ref=${button} class="btn ghost sm diff-choice" aria-haspopup="menu" aria-expanded=${Boolean(at)} title=${`${name}: ${labels[value]}`}
      onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAt(at ? null : { x: r.left, y: r.bottom + 4 });
      }}><${Icon} name=${icon} size=${14} /><span class="label">${labels[value]}</span><${Icon} name="chevronDown" size=${12} class="diff-choice-caret" /></button>
    ${at &&
    html`<${Menu} label=${name} at=${at} owner=${button}
      items=${Object.keys(labels).map((k) => ({ label: labels[k], hint: hints[k], checked: k === value, run: () => onPick(k) }))}
      onClose=${() => {
        setAt(null);
        button.current?.focus();
      }} />`}`;
}

/**
 * The view choices of a comparison: which spaces count, what is marked inside changed lines,
 * unchanged lines folded away, and (where there is room for both) side by side or one text.
 * `compact`: all of them in one menu (a bar with buttons of its own).
 */
export function DiffOptions({ settings, layout = true, compact = false }) {
  const o = diffOptionsOf(settings);
  const unified = Boolean(settings.compareUnified);
  if (compact) {
    const pick = (labels, value, key) => Object.keys(labels).map((k) => ({ key: `${key}-${k}`, label: labels[k], checked: k === value, run: () => saveSettings({ [key]: k }) }));
    const items = () => [
      { heading: true, label: 'Whitespace' },
      ...pick(WHITESPACE_LABELS, o.whitespace, 'compareWhitespace'),
      { heading: true, label: 'Highlighting' },
      ...pick(HIGHLIGHT_LABELS, o.highlight, 'compareHighlight'),
      { separator: true },
      { label: 'Collapse unchanged lines', icon: 'foldLines', checked: o.collapse, run: () => saveSettings({ compareCollapse: !o.collapse }) },
      layout && { label: unified ? 'Side by side' : 'As one text (unified)', icon: unified ? 'columns' : 'unified', run: () => saveSettings({ compareUnified: !unified }) },
    ];
    return html`<${MenuButton} label="How the comparison shows" icon="eye" items=${items} />`;
  }
  return html`<span class="diff-options">
    <${Choice} name="Whitespace" icon="indent" value=${o.whitespace} labels=${WHITESPACE_LABELS} hints=${WHITESPACE_HINTS} onPick=${(v) => saveSettings({ compareWhitespace: v })} />
    <${Choice} name="Highlighting" icon="eye" value=${o.highlight} labels=${HIGHLIGHT_LABELS} hints=${HIGHLIGHT_HINTS} onPick=${(v) => saveSettings({ compareHighlight: v })} />
    <button type="button" class="icon-btn sm diff-toggle ${o.collapse ? 'on' : ''}" aria-pressed=${o.collapse} title=${o.collapse ? 'Unchanged lines folded away: show them all' : 'Fold away the unchanged lines'}
      aria-label="Collapse unchanged lines" onClick=${() => saveSettings({ compareCollapse: !o.collapse })}><${Icon} name="foldLines" size=${16} /></button>
    ${layout &&
    html`<button type="button" class="icon-btn sm diff-toggle" title=${unified ? 'Side by side' : 'As one text (unified)'} aria-label=${unified ? 'Side by side' : 'As one text'}
      onClick=${() => saveSettings({ compareUnified: !unified })}><${Icon} name=${unified ? 'columns' : 'unified'} size=${16} /></button>`}
  </span>`;
}
