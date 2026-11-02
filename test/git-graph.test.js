// The history view's commit graph (app/js/gitGraph.js): every line from a commit's dot leads down
// to one of its parents, columns stay put, the main line keeps the left and its color, and a page
// goes on from the lines the page before left open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_COLORS, graphRows, linePath, linearRows } from '../app/js/gitGraph.js';

const c = (hash, ...parents) => ({ hash, parents });

/**
 * For each commit, the commits its lines reach (following each line from its dot down through the
 * rows below, along lines that pass, until one ends at a dot), or '…' for a line that runs past
 * the last row. Checks the drawing's geometry is whole as it goes.
 */
function reached(commits, rows) {
  const out = new Map();
  rows.forEach((row, r) => {
    const starts = row.lines.filter((l) => l.from[0] === row.lane && l.from[1] === 0.5);
    const got = [];
    for (const first of starts) {
      assert.equal(first.to[1], 1, 'a line from a dot goes to the row’s bottom');
      let col = first.to[0];
      let at = r + 1;
      let hit = '…';
      while (at < rows.length) {
        const below = rows[at];
        const top = below.lines.filter((l) => l.from[0] === col && l.from[1] === 0);
        assert.equal(top.length, 1, `one line goes on in column ${col} at row ${at}`);
        // Into the dot (a passing line never does: its column is taken, so the dot is elsewhere).
        if (top[0].to[0] === below.lane && top[0].to[1] === 0.5) {
          hit = commits[at].hash;
          break;
        }
        // Passing: down to the middle of its column, then on from there.
        assert.deepEqual(top[0].to, [col, 0.5], `a line passing row ${at} keeps column ${col}`);
        const on = below.lines.filter((l) => l.from[0] === col && l.from[1] === 0.5);
        assert.equal(on.length, 1, `the passing line goes on from the middle of row ${at}`);
        col = on[0].to[0];
        at++;
      }
      got.push(hit);
    }
    out.set(commits[r].hash, got.sort());
  });
  return out;
}

/** Checks each commit's lines reach exactly its parents (those in the list), or run off the end. */
function assertWhole(commits, rows) {
  const present = new Set(commits.map((x) => x.hash));
  const map = reached(commits, rows);
  for (const commit of commits) {
    const want = commit.parents.map((p) => (present.has(p) ? p : '…')).sort();
    assert.deepEqual(map.get(commit.hash), want, `${commit.hash} reaches its parents`);
  }
}

test('a straight history: one column, one color, the root’s line ends', () => {
  const commits = [c('e', 'd'), c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')];
  const { rows, width, state } = graphRows(commits);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0, 0, 0]);
  assert.equal(new Set(rows.map((r) => r.color)).size, 1);
  assert.deepEqual(rows[0].lines, [{ from: [0, 0.5], to: [0, 1], color: rows[0].color }]);
  assert.deepEqual(rows[4].lines, [{ from: [0, 0], to: [0, 0.5], color: rows[0].color }]);
  assert.deepEqual(state.lanes, []);
  assertWhole(commits, rows);
});

test('a branch merged back: two columns, the main line stays on the left in its color', () => {
  // m merges f (a feature) into a (main); both came from b. Both topo orders git can give.
  for (const commits of [
    [c('m', 'a', 'f'), c('f', 'b'), c('a', 'b'), c('b')],
    [c('m', 'a', 'f'), c('a', 'b'), c('f', 'b'), c('b')],
  ]) {
    const { rows, width } = graphRows(commits);
    assert.equal(width, 2);
    const at = Object.fromEntries(commits.map((x, i) => [x.hash, rows[i]]));
    assert.equal(at.m.lane, 0);
    assert.equal(at.a.lane, 0);
    assert.equal(at.f.lane, 1);
    assert.equal(at.b.lane, 0, 'the fork point is back on the left');
    assert.equal(at.a.color, at.m.color, 'main keeps its color');
    assert.equal(at.b.color, at.m.color);
    assert.notEqual(at.f.color, at.m.color);
    assertWhole(commits, rows);
  }
});

test('tips with no child above them take a free column; a column freed is taken again', () => {
  // y joins x's line to b at once (column 1 is free again), so z takes column 1.
  const commits = [c('x', 'b'), c('y', 'b'), c('z', 'a'), c('b', 'a'), c('a')];
  const { rows, width } = graphRows(commits);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 1, 0, 0]);
  assert.equal(width, 2);
  assertWhole(commits, rows);
});

test('an octopus merge: one column per parent', () => {
  const commits = [c('o', 'p1', 'p2', 'p3'), c('p3', 'r'), c('p2', 'r'), c('p1', 'r'), c('r')];
  const { rows, width } = graphRows(commits);
  assert.equal(rows[0].lines.filter((l) => l.from[1] === 0.5).length, 3, 'three lines leave the merge');
  assert.equal(width, 3);
  assert.equal(rows[4].lane, 0);
  assertWhole(commits, rows);
});

test('criss-cross merges and a merge of a line still running elsewhere', () => {
  // d and e each merge b and c (the other way round); f merges d and e.
  const commits = [c('f', 'd', 'e'), c('e', 'c', 'b'), c('d', 'b', 'c'), c('c', 'a'), c('b', 'a'), c('a')];
  const { rows } = graphRows(commits);
  assertWhole(commits, rows);
  // A merge whose second parent another line already waits for joins that line.
  const joined = [c('m', 'a', 'x'), c('n', 'x'), c('a', 'r'), c('x', 'r'), c('r')];
  assertWhole(joined, graphRows(joined).rows);
});

test('parents not in the list (a shallow clone, a page cut short) run off the bottom', () => {
  const commits = [c('b', 'a'), c('a', 'zz'), c('q', 'gone')];
  const { rows, state } = graphRows(commits);
  assertWhole(commits, rows);
  assert.deepEqual(state.lanes.filter(Boolean).map((l) => l.hash).sort(), ['gone', 'zz']);
});

/** A history made at random (branches, merges, octopuses), newest first: a valid topo order. */
function randomHistory(seed, n) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const made = [];
  const tips = [];
  for (let i = 0; i < n; i++) {
    const hash = `c${i}`;
    let parents = [];
    if (made.length) {
      const base = tips.length && rand() < 0.8 ? tips[Math.floor(rand() * tips.length)] : made[Math.floor(rand() * made.length)];
      parents = [base];
      if (rand() < 0.25 && tips.length > 1) {
        const other = tips[Math.floor(rand() * tips.length)];
        if (other !== base) parents.push(other);
        if (rand() < 0.1) {
          const third = made[Math.floor(rand() * made.length)];
          if (!parents.includes(third)) parents.push(third);
        }
      }
      for (const p of parents) tips.splice(tips.indexOf(p), tips.includes(p) ? 1 : 0);
    }
    made.push(hash);
    tips.push(hash);
    if (tips.length > 6) tips.shift();
    made.byHash = made.byHash ?? {};
    made.byHash[hash] = parents;
  }
  return made.reverse().map((h) => ({ hash: h, parents: made.byHash[h] }));
}

test('random histories: every line leads to its parent, and pages join up exactly as one list', () => {
  for (const seed of [1, 7, 42, 99, 2024]) {
    const commits = randomHistory(seed, 220);
    const whole = graphRows(commits);
    assertWhole(commits, whole.rows);
    for (const size of [1, 13, 50, 200]) {
      const rows = [];
      let state = null;
      for (let i = 0; i < commits.length; i += size) {
        const page = graphRows(commits.slice(i, i + size), state);
        rows.push(...page.rows);
        state = page.state;
      }
      assert.deepEqual(rows, whole.rows, `seed ${seed}, pages of ${size}`);
    }
    for (const row of whole.rows) assert.ok(row.color >= 0 && row.color < GRAPH_COLORS);
  }
});

test('linear rows (a search, a file followed through renames): one column joined dot to dot', () => {
  const rows = linearRows([c('a'), c('b'), c('c')]);
  assert.deepEqual(rows.map((r) => r.lines.length), [1, 2, 1]);
  assert.deepEqual(linearRows([c('a')], { more: true })[0].lines, [{ from: [0, 0.5], to: [0, 1], color: 0 }]);
  assert.deepEqual(linearRows([c('a')], { first: false })[0].lines, [{ from: [0, 0], to: [0, 0.5], color: 0 }]);
});

test('the SVG path of a line: straight down, or a curve to another column', () => {
  assert.equal(linePath({ from: [0, 0], to: [0, 0.5] }, { w: 10, h: 20, pad: 5 }), 'M5 0V10');
  assert.equal(linePath({ from: [0, 0.5], to: [2, 1] }, { w: 10, h: 20, pad: 5 }), 'M5 10C5 15 25 15 25 20');
});
