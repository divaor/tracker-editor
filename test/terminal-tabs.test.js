import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTab, closeTab, dropIndex, EMPTY_TABS, fromWsl, moveTab, oscCwd, shown, sideOf, splitTab, tabName, unsplit, useTab } from '../app/js/terminalTabs.js';

const three = () => ['a', 'b', 'c'].reduce((s, k) => addTab(s, k), EMPTY_TABS);

test('new tabs go at the end and are in use; only the one in use shows', () => {
  const s = three();
  assert.deepEqual(s, { order: ['a', 'b', 'c'], active: 'c', split: null });
  assert.equal(shown(s, 'c'), true);
  assert.equal(shown(s, 'a'), false);
  assert.equal(useTab(s, 'a').active, 'a');
  assert.equal(useTab(s, 'zz'), s, 'an unknown tab changes nothing');
});

test('tabs move between the others', () => {
  const s = three();
  assert.deepEqual(moveTab(s, 'c', 0).order, ['c', 'a', 'b']);
  assert.deepEqual(moveTab(s, 'a', 2).order, ['b', 'c', 'a']);
  assert.deepEqual(moveTab(s, 'a', 99).order, ['b', 'c', 'a']);
  assert.deepEqual(moveTab(s, 'b', 1).order, ['a', 'b', 'c']);
  assert.equal(moveTab(s, 'zz', 0), s);
});

test('a drop over the strip: the index among the others, by the tabs’ middles', () => {
  const middles = [50, 150, 250];
  assert.equal(dropIndex(middles, 10), 0);
  assert.equal(dropIndex(middles, 100), 1);
  assert.equal(dropIndex(middles, 300), 3);
  // Dragging the first tab past the second: one place on.
  assert.equal(dropIndex(middles, 200, 0), 1);
  // Dragging the last to the start.
  assert.equal(dropIndex(middles, 10, 2), 0);
});

test('splitting: the tab on one side, the one in use on the other', () => {
  const s = useTab(three(), 'a');
  const sp = splitTab(s, 'c', 'right');
  assert.deepEqual(sp.split, { left: 'a', right: 'c' });
  assert.equal(sp.active, 'c');
  assert.equal(sideOf(sp, 'a'), 'left');
  assert.equal(shown(sp, 'a') && shown(sp, 'c') && !shown(sp, 'b'), true);
  // The one in use put on a side: its neighbor goes on the other.
  assert.deepEqual(splitTab(s, 'a', 'right').split, { left: 'b', right: 'a' });
  // The last tab's neighbor is the one before it.
  assert.deepEqual(splitTab(useTab(s, 'c'), 'c', 'left').split, { left: 'c', right: 'b' });
  // One tab cannot be split.
  const one = addTab(EMPTY_TABS, 'x');
  assert.equal(splitTab(one, 'x', 'left'), one);
});

test('split: another side swaps, another tab replaces, using a hidden one replaces the side in use', () => {
  const sp = splitTab(useTab(three(), 'a'), 'c', 'right'); // a | c, c in use
  assert.deepEqual(splitTab(sp, 'c', 'left').split, { left: 'c', right: 'a' }, 'swapped');
  assert.deepEqual(splitTab(sp, 'b', 'left').split, { left: 'b', right: 'c' });
  const used = useTab(sp, 'b'); // c was in use, on the right: b takes its place
  assert.deepEqual(used.split, { left: 'a', right: 'b' });
  assert.equal(used.active, 'b');
  const onLeft = useTab(useTab(sp, 'a'), 'b');
  assert.deepEqual(onLeft.split, { left: 'b', right: 'c' });
  assert.deepEqual(unsplit(sp), { ...sp, split: null, active: 'c' });
  assert.equal(unsplit(sp, 'a').active, 'a');
});

test('closing: the next tab takes the place; a split with nothing left to show joins', () => {
  const s = three();
  assert.deepEqual(closeTab(s, 'c'), { order: ['a', 'b'], active: 'b', split: null });
  assert.deepEqual(closeTab(useTab(s, 'a'), 'a'), { order: ['b', 'c'], active: 'b', split: null });
  assert.deepEqual(closeTab(s, 'a'), { order: ['b', 'c'], active: 'c', split: null });
  const sp = splitTab(useTab(s, 'a'), 'c', 'right'); // a | c
  assert.deepEqual(closeTab(sp, 'c'), { order: ['a', 'b'], split: { right: 'b', left: 'a' }, active: 'b' });
  assert.deepEqual(closeTab(sp, 'b'), { order: ['a', 'c'], split: { left: 'a', right: 'c' }, active: 'c' }, 'a hidden one');
  const two = closeTab(sp, 'b');
  assert.deepEqual(closeTab(two, 'a'), { order: ['c'], split: null, active: 'c' });
  assert.deepEqual(closeTab(EMPTY_TABS, 'x'), EMPTY_TABS);
  assert.deepEqual(closeTab(addTab(EMPTY_TABS, 'x'), 'x'), { order: [], active: null, split: null });
});

test('a tab’s name: the one given, else what it is and where', () => {
  assert.equal(tabName({ place: 'This computer', folder: 'site' }), 'This computer · site');
  assert.equal(tabName({ place: 'Box', runner: true }), 'Run · Box');
  assert.equal(tabName({ name: '  build  ', place: 'Box' }), 'build');
  assert.equal(tabName({ name: '   ', place: 'Box' }), 'Box');
});

test('the folder a shell says it is in', () => {
  assert.equal(oscCwd(7, 'file://box/home/me/my%20app'), '/home/me/my app');
  assert.equal(oscCwd(7, 'file:///srv/www/'), '/srv/www');
  assert.equal(oscCwd(7, 'file://box/'), '/');
  assert.equal(oscCwd(7, 'file://box/100%'), '/100%', 'not percent-encoded after all: as it came');
  // Git Bash: file://PC/C:/Users/Me; PowerShell and cmd: 9;9 with or without quotes.
  assert.equal(oscCwd(7, 'file://PC/C:/Users/Me', { windows: true }), 'C:\\Users\\Me');
  assert.equal(oscCwd(9, '9;"C:\\Users\\Me\\a b"', { windows: true }), 'C:\\Users\\Me\\a b');
  assert.equal(oscCwd(9, '9;D:\\', { windows: true }), 'D:\\');
  assert.equal(oscCwd(633, 'P;Cwd=/home/me/x\\x3by'), '/home/me/x;y');
  // Other OSC 9 (progress), relative paths, control characters: nothing.
  assert.equal(oscCwd(9, '4;1;50'), null);
  assert.equal(oscCwd(7, 'file://box'), null);
  assert.equal(oscCwd(9, '9;relative/dir'), null);
  assert.equal(oscCwd(7, 'file://box/a\u0007b'), null);
  assert.equal(oscCwd(2, 'title'), null);
  // WSL's folders as Windows reaches them.
  assert.equal(fromWsl('/mnt/c/Users/Me'), 'C:\\Users\\Me');
  assert.equal(fromWsl('/home/me/app', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
  assert.equal(fromWsl('/home/me'), null);
});
