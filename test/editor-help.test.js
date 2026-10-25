// Help with the editor from the model (editorHelp.js): which questions are about the editor, the
// guide in passages, the passages and commands a question finds in the real guide, and what
// goes to the model (the whole guide in the system message, or the passages with the question).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  commandLines,
  excerptsAnswer,
  fileQuestion,
  guideChunks,
  guideExcerpts,
  HELP_ACTIONS,
  helpContext,
  helpMessages,
  helpPrompt,
  looksLikeEditorQuestion,
  queryTerms,
} from '../app/js/editorHelp.js';
import { withParam } from '../app/js/selectionAsk.js';

const GUIDE = readFileSync(new URL('../app/help/guide.md', import.meta.url), 'utf8');

test('questions about the editor, and questions about the text', () => {
  for (const q of ['How do I split the view?', 'how can I fold every function', 'Where is the setting for word wrap?', 'Is there a way to edit a file on a server?', 'What are the shortcuts for folding?', 'Can Tracker Editor encrypt files?'])
    assert.ok(looksLikeEditorQuestion(q), q);
  for (const q of ['What does this function return?', 'How do I make it faster?', 'Translate it to Spanish', 'Explain these lines', 'Is there a bug in this?'])
    assert.ok(!looksLikeEditorQuestion(q), q);
});

test('the words of a question, with the forms the guide uses', () => {
  const terms = queryTerms('How do I see the shortcuts for splitting?');
  assert.deepEqual(terms.map((t) => t[0]), ['see', 'shortcut', 'splitt']);
  assert.ok(terms[1].includes('keys'), 'shortcuts are keys in the guide');
  assert.deepEqual(queryTerms('how do I do it?'), []);
});

test('the guide in passages: paragraphs, list items, table rows under their header', () => {
  const chunks = guideChunks('# Guide\n\nIntro.\n\n## 1. Files\n\nFirst paragraph\nstill it.\n\n- one\n  more of one\n- two\n\n### Keys\n\n| Keys | Action |\n| --- | --- |\n| `F1` | Help |\n| `F2` | Rename |\n');
  assert.deepEqual(
    chunks.map((c) => [c.section, c.body]),
    [
      ['', 'Intro.'],
      ['1. Files', 'First paragraph\nstill it.'],
      ['1. Files', '- one\n  more of one'],
      ['1. Files', '- two'],
      ['1. Files › Keys', '| `F1` | Help |'],
      ['1. Files › Keys', '| `F2` | Rename |'],
    ],
  );
  // A row carries its table's header, so it reads (and renders) as a table.
  assert.equal(chunks[4].text, '| Keys | Action |\n| --- | --- |\n| `F1` | Help |');
  assert.equal(chunks[4].head, '| Keys | Action |');
});

test('the real guide answers common questions with the passage that says how', () => {
  const finds = (question, needle, options = {}) => {
    const out = guideExcerpts(question, GUIDE, { budget: 2500, ...options });
    assert.ok(out.includes(needle), `${question} → ${needle}\n${out.slice(0, 600)}`);
    return out;
  };
  const fold = finds('How do I fold every function?', '`Alt+0` folds everything');
  // The best match comes first, under its heading.
  assert.match(fold, /^### 2\. The basics › Code tools/);
  finds('How do I fold every function?', 'Not a full IDE'); // the line that introduces the list
  finds('select a column of text', 'Select a column');
  assert.match(finds('encrypt a file', 'Set the passphrase'), /^### 7\. Encrypted files/);
  finds('split view side by side', '**Split view** (`Ctrl+\\`');
  assert.match(finds('edit a file on a server over ssh', '**SFTP** (over SSH)'), /^### 11\. Files on servers/);
  finds('how do I compare two files', '**⋯ → Compare with…**');
  finds('connect claude with my subscription', 'cannot be connected to the editor');
  // Something isn't working: Troubleshooting first.
  assert.match(finds('the language server says nothing', 'A language server says nothing, or stopped', { trouble: true }), /^### 16\. Troubleshooting/);
  finds('typing drops letters', 'Typing drops or changes characters', { trouble: true });
});

test('the passages stay within the budget, and rows of a table share its header', () => {
  for (const budget of [1500, 4000, 7000]) {
    const out = guideExcerpts('keys for split view, folding and format document', GUIDE, { budget });
    assert.ok(out.length <= budget, `${out.length} > ${budget}`);
    assert.ok(out.length > budget * 0.5, `${out.length} uses little of ${budget}`);
  }
  const keys = guideExcerpts('keys to fold, unfold, split view, format document, rename', GUIDE, { budget: 7000 });
  const section = keys.split('### ').find((s) => s.startsWith('15. Keyboard shortcuts'));
  assert.ok(section, 'the shortcuts table');
  assert.equal(section.split('| Keys | Action |').length, 2, 'its header once');
  assert.equal(guideExcerpts('', GUIDE), '');
  assert.equal(guideExcerpts('qwzx', GUIDE), '');
});

test('the commands that fit, with their keys on this computer', () => {
  const split = commandLines('split view', { desktop: true });
  assert.match(split, /^- Split view.*: Ctrl\+\\/m);
  assert.match(commandLines('split view', { desktop: true, mac: true }), /: Cmd\+\\/);
  assert.match(commandLines('fold everything'), /Fold everything.*Alt\+0/);
  // Desktop-only commands are left out in the browser, and marked on the desktop.
  assert.doesNotMatch(commandLines('type into another window'), /Type into another window/);
  assert.match(commandLines('type into another window', { desktop: true }), /Type into another window: Alt\+T.*\[desktop app\]/);
  assert.ok(commandLines('fold', { max: 2 }).split('\n').length <= 2);
});

test('what goes to the model: the whole guide in the system message, or passages with the question', () => {
  const question = 'How do I fold every function in Tracker Editor?';
  const whole = helpContext(question, GUIDE, { whole: true, desktop: true, version: '0.20.0', name: 'app.js', language: 'JavaScript' });
  assert.equal(whole.guide, GUIDE.trim());
  assert.equal(whole.excerpts, '');
  const [system, user] = helpMessages(question, whole);
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes(GUIDE.trim()), 'the whole guide');
  assert.match(system.content, /Troubleshooting/);
  assert.match(system.content, /never invent a feature/);
  assert.match(system.content, /Windows and Linux \(Ctrl, Alt\)/);
  // The system message is the same for another question (so it is cached); the question comes after it.
  assert.equal(helpMessages('How do I split the view?', helpContext('How do I split the view?', GUIDE, { whole: true, desktop: true, version: '0.20.0' }))[0].content, system.content);
  assert.equal(user.role, 'user');
  assert.match(user.content, /^How do I fold every function/);
  assert.match(user.content, /in the desktop app, with app\.js \(JavaScript\) open/);
  assert.match(user.content, /Fold everything.*Alt\+0/);
  assert.ok(!user.content.includes('<<<'), 'no passages: the guide is in the system message');

  const local = helpContext(question, GUIDE, { budget: 3000, mac: true });
  assert.equal(local.guide, '');
  const [sys2, user2] = helpMessages(question, local, [{ role: 'assistant', content: 'Press Alt+0.' }, { role: 'user', content: 'And unfold?' }]);
  assert.ok(sys2.content.length < 1500, 'no guide in the system message');
  assert.match(sys2.content, /macOS \(Cmd, Option\)/);
  assert.match(user2.content, /From the Tracker Editor guide:\n<<<\n### 2\. The basics › Code tools/);
  assert.match(user2.content, /in the web app \(a browser or the phone\), on a Mac/);
  const all = helpMessages(question, local, [{ role: 'assistant', content: 'Press Alt+0.' }, { role: 'user', content: 'And unfold?' }]);
  assert.deepEqual(all.slice(2).map((m) => m.role), ['assistant', 'user']);
  assert.match(helpPrompt('qwzx', helpContext('qwzx', GUIDE)), /The guide has nothing that matches/);
});

test('the help actions ask a full question; without a model the passages are the answer', () => {
  const how = withParam(HELP_ACTIONS.find((a) => a.id === 'help-how'), 'compare two files');
  assert.equal(how.prompt, 'How do I compare two files in Tracker Editor?');
  assert.equal(how.kind, 'help');
  assert.ok(HELP_ACTIONS.find((a) => a.id === 'help-trouble').trouble);
  assert.match(fileQuestion({ name: 'data.json', language: 'JSON' }), /a JSON file \(data\.json\)/);
  assert.match(fileQuestion(), /this kind of file/);
  const answer = excerptsAnswer(helpContext('how do I compare two files', GUIDE, { budget: 2000 }));
  assert.match(answer, /^From the guide:/);
  assert.match(answer, /#### 5\. History, compare and trash › Compare two files/);
  assert.match(answer, /Commands:/);
  assert.match(excerptsAnswer(helpContext('qwzx', GUIDE)), /Nothing in the guide matches/);
});
