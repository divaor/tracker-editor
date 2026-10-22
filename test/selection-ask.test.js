import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReplacement, SELECTION_ACTIONS, selectionMessages } from '../app/js/selectionAsk.js';

test('actions answer or replace, and their messages carry the text', () => {
  const fix = SELECTION_ACTIONS.find((a) => a.id === 'fix');
  const [system, user] = selectionMessages(fix, { text: 'SELCT * FROM t', name: 'q.sql', language: 'SQL' });
  assert.match(system.content, /ONLY the new version/);
  assert.match(user.content, /^Fix mistakes/);
  assert.match(user.content, /a part of the file q\.sql \(SQL\):\n<<<\nSELCT \* FROM t\n>>>/);
  const [explainSystem, explainUser] = selectionMessages(SELECTION_ACTIONS[0], { text: 'x', name: 'a.md', whole: true });
  assert.match(explainSystem.content, /Markdown/);
  assert.match(explainUser.content, /the file a\.md:/);
  const long = selectionMessages(fix, { text: 'a'.repeat(20000), name: 'big.txt' })[1].content;
  assert.match(long, /\[… cut: 4000 more characters\]/);
});

test('replacements lose fences and preambles the model added', () => {
  assert.equal(cleanReplacement('```sql\nSELECT * FROM t\n```', 'SELCT * FROM t\n'), 'SELECT * FROM t\n');
  assert.equal(cleanReplacement('```\na\n```', '```\nb\n```'), '```\na\n```');
  assert.equal(cleanReplacement("Here is the corrected text:\nHello world.", 'helo world.'), 'Hello world.');
  assert.equal(cleanReplacement('Aquí está la traducción:\nHola', 'Hello'), 'Hola');
  assert.equal(cleanReplacement('\n\nfine  \n', 'fine'), 'fine');
});
