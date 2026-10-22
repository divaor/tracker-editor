// Dragging a tab out of the window (desktop app). The main process starts a
// real file drag ('drag:start' in electron/main.cjs): a file on disk goes as
// itself, other tabs as a copy in a temporary folder, so the desktop, a folder,
// a terminal or the Claude app each take it their own way. A drag that comes
// back into this window is recognized here: on the tab bar it still moves the
// tab, anywhere else it is ignored (not imported, not inserted into the text).
import { isDragCopy } from './folders.js';

const desktop = () => globalThis.window?.desktop;
export const canDragOut = () => Boolean(desktop()?.drag);

let current = null; // { key, path }
let listening = false;
const ended = new Set();

function finish() {
  if (!current) return;
  current = null;
  for (const callback of ended) callback();
}

function listen() {
  if (listening) return;
  listening = true;
  // Windows and Linux answer when the drop is done (macOS at once, so it waits for the pointer).
  // The short delay lets the drop reach this page first.
  desktop().drag.onEnd((info) => {
    if (info.error || desktop().platform !== 'darwin') setTimeout(finish, 300);
  });
  // The page gets no pointer events during a drag: the first one means it is over.
  const pointer = (e) => (e.type === 'pointerdown' || e.buttons === 0) && finish();
  window.addEventListener('pointermove', pointer, true);
  window.addEventListener('pointerdown', pointer, true);
}

/** Starts dragging tab `key` out: `item` is { path } for a file on disk, { name, text } for a copy. */
export function startDragOut(key, item) {
  listen();
  current = { key, path: item.path ?? '' };
  desktop().drag.start(item);
}

/** The tab being dragged out (null for a file dragged from the folders view), and the file's path on disk ('' for a copy). */
export const draggedTab = () => current?.key ?? null;
export const draggedPath = () => current?.path ?? '';

/** Called when the drag that was started here ends; returns the unsubscribe function. */
export function onDragOutEnd(callback) {
  ended.add(callback);
  return () => ended.delete(callback);
}

/** Whether a drop on the page is a tab of this window coming back (or a tab from the web app's own drag). */
export function isOwnDrop(dataTransfer) {
  if (dataTransfer?.types?.includes('text/x-tab')) return true;
  const files = [...(dataTransfer?.files ?? [])];
  const pathOf = desktop()?.disk?.pathOf;
  if (!files.length || !pathOf) return false;
  return files.every((f) => {
    const p = pathOf(f);
    return isDragCopy(p) || Boolean(current && p && p === current.path);
  });
}

/** Done with a drop that was the tab coming back. */
export const dropped = finish;
