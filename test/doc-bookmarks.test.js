import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkLabel, bookmarkOf, MAX_BOOKMARKS, movedBookmarks, placeAt, topOf, withBookmark, withoutBookmark } from '../app/js/docBookmarks.js';

test('a bookmark is kept per file, cleared, and the oldest go past the limit', () => {
  let marks = withBookmark(undefined, '/docs/book.epub', { block: 12, into: 0.5 }, 100);
  assert.deepEqual(bookmarkOf(marks, '/docs/book.epub'), { block: 12, into: 0.5, at: 100 });
  assert.equal(bookmarkOf(marks, '/docs/other.pdf'), null);
  assert.equal(bookmarkOf(marks, ''), null);
  assert.equal(bookmarkOf(undefined, '/docs/book.epub'), null);
  // Not a property every object has.
  assert.equal(bookmarkOf(marks, 'toString'), null);
  marks = withBookmark(marks, '/docs/book.epub', { block: 40, into: 0 }, 200);
  assert.equal(bookmarkOf(marks, '/docs/book.epub').block, 40);
  assert.equal(bookmarkOf(withoutBookmark(marks, '/docs/book.epub'), '/docs/book.epub'), null);

  let many = {};
  for (let i = 0; i < MAX_BOOKMARKS + 5; i++) many = withBookmark(many, `/f${i}.pdf`, { page: 1 }, i);
  assert.equal(Object.keys(many).length, MAX_BOOKMARKS);
  assert.equal(bookmarkOf(many, '/f0.pdf'), null);
  assert.equal(bookmarkOf(many, '/f4.pdf'), null);
  assert.ok(bookmarkOf(many, '/f5.pdf'));
  assert.ok(bookmarkOf(many, `/f${MAX_BOOKMARKS + 4}.pdf`));
});

test('bookmarks follow files and folders that moved', () => {
  const marks = { '/a/book.pdf': { page: 3 }, '/a/sub/x.epub': { block: 2 }, '/b/y.docx': { block: 1 }, 'C:\\docs\\z.pdf': { page: 9 } };
  const moved = movedBookmarks(marks, [{ from: '/a', to: '/c' }, { from: 'C:\\docs\\z.pdf', to: 'C:\\docs\\read\\z.pdf' }]);
  assert.deepEqual(Object.keys(moved).sort(), ['/b/y.docx', '/c/book.pdf', '/c/sub/x.epub', 'C:\\docs\\read\\z.pdf']);
  assert.equal(moved['/c/book.pdf'].page, 3);
  // Nothing moved: the same object.
  assert.equal(movedBookmarks(marks, [{ from: '/elsewhere', to: '/x' }]), marks);
  assert.equal(movedBookmarks(undefined, [{ from: '/a', to: '/b' }]), undefined);
  // A folder named like the start of another is not it.
  assert.equal(movedBookmarks({ '/ab/c.pdf': { page: 1 } }, [{ from: '/a', to: '/z' }])['/ab/c.pdf'].page, 1);
});

test('the place at the top of the screen, and back to it', () => {
  const tops = [0, 100, 300, 300, 700];
  const bottoms = [80, 280, 650, 400, 900];
  assert.deepEqual(placeAt(tops, bottoms, 0), { block: 0, into: 0 });
  assert.deepEqual(placeAt(tops, bottoms, 90), { block: 1, into: 0 });
  assert.deepEqual(placeAt(tops, bottoms, 190), { block: 1, into: 0.5 });
  // A block inside another (a paragraph in a list item): the outer one, which starts first.
  assert.deepEqual(placeAt(tops, bottoms, 335), { block: 2, into: 0.1 });
  // Past the end: the last block.
  assert.deepEqual(placeAt(tops, bottoms, 5000), { block: 4, into: 0 });
  assert.deepEqual(placeAt([], [], 10), { block: 0, into: 0 });
  // An empty block (a rule) reaching below the top.
  assert.deepEqual(placeAt([50], [50], 49.5), { block: 0, into: 0 });
  assert.equal(topOf({ block: 1, into: 0.5 }, 100, 180), 190);
  assert.equal(topOf({ block: 0 }, 40, 10), 40);
  assert.equal(topOf({ block: 0, into: 0 }, -5, 10), 0);
});

test('bookmark labels', () => {
  assert.equal(bookmarkLabel({ page: 12, pages: 300 }), 'page 12 of 300');
  assert.equal(bookmarkLabel({ page: 2 }), 'page 2');
  assert.equal(bookmarkLabel({ block: 4, heading: '  Chapter\n 3 ', percent: 0.341 }), 'Chapter 3 · 34%');
  assert.equal(bookmarkLabel({ block: 4, percent: 0.5 }), '50% in');
  assert.equal(bookmarkLabel({ block: 4, heading: 'x'.repeat(60), percent: 1 }), `${'x'.repeat(47)}… · 100%`);
  assert.equal(bookmarkLabel(null), '');
});
