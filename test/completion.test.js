// Suggestions as you type: the part of the model's answer that is shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCompletion, completionMessages, restCovered, shouldSuggest } from '../app/js/completion.js';

test('the answer is cleaned: fences, echoes, the text after the cursor, length', () => {
  assert.equal(cleanCompletion('sum(items);', { prefix: 'const total = ' }), 'sum(items);');
  assert.equal(cleanCompletion('```js\nsum(items);\n```', { prefix: 'const total = ' }), 'sum(items);');
  assert.equal(cleanCompletion('const total = sum(items);', { prefix: 'function f() {\n  const total = ' }), 'sum(items);');
  // It stops where it would repeat what follows the cursor.
  assert.equal(cleanCompletion('a, b);\n}\n\nfunction next() {}', { prefix: 'call(', suffix: ');\n}\n' }), 'a, b');
  assert.equal(cleanCompletion('x + 1\n  return y;\n}', { prefix: '  const y = ', suffix: '\n  return y;\n}' }), 'x + 1');
  // A blank line ends it; at most 12 lines.
  assert.equal(cleanCompletion('a\nb\n\nc'), 'a\nb');
  assert.equal(cleanCompletion(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')).split('\n').length, 12);
  assert.equal(cleanCompletion('   \n'), '');
  assert.equal(cleanCompletion('<CURSOR>'), '');
});

test('when to ask, and what is asked', () => {
  assert.equal(shouldSuggest({ before: 'const total = ', after: '' }), true);
  assert.equal(shouldSuggest({ before: 'call(', after: ')' }), true);
  assert.equal(shouldSuggest({ before: '   ', after: '' }), false, 'nothing typed on the line');
  assert.equal(shouldSuggest({ before: 'const to', after: 'tal = 1' }), false, 'in the middle of a word');
  assert.equal(shouldSuggest({ before: 'a = ', after: 'b + c' }), false, 'text after the cursor');
  const m = completionMessages({ prefix: 'def f(', suffix: '):', language: 'Python', name: 'a.py' });
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].content, 'File: a.py (Python)\n\ndef f(<CURSOR>):');
});

test('a suggestion takes the place of the closing brackets it writes too', () => {
  assert.equal(restCovered('b) {\n  return a + b;', ')'), 1);
  assert.equal(restCovered("x'])", "'])"), 3);
  assert.equal(restCovered('b', ')'), 0, 'a suggestion without them leaves them');
  assert.equal(restCovered('\n  a,\n  b\n', ');'), 0);
  assert.equal(restCovered('\n  a,\n  b\n);', ');'), 2);
  assert.equal(restCovered('anything', ''), 0);
  assert.equal(restCovered('x) ', ' )  '), 4, 'spaces count with what they surround');
});
