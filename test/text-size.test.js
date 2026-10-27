// The editor's text size: steps, pinches and the keys that change it (textSize.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampFont, DEFAULT_FONT, MAX_FONT, MIN_FONT, pinchFont, stepFont, textSizeKey } from '../app/js/textSize.js';

test('sizes stay whole pixels within the limits', () => {
  assert.equal(clampFont(13.4), 13);
  assert.equal(clampFont(2), MIN_FONT);
  assert.equal(clampFont(99), MAX_FONT);
  assert.equal(clampFont('16'), 16);
  for (const bad of [undefined, null, 'big', NaN, 0, -3]) assert.equal(clampFont(bad), DEFAULT_FONT, String(bad));
});

test('a step is a pixel, two above 20 px, and stops at the ends', () => {
  assert.equal(stepFont(14, 1), 15);
  assert.equal(stepFont(14, -1), 13);
  assert.equal(stepFont(20, 1), 22);
  assert.equal(stepFont(22, -1), 20);
  assert.equal(stepFont(21, -1), 20);
  assert.equal(stepFont(19, 1), 20);
  assert.equal(stepFont(21, 1), 22, 'a size from a pinch goes to the next even one');
  assert.equal(stepFont(MIN_FONT, -1), MIN_FONT);
  assert.equal(stepFont(MAX_FONT, 1), MAX_FONT);
  // Up and back down returns to where it was.
  for (let s = MIN_FONT; s <= 20; s++) assert.equal(stepFont(stepFont(s, 1), -1), s, `from ${s}`);
});

test('a pinch scales the size it started at', () => {
  assert.equal(pinchFont(14, 200, 200), 14);
  assert.equal(pinchFont(14, 200, 100), MIN_FONT, 'fingers half as far apart: 7 px, held at the smallest');
  assert.equal(pinchFont(14, 200, 160), 11);
  assert.equal(pinchFont(14, 200, 300), 21);
  assert.equal(pinchFont(14, 100, 1000), MAX_FONT);
  assert.equal(pinchFont(14, 0, 100), 14, 'no distance to start from: as it was');
});

test('the keys: Ctrl+= or Ctrl++ larger, Ctrl+- smaller, Ctrl+0 the usual size', () => {
  const key = (k, extra = {}) => textSizeKey({ key: k, code: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(key('='), 1);
  assert.equal(key('+', { shiftKey: true }), 1, 'Ctrl+Shift+= on US keyboards, Ctrl++ elsewhere');
  assert.equal(key('-'), -1);
  assert.equal(key('0'), 0);
  assert.equal(key('', { code: 'NumpadAdd' }), 1);
  assert.equal(key('', { code: 'NumpadSubtract' }), -1);
  assert.equal(key('0', { metaKey: true, ctrlKey: false }), 0, 'Cmd on a Mac');
  assert.equal(key('='.repeat(1), { ctrlKey: false }), null, 'needs Ctrl');
  assert.equal(key('0', { altKey: true }), null, 'Ctrl+Alt is AltGr on some keyboards');
  assert.equal(key(')', { shiftKey: true }), null);
  assert.equal(key('p'), null);
});
