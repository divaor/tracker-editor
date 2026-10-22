// Reading aloud: splits a file into passages to speak one at a time, each with
// its place in the text (so the editor can highlight it), and turns Markdown
// into plain speech. Pure, so the Node tests can import it.

const MAX_PASSAGE = 240; // characters; longer paragraphs are split into sentences
const HARD_CUT = 320; // and text without punctuation at spaces

/** Markdown markup → words to say. */
export function speakableMarkdown(line) {
  return line
    .replace(/<[^>]+>/g, ' ') // HTML tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images: their description
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links: their text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '') // heading marks
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*>+\s?/, '') // quotes
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '') // list items and checkboxes
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2') // italics
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, '$1') // escapes like OOR\_JSD
    .replace(/\s*\|\s*/g, ', ') // table cells
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

const speakablePlain = (text) => text.replace(/https?:\/\/\S+/g, 'link').replace(/\s+/g, ' ').trim();

// Sentence ends inside [from, to) of `text`: splits a long paragraph.
function sentences(text, from, to) {
  const out = [];
  let start = from;
  const re = /[.!?…]+["'”’)\]]*\s+/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text)) && m.index < to) {
    const end = m.index + m[0].length;
    if (end - start >= 40 || end >= to) {
      out.push([start, end]);
      start = end;
    }
  }
  if (start < to) out.push([start, to]);
  // Still too long (no punctuation): cut at spaces.
  return out.flatMap(([a, b]) => {
    const parts = [];
    while (b - a > HARD_CUT) {
      const cut = text.lastIndexOf(' ', a + HARD_CUT);
      const at = cut > a ? cut + 1 : a + HARD_CUT;
      parts.push([a, at]);
      a = at;
    }
    parts.push([a, b]);
    return parts;
  });
}

/**
 * The passages to read, in order: [{ from, to, text }], where from/to are the
 * passage's place in `text` and `text` is what to say. Markdown headings, list
 * items and table rows are passages of their own; code blocks are announced
 * and skipped.
 */
export function speechPassages(text, { markdown = false } = {}) {
  const passages = [];
  const say = (from, to, words) => {
    if (/[\p{L}\p{N}]/u.test(words)) passages.push({ from, to, text: words });
  };
  const paragraph = (from, to) => {
    const ranges = to - from > MAX_PASSAGE ? sentences(text, from, to) : [[from, to]];
    for (const [a, b] of ranges) {
      const raw = text.slice(a, b);
      say(a, b, markdown ? raw.split('\n').map(speakableMarkdown).join(' ').trim() : speakablePlain(raw));
    }
  };

  let pos = 0;
  let para = null; // [from, to] of the paragraph being gathered
  let fence = null; // { marker, from } inside a code block
  const endParagraph = () => {
    if (para) paragraph(para[0], para[1]);
    para = null;
  };
  for (const line of text.split('\n')) {
    const from = pos;
    const to = pos + line.length;
    pos = to + 1;
    if (markdown) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
          say(fence.from, to, 'Code block skipped.');
          fence = null;
        }
        continue;
      }
      if (marker) {
        endParagraph();
        fence = { marker, from };
        continue;
      }
      if (/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        endParagraph();
        if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) || !line.includes('-')) paragraph(from, to); // table separator rows are skipped
        continue;
      }
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    para = para ? [para[0], to] : [from, to];
  }
  if (fence) say(fence.from, text.length, 'Code block skipped.');
  endParagraph();
  return passages;
}

/** The passage to start from for a cursor at `offset`: the one containing it, else the next; from the top after the end. */
export function passageAt(passages, offset) {
  const i = passages.findIndex((p) => p.to > offset);
  return i === -1 ? 0 : i;
}

const STOPWORDS = {
  en: 'the and of to is in that it for with as are this was be on not you have but from they which',
  es: 'el la de que y en los las un una por con para es se no del al lo como más pero sus',
  pt: 'o a de que e do da em um uma os as para com não é se no na por mais dos das ao',
  fr: 'le la les de des et un une est que qui dans pour pas sur au avec ce il elle ne',
  de: 'der die das und ist nicht ein eine zu den mit von dem des sich auf für im auch es',
  it: 'il lo la di che e un una per non con sono gli le del della è si nel alla',
};
const WORDS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));

/** A guess at the language of `text` (en, es, pt, fr, de or it), or '' when unsure. */
export function detectLanguage(text) {
  const words = text.slice(0, 4000).toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 8) return '';
  const scores = Object.entries(WORDS).map(([lang, set]) => [lang, words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0)]);
  scores.sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = scores;
  return top >= 3 && top >= second * 1.4 ? best : '';
}
