import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropOperation, inFolder, itemsName, paneCommand, paneRows, sameNamed, transferable, UP_NAME } from '../app/js/panes.js';

const e = (name, extra = {}) => ({ name, path: `/p/${name}`, dir: false, size: 1, mtimeMs: 0, hidden: name.startsWith('.'), ...extra });

test('a pane shows .. first, then folders and files sorted, hidden ones only when asked', () => {
  const entries = [e('b.txt'), e('a', { dir: true }), e('.env'), e('A.md')];
  const rows = paneRows(entries, { up: '/' });
  assert.deepEqual(rows.map((r) => r.name), [UP_NAME, 'a', 'A.md', 'b.txt']);
  assert.equal(rows[0].up, true);
  assert.equal(rows[0].path, '/');
  assert.deepEqual(paneRows(entries, { hidden: true }).map((r) => r.name), ['a', '.env', 'A.md', 'b.txt']);
  assert.deepEqual(paneRows(entries, { sort: 'name', reverse: true }).map((r) => r.name), ['a', 'b.txt', 'A.md']);
  assert.deepEqual(paneRows([]), []);
});

test('keys: F5 copies, F6 moves, F7 a folder, F8 or Del deletes, Tab the other side', () => {
  assert.equal(paneCommand({ key: 'F5' }), 'copy');
  assert.equal(paneCommand({ key: 'F6' }), 'move');
  assert.equal(paneCommand({ key: 'F7' }), 'newFolder');
  assert.equal(paneCommand({ key: 'N', ctrlKey: true, shiftKey: true }), 'newFolder');
  assert.equal(paneCommand({ key: 'F8' }), 'delete');
  assert.equal(paneCommand({ key: 'Delete' }), 'delete');
  assert.equal(paneCommand({ key: 'F2' }), 'rename');
  assert.equal(paneCommand({ key: 'Tab' }), 'switch');
  assert.equal(paneCommand({ key: 'Tab', shiftKey: true }), 'switch');
  assert.equal(paneCommand({ key: 'Tab', ctrlKey: true }), null, 'Ctrl+Tab goes to the next tab');
  assert.equal(paneCommand({ key: 'Backspace' }), 'up');
  assert.equal(paneCommand({ key: 'ArrowUp', altKey: true }), 'up');
  assert.equal(paneCommand({ key: 'Enter', altKey: true }), 'properties');
  assert.equal(paneCommand({ key: 'Enter' }), 'open');
  assert.equal(paneCommand({ key: 'a', ctrlKey: true }), 'selectAll');
  assert.equal(paneCommand({ key: 'a', metaKey: true }), 'selectAll');
  assert.equal(paneCommand({ key: ' ' }), 'view');
  assert.equal(paneCommand({ key: 'Insert' }), 'mark');
  assert.equal(paneCommand({ key: 'ArrowDown' }), null);
  assert.equal(paneCommand({ key: 'r', ctrlKey: true }), null, 'Ctrl+R is the window’s reload');
  assert.equal(paneCommand({ key: 'x' }), null, 'letters jump to names');
  assert.equal(paneCommand({ key: 'F5', ctrlKey: true }), null);
});

test('a drop moves within one place and copies between places; Ctrl copies, Shift moves', () => {
  assert.equal(dropOperation('/home/me/a/x.txt', '/home/me/b'), 'move');
  assert.equal(dropOperation('/home/me/a/x.txt', 'remote://box/var/www'), 'copy');
  assert.equal(dropOperation('remote://box/a/x', 'remote://box/b'), 'move');
  assert.equal(dropOperation('remote://box/a/x', 'remote://other/b'), 'copy');
  assert.equal(dropOperation('C:\\work\\x.txt', 'D:\\backup'), 'copy');
  assert.equal(dropOperation('C:\\work\\x.txt', 'c:\\other'), 'move');
  assert.equal(dropOperation('/home/me/a/x.txt', '/home/me/b', { ctrlKey: true }), 'copy');
  assert.equal(dropOperation('/home/me/a/x.txt', 'remote://box/b', { shiftKey: true }), 'move');
});

test('what can go to a folder: not what is there already, not a folder into itself', () => {
  assert.deepEqual(transferable(['/a/x.txt', '/b/y.txt', '/b', '/b/c'], '/b/c/d'), { go: ['/a/x.txt', '/b/y.txt'], here: [], into: ['/b', '/b/c'] });
  assert.deepEqual(transferable(['/a/x.txt'], '/a'), { go: [], here: ['/a/x.txt'], into: [] });
  assert.deepEqual(transferable(['remote://box/www/x'], 'remote://box/www'), { go: [], here: ['remote://box/www/x'], into: [] });
  assert.deepEqual(transferable(['C:\\w\\a.txt'], 'D:\\b'), { go: ['C:\\w\\a.txt'], here: [], into: [] });
  // A server's top folder and a drive's: their entries are in them.
  assert.deepEqual(transferable(['remote://box/x.txt'], 'remote://box/'), { go: [], here: ['remote://box/x.txt'], into: [] });
  assert.equal(inFolder('C:\\a.txt', 'C:\\'), true);
  assert.equal(inFolder('/a.txt', '/'), true);
  assert.equal(inFolder('/home/a.txt', '/home/'), true);
  assert.equal(inFolder('/home/me/a.txt', '/home'), false);
});

test('the file of the same name on the other side, and names for messages', () => {
  const other = [{ up: true, name: '..', path: '/' }, e('Notes.md'), e('x.txt')];
  assert.equal(sameNamed(other, e('x.txt')).name, 'x.txt');
  assert.equal(sameNamed(other, e('notes.md')).name, 'Notes.md');
  assert.equal(sameNamed(other, e('..')), null);
  assert.equal(sameNamed(other, e('none')), null);
  assert.equal(sameNamed(other, null), null);
  assert.equal(itemsName(['/a/b.txt']), 'b.txt');
  assert.equal(itemsName(['/a', '/b']), '2 items');
});
