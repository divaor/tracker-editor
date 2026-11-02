// The language server's symbols for the model panel (symbolContext.js, pure): which names to look
// up, strings and comments left out, what hovers say, where definitions are, the block and its caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOnly, hoverParts, MAX_SYMBOLS, pickIdentifiers, symbolsBlock, whereLabel } from '../app/js/symbolContext.js';
import { selectionMessages } from '../app/js/selectionAsk.js';

const PY = [
  'from shop import Basket, price_of',
  '',
  '',
  'def total(basket: Basket, discount: float) -> float:',
  '    """Sums the basket: price_in_docstring is not a name."""',
  '    subtotal = sum(price_of(item) for item in basket.items)  # comment_name',
  "    label = 'string_name'",
  '    return subtotal * (1 - discount)',
  '',
].join('\n');

test('strings and comments are blanked, for each language’s comments', () => {
  const py = codeOnly(PY, 'Python');
  assert.equal(py.length, PY.length);
  assert.ok(!py.includes('price_in_docstring') && !py.includes('comment_name') && !py.includes('string_name'));
  assert.ok(py.includes('subtotal = sum(price_of(item) for item in basket.items)'));
  assert.equal(codeOnly('a // b\nc /* d */ e "f" `g`', 'JavaScript').replace(/\s+/g, ' ').trim(), 'a c e " " ` `');
  assert.equal(codeOnly('x = a // b', 'Python'), 'x = a // b', 'Python’s // divides');
  assert.equal(codeOnly('SELECT a -- b\nFROM t', 'SQL').replace(/\s+/g, ' ').trim(), 'SELECT a FROM t');
  assert.equal(codeOnly('$a = 1; # b\n// c', 'PHP').replace(/\s+/g, ' ').trim(), '$a = 1;');
  assert.equal(codeOnly("s = 'it\\'s' + t", 'Python'), "s = '     ' + t", 'escapes inside strings');
});

test('names near the cursor: the nearest first, keywords, one-letter names, strings and comments left out', () => {
  const at = PY.indexOf('subtotal =') + 3;
  const names = pickIdentifiers(PY, { at, language: 'Python' });
  assert.equal(names[0].name, 'subtotal', 'the one at the cursor first');
  const list = names.map((n) => n.name);
  for (const name of ['sum', 'price_of', 'item', 'basket', 'items', 'total', 'Basket', 'discount', 'label']) assert.ok(list.includes(name), name);
  for (const name of ['def', 'for', 'in', 'return', 'float', 'from', 'import', 'price_in_docstring', 'comment_name', 'string_name']) assert.ok(!list.includes(name), name);
  const sub = names[0];
  assert.equal(PY.slice(sub.pos - 4, sub.pos + 4), 'subtotal', 'the place it is written, inside the name');
  assert.ok(names.length <= MAX_SYMBOLS);
});

test('names in a selection: the most used first; only what is selected', () => {
  const from = PY.indexOf('    subtotal');
  const to = PY.indexOf('    label');
  const names = pickIdentifiers(PY, { from, to, language: 'Python' });
  assert.deepEqual(names.map((n) => n.name), ['item', 'subtotal', 'sum', 'price_of', 'basket', 'items'], 'by how often (item is there twice), then where first');
  assert.equal(PY.slice(names[0].pos - 2, names[0].pos + 2), 'item', 'its first place in the selection');
});

test('names: numbers and the middle of words are not names; at most `max`; around the cursor only', () => {
  assert.deepEqual(
    pickIdentifiers('x = 0x1F + 1e10 + abc', { at: 0 }).map((n) => n.name),
    ['abc'],
  );
  const many = Array.from({ length: 40 }, (_, i) => `name${i}`).join(' + ');
  assert.equal(pickIdentifiers(many, { at: 0 }).length, MAX_SYMBOLS);
  assert.equal(pickIdentifiers(many, { at: 0, max: 3 }).length, 3);
  const far = `${Array.from({ length: 30 }, (_, i) => `line${i} = ${i}`).join('\n')}`;
  const near = pickIdentifiers(far, { at: far.indexOf('line15') }).map((n) => n.name);
  assert.equal(near[0], 'line15');
  assert.ok(near.includes('line5') || near.includes('line25') ? near.every((n) => Math.abs(Number(n.slice(4)) - 15) <= 10) : true);
  assert.ok(!near.includes('line0') && !near.includes('line29'), 'more than ten lines away');
  assert.deepEqual(pickIdentifiers('', { at: 0 }), []);
});

test('what a hover says: Pyright’s, TypeScript’s, plain text, MarkedStrings', () => {
  const pyright = { contents: { kind: 'markdown', value: '```python\n(function) def total(\n    basket: Basket,\n    discount: float\n) -> float\n```\n---\nSums the **basket** with a [discount](https://x.y).\n\nMore text.' } };
  assert.deepEqual(hoverParts(pyright), { signature: '(function) def total(basket: Basket, discount: float) -> float', doc: 'Sums the basket with a discount.' });
  const ts = { contents: { kind: 'markdown', value: '```typescript\nconst count: number\n```' } };
  assert.deepEqual(hoverParts(ts), { signature: 'const count: number', doc: '' });
  assert.deepEqual(hoverParts({ contents: { kind: 'plaintext', value: 'int count\n\nHow many.' } }), { signature: 'int count', doc: 'How many.' });
  assert.deepEqual(hoverParts({ contents: [{ language: 'go', value: 'func Add(a, b int) int' }, 'Add adds.'] }), { signature: 'func Add(a, b int) int', doc: 'Add adds.' });
  assert.deepEqual(hoverParts(null), { signature: '', doc: '' });
  assert.deepEqual(hoverParts({ contents: '' }), { signature: '', doc: '' });
});

test('where a definition is: relative to the project, else its last folders; servers and Windows too', () => {
  assert.equal(whereLabel('/home/me/shop/src/basket.py', 12, '/home/me/shop'), 'src/basket.py:12');
  assert.equal(whereLabel('/usr/lib/python3/typeshed/stdlib/builtins.pyi', 1300, '/home/me/shop'), '…/stdlib/builtins.pyi:1300');
  assert.equal(whereLabel('remote://srv1/var/www/app/main.py', 3, '/var/www/app'), 'main.py:3');
  assert.equal(whereLabel('C:\\Users\\me\\proj\\lib\\a.ts', 7, 'c:\\users\\me\\proj'), 'lib/a.ts:7', 'Windows paths: case does not matter');
  assert.equal(whereLabel('/home/me/shopping/x.py', 1, '/home/me/shop'), '…/shopping/x.py:1', 'a folder that only starts the same is not inside');
  assert.equal(whereLabel('notes.py', 4), 'notes.py:4', 'a synced note: its name');
  assert.equal(whereLabel('', 4), '');
});

test('the block: each name, its type and where; empty rows left out; caps', () => {
  const rows = [
    { name: 'total', signature: '(function) def total(basket: Basket, discount: float) -> float', doc: 'Sums the basket.', where: 'shop/cart.py:4' },
    { name: 'mystery', signature: '', doc: '', where: '' },
    { name: 'Basket', signature: '(class) Basket', doc: '', where: 'shop/models.py:10' },
    { name: 'total', signature: 'again', where: 'x:1' },
  ];
  const block = symbolsBlock(rows, { server: 'pyright' });
  assert.equal(block.count, 2);
  assert.equal(block.server, 'pyright');
  assert.equal(
    block.text,
    [
      'Symbols (from the language server: each name’s type or signature, and where it is defined):',
      '- total: (function) def total(basket: Basket, discount: float) -> float (defined at shop/cart.py:4) — Sums the basket.',
      '- Basket: (class) Basket (defined at shop/models.py:10)',
    ].join('\n'),
  );
  const long = symbolsBlock([{ name: 'x1', signature: 's'.repeat(500), doc: 'd'.repeat(500), where: 'a:1' }], { maxSignature: 50, maxDoc: 20 });
  assert.match(long.text, /- x1: s{49}… \(defined at a:1\) — d{19}…$/);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `name${i}`, signature: `int name${i}`, where: `f.py:${i + 1}` }));
  assert.equal(symbolsBlock(many).count, 12, 'twelve at most');
  const small = symbolsBlock(many, { maxChars: 300 });
  assert.ok(small.text.length <= 300 && small.count > 0 && small.count < 12, `${small.text.length} ${small.count}`);
  assert.deepEqual(symbolsBlock([{ name: 'a', signature: '', where: '' }]), { text: '', count: 0, rows: [], server: '' });
});

test('the panel’s messages carry the block after the text', () => {
  const symbols = symbolsBlock([{ name: 'total', signature: 'def total() -> float', where: 'cart.py:4' }]);
  const [, user] = selectionMessages({ kind: 'answer', prompt: 'Explain it.' }, { text: 'total()', name: 'cart.py', language: 'Python', symbols });
  assert.ok(user.content.endsWith(`>>>\n\n${symbols.text}`));
  const [, plain] = selectionMessages({ kind: 'answer', prompt: 'Explain it.' }, { text: 'total()', name: 'cart.py' });
  assert.ok(plain.content.endsWith('>>>'), 'nothing without symbols');
});
