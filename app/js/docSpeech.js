// Reading a document aloud (ui/documentView.js): the text of its blocks (paragraphs, headings,
// list items, table cells; a PDF's pages) joined into one text the reader (reader.js) splits
// into passages, and which block each passage is in, to show it and follow it. Pure.

/** Kinds the reader reads: not spreadsheets (cells one by one read badly). */
export const readsAloud = (kind) => Boolean(kind) && kind !== 'xlsx' && kind !== 'ods';

/**
 * { text, starts, ends }: the blocks' texts (spaces tidied; a blank line inside one, as between a
 * PDF page's paragraphs, kept), a blank line apart; block i is text.slice(starts[i], ends[i]).
 */
export function joinBlocks(texts) {
  let text = '';
  const starts = [];
  const ends = [];
  for (const raw of texts) {
    const t = String(raw ?? '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (t && text) text += '\n\n';
    // An empty block starts where the next one will (it is never read).
    starts.push(t || !text ? text.length : text.length + 2);
    text += t;
    ends.push(t ? text.length : starts.at(-1));
  }
  return { text, starts, ends };
}

/** The block that `offset` (in joinBlocks' text) is in. */
export function blockAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

/** The first block that reaches below `top`, from the blocks' bottoms (pixels, in page order). */
export function firstBelow(bottoms, top) {
  const i = bottoms.findIndex((b) => b > top + 1);
  return i === -1 ? 0 : i;
}

/**
 * A PDF page's text (pdf.js's lines) as it reads: the lines of a paragraph joined, a word broken
 * at a line's end mended, a page number alone on its line left out, and a new paragraph after a
 * line that ends a sentence, or a short one (a heading, a paragraph's last line) before a capital.
 */
export function pdfSpeechText(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\d{1,4}$/.test(l));
  const short = 0.6 * Math.max(0, ...lines.map((l) => l.length));
  let out = '';
  let last = '';
  for (const line of lines) {
    if (!out) out = line;
    else if (/[a-zà-ÿ]-$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = out.slice(0, -1) + line;
    else if (/[.!?:;"”»)]$/.test(out) || (last.length < short && !/[,-]$/.test(last) && /^[A-ZÀ-Þ0-9¿¡"“«]/.test(line))) out += `\n\n${line}`;
    else out += ` ${line}`;
    last = line;
  }
  return out;
}
