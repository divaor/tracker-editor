import { html } from '../../vendor/preact-htm.js';
import { fileTypeOf } from '../fileTypes.js';
import { Icon } from './icons.js';

// The glyphs of fileTypes.js, 24×24 strokes like the app's icons.
const GLYPHS = {
  cup: () => html`<path d="M5 10h11v3.5a5.5 5.5 0 0 1-5.5 5.5A5.5 5.5 0 0 1 5 13.5z" /><path d="M16 11h1.2a2.6 2.6 0 0 1 0 5.2h-1.6M8.5 3.5c-.9 1 .9 2 0 3.3M12.5 3.5c-.9 1 .9 2 0 3.3M4 21.5h13" />`,
  angle: () => html`<path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5M13.5 4.5l-3 15" />`,
  hash: () => html`<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15.5M3.5 15H19" />`,
  braces: () => html`<path d="M8.5 4H7.5A2 2 0 0 0 5.5 6v3.5A2.5 2.5 0 0 1 3 12a2.5 2.5 0 0 1 2.5 2.5V18a2 2 0 0 0 2 2h1M15.5 4h1a2 2 0 0 1 2 2v3.5A2.5 2.5 0 0 0 21 12a2.5 2.5 0 0 0-2.5 2.5V18a2 2 0 0 1-2 2h-1" />`,
  tree: () => html`<path d="M4 5h8M9 10h11M9 15h8M4 20h9" /><path d="M5.5 10h.01M5.5 15h.01" />`,
  gear: () => html`<circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />`,
  markdown: () => html`<rect x="2" y="5" width="20" height="14" rx="2.5" /><path d="M5.5 15V9l3 3.5 3-3.5v6M16.5 9v5.5M14 12.5l2.5 2.5 2.5-2.5" />`,
  lines: () => html`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M8.5 13h7M8.5 17h5" />`,
  log: () => html`<path d="M4 5h16M4 9.5h11M4 14h16M4 18.5h9" />`,
  table: () => html`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M3 14.5h18M9.5 4v16" />`,
  database: () => html`<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-13M4.5 12c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8" />`,
  terminal: () => html`<rect x="2.5" y="4" width="19" height="16" rx="2.5" /><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17" />`,
  box: () => html`<path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" />`,
  branch: () => html`<circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-5 4-11 9" />`,
  lock: () => html`<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />`,
  key: () => html`<circle cx="8" cy="15" r="4.5" /><path d="M11.3 11.7 20 3M16.5 6.5l2.5 2.5M14 9.2l2 2" />`,
  image: () => html`<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" />`,
  archive: () => html`<rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />`,
  music: () => html`<path d="M9 18V5.5l11-2V16" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" />`,
  film: () => html`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />`,
  binary: () => html`<rect x="6" y="6" width="12" height="12" rx="1.5" /><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5" />`,
  mail: () => html`<rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" />`,
  file: () => html`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />`,
};

// Letters on a tinted square, bigger when there are fewer.
const LETTER_SIZE = { 1: 15, 2: 12.5, 3: 9.8 };

/**
 * A file's icon by its type (fileTypes.js): a colored glyph, or its letters (JS, PY, C#…).
 * `plain` (the setting `fileIcons` off) gives the plain file outline. Its title says the type.
 */
export function FileIcon({ name, language = '', size = 15, plain = false }) {
  if (plain) return html`<${Icon} name="file" size=${size} />`;
  const t = fileTypeOf(name, language);
  const draw = t.glyph
    ? html`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[t.glyph]()}</g>`
    : html`<rect x="1" y="2.5" width="22" height="19" rx="4" fill="currentColor" fill-opacity="0.16" />
        <text x="12" y="12.4" text-anchor="middle" dominant-baseline="central" font-size=${LETTER_SIZE[t.letters.length] ?? 9.8} font-weight="800"
        letter-spacing=${t.letters.length > 2 ? '-0.5' : '-0.3'} fill="currentColor">${t.letters}</text>`;
  return html`<span class="file-icon ft-${t.color} ${t.letters ? 'letters' : ''}" title=${t.label} aria-hidden="true">
    <svg width=${size} height=${size} viewBox="0 0 24 24">${draw}</svg>
  </span>`;
}
