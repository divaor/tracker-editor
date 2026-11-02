// The model makes and changes files: the steps it may propose, checked; edits as str_replace;
// the picture of the workspace and the results it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CHANGES,
  applyEdits,
  cleanRel,
  describeStep,
  diffRows,
  filesGuide,
  filesMessages,
  filesSystem,
  isSecretName,
  numbered,
  parsePlan,
  resultsMessage,
  searchText,
  toLspEdits,
  treeText,
  wholeChanges,
  wordsSoFar,
  workspaceText,
} from '../app/js/fileSteps.js';

test('paths: relative to the base folder, never out of it', () => {
  assert.deepEqual(cleanRel('src/app.js'), { rel: 'src/app.js' });
  assert.deepEqual(cleanRel('./src\\lib//a.js'), { rel: 'src/lib/a.js' });
  assert.deepEqual(cleanRel('src/'), { rel: 'src' });
  assert.deepEqual(cleanRel('.'), { rel: '' });
  for (const bad of ['/etc/passwd', 'C:\\Windows\\x', '../x', 'a/../../b', 'remote://s/x', 'a/b?.js', 'con:x', 'a\0b', 'name. ', '']) assert.ok(cleanRel(bad).problem, bad);
  assert.ok(cleanRel(42).problem);
});

test('secrets: never read or written; examples are fine', () => {
  for (const s of ['.env', '.env.local', '.env.production', 'id_rsa', 'server.pem', 'cert.key', 'store.p12', 'a.pfx', '.npmrc', '.git-credentials', 'config/credentials.json', 'secrets.yaml', 'vault.kdbx']) assert.equal(isSecretName(s), true, s);
  for (const ok of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'app.js', 'keys.md', 'environment.ts', 'README.md']) assert.equal(isSecretName(ok), false, ok);
});

test('steps: known ops with their fields; risks; what is wrong is said', () => {
  const read = describeStep({ op: 'read', path: './src/app.js', from: 5, to: 10, why: 'look' });
  assert.equal(read.kind, 'look');
  assert.equal(read.risk, 'look');
  assert.equal(read.step.path, 'src/app.js');
  assert.equal(read.step.from, 5, 'a read’s from/to stay line numbers');
  assert.equal(read.text, 'Read src/app.js (lines 5–10)');
  assert.equal(read.why, 'look');
  assert.equal(describeStep({ op: 'create-file', path: 'a.md', text: '# A\n' }).risk, 'ask');
  assert.equal(describeStep({ op: 'delete', path: 'old.js' }).risk, 'danger');
  assert.equal(describeStep({ op: 'terminal', command: 'npm install' }).risk, 'type');
  const ren = describeStep({ op: 'rename', from: './a.js', to: 'lib\\a.js' });
  assert.deepEqual([ren.step.from, ren.step.to], ['a.js', 'lib/a.js']);
  assert.match(describeStep({ op: 'format-disk' }).problem, /not a step/);
  assert.match(describeStep({ op: 'read', path: '.env' }).problem, /secrets/);
  assert.match(describeStep({ op: 'read', path: '../up.txt' }).problem, /leads out/);
  assert.match(describeStep({ op: 'create-file', path: 'x/.env', text: 'A=1' }).problem, /secrets/);
  assert.match(describeStep({ op: 'edit-file', path: 'a.js', edits: [{ find: '', replace: 'x' }] }).problem, /edits/);
  assert.match(describeStep({ op: 'edit-file', path: 'a.js' }).problem, /edits/);
  assert.equal(describeStep({ op: 'edit-file', path: 'a.js', text: 'all' }).text, 'Change a.js (all of it)');
  assert.match(describeStep({ op: 'terminal', command: 'npm i\nrm -rf /' }).problem, /one line/);
  assert.match(describeStep({ op: 'search', text: '(', regex: true }).problem, /regular expression/);
  assert.match(describeStep({ op: 'list', depth: 9 }).problem, /depth/);
  assert.match(describeStep({ op: 'create-folder', path: '.' }).problem, /folder itself/);
  assert.match(describeStep({ op: 'rename', from: 'a', to: './a' }).problem, /same/);
  assert.equal(describeStep({ op: 'list' }).text, 'List the folder');
});

test('a reply: the words, the steps in their fence, and what was left out', () => {
  const reply = 'I will look first.\n\n```file-steps\n[{ "op": "list" }, { "op": "read", "path": "a.js" }, { "op": "nope" }]\n```\n';
  const plan = parsePlan(reply);
  assert.equal(plan.text, 'I will look first.');
  assert.deepEqual(plan.steps.map((s) => s.step.op), ['list', 'read']);
  assert.equal(plan.problems.length, 1);
  // A json fence counts only when its items are steps; code blocks in the words stay.
  const code = parsePlan('Like this:\n```json\n{"name":"x"}\n```\n```json\n[{"op":"create-folder","path":"src"}]\n```');
  assert.equal(code.steps.length, 1);
  assert.match(code.text, /"name":"x"/);
  assert.deepEqual(parsePlan('```file-steps\nnot json\n```').problems, ['The steps were not valid JSON.']);
  // One step on its own (not a list).
  assert.equal(parsePlan('```file-steps\n{ "op": "read", "path": "b.txt" }\n```').steps.length, 1);
  // At most MAX_CHANGES changes; looks do not count.
  const many = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => ({ op: 'create-file', path: `f${i}.txt`, text: '' }));
  const big = parsePlan(`\`\`\`file-steps\n${JSON.stringify([{ op: 'list' }, ...many])}\n\`\`\``);
  assert.equal(big.steps.length, MAX_CHANGES + 1);
  assert.match(big.problems.join(' '), /More than/);
  assert.equal(wordsSoFar('Doing it.\n```file-steps\n[{"op":'), 'Doing it.');
});

test('edits: each find once, all against the text before the step, as positions', () => {
  const text = 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n';
  const r = applyEdits(text, [
    { find: 'const b = 2;', replace: 'const b = 3;' },
    { find: 'const a = 1;', replace: 'let a = 1;' },
  ]);
  assert.equal(r.text, 'let a = 1;\nconst b = 3;\nconsole.log(a + b);\n');
  assert.deepEqual(r.changes, [
    { from: 0, to: 12, insert: 'let a = 1;' },
    { from: 13, to: 25, insert: 'const b = 3;' },
  ]);
  assert.match(applyEdits(text, [{ find: 'const c', replace: '' }]).error, /not in the file/);
  assert.match(applyEdits(text, [{ find: 'const', replace: 'let' }]).error, /2 times/);
  assert.match(applyEdits(text, [{ find: 'a = 1;\nconst', replace: 'x' }, { find: 'const b', replace: 'y' }]).error, /overlap/);
  assert.match(applyEdits(text, [{ find: 'console', replace: 'window.console' }, { find: 'zzz', replace: '' }]).error, /^Edit 2/);
  // Windows line breaks in what the model wrote match the editor's \n.
  assert.equal(applyEdits('a\nb\n', [{ find: 'a\r\nb', replace: 'A\r\nB' }]).text, 'A\nB\n');
  // Line numbers copied from a read are taken off when that makes it fit.
  assert.equal(applyEdits(text, [{ find: '2\tconst b = 2;', replace: 'const b = 9;' }]).text, 'const a = 1;\nconst b = 9;\nconsole.log(a + b);\n');
  // The whole new text: one change, the same ends kept.
  const whole = applyEdits('one\ntwo\nthree\n', [], 'one\nTWO\nthree\n');
  assert.equal(whole.text, 'one\nTWO\nthree\n');
  assert.deepEqual(whole.changes, [{ from: 4, to: 7, insert: 'TWO' }]);
  assert.deepEqual(wholeChanges('same', 'same'), []);
});

test('changes as a language server’s edits, and the lines a card shows', () => {
  const text = 'a\nbb\nccc\n';
  assert.deepEqual(toLspEdits(text, [{ from: 2, to: 4, insert: 'BB' }]), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: 'BB' }]);
  assert.deepEqual(toLspEdits(text, [{ from: 9, to: 9, insert: 'd\n' }]), [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, newText: 'd\n' }]);
  const rows = diffRows('one\ntwo\nthree\nfour\n', [{ from: 4, to: 7, insert: 'TWO\n2b' }, { from: 14, to: 18, insert: 'FOUR' }]);
  assert.deepEqual(rows, [
    { line: 2, before: ['two'], after: ['TWO', '2b'] },
    { line: 4, before: ['four'], after: ['FOUR'] },
  ]);
  // Two changes on one line show together.
  assert.equal(diffRows('ab cd\n', [{ from: 0, to: 2, insert: 'AB' }, { from: 3, to: 5, insert: 'CD' }]).length, 1);
  // A find that takes whole lines along: only what is new shows.
  const fn = 'function add(a, b) {\n  return a + b;\n}\n';
  assert.deepEqual(diffRows(fn, [{ from: 0, to: fn.length - 1, insert: 'function add(a, b) {\n  return a + b;\n}\n\nfunction greet() {}' }]), [{ line: 4, before: [], after: ['', 'function greet() {}'] }]);
});

test('the tree, a numbered read and search results, for the model', () => {
  const tree = treeText([
    { rel: 'src/app.js', size: 2100 },
    { rel: 'package.json', size: 512 },
    { rel: '.env', size: 20 },
    { rel: 'src/lib/db.js', size: 90 },
  ]);
  assert.equal(tree, ['src/', '  lib/', '    db.js · 90 B', '  app.js · 2.1 KB', '.env · 20 B (secrets: never read)', 'package.json · 512 B'].join('\n'));
  assert.match(treeText(Array.from({ length: 10 }, (_, i) => ({ rel: `f${i}`, size: 1 })), { cap: 3 }), /7 not shown/);
  assert.equal(treeText([]), '(empty)');
  const n = numbered('a\nb\nc\nd', { from: 2, to: 3 });
  assert.deepEqual(n, { text: '2\tb\n3\tc', lines: 4 });
  assert.match(numbered('x'.repeat(50) + '\n' + 'y'.repeat(50), { cap: 60 }).text, /read on with "from": 2/);
  assert.equal(searchText([{ rel: 'a.js', matches: [{ line: 3, preview: '  x()' }] }]), 'a.js:3: x()');
  assert.equal(searchText([]), 'Nothing found.');
});

test('the messages: the same system text each time, the workspace with the question', () => {
  assert.equal(filesSystem(), filesSystem());
  assert.match(filesSystem(), /```file-steps/);
  assert.match(filesSystem(), /- edit-file /);
  assert.match(filesSystem(), /- terminal /);
  const ws = workspaceText({ base: { name: 'proj', where: 'on this computer: /home/me/proj' }, tree: 'a.js · 1 B', file: { rel: 'a.js', text: 'x = 1\n', selection: { from: 1, to: 1 } }, tabs: ['b.js'] });
  assert.match(ws, /^<workspace>\nBase folder: proj \(on this computer: \/home\/me\/proj\)/);
  assert.match(ws, /<file path="a.js">\n1\tx = 1\n2\t\n<\/file>/);
  assert.match(ws, /the part selected is lines 1–1/);
  assert.match(ws, /Other tabs open here: b.js/);
  assert.match(workspaceText({ base: { name: 'Notes' }, tree: '(empty)', kind: 'notes' }), /synced notes/);
  const msgs = filesMessages('Add a README', ws, [{ role: 'user', content: 'before' }, { role: 'assistant', content: 'ok' }], { explainOnly: true });
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[3].content, /^Add a README\n\n\(Explain only/);
  assert.match(msgs[3].content, /<workspace>/);
  const guide = '# Guide\n### Other\nx\n### The model makes and changes files\nApply each card.\n### Next\ny';
  assert.equal(filesGuide(guide), '### The model makes and changes files\nApply each card.');
  assert.match(filesSystem({ guide: 'Apply each card.' }), /from its guide\):\nApply each card\./);
});

test('results for the next turn: each step’s outcome and what it found', () => {
  const text = resultsMessage([
    { text: 'Read a.js', outcome: 'ok', output: '1\tx' },
    { text: 'Change a.js', outcome: 'failed', output: 'The edit: its "find" is not in the file' },
    { text: 'Make b.js', outcome: 'skipped' },
    { text: 'Type a command', outcome: 'typed' },
  ]);
  assert.match(text, /^Results of the steps:\n1\. Read a.js — done\n```\n1\tx\n```/);
  assert.match(text, /2\. Change a.js — FAILED\n```\nThe edit/);
  assert.match(text, /3\. Make b.js — skipped by the person/);
  assert.match(text, /4\. Type a command — typed in the terminal/);
});
