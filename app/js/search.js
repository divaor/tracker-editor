// Find in files (plain text, whole word, match case or regular expression,
// with line numbers and previews) and fuzzy quick open on file names.
// Pure and DOM-free.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Letters and digits, for a character class (word edges, names): Unicode's own classes where
// the engine knows them (browsers, the desktop). The Android app's Node.js has no ICU, so
// `\p{…}` is a syntax error there: the letters and digits of the main scripts stand in.
const WORD_RANGES = 'A-Za-z0-9\\u00AA\\u00B2\\u00B3\\u00B5\\u00B9\\u00BA\\u00BC-\\u00BE\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02C1\\u02C6-\\u02D1\\u02E0-\\u02E4\\u0370-\\u0374\\u0376-\\u037D\\u0386\\u0388-\\u03FF\\u0400-\\u0481\\u048A-\\u052F\\u0531-\\u0556\\u0560-\\u0588\\u05D0-\\u05EA\\u05EF-\\u05F2\\u0620-\\u064A\\u0660-\\u0669\\u066E-\\u066F\\u0671-\\u06D3\\u06F0-\\u06FC\\u0904-\\u0939\\u0966-\\u096F\\u0E01-\\u0E30\\u0E50-\\u0E59\\u10A0-\\u10FF\\u1100-\\u11FF\\u1E00-\\u1FBC\\u2070-\\u2079\\u2080-\\u2089\\u2C00-\\u2CE4\\u3041-\\u3096\\u30A1-\\u30FA\\u3105-\\u312F\\u3131-\\u318E\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A\\uFF66-\\uFF9D';
export const wordCharsFor = (unicodeProperties) => (unicodeProperties ? '\\p{L}\\p{N}' : WORD_RANGES);
export const WORD_CHARS = wordCharsFor(
  (() => {
    try {
      return new RegExp('\\p{L}', 'u').test('é');
    } catch {
      return false;
    }
  })(),
);

/** A global, multiline RegExp for the query, or throws with a readable message for a bad pattern. */
export function buildMatcher(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `(?<![${WORD_CHARS}_])(?:${source})(?![${WORD_CHARS}_])`;
  const flags = `gm${caseSensitive ? '' : 'i'}`;
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err.message.replace(/^Invalid regular expression: /, '')}`);
    }
  }
}

const PREVIEW = 160;

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endNl = text.indexOf('\n', index);
  const end = endNl === -1 ? text.length : endNl;
  return { start, end };
}

/**
 * Searches every file. One result per matching line (with the first match on
 * it), files in the order given. `files`: [{ id, name, text }].
 */
export function findInFiles(files, query, { maxLines = 2000, maxPerFile = 500, ...options } = {}) {
  if (!query) return { files: [], total: 0, lines: 0, truncated: false };
  const matcher = buildMatcher(query, options);
  const out = [];
  let total = 0;
  let lines = 0;
  let truncated = false;
  for (const file of files) {
    const text = file.text ?? '';
    matcher.lastIndex = 0;
    const matches = [];
    let count = 0;
    let line = 1;
    let scanned = 0;
    let lineEnd = -1; // where the line of the last match ends: more matches on it are only counted
    let m;
    while ((m = matcher.exec(text))) {
      if (m[0].length === 0) matcher.lastIndex++;
      count++;
      if (m.index <= lineEnd) continue;
      const { start, end } = lineAt(text, m.index);
      lineEnd = end;
      // Count newlines incrementally from the previous match.
      for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
      scanned = m.index;
      if (matches.length >= maxPerFile || lines >= maxLines) {
        truncated = true;
        continue;
      }
      const full = text.slice(start, end);
      const column = m.index - start;
      const from = Math.max(0, Math.min(column - 40, full.length - PREVIEW));
      const raw = full.slice(from, from + PREVIEW);
      const lead = raw.length - raw.trimStart().length;
      matches.push({
        line,
        column: column + 1,
        length: m[0].length,
        preview: raw.trim(),
        // Where the match sits inside `preview`, for highlighting.
        at: Math.max(0, column - from - lead),
        prefix: from > 0,
      });
      lines++;
    }
    if (count) {
      out.push({ id: file.id, name: file.name, count, matches });
      total += count;
    }
  }
  return { files: out, total, lines, truncated };
}

/**
 * Fuzzy score of `query` against `target` (higher is better), or -1 when the
 * letters do not appear in order. Rewards consecutive letters, word starts
 * and a match at the start.
 */
export function fuzzyScore(target, query) {
  const t = target.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const exact = t.indexOf(q);
  if (exact !== -1) return 1000 - exact * 2 - (t.length - q.length) * 0.1 + (exact === 0 ? 200 : 0);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    const wordStart = found === 0 || /[\s_\-./()]/.test(t[found - 1]);
    score += found === prev + 1 ? 8 : 1;
    if (wordStart) score += 6;
    prev = found;
    ti = found + 1;
  }
  return score - (t.length - q.length) * 0.05;
}

/**
 * Files ranked for quick open; ties keep the given order (most recent first). Files in
 * folders (with `rel`, their path inside the folder) also match by that path ("lib/util").
 */
export function quickOpen(files, query, limit = 60) {
  if (!query.trim()) return files.slice(0, limit);
  const scoreOf = (file) =>
    file.rel !== undefined
      ? Math.max(fuzzyScore(file.name, query), fuzzyScore(file.rel, query) - 3)
      : Math.max(fuzzyScore(file.name, query), fuzzyScore(`${file.project} ${file.name}`, query) - 5, file.item ? fuzzyScore(`${file.item} ${file.name}`, query) - 5 : -1);
  return files
    .map((file, i) => ({ file, i, score: scoreOf(file) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.file);
}
