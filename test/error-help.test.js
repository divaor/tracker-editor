// Help with errors: problem prompts, the useful part of terminal output, code around a line,
// and the question handed to the Claude app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAppPrompt, claudeAppUrl, codeAround, errorContextText, explainProblemAction, fixForErrorAction, fixProblemsAction, outputTail } from '../app/js/errorHelp.js';

const problems = [
  { line: 3, column: 5, severity: 'error', message: 'Missing }' },
  { line: 9, column: 1, severity: 'warning', message: 'Unclosed <div>' },
];

test('actions for the problems the editor found', () => {
  const fix = fixProblemsAction(problems);
  assert.equal(fix.kind, 'replace');
  assert.equal(fix.label, 'Fix 2 problems');
  assert.match(fix.prompt, /- line 3, column 5 \(error\): Missing \}\n- line 9, column 1 \(warning\): Unclosed <div>/);
  assert.match(fix.prompt, /change nothing else/);
  assert.equal(fixProblemsAction(problems.slice(0, 1)).label, 'Fix the problem');
  const explain = explainProblemAction(problems[0]);
  assert.equal(explain.kind, 'answer');
  assert.match(explain.prompt, /line 3, column 5: "Missing \}"/);
  assert.match(fixForErrorAction('TypeError: x is undefined').prompt, /TypeError: x is undefined/);
});

test('the useful part of terminal output', () => {
  const lines = ['$ node app.js', '/w/app.js:3', '  boom();', '  ^', 'ReferenceError: boom is not defined', '    at /w/app.js:3:3', '', 'user@box:~/w$ ', ''];
  assert.equal(outputTail(lines), '$ node app.js\n/w/app.js:3\n  boom();\n  ^\nReferenceError: boom is not defined\n    at /w/app.js:3:3');
  assert.equal(outputTail(['a', 'b', 'c', 'PS C:\\w>'], 2), 'b\nc');
  assert.equal(outputTail(['', '   ']), '');
});

test('code around a line, and the text for the model', () => {
  const text = 'one\ntwo\nthree\nfour\nfive';
  assert.equal(codeAround(text, 3, 1), ' 2 | two\n>3 | three\n 4 | four');
  assert.equal(codeAround(text, 1, 1), '>1 | one\n 2 | two');
  const ctx = errorContextText('Error: x', [{ path: 'src/a.js', line: 3, code: '>3 | x()' }]);
  assert.equal(ctx, 'Output:\nError: x\n\nsrc/a.js, around line 3:\n>3 | x()');
});

test('the question for the Claude app', () => {
  const prompt = claudeAppPrompt({ action: fixProblemsAction(problems.slice(0, 1)), context: { whole: true, name: 'query.sql', language: 'SQL', text: 'SELECT * FROM t WHERE' }, editorFile: 'query.sql' });
  assert.match(prompt, /^The editor found this problem/);
  assert.match(prompt, /It is the file query.sql \(SQL\):\n```\nSELECT \* FROM t WHERE\n```/);
  assert.match(prompt, /my Tracker Editor file "query.sql".*read_editor_file.*save_editor_file/s);
  // A text with fences of its own gets tildes; a part of a file says so; no file name, no connector line.
  const fenced = claudeAppPrompt({ action: { prompt: 'Explain' }, context: { whole: false, name: 'README.md', text: '```js\nx\n```' } });
  assert.match(fenced, /It is a part of README.md:\n~~~\n```js/);
  assert.doesNotMatch(fenced, /Tracker connector/);
  // Long texts are cut, and then the link carries no question (it goes by the clipboard).
  const long = claudeAppPrompt({ action: { prompt: 'Explain' }, context: { whole: true, name: 'big.log', text: 'x'.repeat(20000) } });
  assert.match(long, /\[… 8000 more characters\]/);
  assert.equal(claudeAppUrl(long), 'https://claude.ai/new');
  assert.equal(claudeAppUrl('Fix it'), 'https://claude.ai/new?q=Fix%20it');
});
