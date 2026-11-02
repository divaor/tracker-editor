// The editor's panes side by side: the main one (the active tab's) and up to MAX_EXTRA more,
// the session's `panes` (their tabs, in order). A tab shows in one pane at a time; moving it
// between panes swaps it with what the other pane showed. Their widths are kept per number of
// panes (setting `paneSizes`: { 2: [..], 3: [..], 4: [..] }, fractions). Pure, so the tests
// import it.

export const MAX_PANES = 4;
export const MAX_EXTRA = MAX_PANES - 1;
/** A pane narrower than this does not show: the panes after it wait until the window widens. */
export const MIN_PANE_PX = 260;
/** The narrowest a pane gets by dragging, as a share of the width. */
export const MIN_SHARE = 0.08;

/** Whether a pane can show this tab: an editor's text (a synced file, a tracker document, a file on disk), not a comparison. */
export const paneable = (key) => typeof key === 'string' && /^[frd]:/.test(key);

/** The extra panes kept to the rules: each tab once, open, not the active one, not a comparison, MAX_EXTRA at most. */
export function tidyPanes(panes, { open = [], active = null, max = MAX_EXTRA } = {}) {
  const isOpen = new Set(open);
  const out = [];
  for (const key of Array.isArray(panes) ? panes : []) {
    if (out.length >= max) break;
    if (paneable(key) && isOpen.has(key) && key !== active && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The extra panes of a saved session: an old one's `side` (the split view's second pane) becomes the first. */
export function migratePanes(saved) {
  if (Array.isArray(saved?.panes)) return saved.panes.filter((k) => typeof k === 'string');
  return typeof saved?.side === 'string' && saved.side ? [saved.side] : [];
}

/** The tab before `key` in the bar (else after it) that `shown` does not hold: what the main pane shows when its tab moves out. */
export function neighborOf(open, key, shown = []) {
  const free = (k) => k !== key && !shown.includes(k);
  const at = open.indexOf(key);
  if (at === -1) return open.find(free) ?? null;
  return [...open.slice(0, at)].reverse().find(free) ?? open.slice(at + 1).find(free) ?? null;
}

/** A tab for a new pane: the first after `from` in the bar (else before it) that no pane shows and a pane can show. */
export function nextUnshown(open, from, shown = []) {
  const free = (k) => k !== from && paneable(k) && !shown.includes(k);
  const at = open.indexOf(from);
  return open.slice(at + 1).find(free) ?? [...open.slice(0, Math.max(at, 0))].reverse().find(free) ?? null;
}

/**
 * Shows `key` in pane `target` (0: the main pane; 1, 2, 3: an extra one; 'new': one more at
 * the end). Answers the session's next { active, panes }, or null when it cannot be (no room,
 * a comparison, the only tab). A tab shown in another pane swaps places with the target's; the
 * main pane's tab leaving for a new pane leaves its neighbor in the bar there.
 */
export function placeTab({ open = [], active = null, panes = [] }, key, target) {
  if (!open.includes(key)) return null;
  const list = [...panes];
  const at = list.indexOf(key);
  if (target === 'new') {
    if (!paneable(key)) return null;
    if (at !== -1) {
      // Already in one: it moves to the end.
      list.splice(at, 1);
      return { active, panes: [...list, key] };
    }
    if (list.length >= MAX_EXTRA) return null;
    if (key !== active) return { active, panes: [...list, key] };
    const next = neighborOf(open, key, list);
    return next ? { active: next, panes: [...list, key] } : null;
  }
  if (target === 0) {
    if (key === active) return { active, panes: list };
    // From an extra pane: the main pane's tab goes there instead (a comparison cannot: the pane closes).
    if (at !== -1) {
      if (active && paneable(active)) list[at] = active;
      else list.splice(at, 1);
    }
    return { active: key, panes: list };
  }
  const i = Number(target) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.length || !paneable(key)) return null;
  if (list[i] === key) return { active, panes: list };
  if (key === active) {
    const was = list[i];
    list[i] = key;
    return { active: was, panes: list };
  }
  if (at !== -1) [list[i], list[at]] = [list[at], list[i]];
  else list[i] = key;
  return { active, panes: list };
}

/**
 * The tab of pane `from` (0: main) moved `step` panes along (+1 right, -1 left): it swaps with
 * that pane's; from the main pane with no other pane, it opens one. null when there is nowhere to go.
 */
export function moveTab(state, from, step) {
  const { active, panes = [] } = state;
  const key = from === 0 ? active : panes[from - 1];
  if (!key) return null;
  const to = from + step;
  if (to < 0) return null;
  if (to <= panes.length) return placeTab(state, key, to);
  if (from === 0 && !panes.length) return placeTab(state, key, 'new');
  return null;
}

/** The extra panes without pane `index` (1, 2, 3); its tab stays open in the bar. */
export const closePane = (panes, index) => panes.filter((_, i) => i !== index - 1);

/** Even widths for `n` panes. */
export const evenSizes = (n) => Array.from({ length: Math.max(1, n) }, () => 1 / Math.max(1, n));

/**
 * The widths of `n` panes (fractions adding up to 1) from the setting (`sizes`: { [n]: [..] });
 * two panes without one take the old split's share (`splitRatio`); else even.
 */
export function paneSizes(sizes, n, splitRatio = 0) {
  if (n <= 1) return [1];
  const saved = sizes?.[n];
  if (Array.isArray(saved) && saved.length === n && saved.every((x) => Number.isFinite(x) && x > 0)) {
    const sum = saved.reduce((a, b) => a + b, 0);
    return saved.map((x) => x / sum);
  }
  if (n === 2 && splitRatio >= 0.15 && splitRatio <= 0.85) return [splitRatio, 1 - splitRatio];
  return evenSizes(n);
}

/** The handle after pane `i` dragged by `delta` (a share of the width): it and the next pane share their space, neither under `min`. */
export function dragSizes(sizes, i, delta, min = MIN_SHARE) {
  if (i < 0 || i >= sizes.length - 1) return [...sizes];
  const out = [...sizes];
  const pair = out[i] + out[i + 1];
  const a = Math.max(min, Math.min(pair - min, out[i] + delta));
  out[i] = a;
  out[i + 1] = pair - a;
  return out;
}

/** The setting with `n` panes' widths replaced (rounded to a thousandth). */
export const withSizes = (all, n, sizes) => ({ ...(all && typeof all === 'object' ? all : {}), [n]: sizes.map((x) => Math.round(x * 1000) / 1000) });

/** How many panes fit across `width` pixels (1 to MAX_PANES), each at least `min` wide; 0 (not measured yet) lets them all show. */
export function panesThatFit(width, min = MIN_PANE_PX) {
  if (!width) return MAX_PANES;
  return Math.max(1, Math.min(MAX_PANES, Math.floor(width / min)));
}
