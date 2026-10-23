// Replacing what Find in a folder finds, in the files themselves (desktop). Pure: the main
// process does the replacing with it, and the panel shows a preview of each line with it.
import { buildMatcher } from './search.js';

// With a regular expression, \n and \t in the replacement are a line break and a tab.
const unescape = (s) => s.replace(/\\(\\|n|t)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));

/**
 * `text` with every match of `query` replaced: { text, count }. With a regular expression,
 * $1, $<name> and $& in the replacement are the groups and the match; otherwise it is
 * taken exactly as typed.
 */
export function replaceAll(text, query, options = {}, replacement = '') {
  const matcher = buildMatcher(query, options);
  let count = 0;
  for (const m of text.matchAll(matcher)) if (m[0] !== '' || options.regex) count++;
  if (!count) return { text, count: 0 };
  const next = options.regex ? text.replace(matcher, unescape(replacement)) : text.replace(matcher, () => replacement);
  return { text: next, count };
}

/** One line of a search result as it would read after the replacement (for the preview). */
export function replacedLine(line, query, options = {}, replacement = '') {
  try {
    return replaceAll(line, query, options, replacement).text;
  } catch {
    return line;
  }
}
