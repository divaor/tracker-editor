// Comparing two texts (app/js/lineDiff.js): lines (histogram diff, Myers' between), blocks slid
// to where a reader expects them, the words that changed inside a changed block, the whitespace
// and highlighting options, large inputs within their time, and edits compared again around
// themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChunks, diffLineArrays, diffOptionsOf, diffTexts, foldRuns, mapFolds, pairLines, replaceLinesChange, updateChunks, wordChanges } from '../app/js/lineDiff.js';

const lines = (text) => text.split('\n');
/** The chunks as short strings: "insert a3 b3-5", "modify a9-10 b11-12 [1→2]". */
const brief = (a, b, chunks) =>
  chunks.map((c) => {
    const ta = lines(a).slice(c.a0, c.a1).join('\n');
    const tb = lines(b).slice(c.b0, c.b1).join('\n');
    const words = c.inner.map((m) => `${ta.slice(m.fromA, m.toA)}→${tb.slice(m.fromB, m.toB)}`);
    return `${c.kind} a${c.a0}${c.a1 > c.a0 ? `-${c.a1}` : ''} b${c.b0}${c.b1 > c.b0 ? `-${c.b1}` : ''}${words.length ? ` [${words.join(', ')}]` : ''}`;
  });
// Texts, or arrays of lines (no line at all is a text with none, not one empty line).
const valid = (a, b, chunks) => {
  const [la, lb] = [a, b].map((t) => (Array.isArray(t) ? t : lines(t)));
  assert.deepEqual(applyChunks(la, lb, chunks), lb, 'the chunks turn the left text into the right one');
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].a0 >= chunks[i - 1].a1 && chunks[i].b0 >= chunks[i - 1].b1, 'in order, apart');
  for (const c of chunks) assert.equal(c.kind, c.a0 === c.a1 ? 'insert' : c.b0 === c.b1 ? 'delete' : 'modify');
};

// A PHP class of `n` functions (each its own name, braces and blank lines alike).
const fn = (name, i, { limit = 5000, tail = '' } = {}) => [
  `    function ${name}($args, $filter = '1', $limit = ${limit})`,
  '    {',
  `        if (!isset($args['_data'])) {`,
  `            return ['error' => 'Bad request', 'code' => ${i}];`,
  '        }',
  `        return $this->respond($this->find($filter, $limit), '${name}');${tail}`,
  '    }',
  '',
];
const php = (n, edit = (i, f) => f) => {
  const out = ['<?php', '', 'class Index extends Controller', '{', "    const BASE = 'https://example.com/app/';", ''];
  for (let i = 0; i < n; i++) out.push(...edit(i, fn(`item${i}`, i)));
  out.push('}', '');
  return out.join('\n');
};

test('two lines inserted near the top of a big file: exactly that block, nothing else', () => {
  const a = php(400);
  const b = a.replace("    const BASE = 'https://example.com/app/';\n", "    const BASE = 'https://example.com/app/';\n    const TYPE_VIEW = 'view';\n    const TYPE_APP = 'app';\n");
  const chunks = diffTexts(a, b);
  assert.deepEqual(brief(a, b, chunks), ['insert a5 b5-7']);
  valid(a, b, chunks);
});

test('a changed value: the line is the chunk, the value the only word marked', () => {
  const a = php(50);
  const b = php(50, (i, f) => (i === 20 ? fn(`item${i}`, i, { limit: 500 }) : f));
  const chunks = diffTexts(a, b);
  assert.equal(chunks.length, 1);
  assert.match(brief(a, b, chunks)[0], /^modify a166-167 b166-167 \[5000→500\]$/);
  const url = diffTexts("const URL = 'https://jsd.example.com/app/';", "const URL = 'https://jsd.example.org/app/';");
  assert.deepEqual(brief("const URL = 'https://jsd.example.com/app/';", "const URL = 'https://jsd.example.org/app/';", url), ['modify a0-1 b0-1 [com→org]']);
});

test('a function added between two: the function and its blank line, not the blank before it', () => {
  const a = php(10);
  const b = php(10, (i, f) => (i === 4 ? [...f, ...fn('added', 99)] : f));
  const chunks = diffTexts(a, b);
  assert.equal(chunks.length, 1);
  const c = chunks[0];
  assert.equal(c.kind, 'insert');
  assert.match(lines(b)[c.b0], /function added\(/);
  assert.equal(lines(b)[c.b1 - 1], '');
  valid(a, b, chunks);
  // A function added last in a class: after the blank line that ends the one before.
  const a2 = ['class A {', '    function a() {', '    }', '}'].join('\n');
  const b2 = ['class A {', '    function a() {', '    }', '', '    function b() {', '    }', '}'].join('\n');
  assert.deepEqual(brief(a2, b2, diffTexts(a2, b2)), ['insert a3 b3-6']);
});

test('a removed function, functions added in two places, changed lines: each its own chunk', () => {
  const a = php(120);
  const b = php(120, (i, f) => {
    if (i === 30) return [];
    if (i === 60 || i === 90) return [...f, ...fn(`new${i}a`, i), ...fn(`new${i}b`, i)];
    if (i % 25 === 3) return fn(`item${i}`, i, { tail: ' // checked' });
    return f;
  });
  const chunks = diffTexts(a, b);
  valid(a, b, chunks);
  const kinds = chunks.map((c) => c.kind);
  assert.equal(kinds.filter((k) => k === 'delete').length, 1);
  assert.equal(kinds.filter((k) => k === 'insert').length, 2);
  assert.equal(kinds.filter((k) => k === 'modify').length, 5);
  for (const c of chunks.filter((k) => k.kind === 'modify')) assert.deepEqual(brief(a, b, [c])[0].replace(/^.*\[/, '['), '[→ // checked]');
});

test('a moved line: removed where it was, added where it went', () => {
  const a = 'alpha\nbeta\ngamma\ndelta';
  const b = 'beta\ngamma\ndelta\nalpha';
  assert.deepEqual(brief(a, b, diffTexts(a, b)), ['delete a0-1 b0', 'insert a4 b3-4']);
});

test('a line changed and lines added after it: the change, then the added lines apart', () => {
  const a = 'x\n  $x = 1;\ny';
  const b = 'x\n  $x = 2;\n  $y = 3;\n  $z = 4;\ny';
  assert.deepEqual(brief(a, b, diffTexts(a, b)), ['modify a1-2 b1-2 [1→2]', 'insert a2 b2-4']);
});

test('lines too unlike to compare by words keep whole lines; a line split in two stays one change', () => {
  assert.deepEqual(brief('x\nfoo bar baz\ny', 'x\nqux quux\ny', diffTexts('x\nfoo bar baz\ny', 'x\nqux quux\ny')), ['modify a1-2 b1-2']);
  assert.deepEqual(brief('$a = load($x);', 'return compute($y) + other(1, 2, 3);', diffTexts('$a = load($x);', 'return compute($y) + other(1, 2, 3);')), ['modify a0-1 b0-1']);
  // A short line with a word or two changed keeps its marks.
  assert.deepEqual(brief('x = 1', 'y = 2', diffTexts('x = 1', 'y = 2')), ['modify a0-1 b0-1 [x→y, 1→2]']);
  const a = 'one long line with many words in it\nz';
  const b = 'one long line\nwith many words\nin it\nz';
  const chunks = diffTexts(a, b);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].kind, 'modify');
  assert.ok(chunks[0].inner.every((m) => /^\s*$/.test(a.slice(m.fromA, m.toA))), 'only the line breaks changed');
});

test('stray matches amid new text do not make confetti', () => {
  const { changes } = wordChanges('$a = load($x);', '$a = compute($y) + other(1, 2, 3);');
  assert.ok(changes.length <= 2, JSON.stringify(changes));
});

test('whitespace: every space, the ends of lines, or none', () => {
  const a = 'x\n  foo(a, b);\ny';
  const b = 'x\n    foo(a, b);   \ny';
  assert.deepEqual(brief(a, b, diffTexts(a, b)), ['modify a1-2 b1-2 [  →    , →   ]']);
  assert.deepEqual(diffTexts(a, b, { whitespace: 'trim' }), []);
  assert.deepEqual(diffTexts(a, b, { whitespace: 'ignore' }), []);
  const c = 'x\n  foo(a,b);\ny';
  const d = 'x\n  foo( a, b );\ny';
  assert.equal(diffTexts(c, d, { whitespace: 'trim' }).length, 1);
  assert.deepEqual(diffTexts(c, d, { whitespace: 'ignore' }), []);
  // A line break's \r is a space at the end of the line.
  assert.equal(diffTexts('a\r\nb', 'a\nb').length, 1);
  assert.deepEqual(diffTexts('a\r\nb', 'a\nb', { whitespace: 'trim' }), []);
});

test('highlighting: words, characters, lines or none', () => {
  const a = 'x\ncolor: red;\ngetUserName()\ny';
  const b = 'x\ncolour: red;\ngetUserId()\ny';
  assert.deepEqual(brief(a, b, diffTexts(a, b)), ['modify a1-3 b1-3 [color→colour, getUserName→getUserId]']);
  assert.deepEqual(brief(a, b, diffTexts(a, b, { highlight: 'chars' })), ['modify a1-3 b1-3 [→u, Name→Id]']);
  assert.deepEqual(brief(a, b, diffTexts(a, b, { highlight: 'lines' })), ['modify a1-3 b1-3']);
  // Characters never split an emoji in two.
  assert.deepEqual(brief('say 😀 now', 'say 😃 now', diffTexts('say 😀 now', 'say 😃 now', { highlight: 'chars' })), ['modify a0-1 b0-1 [😀→😃]']);
  assert.deepEqual(brief('x1😀', 'x2😀', diffTexts('x1😀', 'x2😀', { highlight: 'chars' })), ['modify a0-1 b0-1 [1→2]']);
  assert.deepEqual(brief(a, b, diffTexts(a, b, { highlight: 'none' })), ['modify a1-3 b1-3']);
  assert.deepEqual(diffOptionsOf({ compareWhitespace: 'trim', compareHighlight: 'chars', compareCollapse: false }), { whitespace: 'trim', highlight: 'chars', collapse: false });
  assert.deepEqual(diffOptionsOf({ compareWhitespace: 'odd' }), { whitespace: 'exact', highlight: 'words', collapse: true });
});

test('lines are paired by likeness', () => {
  assert.deepEqual(pairLines(['  $x = 1;', 'return $x;'], ['// new', '  $x = 2;', 'return $x + 1;']), [
    [0, 1],
    [1, 2],
  ]);
  assert.deepEqual(pairLines(['foo bar baz'], ['qux quux']), []);
});

test('random edits: the chunks always turn one text into the other', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ['foo', 'bar', '}', '', '{', 'return x;', 'if (a) {', 'baz qux', '  y = 2;', '  y = 3;'];
  for (let t = 0; t < 1500; t++) {
    const A = Array.from({ length: Math.floor(rnd() * 40) }, () => pool[Math.floor(rnd() * pool.length)]);
    const B = A.slice();
    for (let o = Math.floor(rnd() * 8); o > 0; o--) {
      const p = Math.floor(rnd() * (B.length + 1));
      const r = rnd();
      if (r < 0.3) B.splice(p, 0, pool[Math.floor(rnd() * pool.length)]);
      else if (r < 0.6) B.splice(p, Math.ceil(rnd() * 3));
      else if (p < B.length) B[p] = `${B[p]} ${pool[Math.floor(rnd() * pool.length)]}`;
    }
    const chunks = diffLineArrays(A, B, { highlight: rnd() < 0.5 ? 'words' : 'chars' });
    valid(A, B, chunks);
    for (const c of chunks) {
      const ta = A.slice(c.a0, c.a1).join('\n');
      const tb = B.slice(c.b0, c.b1).join('\n');
      for (const m of c.inner) assert.ok(m.fromA >= 0 && m.toA <= ta.length && m.fromA <= m.toA && m.fromB >= 0 && m.toB <= tb.length && m.fromB <= m.toB);
    }
  }
});

test('large inputs: 100,000 lines compared well within a second, exactly', () => {
  const a = php(13000);
  const b = php(13000, (i, f) => {
    if (i % 97 === 5) return [];
    if (i % 211 === 7) return [...f, ...fn(`added${i}`, i)];
    if (i % 50 === 3) return fn(`item${i}`, i, { limit: 1 });
    return f;
  });
  assert.ok(lines(a).length > 100000);
  const t0 = Date.now();
  const chunks = diffTexts(a, b);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `${ms} ms`);
  valid(a, b, chunks);
  const kinds = chunks.reduce((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const removed = Array.from({ length: 13000 }, (_, i) => i).filter((i) => i % 97 === 5);
  assert.deepEqual(kinds, {
    delete: removed.length,
    insert: Array.from({ length: 13000 }, (_, i) => i).filter((i) => i % 211 === 7 && i % 97 !== 5).length,
    modify: Array.from({ length: 13000 }, (_, i) => i).filter((i) => i % 50 === 3 && i % 97 !== 5 && i % 211 !== 7).length,
  });
  // Two texts with nothing in common: one block, quickly.
  const x = Array.from({ length: 100000 }, (_, i) => `x${i}`);
  const y = Array.from({ length: 100000 }, (_, i) => `y${i}`);
  const t1 = Date.now();
  const all = diffLineArrays(x, y);
  assert.ok(Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
  assert.equal(all.length, 1);
});

test('an edit compares again only around itself, and the result stays right', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const source = (arr) => ({ lines: arr.length, line: (i) => arr[i] });
  for (let t = 0; t < 300; t++) {
    const A = lines(php(6 + Math.floor(rnd() * 6)));
    const B = A.slice();
    for (let o = 0; o < 4; o++) B.splice(Math.floor(rnd() * B.length), Math.floor(rnd() * 3), ...(rnd() < 0.5 ? ['  // note'] : []));
    let chunks = diffLineArrays(A, B);
    for (let e = 0; e < 5; e++) {
      const side = rnd() < 0.5 ? 'a' : 'b';
      const arr = side === 'a' ? A : B;
      const from = Math.floor(rnd() * arr.length);
      const cut = Math.min(arr.length - from, Math.floor(rnd() * 3));
      const add = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => `edit ${t} ${e} ${k}`);
      if (arr.length - cut + add.length === 0) continue;
      arr.splice(from, cut, ...add);
      const res = updateChunks(chunks, { side, from, to: from + Math.max(cut, 1), delta: add.length - cut }, source(A), source(B));
      chunks = res.chunks;
      valid(A.join('\n'), B.join('\n'), chunks);
    }
  }
});

test('folds: unchanged stretches less a margin, and after an edit', () => {
  const chunks = [{ a0: 20, a1: 21, b0: 20, b1: 22 }, { a0: 60, a1: 60, b0: 61, b1: 63 }];
  const folds = foldRuns(chunks, 100, 103, { margin: 3, minSize: 4 });
  assert.deepEqual(folds, [
    { a0: 0, a1: 17, b0: 0, b1: 17 },
    { a0: 24, a1: 57, b0: 25, b1: 58 },
    { a0: 63, a1: 100, b0: 66, b1: 103 },
  ]);
  assert.deepEqual(foldRuns(chunks, 100, 103, { margin: 3, minSize: 40 }), []);
  // An edit at lines 30-32 of the left: that fold goes, the ones after move.
  assert.deepEqual(mapFolds(folds, { side: 'a', from: 30, to: 33, delta: 2 }), [folds[0], { a0: 65, a1: 102, b0: 66, b1: 103 }]);
});

test('lines put in place of others: in the middle, at the end, all of them', () => {
  const doc = (text) => ({ lines: lines(text).length, length: text.length, lineFrom: (i) => lines(text).slice(0, i).join('\n').length + (i ? 1 : 0) });
  const apply = (text, ch) => text.slice(0, ch.from) + ch.insert + text.slice(ch.to);
  const t = 'a\nb\nc';
  assert.equal(apply(t, replaceLinesChange(doc(t), 1, 2, ['B', 'B2'])), 'a\nB\nB2\nc');
  assert.equal(apply(t, replaceLinesChange(doc(t), 1, 1, ['new'])), 'a\nnew\nb\nc');
  assert.equal(apply(t, replaceLinesChange(doc(t), 2, 3, [])), 'a\nb');
  assert.equal(apply(t, replaceLinesChange(doc(t), 3, 3, ['d', 'e'])), 'a\nb\nc\nd\ne');
  assert.equal(apply(t, replaceLinesChange(doc(t), 0, 3, ['x'])), 'x');
  assert.equal(apply(t, replaceLinesChange(doc(t), 0, 1, [])), 'b\nc');
});
