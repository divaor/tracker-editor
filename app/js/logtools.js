// Tools for logs and other long files: showing only the lines that match (or
// hiding them), and a lighter editor for very large files.
// Pure, so the Node tests can import it.

// Above this, a file opens in the lighter editor (no highlighting, no wrapping).
export const BIG_CHARS = 3_000_000;
export const BIG_LINES = 60_000;

/** Whether a text is large enough for the lighter editor. */
export function isBigText(text) {
  if (text.length > BIG_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) if (++lines > BIG_LINES) return true;
  return false;
}

/**
 * A line test for a filter { pattern, regex, caseSensitive }: a RegExp (plain
 * text is escaped). Throws with a readable message when the pattern is invalid.
 */
export function compileFilter({ pattern, regex = false, caseSensitive = false }) {
  const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, caseSensitive ? 'u' : 'iu');
  } catch (err) {
    throw new Error(`Not a valid pattern: ${err.message.replace(/^Invalid regular expression: /, '')}`);
  }
}

/**
 * Runs of lines to hide (1-based, inclusive [from, to]) for `mode` 'show'
 * (only matching lines stay) or 'hide' (matching lines go), with how many show.
 */
export function hiddenRuns(lineCount, lineText, test, mode = 'show') {
  const runs = [];
  let start = 0;
  let shown = 0;
  for (let n = 1; n <= lineCount; n++) {
    const keep = test.test(lineText(n)) === (mode === 'show');
    if (keep) {
      shown++;
      if (start) runs.push([start, n - 1]);
      start = 0;
    } else if (!start) start = n;
  }
  if (start) runs.push([start, lineCount]);
  return { runs, shown };
}
