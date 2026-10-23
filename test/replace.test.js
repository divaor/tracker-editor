// Replace in a folder: the text after replacing, with the same options as Find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceAll, replacedLine } from '../app/js/replace.js';

test('replacing plain text, whole words, case', () => {
  assert.deepEqual(replaceAll('a cat, a Cat, concat', 'cat', {}, 'dog'), { text: 'a dog, a dog, condog', count: 3 });
  assert.deepEqual(replaceAll('a cat, a Cat, concat', 'cat', { caseSensitive: true }, 'dog'), { text: 'a dog, a Cat, condog', count: 2 });
  assert.deepEqual(replaceAll('a cat, a Cat, concat', 'cat', { wholeWord: true }, 'dog'), { text: 'a dog, a dog, concat', count: 2 });
  // As typed: "$1" is not a group without a regular expression.
  assert.deepEqual(replaceAll('price: 5', 'price', {}, '$1 cost'), { text: '$1 cost: 5', count: 1 });
  assert.deepEqual(replaceAll('nothing here', 'cat', {}, 'dog'), { text: 'nothing here', count: 0 });
});

test('replacing with a regular expression: groups, names, line breaks', () => {
  assert.deepEqual(replaceAll('2026-10-23 and 2025-01-02', '(\\d{4})-(\\d{2})-(\\d{2})', { regex: true }, '$3/$2/$1'), { text: '23/10/2026 and 02/01/2025', count: 2 });
  assert.equal(replaceAll('userId = 1', '(?<name>user)Id', { regex: true }, '$<name>Key').text, 'userKey = 1');
  assert.equal(replaceAll('a,b', ',', { regex: true }, '\\n').text, 'a\nb');
  assert.equal(replaceAll('a,b', ',', { regex: true }, '\\\\n').text, 'a\\nb');
  assert.equal(replaceAll('x', 'x', { regex: true }, '[$&]').text, '[x]');
  assert.throws(() => replaceAll('x', '(', { regex: true }, 'y'), /Invalid regular expression/);
  // The preview of a line never throws.
  assert.equal(replacedLine('const a = 1;', '(', { regex: true }, 'y'), 'const a = 1;');
  assert.equal(replacedLine('const old = 1;', 'old', { wholeWord: true }, 'fresh'), 'const fresh = 1;');
});
