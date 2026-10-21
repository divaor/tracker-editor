// Find in files (plain text, whole word, match case or regular expression,
// with line numbers and previews) and fuzzy quick open on file names.
// Pure and DOM-free.

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A global, multiline RegExp for the query, or throws with a readable message for a bad pattern. */
export function buildMatcher(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
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
    let lastLineStart = -1;
    let m;
    while ((m = matcher.exec(text))) {
      if (m[0].length === 0) matcher.lastIndex++;
      count++;
      const { start, end } = lineAt(text, m.index);
      if (start === lastLineStart) continue;
      // Count newlines incrementally from the previous match.
      for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) line++;
      scanned = m.index;
      lastLineStart = start;
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

/** Files ranked for quick open; ties keep the given order (most recent first). */
export function quickOpen(files, query, limit = 60) {
  if (!query.trim()) return files.slice(0, limit);
  return files
    .map((file, i) => ({ file, i, score: Math.max(fuzzyScore(file.name, query), fuzzyScore(`${file.project} ${file.name}`, query) - 5) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((r) => r.file);
}
