// The minimap's arithmetic (minimapLayout.js): which lines show, the box of the part on screen,
// the line under a click, dragging the box, whole-file marks on its edge, and a line's runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINIMAP, dragScroll, lineAtY, lineRuns, markTicks, minimapLayout, minimapShown, onBox } from '../app/js/minimapLayout.js';

test('shown by the setting, else in the desktop app only', () => {
  assert.equal(minimapShown(null, { desktop: true }), true);
  assert.equal(minimapShown(undefined, { desktop: false }), false);
  assert.equal(minimapShown(false, { desktop: true }), false);
  assert.equal(minimapShown(true, { desktop: false }), true);
});

test('a short file: every line shows from the top, the box over the lines on screen', () => {
  // 100 lines, 2 px each, in a 600 px minimap: no scrolling of its own.
  const l = minimapLayout({ lines: 100, height: 600, topLine: 21, bottomLine: 60, scrollTop: 400, scrollHeight: 2100, clientHeight: 800 });
  assert.equal(l.total, 200);
  assert.equal(l.scroll, 0);
  assert.equal(l.first, 1);
  assert.equal(l.offset, 0);
  assert.equal(l.last, 100);
  assert.equal(l.boxTop, 40);
  assert.equal(l.boxHeight, 80);
  assert.equal(l.track, 200);
  assert.equal(lineAtY(l, 41, 100), 21);
  assert.equal(lineAtY(l, -5, 100), 1);
  assert.equal(lineAtY(l, 5000, 100), 100);
  assert.ok(onBox(l, 50));
  assert.ok(!onBox(l, 130));
});

test('a long file: the minimap scrolls in step with the editor', () => {
  // 50,000 lines (100,000 px) in a 600 px minimap; the editor half way down.
  // The editor: 20 px lines and 12 px of padding, 800 px high (40 lines on screen).
  const base = { lines: 50000, height: 600, scrollHeight: 50000 * 20 + 12, clientHeight: 800 };
  const room = base.scrollHeight - base.clientHeight;
  const top = minimapLayout({ ...base, topLine: 1, bottomLine: 40, scrollTop: 0 });
  assert.equal(top.scroll, 0);
  assert.equal(top.first, 1);
  assert.equal(top.boxTop, 0);
  const mid = minimapLayout({ ...base, topLine: 24981, bottomLine: 25020, scrollTop: room / 2 });
  assert.equal(mid.scroll, (100000 - 600) / 2);
  assert.equal(mid.first, Math.floor(mid.scroll / 2) + 1);
  assert.ok(mid.offset >= 0 && mid.offset < 2);
  assert.ok(mid.last - mid.first <= 301, 'only what shows is drawn');
  // The box stays inside the minimap, half way along its room.
  assert.ok(mid.boxTop >= 0 && mid.boxTop + mid.boxHeight <= 600);
  assert.ok(Math.abs(mid.boxTop - (600 - mid.boxHeight) / 2) < 2);
  const end = minimapLayout({ ...base, topLine: 49961, bottomLine: 50000, scrollTop: room });
  assert.equal(end.scroll, 100000 - 600);
  assert.ok(Math.abs(end.boxTop + end.boxHeight - 600) < 1);
  assert.equal(lineAtY(end, 599, 50000), 50000);
  // A tiny file still has a box one can grab.
  assert.equal(minimapLayout({ lines: 1, height: 600, topLine: 1, bottomLine: 1 }).boxHeight, MINIMAP.lineHeight * 3);
});

test('dragging the box: it follows the pointer over the room it moves in', () => {
  // Short file: 1 minimap px (half a line) moves the editor by half an editor line.
  assert.equal(dragScroll({ startScrollTop: 100, dy: 2, scrollHeight: 2100, clientHeight: 800, track: 200, box: 80 }), 100 + (2 * 1300) / 120);
  // Kept inside what can scroll.
  assert.equal(dragScroll({ startScrollTop: 100, dy: -500, scrollHeight: 2100, clientHeight: 800, track: 200, box: 80 }), 0);
  assert.equal(dragScroll({ startScrollTop: 100, dy: 5000, scrollHeight: 2100, clientHeight: 800, track: 200, box: 80 }), 1300);
  // A long file: across the whole minimap is the whole file.
  assert.equal(dragScroll({ startScrollTop: 0, dy: 600 - 32, scrollHeight: 1000800, clientHeight: 800, track: 600, box: 32 }), 1000000);
});

test('whole-file marks: placed by line, merged per row, the strongest kind kept', () => {
  const ticks = markTicks(
    [
      { line: 1, kind: 'added' },
      { line: 1, kind: 'error' },
      { line: 500, kind: 'warning' },
      { line: 1000, kind: 'modified' },
      { line: 7, kind: 'nonsense' },
    ],
    { lines: 1000, height: 500 },
  );
  assert.deepEqual(ticks.map((t) => t.kind), ['error', 'warning', 'modified']);
  assert.equal(ticks[0].y, 0);
  // Line 500 of 1,000 starts half way down, less half a row.
  assert.equal(ticks[1].y, 249);
  // The last line's tick stays inside.
  assert.ok(ticks[2].y + ticks[2].h <= 500);
  assert.ok(ticks.every((t) => t.h >= 2));
  assert.deepEqual(markTicks([], { lines: 10, height: 100 }), []);
  assert.deepEqual(markTicks([{ line: 1, kind: 'error' }], { lines: 10, height: 0 }), []);
  // Short files: a tick per line, as tall as a line.
  const short = markTicks([{ line: 2, kind: 'match' }], { lines: 10, height: 100 });
  assert.deepEqual(short, [{ y: 10, h: 10, kind: 'match' }]);
});

test('a line as runs of characters, colored by the syntax’s spans (inner ones win), tabs expanded', () => {
  const text = 'const a = "hi"; // ok';
  const spans = [
    { from: 100, to: 105, kind: 'keyword' },
    { from: 110, to: 114, kind: 'string' },
    { from: 116, to: 121, kind: 'comment' },
  ];
  assert.deepEqual(lineRuns(text, { from: 100, spans }), [
    { col: 0, len: 5, kind: 'keyword' },
    { col: 6, len: 1, kind: 'text' },
    { col: 8, len: 1, kind: 'text' },
    { col: 10, len: 4, kind: 'string' },
    { col: 14, len: 1, kind: 'text' },
    { col: 16, len: 2, kind: 'comment' },
    { col: 19, len: 2, kind: 'comment' },
  ]);
  // Tabs go to their stop; an inner span over an outer one wins.
  assert.deepEqual(lineRuns('\tab', { from: 0, spans: [{ from: 1, to: 3, kind: 'string' }, { from: 2, to: 3, kind: 'keyword' }], tabSize: 4 }), [
    { col: 4, len: 1, kind: 'string' },
    { col: 5, len: 1, kind: 'keyword' },
  ]);
  // Long lines stop at the minimap's width; empty and blank lines have none.
  assert.equal(lineRuns('x'.repeat(500), { maxCols: 80 })[0].len, 80);
  assert.deepEqual(lineRuns(''), []);
  assert.deepEqual(lineRuns('    '), []);
});
