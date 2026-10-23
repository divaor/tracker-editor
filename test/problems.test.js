// Problems as you type: JSON (with comments where they are allowed), YAML checks of our
// own, and messages for the syntax errors the parser finds (real parse trees from the
// CodeMirror bundle, which loads in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJsonc, jsonProblems, problemsFor, syntaxProblems, treeErrors, yamlProblems } from '../app/js/problems.js';
import { EditorState, LanguageDescription, ensureSyntaxTree, languages } from '../app/vendor/cm/codemirror.js';

// Problems in a text as the editor finds them.
async function check(name, text) {
  const desc = LanguageDescription.matchFilename(languages, name);
  const state = EditorState.create({ doc: text, extensions: [await desc.load()] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const errors = treeErrors(tree, (from, to) => state.sliceDoc(from, to));
  return problemsFor(text, { language: desc.name, name, errors }).map((p) => `${text.slice(p.from, p.to)}: ${p.message}`);
}

test('JSON: the first mistake, at its place; comments only where allowed', () => {
  assert.deepEqual(jsonProblems('{"a": 1}'), []);
  assert.deepEqual(jsonProblems(''), []);
  const comma = jsonProblems('{"a": [1, 2,]}');
  assert.equal(comma[0].message, 'Extra comma before "]"');
  assert.equal(comma[0].from, 11, 'at the comma');
  assert.equal(jsonProblems('{"a": 1 "b": 2}')[0].message, 'Expected "," or "}"');
  assert.equal(jsonProblems('{\n  // note\n  "a": 1\n}')[0].message, 'Comments are not allowed in JSON (they are in .jsonc files)');
  // tsconfig.json and friends: comments and trailing commas are fine.
  assert.deepEqual(jsonProblems('{\n  // note\n  "a": [1,],\n  /* x */ "b": 2,\n}', { comments: true }), []);
  assert.equal(jsonProblems('{\n  // note\n  "a": 1 "b"\n}', { comments: true })[0].message, 'Expected "," or "}"');
  // A "//" inside a string is not a comment.
  assert.deepEqual(jsonProblems('{"url": "https://x.org/a"}', { comments: true }), []);
  for (const name of ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json', '.eslintrc.json', 'settings.json', 'x.jsonc', 'a.code-workspace']) assert.ok(isJsonc(name), name);
  for (const name of ['package.json', 'data.json', 'settings.json.bak']) assert.ok(!isJsonc(name), name);
});

test('YAML: a key twice in the same mapping, tabs, a quote left open', () => {
  const twice = yamlProblems('server:\n  host: a\n  port: 1\n  host: b\n');
  assert.equal(twice.length, 1);
  assert.equal(twice[0].message, '“host” is already a key here (line 2)');
  // Same key in other mappings, sequence items or documents: fine.
  assert.deepEqual(yamlProblems('a:\n  name: x\nb:\n  name: y\n'), []);
  assert.deepEqual(yamlProblems('items:\n  - name: a\n    port: 1\n  - name: b\n    port: 2\n'), []);
  assert.deepEqual(yamlProblems('- name: a\n- name: b\n'), []);
  assert.deepEqual(yamlProblems('a: 1\n---\na: 2\n'), []);
  // Block scalars are text.
  assert.deepEqual(yamlProblems('script: |\n  a: 1\n  a: 2\nnext: 1\n'), []);
  assert.deepEqual(yamlProblems('note: >-\n  x: 1\n  x: 1\n'), []);
  // Quoted keys count as the same key; "<<" (merge) may repeat.
  assert.equal(yamlProblems('"a": 1\na: 2\n').length, 1);
  assert.deepEqual(yamlProblems('x:\n  <<: *a\n  <<: *b\n'), []);
  // Flow collections across lines are left alone.
  assert.deepEqual(yamlProblems('list: [\n  a,\n  a,\n]\nother: 1\n'), []);
  assert.equal(yamlProblems('a: 1\n\tb: 2\n')[0].message, 'Tabs cannot indent YAML: use spaces');
  assert.equal(yamlProblems('a: "open\nb: 2\n')[0].message, 'This quoted value is not closed');
  // A quoted value may go on over lines.
  assert.deepEqual(yamlProblems('msg: "one\n  two"\nb: 2\n'), []);
  assert.deepEqual(yamlProblems("it: 'it''s'\n"), []);
});

test('syntax errors from the parser get plain messages, once per place', () => {
  const text = 'const a = ;';
  assert.deepEqual(syntaxProblems(text, [{ from: 10, to: 10, kind: 'error' }, { from: 10, to: 10, kind: 'error' }]), [{ from: 10, to: 11, severity: 'error', message: 'Unexpected “;”' }]);
  assert.equal(syntaxProblems('f(\n', [{ from: 3, to: 3, kind: 'error' }])[0].message, 'The text ends before something is closed');
  assert.equal(syntaxProblems('<a></b>', [{ from: 3, to: 7, kind: 'mismatched', tag: 'b', open: 'a' }])[0].message, '</b> does not close <a>');
  assert.equal(syntaxProblems('<div><span></div>', [{ from: 6, to: 10, kind: 'missing', open: 'span', before: 'div' }], 'HTML')[0].severity, 'warning');
});

test('real files: mistakes found, valid ones left alone', async () => {
  assert.deepEqual(await check('x.js', 'const a = ;\n'), [';: Unexpected “;”']);
  assert.deepEqual(await check('x.py', 'def f(:\n    pass\n'), [':: Unexpected “:”']);
  assert.deepEqual(await check('x.xml', '<a></b>'), ['</b>: </b> does not close <a>']);
  assert.deepEqual(await check('x.xml', '<a><b></a>'), ['b: <b> is not closed before </a>']);
  assert.deepEqual(await check('x.html', '<div><span></div>'), ['span: <span> is not closed before </div>']);
  assert.deepEqual(await check('x.css', 'a { color red }'), ['}: Unexpected “}”']);
  assert.deepEqual(await check('x.yaml', 'a: 1\na: 2\n'), ['a: “a” is already a key here (line 1)']);
  // Valid files: nothing.
  const valid = {
    'ok.js': 'import { x } from "y";\nexport class A extends B {\n  #p = 1;\n  async *gen() { yield* x?.y ?? []; }\n}\nconst f = (a, { b = 2 } = {}) => `t${a}`;\n',
    'ok.ts': 'interface P<T> { a?: T; }\nexport function f<T extends object>(x: P<T>): T | null { return x.a ?? null; }\n',
    'ok.py': 'import os\n\n@dec\nclass A:\n    def f(self, *a, **k) -> int:\n        return [x for x in a if x]\n\nprint(f"{os.sep}")\n',
    'ok.json': '{"a": [1, 2.5e3, true, null], "b": {"c": "\\u00e9"}}',
    'ok.yaml': 'a: 1\nlist:\n  - x\n  - y: 2\n    z: 3\ntext: |\n  any: thing\n',
    'ok.xml': '<?xml version="1.0"?>\n<a x="1"><b/><c>t &amp; u</c><!-- c --></a>\n',
    'ok.html': '<!doctype html>\n<html><body><p>one<p>two<ul><li>a<li>b</ul><br><img src=x></body></html>\n',
    'ok.css': '@media (max-width: 600px) { .a > b:hover::after { content: "}"; margin: calc(1px + 2%); } }\n',
    'ok.go': 'package main\n\nfunc main() {\n\tm := map[string]int{"a": 1}\n\tfor k, v := range m { _ = k; _ = v }\n}\n',
  };
  for (const [name, text] of Object.entries(valid)) assert.deepEqual(await check(name, text), [], name);
  // Languages whose parser accepts anything (or reports wrongly) are not checked.
  assert.deepEqual(problemsFor('SELECT ((', { language: 'SQL', errors: [{ from: 7, to: 7, kind: 'error' }] }), []);
  assert.deepEqual(problemsFor('# (', { language: 'Markdown', errors: [{ from: 2, to: 2, kind: 'error' }] }), []);
});
