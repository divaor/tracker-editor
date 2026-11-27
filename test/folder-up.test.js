// Going up past a picked folder (0.54): electron/folders.cjs allowUp, behind IPC folder:allow-up.
// Only from a folder the page reaches, to the one above it (or a folder above it), and a new one
// only after the person says so in the native dialog (`ask` here). In test:phone-node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wideOf } from '../app/js/folders.js';

const require = createRequire(import.meta.url);
const { allowUp, allowedBy } = require('../electron/folders.cjs');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-up-')));

// The main process's picked folders, and a dialog that answers `answer` (and says what it was asked).
function setup(answer) {
  const top = tmp();
  const picked = path.join(top, 'work', 'site');
  fs.mkdirSync(path.join(picked, 'src'), { recursive: true });
  const roots = [picked];
  const asked = [];
  const deps = {
    roots: () => roots,
    add: (p) => roots.push(p),
    ask: async (q) => (asked.push(q), typeof answer === 'function' ? answer(q) : answer),
    wideOf: (p) => wideOf(p, { home: top }),
  };
  return { top, picked, roots, asked, deps };
}

test('going up asks first; Go up allows the folder above, and it is reachable then', async () => {
  const { top, picked, roots, asked, deps } = setup('up');
  const parent = path.join(top, 'work');
  assert.equal(allowedBy(roots, parent), false);
  assert.deepEqual(await allowUp(picked, {}, deps), { dir: parent, allowed: parent });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].dir, parent, 'the dialog names the folder');
  assert.equal(asked[0].wide, top, 'and offers all of its place (here: the home folder holding it)');
  assert.deepEqual(roots, [picked, parent]);
  assert.equal(allowedBy(roots, path.join(parent, 'other.txt')), true);
  // Reachable now: no question again.
  assert.deepEqual(await allowUp(path.join(picked, 'src'), {}, deps), { dir: picked });
  assert.deepEqual(await allowUp(picked, {}, deps), { dir: parent });
  assert.equal(asked.length, 1);
});

test('Allow all adds the wider place, so later ups inside it never ask', async () => {
  const { top, picked, roots, asked, deps } = setup('all');
  assert.deepEqual(await allowUp(picked, {}, deps), { dir: path.join(top, 'work'), allowed: top });
  assert.deepEqual(roots, [picked, top]);
  assert.deepEqual(await allowUp(path.join(top, 'work'), {}, deps), { dir: top });
  assert.equal(asked.length, 1);
});

test('Cancel (or no answer) changes nothing', async () => {
  for (const answer of ['cancel', null, undefined, 'yes']) {
    const { picked, roots, deps } = setup(answer);
    assert.deepEqual(await allowUp(picked, {}, deps), { cancelled: true });
    assert.deepEqual(roots, [picked]);
  }
  // "Allow all" when nothing wider was offered is not taken either.
  const { top, roots, deps } = setup('all');
  const result = await allowUp(path.join(top, 'work', 'site'), {}, { ...deps, wideOf: () => null });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(roots.length, 1);
});

test('a folder further up, named by a crumb: only one above the folder, asked the same way', async () => {
  const { top, picked, roots, asked, deps } = setup('up');
  assert.deepEqual(await allowUp(picked, { to: top }, deps), { dir: top, allowed: top });
  assert.equal(asked[0].wide, null, 'the home folder itself: nothing wider to offer');
  assert.ok(roots.includes(top));
  const other = setup('up');
  await assert.rejects(allowUp(other.picked, { to: path.join(other.picked, 'src') }, other.deps), /not a folder above/, 'not one inside it');
  await assert.rejects(allowUp(other.picked, { to: other.picked }, other.deps), /not a folder above/, 'not itself');
  await assert.rejects(allowUp(other.picked, { to: path.join(other.top, 'elsewhere') }, other.deps), /not a folder above/, 'not a sibling');
  await assert.rejects(allowUp(other.picked, { to: 'work' }, other.deps), /not a folder above/, 'not a relative path');
  assert.equal(other.asked.length, 0);
});

test('never from a folder the page cannot reach, nor through a link that leads out', async () => {
  const { top, picked, asked, deps } = setup('up');
  const outside = tmp();
  await assert.rejects(allowUp(outside, {}, deps), /not opened here/);
  await assert.rejects(allowUp('relative/dir', {}, deps), /not opened here/);
  await assert.rejects(allowUp(42, {}, deps), /not opened here/);
  await assert.rejects(allowUp(path.join(picked, '..', '..'), {}, deps), /not opened here/, '.. does not count as inside');
  fs.symlinkSync(outside, path.join(picked, 'link'));
  await assert.rejects(allowUp(path.join(picked, 'link'), {}, deps), /not opened here/, 'a link out of the folder');
  assert.equal(asked.length, 0);
  assert.ok(top);
});

test('at the top there is nothing above', async () => {
  const { deps, roots } = setup('up');
  roots.push('/');
  assert.deepEqual(await allowUp('/', {}, deps), { top: true });
});
