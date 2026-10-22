import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, SearchQuery } from '../app/vendor/cm/codemirror.js';
import { countLabel, countMatches } from '../app/js/searchPanel.js';

const state = (doc, anchor = 0, head = anchor) => EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });

test('countMatches counts and finds the match the selection is on', () => {
  const doc = 'foo bar Foo foo';
  assert.deepEqual(countMatches(new SearchQuery({ search: 'foo' }), state(doc)), { total: 3, index: 0, capped: false, valid: true });
  assert.equal(countMatches(new SearchQuery({ search: 'foo' }), state(doc, 8, 11)).index, 2);
  assert.equal(countMatches(new SearchQuery({ search: 'foo', caseSensitive: true }), state(doc)).total, 2);
  assert.equal(countMatches(new SearchQuery({ search: 'fo', wholeWord: true }), state(doc)).total, 0);
  assert.equal(countMatches(new SearchQuery({ search: 'b.r', regexp: true }), state(doc)).total, 1);
});

test('countMatches stops at the cap and reports bad patterns', () => {
  assert.deepEqual(countMatches(new SearchQuery({ search: 'a' }), state('a'.repeat(50)), 10), { total: 10, index: 0, capped: true, valid: true });
  assert.equal(countMatches(new SearchQuery({ search: '(', regexp: true }), state('x')).valid, false);
  assert.equal(countMatches(new SearchQuery({ search: '' }), state('x')).total, 0);
});

test('countLabel', () => {
  assert.equal(countLabel({ total: 12, index: 3, capped: false, valid: true }, 'x'), '3 of 12');
  assert.equal(countLabel({ total: 12, index: 0, capped: false, valid: true }, 'x'), '12 matches');
  assert.equal(countLabel({ total: 1, index: 0, capped: false, valid: true }, 'x'), '1 match');
  assert.equal(countLabel({ total: 10000, index: 0, capped: true, valid: true }, 'x'), '10000+ matches');
  assert.equal(countLabel({ total: 0, index: 0, capped: false, valid: true }, 'x'), 'No results');
  assert.equal(countLabel({ total: 0, index: 0, capped: false, valid: true }, ''), '');
  assert.equal(countLabel({ total: 0, index: 0, capped: false, valid: false }, '('), 'Invalid pattern');
});
