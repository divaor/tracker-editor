import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { documentKind } from '../docTypes.js';
import { peekKind } from '../folders.js';
import { formatBytes, timeAgo } from '../format.js';
import { previewKind } from '../previews.js';
import { Icon } from './icons.js';
import { DocumentView } from './documentView.js';
import { PreviewBody } from './preview.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif' };
const extOf = (name) => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * What a file holds, read for a preview (a moment after it is picked, so moving
 * through a list stays quick): { kind, url } for pictures (a blob URL, revoked when
 * it changes), { kind: 'text', text, more } for text, { kind: 'doc' } for documents
 * (their view reads them), or { error }.
 */
function usePeek(entry) {
  const [peek, setPeek] = useState(null);
  useEffect(() => {
    setPeek(null);
    if (!entry || entry.dir) return;
    const kind = peekKind(entry.name);
    if (kind === 'none') return setPeek({ kind });
    if (kind === 'doc') return setPeek({ kind });
    let url = '';
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const bridge = window.desktop.folders;
        if (kind === 'text') {
          const got = await bridge.peekText(entry.path);
          if (!stale) setPeek({ kind, ...got });
          return;
        }
        const bytes = new Uint8Array(await bridge.peekBytes(entry.path));
        if (stale) return;
        url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(entry.name)] ?? 'application/octet-stream' }));
        setPeek({ kind, url });
      } catch (err) {
        if (!stale) setPeek({ kind: 'none', error: message(err) });
      }
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry?.path, entry?.mtimeMs, entry?.size]);
  return peek;
}

/** The facts of a file under its preview (or instead of one). */
const Facts = ({ entry, extra = '' }) =>
  html`<p class="peek-facts muted small">${entry.dir ? 'Folder' : formatBytes(entry.size)}${entry.mtimeMs ? ` · ${timeAgo(new Date(entry.mtimeMs).toISOString())}` : ''}${extra ? ` · ${extra}` : ''}</p>`;

/** A file's preview: the picture, the document (PDF, e-book, Word…), the rendered Markdown (HTML, CSV, JSON…) or the start of its text. */
export function FilePeek({ entry, big = false, onOpen, onOpenOutside }) {
  const peek = usePeek(entry);
  const [size, setSize] = useState('');
  useEffect(() => setSize(''), [entry?.path]);
  if (!entry) return html`<div class="peek-empty muted small">Pick a file to see it here.</div>`;
  const icon = entry.dir ? 'folder' : peekKind(entry.name) === 'image' ? 'image' : 'file';
  if (entry.dir || peek?.kind === 'none') {
    return html`<div class="peek-card">
      <${Icon} name=${icon} size=${big ? 64 : 36} />
      <strong class="peek-name">${entry.name}</strong>
      <${Facts} entry=${entry} />
      ${peek?.error && html`<p class="muted small">${peek.error}</p>`}
      ${entry.dir
        ? html`<button type="button" class="btn sm" onClick=${() => onOpen(entry)}><${Icon} name="folderOpen" size=${15} />Open the folder</button>`
        : peekKind(entry.name) === 'text'
          ? html`<button type="button" class="btn sm" onClick=${() => onOpen(entry)}><${Icon} name="edit" size=${15} />Open it</button>`
          : html`<button type="button" class="btn sm" onClick=${() => onOpenOutside(entry)}><${Icon} name="external" size=${15} />Open with its program</button>`}
    </div>`;
  }
  if (!peek) return html`<div class="peek-empty muted small">Loading ${entry.name}…</div>`;
  if (peek.kind === 'image') {
    return html`<div class="peek-image">
      <img src=${peek.url} alt=${entry.name} onLoad=${(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      ${!big && html`<${Facts} entry=${entry} extra=${size} />`}
    </div>`;
  }
  if (peek.kind === 'doc') {
    return html`<${DocumentView} key=${entry.path} name=${entry.name} kind=${documentKind(entry.name)} version=${entry.mtimeMs} compact=${!big}
      load=${() => window.desktop.disk.readBytes(entry.path)} onOpenOutside=${big ? undefined : () => onOpenOutside(entry)} bookmarkKey=${big ? entry.path : undefined}
      readKey=${big ? `viewer:${entry.path}` : undefined} listenInBar />`;
  }
  const kind = previewKind(entry.name);
  return html`<div class="peek-text-wrap ${kind ? `peek-${kind}` : ''}">
    ${kind ? html`<${PreviewBody} kind=${kind} text=${peek.text} name=${entry.name} />` : html`<pre class="peek-text">${peek.text}</pre>`}
    ${peek.more && html`<p class="muted small peek-more">The start of the file. <button type="button" class="btn link" onClick=${() => onOpen(entry)}>Open it</button> for all of it.</p>`}
  </div>`;
}

/** The preview at the bottom of the folders view, for the file picked in the list. */
export function PeekPane({ entry, height, onOpen, onOpenOutside, onExpand, onReadText, onClose }) {
  return html`<section class="peek-pane" style=${{ height: `${height}px` }} aria-label="Preview">
    <div class="peek-head">
      <${Icon} name="eye" size=${14} />
      <span class="peek-title" title=${entry?.path ?? ''}>${entry?.name ?? 'Preview'}</span>
      <span class="spacer" />
      ${entry && !entry.dir && peekKind(entry.name) === 'image' && onReadText && html`<${ReadTextButton} entry=${entry} onReadText=${onReadText} />`}
      ${entry && !entry.dir && html`<button type="button" class="icon-btn sm" aria-label="View it large (Space)" title="View it large (Space)" onClick=${() => onExpand(entry)}><${Icon} name="fullscreen" size=${15} /></button>`}
      <button type="button" class="icon-btn sm" aria-label="Hide the preview" title="Hide the preview" onClick=${onClose}><${Icon} name="x" size=${15} /></button>
    </div>
    <div class="peek-body">
      <${FilePeek} entry=${entry} onOpen=${onOpen} onOpenOutside=${onOpenOutside} />
    </div>
  </section>`;
}

const ReadTextButton = ({ entry, onReadText }) =>
  html`<button type="button" class="icon-btn sm" aria-label="Text from the image" title="Text from the image: read its text on this device" onClick=${() => onReadText(entry)}><${Icon} name="scan" size=${15} /></button>`;

/**
 * Files viewed large over the window, one at a time (like Quick Look): the arrow
 * keys go to the previous and next file of the folder, Space or Escape close it.
 */
export function FileViewer({ entries, path, onPath, onOpen, onOpenOutside, onReadText, onClose }) {
  const index = Math.max(0, entries.findIndex((e) => e.path === path));
  const entry = entries[index];
  // Where it is now, ahead of the next render (keys pressed quickly in a row each count).
  const at = useRef(path);
  at.current = path;
  const go = (step) => {
    const from = Math.max(0, entries.findIndex((e) => e.path === at.current));
    const next = entries[(from + step + entries.length) % entries.length];
    if (!next) return;
    at.current = next.path;
    onPath(next.path);
  };
  // A layout effect: keys pressed right after Space already reach it.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea')) return;
      const keys = { ArrowLeft: () => go(-1), ArrowUp: () => go(-1), ArrowRight: () => go(1), ArrowDown: () => go(1), Escape: onClose, ' ': onClose, Enter: () => entry && onOpen(entry) };
      const run = keys[e.key];
      if (!run || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  if (!entry) return null;
  const inApp = ['text', 'doc'].includes(peekKind(entry.name));
  const openLabel = inApp ? 'Open' : 'Open with its program';
  return html`<div class="viewer-backdrop" role="dialog" aria-modal="true" aria-label=${`Viewing ${entry.name}`} onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="viewer">
      <div class="viewer-head">
        <${Icon} name=${peekKind(entry.name) === 'image' ? 'image' : 'file'} size=${16} />
        <strong class="viewer-name" title=${entry.path}>${entry.name}</strong>
        <span class="muted small viewer-count">${index + 1} of ${entries.length}<span class="viewer-size"> · ${formatBytes(entry.size)}</span></span>
        <span class="spacer" />
        <button type="button" class="icon-btn sm" aria-label="Previous (←)" title="Previous (←)" disabled=${entries.length < 2} onClick=${() => go(-1)}><${Icon} name="arrowUp" size=${16} class="turn-left" /></button>
        <button type="button" class="icon-btn sm" aria-label="Next (→)" title="Next (→)" disabled=${entries.length < 2} onClick=${() => go(1)}><${Icon} name="arrowUp" size=${16} class="turn-right" /></button>
        ${peekKind(entry.name) === 'image' && onReadText && html`<${ReadTextButton} entry=${entry} onReadText=${onReadText} />`}
        <button type="button" class="btn sm viewer-open" title=${`${openLabel} (Enter)`} aria-label=${openLabel} onClick=${() => onOpen(entry)}><${Icon} name=${inApp ? 'edit' : 'external'} size=${15} /><span class="viewer-open-label">${openLabel}</span></button>
        <button type="button" class="icon-btn sm" aria-label="Close (Esc)" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${17} /></button>
      </div>
      <div class="viewer-body">
        <${FilePeek} key=${entry.path} entry=${entry} big onOpen=${onOpen} onOpenOutside=${onOpenOutside} />
      </div>
    </div>
  </div>`;
}
