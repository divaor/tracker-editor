import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { renderMarkdown } from '../markdown.js';
import { toggleChecklistItem } from '../tracker-model.js';

/** Rendered Markdown next to (or, on phones, instead of) the text. Ticking a box edits the text. */
export function MarkdownPreview({ text = '', onToggle }) {
  const [shown, setShown] = useState(text);
  // Re-render a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setShown(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  const onClick = (e) => {
    const box = e.target.closest?.('input.md-check');
    if (!box) return;
    e.preventDefault();
    const index = [...e.currentTarget.querySelectorAll('input.md-check')].indexOf(box);
    const next = toggleChecklistItem(text, index);
    setShown(next);
    onToggle(next);
  };
  return html`<div class="preview-pane"><div class="markdown preview-body" onClick=${onClick} dangerouslySetInnerHTML=${{ __html: renderMarkdown(shown) }} /></div>`;
}
