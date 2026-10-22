import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, passageAt, speakableMarkdown, speechPassages } from '../app/js/speech.js';

test('turns Markdown into words to say', () => {
  assert.equal(speakableMarkdown('## The **setup** today ##'), 'The setup today');
  assert.equal(speakableMarkdown('- [x] Read the [guide](https://example.com/guide) first'), 'Read the guide first');
  assert.equal(speakableMarkdown('1. Run `npm test`, then _ship_ it'), 'Run npm test, then ship it');
  assert.equal(speakableMarkdown('| #7 | OOR\\_JSD | dba\\_agent\\_ro |'), '#7, OOR_JSD, dba_agent_ro');
  assert.equal(speakableMarkdown('> See https://github.com/divaor/tracking_app for more'), 'See link for more');
  assert.equal(speakableMarkdown('![Board view](docs/board.png)'), 'Board view');
});

test('splits a Markdown file into passages that point back into the text', () => {
  const text = [
    '# Database override guide',
    '',
    'A report can pick, per request, which database it reads.',
    'It falls back to the default.',
    '',
    '```sql',
    'select * from [OOR].[dbo].[kbn_dim_assign_lines]',
    '```',
    '',
    '| Connection | Database |',
    '|---|---|',
    '| #7 | OOR |',
    '',
    '- first step',
    '- [ ] second step',
    '',
    '---',
  ].join('\n');
  const passages = speechPassages(text, { markdown: true });
  assert.deepEqual(
    passages.map((p) => p.text),
    ['Database override guide', 'A report can pick, per request, which database it reads. It falls back to the default.', 'Code block skipped.', 'Connection, Database', '#7, OOR', 'first step', 'second step'],
  );
  for (const p of passages) assert.ok(p.to > p.from && p.from >= 0 && p.to <= text.length);
  assert.equal(text.slice(passages[0].from, passages[0].to), '# Database override guide');
  assert.ok(text.slice(passages[2].from, passages[2].to).startsWith('```sql') && text.slice(passages[2].from, passages[2].to).endsWith('```'));
});

test('long paragraphs are read sentence by sentence', () => {
  const sentence = (i) => `Sentence number ${i} explains one more detail of the plan in plain words.`;
  const text = Array.from({ length: 8 }, (_, i) => sentence(i + 1)).join(' ');
  const passages = speechPassages(text);
  assert.ok(passages.length >= 3, `${passages.length} passages`);
  assert.equal(passages.map((p) => p.text).join(' '), text);
  assert.ok(passages.every((p) => p.to - p.from <= 320));
  const unpunctuated = 'word '.repeat(400);
  assert.ok(speechPassages(unpunctuated).every((p) => p.to - p.from <= 320));
});

test('plain text keeps its symbols, but not URLs', () => {
  const passages = speechPassages('# not a heading here\nx = a * b  # see https://example.com\n');
  assert.deepEqual(passages.map((p) => p.text), ['# not a heading here x = a * b # see link']);
});

test('starts from the passage at the cursor', () => {
  const passages = [{ from: 0, to: 10 }, { from: 12, to: 30 }, { from: 32, to: 40 }];
  assert.equal(passageAt(passages, 0), 0);
  assert.equal(passageAt(passages, 11), 1);
  assert.equal(passageAt(passages, 35), 2);
  assert.equal(passageAt(passages, 99), 0, 'after the end: from the top');
});

test('guesses the language for picking a voice', () => {
  assert.equal(detectLanguage('This is the plan for the release, and it is not done yet but we have a draft of it.'), 'en');
  assert.equal(detectLanguage('Este es el plan para la entrega y no está listo, pero tenemos un borrador de lo que se hará.'), 'es');
  assert.equal(detectLanguage('Este é o plano para a entrega e não está pronto, mas temos um rascunho do que será feito com os dados.'), 'pt');
  assert.equal(detectLanguage('select * from dbo.table'), '');
});
