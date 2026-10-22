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

test('actions with a value, follow-ups, code blocks and file types', async () => {
  const { lastCodeBlock, resultExtension, withParam, ACTION_GROUPS } = await import('../app/js/selectionAsk.js');
  for (const a of SELECTION_ACTIONS) {
    assert.ok(ACTION_GROUPS.some((g) => g.id === a.group), `${a.id} has a group`);
    assert.equal(a.prompt.includes('{param}'), Boolean(a.param), `${a.id}: {param} only with param`);
  }
  const convert = withParam(SELECTION_ACTIONS.find((a) => a.id === 'convert'), ' YAML ');
  assert.equal(convert.prompt, 'Convert it into YAML. Keep all of the data.');
  assert.equal(convert.label, 'Convert to YAML');
  assert.equal(resultExtension(convert), 'yaml');
  assert.equal(resultExtension(SELECTION_ACTIONS.find((a) => a.id === 'markdown')), 'md');
  assert.equal(resultExtension(withParam(SELECTION_ACTIONS.find((a) => a.id === 'rewrite-in'), 'PowerShell')), 'ps1');
  assert.equal(resultExtension(SELECTION_ACTIONS.find((a) => a.id === 'fix')), '');
  const replace = withParam(SELECTION_ACTIONS.find((a) => a.id === 'replace'), 'dates to ISO');
  assert.match(replace.prompt, /change nothing else: dates to ISO$/);
  const explain = SELECTION_ACTIONS.find((a) => a.id === 'explain');
  const history = [{ role: 'assistant', content: 'It selects.' }, { role: 'user', content: 'Why id 1?' }];
  const messages = selectionMessages(explain, { text: 'x', name: 'a.sql' }, history);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.slice(2), history);
  assert.equal(lastCodeBlock('Problems:\n- line 1\n\n```sql\nSELECT 1\n```\n\nand\n```sql\nSELECT 2\nFROM t\n```'), 'SELECT 2\nFROM t');
  assert.equal(lastCodeBlock('All good.'), '');
});
