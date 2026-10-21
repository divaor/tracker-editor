// Local model helpers: split files into chunks for embeddings, rank chunks
// by similarity, and build the prompts. Pure and DOM-free.

/**
 * Splits a text into chunks of whole lines, about `maxChars` long, preferring
 * to break at blank lines. Each chunk knows its line range (1-based) so
 * answers can point to where something is.
 */
export function chunkText(text, { maxChars = 1200 } = {}) {
  const lines = text.split('\n');
  const chunks = [];
  let start = 0;
  let size = 0;
  const flush = (end) => {
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) chunks.push({ from: start + 1, to: end, text: body });
    start = end;
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A single very long line (minified code, a pasted log) is cut into pieces.
    if (line.length > maxChars) {
      if (i > start) flush(i);
      for (let at = 0; at < line.length; at += maxChars) chunks.push({ from: i + 1, to: i + 1, text: line.slice(at, at + maxChars) });
      start = i + 1;
      continue;
    }
    if (size + line.length > maxChars && i > start) flush(i);
    size += line.length + 1;
    if (!line.trim() && size > maxChars * 0.6) flush(i + 1);
  }
  if (start < lines.length) flush(lines.length);
  return chunks;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Top `k` entries ({ vector, ... }) by similarity to `query`, best first, each with a `score`. */
export function rankBySimilarity(query, entries, k = 8) {
  return entries
    .map((entry) => ({ ...entry, score: cosine(query, entry.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

const SYSTEM = 'You help the user with the text files open in their editor. Be concise and concrete. When you use a passage, cite it as [file name:line].';

/** Messages asking for a summary of a file (or of the selected part of it). */
export function summaryMessages(name, text, { selection = false, maxChars = 24000 } = {}) {
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n[… cut, ${text.length - maxChars} more characters]` : text;
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Summarize ${selection ? 'this selection from' : 'the file'} “${name}”. Start with one sentence on what it is, then the key points as a short list, then anything that looks unfinished or needs a decision.\n\n\`\`\`\n${body}\n\`\`\``,
    },
  ];
}

/** Messages for a question answered from passages of the user's files. */
export function askMessages(question, passages, { history = [] } = {}) {
  const context = passages.length
    ? passages.map((p) => `### ${p.name} (lines ${p.from}–${p.to})\n${p.text}`).join('\n\n')
    : '(No matching passages were found in the files.)';
  return [
    { role: 'system', content: `${SYSTEM} Answer only from the passages below; if they do not contain the answer, say so and suggest what to search for.\n\nPassages from the user's files:\n\n${context}` },
    ...history,
    { role: 'user', content: question },
  ];
}
