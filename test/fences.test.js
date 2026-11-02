// Fenced blocks in the model's answers read as CommonMark reads them (fences.js), and the step
// parsers that use it: a ``` inside a file's text (a README's code) never ends a steps block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeFences, parseJsonLoose, unwrapFence, withoutBlocks, wordsBefore } from '../app/js/fences.js';
import { parsePlan as parseFileSteps, wordsSoFar } from '../app/js/fileSteps.js';
import { parsePlan as parseGitSteps } from '../app/js/gitAssist.js';
import { cleanReplacement, lastCodeBlock } from '../app/js/selectionAsk.js';
import { parseNextEdits } from '../app/js/nextEdits.js';
import { cleanVisionReply } from '../app/js/ocr.js';
import { cleanCompletion } from '../app/js/completion.js';
import { hoverParts } from '../app/js/symbolContext.js';

// The answer that came back as "The steps were not valid JSON." (11-02): a small project whose
// README.md holds two ``` blocks, the steps in a ```file-steps block (and as a ```` one, which
// models use around text holding ```).
const README = '# School timetable\n\n## Data model\n\n```\nstudents ──< enrollments >── classes\n```\n\n## Run\n\n```\npython main.py --serve\n```\n';
const STEPS = [
  { op: 'create-folder', path: 'site', why: 'Holds the generated index.html' },
  { op: 'create-file', path: 'schema.sql', why: 'Tables', text: 'PRAGMA foreign_keys = ON;\n\nCREATE TABLE students (id INTEGER PRIMARY KEY);\n' },
  { op: 'create-file', path: 'mock_data.py', why: 'Mock rows', text: '"""Mock data."""\nSTUDENTS = [(1, "Alice", "Johnson", 10)]\n' },
  { op: 'edit-file', path: 'main.py', why: 'Builds the page', text: 'PAGE = """<!DOCTYPE html>\\n<td>{teachers}</td>"""\nprint("\\u2013")\n' },
  { op: 'create-file', path: 'site/style.css', why: 'Styling', text: ':root { --accent: #2f5fd0; }\n' },
  { op: 'create-file', path: '.gitignore', why: 'Ignore the database', text: 'school.db\n__pycache__/\n' },
  { op: 'create-file', path: 'README.md', why: 'How to run it', text: README },
  { op: 'terminal', command: 'python main.py --serve' },
];
const body = '[\n' + STEPS.map((s) => '  ' + JSON.stringify(s)).join(',\n') + '\n]';
const answer = (fence) => `I'll build this in plain Python.\n\n1. \`site/\`: the folder.\n\n${fence}file-steps\n${body}\n${fence}\n\nTo run it: apply the changes, then press Enter on the terminal command.`;

test('the answer of 11-02: every step read, whatever the fence', () => {
  for (const fence of ['```', '````', '~~~']) {
    const plan = parseFileSteps(answer(fence));
    assert.deepEqual(plan.problems, [], fence);
    assert.deepEqual(plan.steps.map((s) => s.step.op), STEPS.map((s) => s.op), fence);
    const readme = plan.steps.find((s) => s.step.path === 'README.md');
    assert.equal(readme.step.text, README, 'the README with its own ``` blocks, whole');
    assert.match(plan.text, /^I'll build this in plain Python\.\n\n1\. `site\/`: the folder\.\n\nTo run it:/);
    assert.ok(!plan.text.includes('create-file'), 'the block is out of the words');
  }
});

test('while it streams, the words stop before the steps (a ```` fence too)', () => {
  const full = answer('````');
  const cut = full.slice(0, full.indexOf('schema.sql'));
  assert.equal(wordsSoFar(cut), "I'll build this in plain Python.\n\n1. `site/`: the folder.");
  assert.equal(wordsSoFar('Only words so far'), 'Only words so far');
});

test('codeFences: CommonMark fences, info strings, nesting by length', () => {
  const text = 'Intro\n```js title\nlet a = 1;\n```\n~~~\ntilde\n~~~\n````md\n```\ninner\n```\n````\nend';
  const blocks = codeFences(text);
  assert.deepEqual(blocks.map((b) => [b.lang, b.info, b.body, b.closed]), [
    ['js', 'js title', 'let a = 1;', true],
    ['', '', 'tilde', true],
    ['md', 'md', '```\ninner\n```', true],
  ]);
  assert.equal(text.slice(blocks[0].start, blocks[0].end), '```js title\nlet a = 1;\n```');
  // A longer closing fence closes; a shorter one, or one of the other character, does not.
  assert.equal(codeFences('```\na\n`````\nb').at(0).body, 'a');
  assert.equal(codeFences('````\na\n```\nb\n````').at(0).body, 'a\n```\nb');
  assert.equal(codeFences('```\na\n~~~\nb\n```').at(0).body, 'a\n~~~\nb');
  // Inline code is no fence; a closing line with words after the fence is none either.
  assert.deepEqual(codeFences('Use ```x``` here\nplain'), []);
  assert.equal(codeFences('```\na\n``` not yet\n```').at(0).body, 'a\n``` not yet');
  // CRLF, and an indented fence (in a list item) with its indentation taken off the lines.
  assert.equal(codeFences('```json\r\n{"a": 1}\r\n```\r\n').at(0).body, '{"a": 1}');
  assert.equal(codeFences('1. Steps:\n   ```json\n   [1,\n    2]\n   ```').at(0).body, '[1,\n 2]');
});

test('codeFences: a block left open runs to the end, a closing run on the last line is the fence', () => {
  assert.deepEqual(codeFences('Words\n```file-steps\n[{"op": "list"').map((b) => [b.lang, b.body, b.closed]), [['file-steps', '[{"op": "list"', false]]);
  assert.equal(codeFences('```json\n[1, 2]```').at(0).body, '[1, 2]');
  assert.equal(parseFileSteps('```file-steps\n[{ "op": "list", "path": "." }]```').steps.length, 1);
});

test('withoutBlocks and wordsBefore', () => {
  const text = 'A\n\n```x\n1\n```\n\nB\n\n```y\n2\n```\n\nC';
  const blocks = codeFences(text);
  assert.equal(withoutBlocks(text, [blocks[1]]), 'A\n\n```x\n1\n```\n\nB\n\nC');
  assert.equal(withoutBlocks(text, blocks), 'A\n\nB\n\nC');
  assert.equal(wordsBefore(text, ['y']), 'A\n\n```x\n1\n```\n\nB');
  assert.equal(wordsBefore(text, ['z']), text);
});

test('parseJsonLoose: what models get slightly wrong', () => {
  assert.deepEqual(parseJsonLoose('[{"op": "create-file", "text": "line 1\nline 2\tend"}]'), [{ op: 'create-file', text: 'line 1\nline 2\tend' }]);
  assert.deepEqual(parseJsonLoose('[{"a": 1}, {"b": [2, 3,],},]'), [{ a: 1 }, { b: [2, 3] }]);
  assert.deepEqual(parseJsonLoose('[{"a": "x]"}]\n\nThat is all.'), [{ a: 'x]' }]);
  assert.deepEqual(parseJsonLoose('{"a": "say \\"hi\\", ok"}'), { a: 'say "hi", ok' });
  assert.throws(() => parseJsonLoose('[{"a": 1'));
  assert.throws(() => parseJsonLoose('not json'));
});

test('a steps block that is not JSON still says so', () => {
  const plan = parseFileSteps('Here:\n```file-steps\n[{ op: create-file }]\n```');
  assert.deepEqual(plan.problems, ['The steps were not valid JSON.']);
  assert.equal(plan.steps.length, 0);
  assert.match(plan.text, /```file-steps/, 'the block stays in the words, so it can be seen');
  // A ```json block of other things is left alone; a plain code block too.
  assert.equal(parseFileSteps('```json\n{"name": "x"}\n```\n```sh\nnpm test\n```').text, '```json\n{"name": "x"}\n```\n```sh\nnpm test\n```');
});

test('Git with the model: a commit message holding ``` keeps the block whole', () => {
  const steps = [{ op: 'commit', message: 'Docs: the example\n\n```\nnpm run build\n```', why: 'commit the docs' }];
  const reply = `Commit it:\n\n\`\`\`git-steps\n${JSON.stringify(steps, null, 2)}\n\`\`\`\nDone.`;
  const plan = parseGitSteps(reply);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].step.message, steps[0].message);
  assert.equal(plan.text, 'Commit it:\n\nDone.');
});

test('the model panel: a fence around a whole answer comes off, whatever its length', () => {
  const md = '# Title\n\n```\ncode\n```\n';
  assert.equal(cleanReplacement('````markdown\n' + md + '````', 'old text\n'), md.trimEnd() + '\n');
  assert.equal(cleanReplacement('```js\nlet a;\n```', 'let b;'), 'let a;');
  assert.equal(cleanReplacement('```js\nlet a;\n```', '```js\nlet b;\n```'), '```js\nlet a;\n```', 'kept when the text was fenced');
  assert.equal(lastCodeBlock('First:\n```sql\nSELECT 1;\n```\nThen:\n````md\n```\nnested\n```\n````'), '```\nnested\n```');
  assert.equal(lastCodeBlock('no code'), '');
});

test('next edits, the reading of a picture, suggestions and hovers', () => {
  const doc = '# Notes\n\nText\n';
  const reply = '```json\n{"edits": [{"find": "Text\\n", "replace": "Text\\n\\n```\\nnpm test\\n```\\n", "why": "an example"}]}\n```';
  const [edit] = parseNextEdits(reply, doc);
  assert.equal(edit.replace, 'Text\n\n```\nnpm test\n```\n');
  assert.equal(cleanVisionReply('````\nA list:\n```\ncode\n```\n````'), 'A list:\n```\ncode\n```');
  assert.equal(cleanCompletion('```js\nreturn total;\n```'), 'return total;');
  assert.deepEqual(hoverParts({ contents: { kind: 'markdown', value: '```ts\nfunction save(): void\n```\nSaves it.' } }), { signature: 'function save(): void', doc: 'Saves it.' });
  assert.equal(unwrapFence('just text'), null);
  assert.equal(unwrapFence('````\na\n```'), null, 'a shorter closing fence closes nothing');
});
