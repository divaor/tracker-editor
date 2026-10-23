// Suggestions as you type, from the connected model (grey text, Tab accepts): what to ask
// for, and what of the answer to keep. Pure: the tests use it; inlineSuggest.js asks.

/** Messages asking a chat model for the text at the cursor (for servers without FIM). */
export function completionMessages({ prefix, suffix, language = '', name = '' }) {
  return [
    {
      role: 'system',
      content:
        'You complete the text at the cursor in a file. Reply with only the text to insert at <CURSOR>: no explanations, no code fences, nothing that is already before or after it. Keep it short: the rest of the line, or a few lines that finish what was started.',
    },
    { role: 'user', content: `File: ${name || 'untitled'}${language ? ` (${language})` : ''}\n\n${prefix}<CURSOR>${suffix}` },
  ];
}

/**
 * The part of a model's answer worth showing: fences and echoes of the text around the
 * cursor removed, cut where it would repeat what follows, at most `maxLines` lines. '' when
 * nothing useful is left.
 */
export function cleanCompletion(answer, { prefix = '', suffix = '', maxLines = 12 } = {}) {
  let text = String(answer ?? '').replace(/\r\n?/g, '\n');
  // Fences: ```lang … ```
  const fence = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence) text = fence[1];
  text = text.replace(/<CURSOR>/g, '');
  // An echo of the line so far ("const total = " answered as "const total = sum()").
  const lineSoFar = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lineSoFar.trim() && text.startsWith(lineSoFar)) text = text.slice(lineSoFar.length);
  else if (lineSoFar.trim() && text.trimStart().startsWith(lineSoFar.trim()) && lineSoFar.trim().length > 3) {
    text = text.trimStart().slice(lineSoFar.trim().length);
    // The space typed before the cursor is not doubled.
    if (/\s$/.test(lineSoFar)) text = text.replace(/^[ \t]+/, '');
  }
  // Up to where it starts repeating the text after the cursor.
  const after = suffix.trimStart();
  if (after) {
    const head = after.slice(0, Math.min(after.length, 40));
    const at = head.length >= 3 ? text.indexOf(head) : -1;
    if (at !== -1) text = text.slice(0, at);
    // The rest of the line after the cursor (a closing bracket) is not repeated at the end.
    const restOfLine = suffix.split('\n')[0].trim();
    if (restOfLine && text.trimEnd().endsWith(restOfLine)) text = text.trimEnd().slice(0, -restOfLine.length);
  }
  // A blank line ends a suggestion; then the line count.
  const blank = text.search(/\n\s*\n/);
  if (blank > 0) text = text.slice(0, blank);
  const lines = text.split('\n');
  if (lines.length > maxLines) text = lines.slice(0, maxLines).join('\n');
  text = text.replace(/\s+$/, (ws) => (ws.includes('\n') ? '' : ws.length > 1 ? '' : ws));
  return text.trim() ? text : '';
}

/** Whether to ask at this place: something typed before the cursor, and the line ending here (or only closing brackets after). */
export function shouldSuggest({ before, after }) {
  if (!before.trim()) return false;
  if (/^\s*[)\]}'"`;,]*\s*$/.test(after) === false) return false;
  // Not in the middle of a word.
  return !/\w$/.test(before) || after === '' || /^\s/.test(after) || /^[)\]}'"`;,]/.test(after);
}

/**
 * How much of the rest of the line a suggestion takes the place of: all of it (closing
 * brackets and quotes, as shouldSuggest allows there) when the suggestion has those
 * characters in the same order (an auto-closed ")" that the model wrote too), else 0.
 */
export function restCovered(text, rest) {
  const want = rest.replace(/\s+/g, '');
  if (!want) return 0;
  let i = 0;
  for (const ch of text) if (i < want.length && ch === want[i]) i++;
  return i === want.length ? rest.length : 0;
}
