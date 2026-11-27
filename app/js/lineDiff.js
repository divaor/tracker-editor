// Two texts compared as JetBrains' diff viewer compares them, for the comparisons (diffView.js
// side by side, and the unified view through @codemirror/merge). Pure (no DOM).
//
// Lines first: patience diff (lines found once on each side anchor the rest), Myers' diff
// between the anchors, then a slider pass so an inserted or removed block starts and ends where
// a reader expects it (next to a blank line, before a less indented one). Inside each block
// changed on both sides, its lines are paired by likeness: lines new on one side at the block's
// edges become blocks of their own, and the paired part is compared by words (or characters),
// so only what really changed inside a line is marked. A block too unlike to compare keeps
// whole lines (no confetti of stray matches). Large inputs have a time budget: past it the rest
// is compared more coarsely, never wrongly.
//
// A chunk: { a0, a1, b0, b1 } lines (0-based, half-open; one side empty for an insertion or a
// deletion), `kind` 'insert' | 'delete' | 'modify', `inner` [{ fromA, toA, fromB, toB }] the
// changed text inside it (offsets from the chunk's first line on each side, its lines joined
// by "\n": @codemirror/merge's Change), `precise` false where the budget made it coarse.
// Texts have "\n" line breaks (the app's texts always do).

export const WHITESPACE_OPTIONS = ['exact', 'trim', 'ignore'];
export const HIGHLIGHT_OPTIONS = ['words', 'lines', 'chars', 'none'];

/** The options a comparison runs with, from settings (anything unknown: the usual). */
export const diffOptionsOf = (s = {}) => ({
  whitespace: WHITESPACE_OPTIONS.includes(s.compareWhitespace) ? s.compareWhitespace : 'exact',
  highlight: HIGHLIGHT_OPTIONS.includes(s.compareHighlight) ? s.compareHighlight : 'words',
  collapse: s.compareCollapse !== false,
});

// Myers' search gives up past this much work in one region (its edit distance times its size):
// what is left of the region is then one block. Two regions of 2,000 lines are always exact.
const COST = 6e6;
const MIN_DEPTH = 256;
// Lines of a changed block are paired by likeness only while the pairs to weigh stay few.
const PAIR_CELLS = 40000;
const PAIR_MIN = 0.5;
// A block's words are compared only while it holds this many tokens on a side.
const MAX_TOKENS = 30000;

const normalizer = (whitespace) => (whitespace === 'ignore' ? (s) => s.replace(/\s+/g, '') : whitespace === 'trim' ? (s) => s.trim() : (s) => s);

/** Each line as a number (equal lines, as the whitespace option sees them, the same number). */
function lineIds(aLines, bLines, whitespace) {
  const norm = normalizer(whitespace);
  const ids = new Map();
  const of = (lines) => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const key = norm(lines[i]);
      let id = ids.get(key);
      if (id === undefined) ids.set(key, (id = ids.size));
      out[i] = id;
    }
    return out;
  };
  const a = of(aLines);
  const b = of(bLines);
  return { a, b, count: ids.size };
}

// ---- Myers' diff, linear space (the middle snake), over two arrays of numbers ----

/**
 * The point where a shortest edit path of A[a0, a1) and B[b0, b1) crosses its middle (both
 * non-empty, their first and last items differ): [x, y] absolute, or null when the search
 * would cost more than `limit` steps or ran past `deadline` (the caller keeps the region whole).
 */
function middleSnake(A, B, a0, a1, b0, b1, limit, deadline) {
  const n = a1 - a0;
  const m = b1 - b0;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  const stop = Math.min(maxD, limit);
  for (let d = 0; d < stop; d++) {
    if ((d & 63) === 63 && Date.now() > deadline) return null;
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1]) ? v1[k1o + 1] : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && A[a0 + x1] === B[b0 + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < size && v2[k2o] !== -1 && x1 >= n - v2[k2o]) return [a0 + x1, b0 + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1]) ? v2[k2o + 1] : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && A[a1 - x2 - 1] === B[b1 - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < size && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          const y1 = off + x1 - k1o;
          if (x1 >= n - x2) return [a0 + x1, b0 + y1];
        }
      }
    }
  }
  return null;
}

/**
 * The differing stretches of A[a0, a1) and B[b0, b1), in order, through `emit(a0, a1, b0, b1,
 * precise)`. Exact (a shortest edit) unless the search grows past its budget.
 */
function myers(A, B, a0, a1, b0, b1, emit, deadline) {
  while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
    a0++;
    b0++;
  }
  while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) {
    a1--;
    b1--;
  }
  if (a0 === a1 || b0 === b1) {
    if (a0 < a1 || b0 < b1) emit(a0, a1, b0, b1, true);
    return;
  }
  if (a1 - a0 === 1 || b1 - b0 === 1) {
    // One item on a side: it is in the other, or it is not.
    if (a1 - a0 === 1) {
      for (let j = b0; j < b1; j++)
        if (B[j] === A[a0]) {
          if (j > b0) emit(a0, a0, b0, j, true);
          if (j + 1 < b1) emit(a1, a1, j + 1, b1, true);
          return;
        }
    } else {
      for (let i = a0; i < a1; i++)
        if (A[i] === B[b0]) {
          if (i > a0) emit(a0, i, b0, b0, true);
          if (i + 1 < a1) emit(i + 1, a1, b1, b1, true);
          return;
        }
    }
    emit(a0, a1, b0, b1, true);
    return;
  }
  const size = a1 - a0 + (b1 - b0);
  const mid = Date.now() > deadline ? null : middleSnake(A, B, a0, a1, b0, b1, Math.max(MIN_DEPTH, Math.floor(COST / size)), deadline);
  if (!mid || (mid[0] === a0 && mid[1] === b0) || (mid[0] === a1 && mid[1] === b1)) {
    emit(a0, a1, b0, b1, false);
    return;
  }
  myers(A, B, a0, mid[0], b0, mid[1], emit, deadline);
  myers(A, B, mid[0], a1, mid[1], b1, emit, deadline);
}

// ---- Lines: histogram diff (git's), with Myers' where no line is rare enough ----

// Lines found more often than this on the left are no anchors (git's limit).
const MAX_CHAIN = 64;

/**
 * The blocks of lines A and B (line numbers) differ by: [{ a0, a1, b0, b1, precise }]. Each
 * stretch is split at the longest run of lines both sides share around the rarest line they
 * share (a line once on each side first: patience diff's anchors), then each side of it in turn;
 * a stretch whose shared lines are all too common goes to Myers' diff.
 */
function lineHunks(A, B, count, deadline) {
  const out = [];
  const emit = (a0, a1, b0, b1, precise) => {
    const last = out[out.length - 1];
    if (last && last.a1 === a0 && last.b1 === b0) {
      last.a1 = a1;
      last.b1 = b1;
      last.precise = last.precise && precise;
    } else out.push({ a0, a1, b0, b1, precise });
  };
  const stamp = new Int32Array(count);
  const seen = new Int32Array(count);
  const head = new Int32Array(count);
  const next = new Int32Array(A.length);
  let gen = 0;
  // The longest shared run around the rarest shared line: [a0, a1, b0, b1], or null.
  const best = (a0, a1, b0, b1) => {
    gen++;
    for (let i = a1 - 1; i >= a0; i--) {
      const id = A[i];
      if (stamp[id] !== gen) {
        stamp[id] = gen;
        seen[id] = 0;
        head[id] = -1;
      }
      seen[id]++;
      next[i] = head[id];
      head[id] = i;
    }
    let found = null;
    let foundLen = 0;
    let foundRare = MAX_CHAIN + 1;
    for (let j = b0; j < b1; ) {
      const id = B[j];
      if (stamp[id] !== gen || seen[id] > foundRare) {
        j++;
        continue;
      }
      let nextJ = j + 1;
      for (let i = head[id]; i !== -1; i = next[i]) {
        let s1 = i;
        let s2 = j;
        let rare = seen[id];
        while (s1 > a0 && s2 > b0 && A[s1 - 1] === B[s2 - 1]) {
          s1--;
          s2--;
          rare = Math.min(rare, seen[A[s1]]);
        }
        let e1 = i + 1;
        let e2 = j + 1;
        while (e1 < a1 && e2 < b1 && A[e1] === B[e2]) {
          rare = Math.min(rare, seen[A[e1]]);
          e1++;
          e2++;
        }
        if (e2 > nextJ) nextJ = e2;
        if (rare < foundRare || (rare === foundRare && e1 - s1 > foundLen)) {
          found = [s1, e1, s2, e2];
          foundLen = e1 - s1;
          foundRare = rare;
        }
      }
      j = nextJ;
    }
    return found;
  };
  // Stretches waiting, the next one on top: each is done before the ones after it.
  const stack = [[0, A.length, 0, B.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop();
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
      a0++;
      b0++;
    }
    while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) {
      a1--;
      b1--;
    }
    if (a0 === a1 || b0 === b1) {
      if (a0 < a1 || b0 < b1) emit(a0, a1, b0, b1, true);
      continue;
    }
    if (Date.now() > deadline) {
      emit(a0, a1, b0, b1, false);
      continue;
    }
    const run = best(a0, a1, b0, b1);
    if (!run) {
      myers(A, B, a0, a1, b0, b1, emit, deadline);
      continue;
    }
    stack.push([run[1], a1, run[3], b1], [a0, run[0], b0, run[2]]);
  }
  return out;
}

// ---- Sliding inserted and removed blocks to where a reader expects them ----

const isBlank = (s) => s === undefined || /^\s*$/.test(s);
const indentOf = (s) => {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
};
// A split between line t - 1 and line t: best just after a blank line (or the start), good just
// before one (or the end), better before a line indented less. So a block added with the blank
// line around it reads as "the function, then its blank line".
const splitScore = (lines, t) => (isBlank(lines[t - 1]) ? 2 : isBlank(lines[t]) ? 1 : 0) - (isBlank(lines[t]) ? 0 : indentOf(lines[t]) / 100);

function slide(hunks, A, B, aLines, bLines) {
  for (let h = 0; h < hunks.length; h++) {
    const k = hunks[h];
    const ins = k.a0 === k.a1;
    if (!ins && k.b0 !== k.b1) continue;
    const ids = ins ? B : A;
    const lines = ins ? bLines : aLines;
    let s = ins ? k.b0 : k.a0;
    let e = ins ? k.b1 : k.a1;
    const prevEnd = h ? (ins ? hunks[h - 1].b1 : hunks[h - 1].a1) + 1 : 0;
    const nextStart = h < hunks.length - 1 ? (ins ? hunks[h + 1].b0 : hunks[h + 1].a0) - 1 : ids.length;
    let up = 0;
    while (s - up - 1 >= prevEnd && ids[s - up - 1] === ids[e - up - 1]) up++;
    let down = 0;
    while (e + down < nextStart && ids[s + down] === ids[e + down]) down++;
    if (!up && !down) continue;
    let best = 0;
    let bestScore = -Infinity;
    for (let shift = -up; shift <= down; shift++) {
      const score = splitScore(lines, s + shift) + splitScore(lines, e + shift);
      if (score >= bestScore) {
        bestScore = score;
        best = shift;
      }
    }
    if (!best) continue;
    k.a0 += best;
    k.a1 += best;
    k.b0 += best;
    k.b1 += best;
  }
  return hunks;
}

// ---- Words: tokens, compared inside a changed block ----

const SPACE = 1;
const NEWLINE = 2;
const PUNCT = 3;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const isSpaceCode = (c) => c === 32 || c === 9 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0xfeff;
// Letters, digits, `_` and (roughly) any other script's letters: punctuation of their own aside.
const isWordCode = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 0xc0 && !(c >= 0x2000 && c <= 0x206f) && !(c >= 0x3000 && c <= 0x303f) && !(c >= 0xff00 && c <= 0xff0f) && c !== 0xd7 && c !== 0xf7);

/** A text's tokens: words, runs of spaces, line breaks, each other character alone. */
function tokenize(text) {
  const from = [];
  const to = [];
  const kind = [];
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    let j = i + 1;
    let k = PUNCT;
    if (c === 10) k = NEWLINE;
    else if (isSpaceCode(c)) {
      k = SPACE;
      while (j < text.length && isSpaceCode(text.charCodeAt(j))) j++;
    } else if (isWordCode(c)) {
      k = 0;
      while (j < text.length && isWordCode(text.charCodeAt(j))) j++;
    } else if (c >= 0xd800 && c <= 0xdbff && j < text.length) j++;
    from.push(i);
    to.push(j);
    kind.push(k);
    i = j;
  }
  return { from, to, kind };
}

/** The tokens the comparison looks at: spaces left out as the whitespace option says. */
function keptTokens(t, whitespace) {
  const keep = [];
  for (let i = 0; i < t.kind.length; i++) {
    const k = t.kind[i];
    if (whitespace === 'ignore' && (k === SPACE || k === NEWLINE)) continue;
    if (whitespace === 'trim' && k === SPACE && (i === 0 || t.kind[i - 1] === NEWLINE || i === t.kind.length - 1 || t.kind[i + 1] === NEWLINE)) continue;
    keep.push(i);
  }
  return keep;
}

const nonSpace = (text, from, to) => {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c !== 10 && !isSpaceCode(c)) n++;
  }
  return n;
};

/**
 * The changed parts of two texts by words: { changes: [{ fromA, toA, fromB, toB }] (offsets in
 * the texts), like } where `like` is the share of their characters (spaces aside) left as they
 * were. Changes only spaces apart are one; a short run left alike between two longer changes
 * (a stray "(" or ";" amid new text) joins them.
 */
export function wordChanges(a, b, { whitespace = 'exact', deadline = Date.now() + 1000 } = {}) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const ka = keptTokens(ta, whitespace);
  const kb = keptTokens(tb, whitespace);
  if (ka.length > MAX_TOKENS || kb.length > MAX_TOKENS) return { changes: [{ fromA: 0, toA: a.length, fromB: 0, toB: b.length }], like: 0 };
  const ids = new Map();
  const idsOf = (text, t, keep) => {
    const out = new Int32Array(keep.length);
    for (let i = 0; i < keep.length; i++) {
      const s = text.slice(t.from[keep[i]], t.to[keep[i]]);
      let id = ids.get(s);
      if (id === undefined) ids.set(s, (id = ids.size));
      out[i] = id;
    }
    return out;
  };
  const A = idsOf(a, ta, ka);
  const B = idsOf(b, tb, kb);
  const runs = [];
  myers(A, B, 0, A.length, 0, B.length, (a0, a1, b0, b1) => runs.push([a0, a1, b0, b1]), deadline);
  // Token runs to characters: an empty run is the place between its neighbours.
  const charsA = (i0, i1) => (i0 < i1 ? [ta.from[ka[i0]], ta.to[ka[i1 - 1]]] : i0 < ka.length ? [ta.from[ka[i0]], ta.from[ka[i0]]] : [a.length, a.length]);
  const charsB = (i0, i1) => (i0 < i1 ? [tb.from[kb[i0]], tb.to[kb[i1 - 1]]] : i0 < kb.length ? [tb.from[kb[i0]], tb.from[kb[i0]]] : [b.length, b.length]);
  const kindIn = (t, keep, i0, i1, test) => {
    for (let i = i0; i < i1; i++) if (!test(t.kind[keep[i]])) return false;
    return true;
  };
  const merged = [];
  const sizeOf = (r) => Math.max(...[charsA(r[0], r[1]), charsB(r[2], r[3])].map(([f, t]) => t - f));
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last) {
      // What is alike between the last change and this one.
      const [ga0, ga1, gb0, gb1] = [last[1], run[0], last[3], run[2]];
      const spacesOnly = kindIn(ta, ka, ga0, ga1, (k) => k === SPACE) && kindIn(tb, kb, gb0, gb1, (k) => k === SPACE);
      const noBreak = kindIn(ta, ka, ga0, ga1, (k) => k !== NEWLINE) && kindIn(tb, kb, gb0, gb1, (k) => k !== NEWLINE);
      const [fa, la] = charsA(ga0, ga1);
      const gap = nonSpace(a, fa, la);
      if (spacesOnly || (noBreak && gap > 0 && gap * 2 <= Math.min(sizeOf(last), sizeOf(run)))) {
        last[1] = run[1];
        last[3] = run[3];
        continue;
      }
    }
    merged.push([...run]);
  }
  const changes = merged.map(([a0, a1, b0, b1]) => {
    const [fromA, toA] = charsA(a0, a1);
    const [fromB, toB] = charsB(b0, b1);
    return { fromA, toA, fromB, toB };
  });
  return { changes, like: likeOf(a, b, changes) };
}

/** The share of two texts' characters (spaces aside) that `changes` leave alike. */
function likeOf(a, b, changes) {
  const total = nonSpace(a, 0, a.length) + nonSpace(b, 0, b.length);
  if (!total) return 1;
  let changed = 0;
  for (const c of changes) changed += nonSpace(a, c.fromA, c.toA) + nonSpace(b, c.fromB, c.toB);
  return (total - changed) / total;
}

/** Changed words narrowed to the characters that differ, where most of them stay alike. */
function charChanges(a, b, changes, deadline) {
  const out = [];
  for (const c of changes) {
    const la = c.toA - c.fromA;
    const lb = c.toB - c.fromB;
    if (!la || !lb || la + lb > 400) {
      out.push(c);
      continue;
    }
    // By UTF-16 units, as the offsets count; a part never splits an emoji's two.
    const A = Int32Array.from({ length: la }, (_, i) => a.charCodeAt(c.fromA + i));
    const B = Int32Array.from({ length: lb }, (_, i) => b.charCodeAt(c.fromB + i));
    const low = (s, at) => at > 0 && at < s.length && isLow(s.charCodeAt(at));
    const parts = [];
    myers(A, B, 0, A.length, 0, B.length, (a0, a1, b0, b1) => {
      let [fa, ta, fb, tb] = [c.fromA + a0, c.fromA + a1, c.fromB + b0, c.fromB + b1];
      if (low(a, fa) || low(b, fb)) [fa, fb] = [fa - 1, fb - 1];
      if (low(a, ta) || low(b, tb)) [ta, tb] = [ta + 1, tb + 1];
      const prev = parts[parts.length - 1];
      if (prev && prev.toA >= fa) Object.assign(prev, { toA: ta, toB: tb });
      else parts.push({ fromA: fa, toA: ta, fromB: fb, toB: tb });
    }, deadline);
    const changed = parts.reduce((n, p) => n + p.toA - p.fromA + p.toB - p.fromB, 0);
    if (changed * 2 <= la + lb) out.push(...parts);
    else out.push(c);
  }
  return out;
}

// ---- Pairing the lines of a changed block by likeness ----

/** A line's pairs of characters (spaces aside), counted: what likeness compares. */
function grams(line) {
  const s = line.replace(/\s+/g, '');
  const bag = new Map();
  if (s.length === 1) bag.set(s.charCodeAt(0), 1);
  for (let i = 0; i + 1 < s.length; i++) {
    const k = s.charCodeAt(i) * 65536 + s.charCodeAt(i + 1);
    bag.set(k, (bag.get(k) ?? 0) + 1);
  }
  return { bag, size: Math.max(0, s.length - 1) || s.length };
}

const common = (x, y) => {
  const [small, big] = x.bag.size <= y.bag.size ? [x.bag, y.bag] : [y.bag, x.bag];
  let n = 0;
  for (const [k, c] of small) {
    const m = big.get(k);
    if (m) n += Math.min(c, m);
  }
  return n;
};

/** How alike two lines are, 0 to 1 (Dice's coefficient of their pairs of characters). */
const likeness = (x, y) => (!x.size || !y.size ? (x.size === y.size ? 1 : 0) : (2 * common(x, y)) / (x.size + y.size));

const merge = (list) => {
  const bag = new Map();
  let size = 0;
  for (const g of list) {
    for (const [k, c] of g.bag) bag.set(k, (bag.get(k) ?? 0) + c);
    size += g.size;
  }
  return { bag, size };
};

/** The lines of two runs that go together ([[i, j]], in order), each pair at least PAIR_MIN alike. */
function pairGrams(ga, gb) {
  const n = ga.length;
  const m = gb.length;
  if (!n || !m || n * m > PAIR_CELLS) return [];
  const score = new Float64Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  const sims = new Float64Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) sims[i * m + j] = likeness(ga[i], gb[j]);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = sims[(i - 1) * m + j - 1];
      score[at(i, j)] = Math.max(score[at(i - 1, j)], score[at(i, j - 1)], s >= PAIR_MIN ? score[at(i - 1, j - 1)] + s : 0);
    }
  const pairs = [];
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const s = sims[(i - 1) * m + j - 1];
    if (s >= PAIR_MIN && score[at(i, j)] === score[at(i - 1, j - 1)] + s) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (score[at(i, j)] === score[at(i - 1, j)]) i--;
    else j--;
  }
  return pairs.reverse();
}

/** The lines of two runs that go together: [[i, j]] in order, each pair alike enough. */
export const pairLines = (aLines, bLines) => pairGrams(aLines.map(grams), bLines.map(grams));

const joined = (lines, from, to) => lines.slice(from, to).join('\n');

/**
 * A block changed on both sides, as one or more chunks (see the top of this file): lines new on
 * one side at its edges (not just its other lines split or joined) are blocks of their own.
 */
function refineBlock(h, aLines, bLines, { whitespace, highlight }, deadline) {
  const ga = aLines.slice(h.a0, h.a1).map(grams);
  const gb = bLines.slice(h.b0, h.b1).map(grams);
  const pairs = Date.now() > deadline ? [] : pairGrams(ga, gb);
  let pieces = [{ a0: h.a0, a1: h.a1, b0: h.b0, b1: h.b1, paired: false }];
  if (pairs.length) {
    const [fi, fj] = pairs[0];
    const [li, lj] = pairs[pairs.length - 1];
    const lead = { a0: h.a0, a1: h.a0 + fi, b0: h.b0, b1: h.b0 + fj, paired: false };
    const mid = { a0: h.a0 + fi, a1: h.a0 + li + 1, b0: h.b0 + fj, b1: h.b0 + lj + 1, paired: true };
    const tail = { a0: h.a0 + li + 1, a1: h.a1, b0: h.b0 + lj + 1, b1: h.b1, paired: false };
    // An edge whose lines are mostly found on the other side (a line split in two, two joined)
    // stays with the middle.
    const allA = merge(ga);
    const allB = merge(gb);
    const found = (list, all) => {
      const g = merge(list);
      return g.size ? common(g, all) / g.size : 0;
    };
    const isNew = (p) => found(ga.slice(p.a0 - h.a0, p.a1 - h.a0), allB) < 0.5 && found(gb.slice(p.b0 - h.b0, p.b1 - h.b0), allA) < 0.5;
    const empty = (p) => p.a0 === p.a1 && p.b0 === p.b1;
    if (!empty(lead) && !isNew(lead)) {
      mid.a0 = lead.a0;
      mid.b0 = lead.b0;
      lead.a1 = lead.a0;
      lead.b1 = lead.b0;
    }
    if (!empty(tail) && !isNew(tail)) {
      mid.a1 = tail.a1;
      mid.b1 = tail.b1;
      tail.a0 = tail.a1;
      tail.b0 = tail.b1;
    }
    pieces = [lead, mid, tail];
  }
  const out = [];
  for (const p of pieces) {
    if (p.a0 === p.a1 && p.b0 === p.b1) continue;
    const kind = p.a0 === p.a1 ? 'insert' : p.b0 === p.b1 ? 'delete' : 'modify';
    let inner = [];
    if (kind === 'modify' && (highlight === 'words' || highlight === 'chars') && Date.now() <= deadline) {
      const a = joined(aLines, p.a0, p.a1);
      const b = joined(bLines, p.b0, p.b1);
      const words = wordChanges(a, b, { whitespace, deadline }).changes;
      const changes = (highlight === 'chars' ? charChanges(a, b, words, deadline) : words).filter((c) => c.fromA < c.toA || c.fromB < c.toB);
      // Marks that would cover nearly everything say nothing the tint does not; many of them
      // over lines mostly unlike are confetti. Either way the lines show whole.
      const like = likeOf(a, b, changes);
      if (like >= (p.paired ? 0.1 : 0.25) && (like >= (p.paired ? 0.2 : 0.5) || changes.length <= 3)) inner = changes;
    }
    out.push({ a0: p.a0, a1: p.a1, b0: p.b0, b1: p.b1, kind, inner, precise: h.precise });
  }
  return out;
}

/**
 * Two texts (arrays of lines) compared: the chunks they differ by (see the top of this file).
 * Options: `whitespace` ('exact' | 'trim': spaces at the ends of lines | 'ignore': all spaces),
 * `highlight` ('words' | 'chars' | 'lines' | 'none': what `inner` holds), `timeout` (ms).
 */
export function diffLineArrays(aLines, bLines, { whitespace = 'exact', highlight = 'words', timeout = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  const { a, b, count } = lineIds(aLines, bLines, whitespace);
  const hunks = slide(lineHunks(a, b, count, deadline), a, b, aLines, bLines);
  // The words get half as long again: past that, changed blocks keep whole lines.
  const wordsBy = deadline + timeout / 2;
  const out = [];
  for (const h of hunks) {
    if (h.a0 === h.a1 || h.b0 === h.b1) out.push({ a0: h.a0, a1: h.a1, b0: h.b0, b1: h.b1, kind: h.a0 === h.a1 ? 'insert' : 'delete', inner: [], precise: h.precise });
    else out.push(...refineBlock(h, aLines, bLines, { whitespace, highlight }, wordsBy));
  }
  return out;
}

/** Two texts ("\n" line breaks) compared: diffLineArrays of their lines. */
export const diffTexts = (a, b, options) => diffLineArrays(a.split('\n'), b.split('\n'), options);

/**
 * The chunks after an edit of one side, comparing again only the lines around it. `edit`:
 * { side: 'a' | 'b', from, to, delta }: the edited side's lines the change touched in the text
 * before it ([from, to), 0-based) and the change in its number of lines. `a` / `b`: the texts now
 * as { lines, line(i) }. Returns { chunks, region: { side, from, to, delta } } (the old lines of
 * the edited side compared again: folds there go).
 */
export function updateChunks(chunks, edit, a, b, options = {}) {
  const sideA = edit.side === 'a';
  const x0 = (c) => (sideA ? c.a0 : c.b0);
  const x1 = (c) => (sideA ? c.a1 : c.b1);
  const o1 = (c) => (sideA ? c.b1 : c.a1);
  const edited = sideA ? a : b;
  const other = sideA ? b : a;
  const oldLines = edited.lines - edit.delta;
  let r0 = Math.max(0, edit.from - 1);
  let r1 = Math.min(oldLines, edit.to + 1);
  // The chunks the edit touches (or comes next to) are compared again with it.
  let lo = 0;
  while (lo < chunks.length && x1(chunks[lo]) < r0) lo++;
  let hi = lo;
  while (hi < chunks.length && x0(chunks[hi]) <= r1) hi++;
  if (hi > lo) {
    r0 = Math.min(r0, x0(chunks[lo]));
    r1 = Math.max(r1, x1(chunks[hi - 1]));
  }
  // The other side's lines there: past the chunk before, both sides go line for line.
  const before = lo ? chunks[lo - 1] : null;
  const ro0 = before ? r0 - x1(before) + o1(before) : r0;
  const last = hi ? chunks[hi - 1] : null;
  const ro1 = last ? r1 - x1(last) + o1(last) : r1;
  const linesOf = (src, from, to) => {
    const out = [];
    for (let i = from; i < to; i++) out.push(src.line(i));
    return out;
  };
  const ex = linesOf(edited, r0, r1 + edit.delta);
  const ot = linesOf(other, ro0, ro1);
  const found = sideA ? diffLineArrays(ex, ot, options) : diffLineArrays(ot, ex, options);
  const [da, db] = sideA ? [r0, ro0] : [ro0, r0];
  const moved = found.map((c) => ({ ...c, a0: c.a0 + da, a1: c.a1 + da, b0: c.b0 + db, b1: c.b1 + db }));
  const shift = (c) => (sideA ? { ...c, a0: c.a0 + edit.delta, a1: c.a1 + edit.delta } : { ...c, b0: c.b0 + edit.delta, b1: c.b1 + edit.delta });
  return {
    chunks: [...chunks.slice(0, lo), ...moved, ...chunks.slice(hi).map(shift)],
    region: { side: edit.side, from: r0, to: r1, delta: edit.delta },
  };
}

/**
 * The unchanged stretches long enough to fold away: [{ a0, a1, b0, b1 }] lines, `margin` lines
 * left showing next to each chunk, at least `minSize` lines each.
 */
export function foldRuns(chunks, linesA, linesB, { margin = 3, minSize = 4 } = {}) {
  const out = [];
  let pa = 0;
  let pb = 0;
  for (let i = 0; i <= chunks.length; i++) {
    const c = chunks[i];
    const from = i ? margin : 0;
    const endA = c ? c.a0 - margin : linesA;
    const startA = pa + from;
    if (endA - startA >= minSize) out.push({ a0: startA, a1: endA, b0: pb + from, b1: pb + from + (endA - startA) });
    if (!c) break;
    pa = c.a1;
    pb = c.b1;
  }
  return out;
}

/** Folds after an edit (updateChunks' `region`): those it touched go, those after it move. */
export function mapFolds(folds, { side, from, to, delta }) {
  const x0 = side === 'a' ? 'a0' : 'b0';
  const x1 = side === 'a' ? 'a1' : 'b1';
  return folds.filter((f) => f[x1] <= from || f[x0] >= to).map((f) => (f[x0] >= to ? { ...f, [x0]: f[x0] + delta, [x1]: f[x1] + delta } : f));
}

/**
 * The change that puts `lines` in place of lines [from, to) of a text (0-based): `doc` is
 * { lines, lineFrom(i), length }. A text always keeps one line: replacing all of them by none
 * leaves it empty.
 */
export function replaceLinesChange(doc, from, to, lines) {
  if (to < doc.lines) return { from: doc.lineFrom(from), to: doc.lineFrom(to), insert: lines.map((l) => `${l}\n`).join('') };
  if (from > 0) return { from: doc.lineFrom(from) - 1, to: doc.length, insert: lines.map((l) => `\n${l}`).join('') };
  return { from: 0, to: doc.length, insert: lines.join('\n') };
}

/** Applies chunks to A's lines: B's lines (the tests check a comparison with it). */
export function applyChunks(aLines, bLines, chunks) {
  const out = [];
  let at = 0;
  for (const c of chunks) {
    out.push(...aLines.slice(at, c.a0), ...bLines.slice(c.b0, c.b1));
    at = c.a1;
  }
  out.push(...aLines.slice(at));
  return out;
}
