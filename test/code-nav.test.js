// 0.13: code navigation in one file: the name at the cursor, its declaration, its usages,
// symbols to jump to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarationKind, findDefinition, isMemberAt, lineStart, matchSymbols, occurrences, usages, wordAt } from '../app/js/codeNav.js';
import { outline } from '../app/js/outline.js';

test('the name at the cursor', () => {
  const text = 'const total = sum(items);';
  assert.deepEqual(wordAt(text, 8), { word: 'total', from: 6, to: 11 });
  assert.deepEqual(wordAt(text, 11), { word: 'total', from: 6, to: 11 }); // just after it
  assert.equal(wordAt(text, 12), null); // between " " and "="
  assert.equal(wordAt('x = 42', 5), null); // numbers are not names
  assert.equal(wordAt('$el.ñandú_2', 2).word, '$el');
  assert.equal(wordAt('$el.ñandú_2', 6).word, 'ñandú_2');
  // Dashes count in CSS, YAML and the like.
  assert.equal(wordAt('.main-nav { }', 3).word, 'main');
  assert.equal(wordAt('.main-nav { }', 3, { dashes: true }).word, 'main-nav');
  assert.equal(wordAt('a -- b', 3, { dashes: true }), null);
});

test('usages are whole names, with their lines', () => {
  const text = 'let item = 1;\nitems.push(item);\n// item here\nreturn item_2 + item;';
  const found = occurrences(text, 'item');
  assert.deepEqual(found.map((o) => [o.line, o.column]), [[1, 5], [2, 12], [3, 4], [4, 17]]);
  assert.equal(found[1].text, 'items.push(item);');
  assert.equal(occurrences('a-b a', 'a').length, 2);
  assert.equal(occurrences('main-nav main', 'main-nav').length, 1);
  assert.equal(occurrences(text, 'item', { limit: 2 }).length, 2);
  assert.deepEqual(usages(text, 'item').map((u) => u.declaration), [true, false, false, false]);
});

test('declarations, the way most languages write them', () => {
  const kind = (line, word, nth = 0) => {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = occurrences(line, word)[i]?.from ?? -1;
    return declarationKind(line, at + 1, word);
  };
  for (const [line, word] of [
    ['function load(config) {', 'load'],
    ['export default async function load() {', 'load'],
    ['  async load(path) {', 'load'],
    ['  static create(): Store {', 'create'],
    ['const load = () => 1', 'load'],
    ['class Store extends Base {', 'Store'],
    ['def parse(self, text):', 'parse'],
    ['def parse(self, text):', 'text'],
    ['int count = 0;', 'count'],
    ['  public String name(int a) {', 'name'],
    ['  public void run() throws IOException {', 'run'],
    ['import { a, b as c } from "x";', 'c'],
    ['from os import path', 'path'],
    ['server:', 'server'],
    ['  - name: web', 'name'],
    ['"key": 1,', 'key'],
    ['func (r *Repo) Save(x int) error {', 'Save'],
    ['CREATE TABLE users (', 'users'],
    ['create or replace view dbo.v_orders as', 'v_orders'],
    ['deploy() {', 'deploy'],
    ['for (const row of rows) {', 'row'],
    ['for x in items:', 'x'],
    ['} catch (err) {', 'err'],
    ['type Props = {', 'Props'],
    ['fn main() {', 'main'],
    ['local function helper()', 'helper'],
  ])
    assert.equal(kind(line, word), 'strong', `${word} in: ${line}`);
  assert.equal(kind('items.map((item) => item.id)', 'item'), 'strong');
  assert.equal(kind('items.map((item) => item.id)', 'item', 1), null);
  assert.equal(kind('    total = parse(y)', 'total'), 'assign');
  for (const [line, word] of [
    ['  load(path);', 'load'],
    ['if (load(x)) {', 'load'],
    ['return count;', 'count'],
    ['x == y', 'x'],
    ['// function hidden() {', 'hidden'],
    ['# def hidden():', 'hidden'],
    ['  echo $name', 'name'],
    ['foo(bar);', 'foo'],
    ['const a = b ? c : d;', 'c'],
    ['total += 1', 'total'],
  ])
    assert.equal(kind(line, word), null, `${word} in: ${line}`);
});

test('the declaration seen from the cursor: the nearest before it, else the first', () => {
  const js = ['function outer() {', '  const value = 1;', '  return value;', '}', 'function other() {', '  let value = 2;', '  log(value);', '}', 'value;'].join('\n');
  const at = (line, col) => lineStart(js, line) + col - 1;
  assert.equal(findDefinition(js, 'value', at(3, 10)).line, 2);
  assert.equal(findDefinition(js, 'value', at(7, 8)).line, 6);
  assert.equal(findDefinition(js, 'outer', at(9, 1)).line, 1);
  assert.equal(findDefinition(js, 'log', 0), null);
  // Assignments: only when nothing else declares it, the first one.
  const py = 'count = 0\nfor item in items:\n    count = count + 1\nprint(count)';
  assert.equal(findDefinition(py, 'count', py.length).line, 1);
  assert.equal(findDefinition(py, 'item', py.length).line, 2);
  // YAML: the key.
  const yaml = 'defaults: &defaults\n  retries: 3\nservice:\n  <<: *defaults\n  retries: 5\n';
  assert.equal(findDefinition(yaml, 'service', 0).line, 3);
});

test('lines and symbols to jump to', () => {
  assert.equal(lineStart('a\nbb\nccc', 1), 0);
  assert.equal(lineStart('a\nbb\nccc', 3), 5);
  assert.equal(lineStart('a\nbb', 9), 0);
  const symbols = outline('class Store {\n  load() {\n  }\n  save(x) {\n  }\n}\nfunction loadAll() {}\n', 'JavaScript');
  assert.deepEqual(symbols.map((s) => s.title), ['Store', 'load', 'save', 'loadAll']);
  assert.deepEqual(matchSymbols(symbols, 'load').map((s) => s.title), ['load', 'loadAll']);
  assert.deepEqual(matchSymbols(symbols, 'all').map((s) => s.title), ['loadAll']);
  assert.equal(matchSymbols(symbols, '').length, 4);
});

test('outline: more languages and methods in classes', () => {
  const titles = (text, lang) => outline(text, lang).map((e) => `${e.level}:${e.title}`);
  assert.deepEqual(titles('class A {\n  constructor(x) {\n  }\n  if (x) {\n  }\n  async load(p) {\n  }\n}\n', 'TypeScript'), ['1:A', '2:constructor', '2:load']);
  assert.deepEqual(titles('apiVersion: v1\nmetadata:\n  name: web\n    deep: x\nspec:\n  - item: 1\n', 'YAML'), ['1:apiVersion', '1:metadata', '2:name', '1:spec']);
  assert.deepEqual(titles('#include <x>\nstatic int add(int a, int b)\n{\n  return a;\n}\nstruct Point {\n};\n', 'C'), ['1:add', '1:Point']);
  assert.deepEqual(titles('<?php\nclass Repo {\n  public function find($id) {\n  }\n}\n', 'PHP'), ['1:Repo', '2:find']);
  assert.deepEqual(titles('module Shop\n  class Cart\n    def total\n    end\n  end\nend\n', 'Ruby'), ['1:Shop', '2:Cart', '2:total']);
  assert.deepEqual(titles('class Repo {\n    suspend fun load(): Int {\n    }\n}\nfun main() {}\n', 'Kotlin'), ['1:Repo', '2:load', '1:main']);
});

test('attributes set on the object: Ctrl+click on self.total or this.items finds where it is set', () => {
  // Python: set in __init__, changed and read in methods; a local of the same name elsewhere.
  const py = ['class Cart:', '    def __init__(self):', '        self.total = 0', '        self.items: list = []', '', '    def add(self, n):', '        total = n * 2', '        self.total += total', '        return self.total == 0', ''].join('\n');
  assert.equal(declarationKind('        self.total = 0', 14, 'total'), 'member');
  assert.equal(declarationKind('        self.items: list = []', 14, 'items'), 'member');
  assert.equal(declarationKind('        self.total += total', 14, 'total'), null, 'a change is not a declaration');
  assert.equal(declarationKind('        return self.total == 0', 21, 'total'), null);
  const used = py.lastIndexOf('self.total') + 5;
  assert.equal(isMemberAt(py, used), true);
  // Reached through self: the attribute in __init__, not the local below it.
  assert.equal(findDefinition(py, 'total', used, undefined, { member: true }).line, 3);
  // The bare name: the local assignment.
  const bare = py.indexOf('self.total += total') + 'self.total += '.length;
  assert.equal(isMemberAt(py, bare), false);
  assert.equal(findDefinition(py, 'total', bare).line, 7);
  // JavaScript and PHP, Ruby.
  const js = ['class Store {', '  constructor() {', '    this.items = [];', '  }', '  add(x) {', '    this.items.push(x);', '  }', '}'].join('\n');
  const at = js.indexOf('this.items.push') + 5;
  assert.equal(isMemberAt(js, at), true);
  assert.equal(findDefinition(js, 'items', at, undefined, { member: true }).line, 3);
  assert.equal(declarationKind('        $this->name = $name;', 16, 'name'), 'member');
  assert.equal(declarationKind('    @count = 0', 6, 'count'), 'member');
  assert.equal(isMemberAt('Foo::bar()', 5), true);
  assert.equal(isMemberAt('$this->name', 7), true);
  // The attribute comes before a function of that name, and the bare name still finds the function.
  const withFunction = `${js}\nfunction items() {}\n`;
  assert.equal(findDefinition(withFunction, 'items', at, undefined, { member: true }).line, 3);
  assert.equal(findDefinition(withFunction, 'items', withFunction.length - 2).line, 9);
  // A parameter of the same name (set from it in the constructor) is not where the attribute is.
  const param = ['class Cart:', '    def __init__(self, total, items):', '        self.total = total', '', '    def show(self):', '        return self.total', ''].join('\n');
  const shown = param.lastIndexOf('self.total') + 5;
  assert.equal(findDefinition(param, 'total', shown, undefined, { member: true }).line, 3);
  // A method reached through an object: the method, not a parameter or a local of that name.
  const method = ['def report(save):', '    return save', '', 'class Doc:', '    def save(self):', '        pass', '', 'def main(doc):', '    save = 1', '    doc.save()', ''].join('\n');
  const call = method.indexOf('doc.save') + 4;
  assert.equal(findDefinition(method, 'save', call, undefined, { member: true }).line, 5);
  assert.equal(findDefinition(method, 'save', method.indexOf('return save') + 7).line, 1, 'the bare name: the nearest declaration before it, as before');
});
