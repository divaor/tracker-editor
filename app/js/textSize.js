// The editor's text size (setting `fontSize`, per device): a step at a time from the keys,
// Ctrl+wheel and the status bar's Aa, or a pinch on a touch screen. Pure, so the Node tests
// can import it.

export const DEFAULT_FONT = 14;
export const MIN_FONT = 9;
export const MAX_FONT = 32;

/** A size the editor can use: a whole number of pixels, MIN_FONT to MAX_FONT. */
export function clampFont(size) {
  const n = Math.round(Number(size));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_FONT, Math.max(MIN_FONT, n)) : DEFAULT_FONT;
}

/** One step larger (`dir` 1) or smaller (-1): a pixel at a time, then even sizes above 20 px. */
export function stepFont(size, dir) {
  const now = clampFont(size);
  if (dir > 0) return clampFont(now >= 20 ? Math.floor(now / 2) * 2 + 2 : now + 1);
  return clampFont(now > 20 ? Math.ceil(now / 2) * 2 - 2 : now - 1);
}

/** The size for a pinch: the size it started at, scaled by how far the fingers moved apart. */
export function pinchFont(start, startDistance, distance) {
  if (!(startDistance > 0) || !(distance > 0)) return clampFont(start);
  return clampFont(clampFont(start) * (distance / startDistance));
}

/** Which way a key changes the size: 1 (Ctrl+= or Ctrl++), -1 (Ctrl+-), 0 (Ctrl+0), or null. */
export function textSizeKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return -1;
  if (!e.shiftKey && (e.key === '0' || e.code === 'Numpad0')) return 0;
  return null;
}
