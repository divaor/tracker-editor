// Where things go in a comparison side by side (diffView.js): the chunk at a line, stepping
// from chunk to chunk, scrolling the two sides in step, and the ribbons between them. Pure (no
// DOM); test/diff-layout.test.js. Chunks are lineDiff.js's ({ a0, a1, b0, b1 } lines).

const ends = (side) => (side === 'a' ? ['a0', 'a1'] : ['b0', 'b1']);

/**
 * The chunk (index) a line of a side is in, -1 for none. A chunk with no lines on that side
 * counts on the line just after its place (where the side shows the thin line).
 */
export function chunkAtLine(chunks, side, line) {
  const [x0, x1] = ends(side);
  let lo = 0;
  let hi = chunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid][x1] <= line && !(chunks[mid][x0] === chunks[mid][x1] && chunks[mid][x0] === line)) lo = mid + 1;
    else hi = mid;
  }
  const c = chunks[lo];
  if (!c) return -1;
  // A chunk with lines there wins over one only placed there (an insertion just above it).
  const next = chunks[lo + 1];
  if (c[x0] === c[x1] && next && next[x0] <= line && line < next[x1]) return lo + 1;
  return c[x0] <= line && (line < c[x1] || (c[x0] === c[x1] && c[x0] === line)) ? lo : -1;
}

/**
 * The chunk after (`step` 1) or before (-1) the cursor's line on a side: the next one past the
 * chunk the cursor is in, else past the line; around from the end to the start. -1 for none.
 */
export function stepChunk(chunks, side, line, step) {
  if (!chunks.length) return -1;
  const [x0] = ends(side);
  const at = chunkAtLine(chunks, side, line);
  let i;
  if (at >= 0) i = at + step;
  else if (step > 0) {
    i = chunks.findIndex((c) => c[x0] > line);
    if (i < 0) i = chunks.length;
  } else {
    i = -1;
    for (let k = chunks.length - 1; k >= 0; k--)
      if (chunks[k][x0] < line) {
        i = k;
        break;
      }
  }
  return (i + chunks.length) % chunks.length;
}

/**
 * Points that tie a height on the left side to a height on the right (scrolling in step):
 * { a: [...], b: [...] }, both rising. `bounds` holds each chunk's [top A, bottom A, top B,
 * bottom B] (an empty side's top and bottom are its place); `endA` / `endB` the sides' heights.
 * Between chunks both sides move alike; across a chunk each covers its own height, and where a
 * side has no lines the place widens by `half` up and down, so going past a block on the other
 * side scrolls through it over a line instead of jumping.
 */
export function scrollPoints(bounds, endA, endB, half = 0) {
  const a = [0];
  const b = [0];
  const push = (ya, yb) => {
    a.push(Math.max(ya, a[a.length - 1]));
    b.push(Math.max(yb, b[b.length - 1]));
  };
  for (const [a0, a1, b0, b1] of bounds) {
    const pad = a0 === a1 || b0 === b1 ? half : 0;
    push(a0 - pad, b0 - pad);
    push(a1 + pad, b1 + pad);
  }
  push(endA, endB);
  return { a, b };
}

/** A height on one side (`from` the side's points) as a height on the other (`to`'s). */
export function mapThrough(from, to, y) {
  let lo = 0;
  let hi = from.length - 1;
  if (y <= from[0]) return to[0] + (y - from[0]);
  if (y >= from[hi]) return to[hi] + (y - from[hi]);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (from[mid] <= y) lo = mid;
    else hi = mid;
  }
  const span = from[hi] - from[lo];
  return span > 0 ? to[lo] + ((y - from[lo]) * (to[hi] - to[lo])) / span : to[hi];
}

/** The first chunk whose ribbon reaches `top` or below (both sides' bottoms rise chunk by chunk). */
export function firstVisible(bounds, top) {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Math.max(bounds[mid][1], bounds[mid][3]) < top) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const r = (n) => Math.round(n * 10) / 10;

/**
 * The ribbon joining a chunk's band on the left (y a0 to a1, at x 0) to its band on the right
 * (b0 to b1, at x w): { fill, edges } SVG paths, the curves JetBrains' diff viewer draws.
 */
export function ribbonPath(w, a0, a1, b0, b1) {
  const m = w / 2;
  const top = `M0 ${r(a0)}C${r(m)} ${r(a0)} ${r(m)} ${r(b0)} ${r(w)} ${r(b0)}`;
  const bottom = `M0 ${r(a1)}C${r(m)} ${r(a1)} ${r(m)} ${r(b1)} ${r(w)} ${r(b1)}`;
  const fill = `${top}L${r(w)} ${r(b1)}C${r(m)} ${r(b1)} ${r(m)} ${r(a1)} 0 ${r(a1)}Z`;
  return { fill, edges: `${top}${bottom}` };
}
