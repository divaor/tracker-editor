// The commit graph of the history view (ui/gitHistory.js): commits newest first in topo order
// (git log --topo-order, a page at a time) → for each row the lane of its dot and the lines to
// draw through the row, in lane units, for the view to draw (SVG). A line keeps its column while
// it runs (a column freed stays free until a new line takes it), keeps its color down its first
// parents, and moves left when it meets the same parent's line further left, so the main line
// stays on the left. A page goes on from the lines the page before left open (`state`).
// Pure (no DOM): test/git-graph.test.js.

/** How many colors the lines take turns with (`--graph-0` … in the CSS). */
export const GRAPH_COLORS = 8;

const copyLanes = (lanes) => lanes.map((l) => (l ? { ...l } : null));
const trim = (lanes) => {
  while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
  return lanes;
};
/** The first free column at or after `from`, else the first free one, else a new one. */
function freeColumn(lanes, from = 0) {
  for (let i = from; i < lanes.length; i++) if (!lanes[i]) return i;
  for (let i = 0; i < Math.min(from, lanes.length); i++) if (!lanes[i]) return i;
  return lanes.length;
}

/**
 * Rows for `commits` ([{ hash, parents }], newest first in topo order) → { rows, state, width }.
 * A row: { lane, color, lines: [{ from: [x, y], to: [x, y], color }] }, x a column and y 0 (the
 * row's top), 0.5 (its dot) or 1 (its bottom). `state` (from the page before, or null) holds the
 * lines still open; the next page passes back the one returned. `width`: the most columns used.
 */
export function graphRows(commits, state = null) {
  let lanes = state?.lanes ? copyLanes(state.lanes) : [];
  let nextColor = state?.nextColor ?? 0;
  const newColor = () => nextColor++ % GRAPH_COLORS;
  let width = lanes.length;
  const rows = [];
  for (const commit of commits ?? []) {
    const parents = Array.isArray(commit?.parents) ? commit.parents.filter((p) => typeof p === 'string' && p) : [];
    const before = lanes;
    const waiting = [];
    before.forEach((l, i) => l?.hash === commit.hash && waiting.push(i));
    const lane = waiting.length ? waiting[0] : freeColumn(before);
    const color = waiting.length ? before[lane].color : newColor();
    const lines = [];
    // The top half: every open line; the ones waiting for this commit end at its dot.
    before.forEach((l, i) => {
      if (!l) return;
      lines.push(l.hash === commit.hash ? { from: [i, 0], to: [lane, 0.5], color: l.color } : { from: [i, 0], to: [i, 0.5], color: l.color });
    });
    const after = copyLanes(before);
    for (const i of waiting) after[i] = null;
    // Where each line passing this row goes in the bottom half (its own column, or one left).
    const passing = new Map();
    before.forEach((l, i) => l && l.hash !== commit.hash && passing.set(i, i));
    parents.forEach((parent, k) => {
      const at = after.findIndex((l) => l?.hash === parent);
      if (at === -1) {
        // Nobody waits for it yet: the first parent goes on in this commit's column and color.
        const col = k === 0 && !after[lane] ? lane : freeColumn(after, lane + 1);
        after[col] = { hash: parent, color: k === 0 && col === lane ? color : newColor() };
        lines.push({ from: [lane, 0.5], to: [col, 1], color: after[col].color });
      } else if (k === 0 && at > lane && !after[lane]) {
        // The first parent is waited for further right: that line comes left to this column,
        // which keeps this commit's color (the main line stays on the left).
        after[lane] = { hash: parent, color };
        after[at] = null;
        passing.set(at, lane);
        lines.push({ from: [lane, 0.5], to: [lane, 1], color });
      } else {
        // Waited for already (to the left, or for a merge's other parents): a line over to it.
        lines.push({ from: [lane, 0.5], to: [at, 1], color: after[at].color });
      }
    });
    // The bottom half of the lines that passed: straight down, or over to where they moved.
    for (const [i, to] of passing) lines.push({ from: [i, 0.5], to: [to, 1], color: before[i].color });
    lanes = trim(after);
    width = Math.max(width, before.length, lanes.length, lane + 1);
    rows.push({ lane, color, lines });
  }
  return { rows, state: { lanes: copyLanes(lanes), nextColor }, width };
}

/**
 * Rows for commits that do not join up (a search, a file followed through renames): one column,
 * each dot joined to the next. `more`: there are rows after the last (its line goes on down).
 */
export function linearRows(commits, { more = false, first = true } = {}) {
  const list = commits ?? [];
  return list.map((c, i) => {
    const lines = [];
    if (i > 0 || !first) lines.push({ from: [0, 0], to: [0, 0.5], color: 0 });
    if (i < list.length - 1 || more) lines.push({ from: [0, 0.5], to: [0, 1], color: 0 });
    return { lane: 0, color: 0, lines };
  });
}

/** An SVG path for a line of a row `h` high with columns `w` wide (curves where it changes column). */
export function linePath(line, { w = 12, h = 26, pad = 7 } = {}) {
  const x = (col) => pad + col * w;
  const [x1, y1] = [x(line.from[0]), line.from[1] * h];
  const [x2, y2] = [x(line.to[0]), line.to[1] * h];
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}
