// Reading aloud: splits a file into passages to speak one at a time, each with
// its place in the text (so the editor can highlight it), and rewrites the
// text the way a person would read it: Markdown as prose, dates and
// abbreviations in words, asides and dashes as pauses. Each passage carries
// the pause that follows it. Pure, so the Node tests can import it.

const HARD_CUT = 320; // characters; text without punctuation is cut at spaces

// Silence after each kind of passage, in milliseconds at normal speed.
export const PAUSES = { heading: 700, paragraph: 450, sentence: 90, item: 280, row: 220, code: 450 };

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

const MONTHS = {
  en: 'January February March April May June July August September October November December',
  es: 'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre',
  pt: 'janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro',
};
const LANG_WORDS = {
  en: {
    and: 'and',
    number: 'number',
    version: 'version',
    code: 'Code block skipped.',
    date: (d, month, y) => `${month} ${d}, ${y}`,
    abbreviations: [
      [/\be\.g\.,?/gi, 'for example,'],
      [/\bi\.e\.,?/gi, 'that is,'],
      [/\betc\./gi, 'et cetera.'],
      [/\bvs\.?(?=\s)/gi, 'versus'],
      [/\bapprox\./gi, 'approximately'],
      [/\bw\/o\b/gi, 'without'],
      [/\bw\/(?=\s)/gi, 'with'],
    ],
  },
  es: {
    and: 'y',
    number: 'número',
    version: 'versión',
    code: 'Bloque de código omitido.',
    date: (d, month, y) => `${d} de ${month} de ${y}`,
    abbreviations: [[/\bp\. ?ej\.,?/gi, 'por ejemplo,'], [/\betc\./gi, 'etcétera.']],
  },
  pt: {
    and: 'e',
    number: 'número',
    version: 'versão',
    code: 'Bloco de código omitido.',
    date: (d, month, y) => `${d} de ${month} de ${y}`,
    abbreviations: [[/\bp\. ?ex\.,?/gi, 'por exemplo,'], [/\betc\./gi, 'etcétera.']],
  },
};
const words = (lang) => LANG_WORDS[lang || 'en'] ?? null;

/**
 * Rewrites text the way a person reads it aloud: ISO dates and common
 * abbreviations in words, dashes, arrows, slashes and (asides) as short
 * pauses, "#7" and "v2" spoken out, snake_case names as separate words and
 * no emoji. Word lists exist for English, Spanish and Portuguese.
 */
export function naturalize(text, lang = 'en') {
  const w = words(lang);
  let s = text.replace(/\p{Extended_Pictographic}\uFE0F?/gu, '');
  if (w) {
    const months = MONTHS[lang || 'en'].split(' ');
    s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (months[Number(mo) - 1] && Number(d) >= 1 && Number(d) <= 31 ? w.date(Number(d), months[Number(mo) - 1], y) : m));
    for (const [re, out] of w.abbreviations) s = s.replace(re, out);
    s = s
      .replace(/\s&\s/g, ` ${w.and} `)
      .replace(/(^|\s)#(\d+)/g, `$1${w.number} $2`)
      .replace(/\bv(\d+(?:\.\d+)*)\b/g, `${w.version} $1`);
  }
  return s
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => (inner.trim() ? `, ${inner.trim()},` : '')) // asides
    .replace(/\s*(?:—|–|\s-\s|->|→|=>)\s*/g, ', ') // dashes and arrows
    .replace(/\s+\/\s+/g, ', ') // "a / b"
    .replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, ' ') // snake_case
    .replace(/([!?.])\1+/g, '$1')
    .replace(/(,\s*)+(?=[,.;:!?])/g, '')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Headings, list items and table rows end with a full stop, so voices finish them like sentences.
const closed = (text) => (/[.!?…:;]$/.test(text) ? text : `${text}.`);

// Sentence ends inside [from, to) of `text`: splits a long paragraph.
function sentences(text, from, to, maxPassage) {
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
 * The passages to read, in order: [{ from, to, text, kind, pause }], where
 * from/to are the passage's place in `text`, `text` is what to say, kind is
 * heading, paragraph, sentence (inside a paragraph), item, row or code, and
 * pause the silence after it (ms). Markdown headings, list items and table
 * rows are passages of their own; code blocks are announced and skipped.
 * Paragraphs longer than maxPassage characters are read sentence by sentence.
 */
export function speechPassages(text, { markdown = false, lang = 'en', maxPassage = 240 } = {}) {
  const passages = [];
  const codeSkipped = words(lang)?.code ?? LANG_WORDS.en.code;
  const say = (from, to, raw, kind) => {
    let spoken = naturalize(raw, lang);
    if (!/[\p{L}\p{N}]/u.test(spoken)) return;
    if (kind === 'heading' || kind === 'item' || kind === 'row') spoken = closed(spoken);
    passages.push({ from, to, text: spoken, kind, pause: PAUSES[kind] });
  };
  const block = (from, to, kind) => {
    const ranges = to - from > maxPassage ? sentences(text, from, to, maxPassage) : [[from, to]];
    ranges.forEach(([a, b], i) => {
      const raw = text.slice(a, b);
      const spoken = markdown ? raw.split('\n').map(speakableMarkdown).join(' ').trim() : speakablePlain(raw);
      say(a, b, spoken, kind === 'paragraph' && i < ranges.length - 1 ? 'sentence' : kind);
    });
  };

  let pos = 0;
  let para = null; // [from, to] of the paragraph being gathered
  let fence = null; // { marker, from } inside a code block
  const endParagraph = () => {
    if (para) block(para[0], para[1], 'paragraph');
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
          passages.push({ from: fence.from, to, text: codeSkipped, kind: 'code', pause: PAUSES.code });
          fence = null;
        }
        continue;
      }
      if (marker) {
        endParagraph();
        fence = { marker, from };
        continue;
      }
      if (/^\s{0,3}#{1,6}\s/.test(line)) {
        endParagraph();
        block(from, to, 'heading');
        continue;
      }
      if (/^\s{0,3}(?:[-*+]\s|\d+[.)]\s)/.test(line)) {
        endParagraph();
        block(from, to, 'item');
        continue;
      }
      if (/^\s{0,3}\|/.test(line)) {
        endParagraph();
        if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) || !line.includes('-')) block(from, to, 'row'); // table separator rows are skipped
        continue;
      }
      if (/^\s{0,3}>/.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        endParagraph();
        block(from, to, 'paragraph');
        continue;
      }
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    para = para ? [para[0], to] : [from, to];
  }
  if (fence) passages.push({ from: fence.from, to: text.length, text: codeSkipped, kind: 'code', pause: PAUSES.code });
  endParagraph();
  // A heading follows a longer silence, like a new section.
  passages.forEach((p, i) => {
    if (passages[i + 1]?.kind === 'heading') p.pause = Math.max(p.pause, PAUSES.heading);
  });
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

// Voices whose names say they are the natural-sounding kind (neural, online, enhanced…).
const NATURAL = /natural|neural|online|enhanced|premium|wavenet|studio|journey|chirp|network|siri/i;
export const isNaturalVoice = (voice) => NATURAL.test(`${voice.name} ${voice.voiceURI ?? ''}`);

/** Voices ranked for reading `lang`: that language first, then the natural-sounding ones, then the device's default. */
export function rankVoices(voices, lang) {
  const score = (v) =>
    (lang && v.lang.toLowerCase().replace('_', '-').startsWith(lang) ? 100 : 0) +
    (isNaturalVoice(v) ? 10 : 0) +
    (/google/i.test(v.name) ? 4 : 0) +
    (v.default ? 2 : 0) +
    (v.localService ? 0 : 1);
  return [...voices].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

/** The server voice for `lang`: from "es=ef_dora, pt=pf_dora" when listed, else the main voice. */
export function serverVoiceFor({ voice = '', otherVoices = '' } = {}, lang = '') {
  for (const pair of otherVoices.split(/[,;\n]/)) {
    const [code, name] = pair.split('=').map((x) => x.trim());
    if (code && name && lang && code.toLowerCase() === lang) return name;
  }
  return voice;
}
