// Bookmarks in documents shown as they look: one per file, kept in this device's settings
// (`docBookmarks`, by the file's path), and the document opens there until it is cleared.
// A PDF's bookmark is a page; a converted document's (e-books, Word, sheets…) is the block at
// the top of the screen, counted among BOOKMARK_BLOCKS: the conversion makes the same page
// each time, so the place holds on any screen width and text size. Pure.
import { remapPath } from './folders.js';

/** The blocks of a converted document a bookmark counts, in the order of the page. */
export const BOOKMARK_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, tr, pre, blockquote, figure, dt, dd, hr, img';
export const MAX_BOOKMARKS = 300;

/** The bookmark kept for `key` (a path), or null. */
export const bookmarkOf = (marks, key) => (key && marks && Object.hasOwn(marks, key) ? marks[key] : null);

/** `marks` with `key` at `mark` ({ page } or { block, into }, and its `label`); the oldest go past MAX_BOOKMARKS. */
export function withBookmark(marks, key, mark, now = Date.now()) {
  const next = { ...marks, [key]: { ...mark, at: now } };
  const keys = Object.keys(next);
  if (keys.length > MAX_BOOKMARKS) {
    keys.sort((a, b) => (next[a].at ?? 0) - (next[b].at ?? 0));
    for (const k of keys.slice(0, keys.length - MAX_BOOKMARKS)) delete next[k];
  }
  return next;
}

/** `marks` without `key`'s bookmark. */
export function withoutBookmark(marks, key) {
  const next = { ...marks };
  delete next[key];
  return next;
}

/** Bookmarks of files that moved follow them: `moves` [{ from, to }] (files or folders). */
export function movedBookmarks(marks, moves) {
  let next = null;
  for (const [key, mark] of Object.entries(marks ?? {})) {
    const to = moves.map((m) => remapPath(key, m.from, m.to)).find(Boolean);
    if (!to || to === key) continue;
    next ??= { ...marks };
    delete next[key];
    next[to] = mark;
  }
  return next ?? marks;
}

/**
 * Where the top of the screen is among the blocks: `tops` and `bottoms` are their edges (in
 * pixels, in the order of the page), `top` the scroll position. Gives { block, into }: the first
 * block that reaches below the top, and how far into it (0–1) the top is.
 */
export function placeAt(tops, bottoms, top) {
  for (let i = 0; i < bottoms.length; i++) {
    if (bottoms[i] > top + 1) {
      const height = bottoms[i] - tops[i];
      const into = height > 0 ? Math.min(1, Math.max(0, (top - tops[i]) / height)) : 0;
      return { block: i, into: Math.round(into * 1000) / 1000 };
    }
  }
  return { block: Math.max(0, bottoms.length - 1), into: 0 };
}

/** The scroll position of a place: its block's top, and `into` of its height. */
export const topOf = (place, blockTop, blockHeight) => Math.max(0, blockTop + (place.into ?? 0) * blockHeight);

/** A bookmark's words: "page 12 of 300", or the heading before it and how far in ("Chapter 3 · 34%"). */
export function bookmarkLabel(mark) {
  if (!mark) return '';
  if (mark.page) return mark.pages ? `page ${mark.page} of ${mark.pages}` : `page ${mark.page}`;
  const percent = `${Math.round(Math.max(0, Math.min(1, mark.percent ?? 0)) * 100)}%`;
  const heading = String(mark.heading ?? '').replace(/\s+/g, ' ').trim();
  return heading ? `${heading.length > 48 ? `${heading.slice(0, 47)}…` : heading} · ${percent}` : `${percent} in`;
}
