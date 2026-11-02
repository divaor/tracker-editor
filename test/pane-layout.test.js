// The editor's panes side by side (paneLayout.js): the session's rules, moving tabs between
// panes, and their widths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EXTRA, closePane, dragSizes, evenSizes, migratePanes, moveTab, neighborOf, nextUnshown, paneSizes, paneable, panesThatFit, placeTab, tidyPanes, withSizes } from '../app/js/paneLayout.js';

const open = ['f:a', 'f:b', 'd:/c.txt', 'r:docs/d.md', 'c:x', 'f:e'];

test('the panes keep the session rules: open, once each, never the active tab, no comparisons, three at most', () => {
  assert.deepEqual(tidyPanes(['f:b', 'f:b', 'c:x', 'f:gone', 'f:a', 'd:/c.txt', 'r:docs/d.md', 'f:e'], { open, active: 'f:a' }), ['f:b', 'd:/c.txt', 'r:docs/d.md']);
  assert.equal(MAX_EXTRA, 3);
  assert.deepEqual(tidyPanes(null, { open }), []);
  assert.deepEqual(tidyPanes(['f:b'], { open: ['f:a'] }), [], 'a closed tab leaves its pane');
  assert.ok(paneable('f:1') && paneable('r:x') && paneable('d:/x') && !paneable('c:1') && !paneable(null));
});

test('an old session’s side pane becomes the first of the panes', () => {
  assert.deepEqual(migratePanes({ side: 'f:b' }), ['f:b']);
  assert.deepEqual(migratePanes({ side: null }), []);
  assert.deepEqual(migratePanes({ panes: ['f:a', 3, 'f:b'], side: 'f:x' }), ['f:a', 'f:b'], 'panes win over an old side');
  assert.deepEqual(migratePanes(undefined), []);
});

test('the main pane’s next tab when its own moves out: the one before in the bar, else after, not shown elsewhere', () => {
  assert.equal(neighborOf(open, 'f:b', []), 'f:a');
  assert.equal(neighborOf(open, 'f:a', ['f:b']), 'd:/c.txt');
  assert.equal(neighborOf(['f:a'], 'f:a', []), null);
  // A tab for a new pane: after the current one, a kind a pane can show.
  assert.equal(nextUnshown(open, 'r:docs/d.md', []), 'f:e', 'the comparison is passed over');
  assert.equal(nextUnshown(open, 'f:e', ['f:a']), 'r:docs/d.md', 'none after: the nearest before');
  assert.equal(nextUnshown(['f:a'], 'f:a', []), null);
});

test('a new pane: a tab not shown goes there; the main pane’s own leaves a neighbor; four panes at most; no comparisons', () => {
  const s = { open, active: 'f:a', panes: [] };
  assert.deepEqual(placeTab(s, 'f:b', 'new'), { active: 'f:a', panes: ['f:b'] });
  assert.deepEqual(placeTab(s, 'f:a', 'new'), { active: 'f:b', panes: ['f:a'] });
  assert.equal(placeTab(s, 'c:x', 'new'), null);
  assert.equal(placeTab({ open: ['f:a'], active: 'f:a', panes: [] }, 'f:a', 'new'), null, 'the only tab stays where it is');
  const full = { open, active: 'f:a', panes: ['f:b', 'd:/c.txt', 'r:docs/d.md'] };
  assert.equal(placeTab(full, 'f:e', 'new'), null);
  // One already in a pane goes to the end.
  assert.deepEqual(placeTab(full, 'f:b', 'new'), { active: 'f:a', panes: ['d:/c.txt', 'r:docs/d.md', 'f:b'] });
  assert.equal(placeTab(s, 'f:gone', 'new'), null);
});

test('moving a tab into a pane swaps it with what that pane showed', () => {
  const s = { open, active: 'f:a', panes: ['f:b', 'd:/c.txt'] };
  // Into the main pane: the main pane's tab takes its place.
  assert.deepEqual(placeTab(s, 'd:/c.txt', 0), { active: 'd:/c.txt', panes: ['f:b', 'f:a'] });
  // The main pane's tab into pane 2: that pane's tab comes to the main pane.
  assert.deepEqual(placeTab(s, 'f:a', 1), { active: 'f:b', panes: ['f:a', 'd:/c.txt'] });
  // Between two extra panes.
  assert.deepEqual(placeTab(s, 'f:b', 2), { active: 'f:a', panes: ['d:/c.txt', 'f:b'] });
  // A tab not shown replaces the pane's (which stays open in the bar).
  assert.deepEqual(placeTab(s, 'f:e', 2), { active: 'f:a', panes: ['f:b', 'f:e'] });
  assert.deepEqual(placeTab(s, 'f:e', 0), { active: 'f:e', panes: ['f:b', 'd:/c.txt'] });
  // Where it is already: nothing changes; no such pane: null.
  assert.deepEqual(placeTab(s, 'f:b', 1), { active: 'f:a', panes: ['f:b', 'd:/c.txt'] });
  assert.equal(placeTab(s, 'f:e', 3), null);
  assert.equal(placeTab(s, 'c:x', 1), null);
  // A comparison in the main pane cannot go into a pane: the pane closes instead.
  assert.deepEqual(placeTab({ open, active: 'c:x', panes: ['f:b'] }, 'f:b', 0), { active: 'f:b', panes: [] });
});

test('moving the tab of a pane left or right; from the main pane with none, a pane opens', () => {
  const s = { open, active: 'f:a', panes: ['f:b', 'd:/c.txt'] };
  assert.deepEqual(moveTab(s, 0, 1), { active: 'f:b', panes: ['f:a', 'd:/c.txt'] });
  assert.deepEqual(moveTab(s, 2, -1), { active: 'f:a', panes: ['d:/c.txt', 'f:b'] });
  assert.deepEqual(moveTab(s, 1, -1), { active: 'f:b', panes: ['f:a', 'd:/c.txt'] });
  assert.equal(moveTab(s, 0, -1), null);
  assert.equal(moveTab(s, 2, 1), null, 'nothing after the last pane');
  assert.deepEqual(moveTab({ open, active: 'f:a', panes: [] }, 0, 1), { active: 'f:b', panes: ['f:a'] });
  assert.deepEqual(closePane(['f:b', 'd:/c.txt', 'f:e'], 2), ['f:b', 'f:e']);
});

test('widths: kept per number of panes, two seeded by the old split, dragged between neighbors, even by default', () => {
  assert.deepEqual(paneSizes({}, 1), [1]);
  assert.deepEqual(paneSizes({}, 3), evenSizes(3));
  assert.deepEqual(paneSizes({}, 2, 0.6), [0.6, 0.4]);
  assert.deepEqual(paneSizes({ 2: [3, 1] }, 2, 0.6), [0.75, 0.25], 'saved ones win, made to add up to 1');
  assert.deepEqual(paneSizes({ 3: [0.5, 0.5] }, 3), evenSizes(3), 'a saved list of the wrong length is ignored');
  assert.deepEqual(paneSizes({ 2: [0, 1] }, 2), [0.5, 0.5], 'and one with a zero');
  const dragged = dragSizes([0.25, 0.25, 0.25, 0.25], 1, 0.1);
  assert.deepEqual(dragged.map((x) => Math.round(x * 100)), [25, 35, 15, 25]);
  assert.deepEqual(dragSizes([0.5, 0.5], 0, 0.9, 0.1).map((x) => Math.round(x * 10)), [9, 1], 'never under the least');
  assert.deepEqual(dragSizes([0.5, 0.5], 1, 0.2), [0.5, 0.5], 'no handle after the last pane');
  assert.deepEqual(withSizes({ 2: [0.5, 0.5] }, 3, [1 / 3, 1 / 3, 1 / 3]), { 2: [0.5, 0.5], 3: [0.333, 0.333, 0.333] });
  assert.deepEqual(withSizes(null, 2, [0.6, 0.4]), { 2: [0.6, 0.4] });
});

test('how many panes fit: each at least 260 px; not measured yet, all of them', () => {
  assert.equal(panesThatFit(0), 4);
  assert.equal(panesThatFit(500), 1);
  assert.equal(panesThatFit(800), 3);
  assert.equal(panesThatFit(2000), 4);
});
