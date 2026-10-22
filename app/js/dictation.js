// Dictation (voice notes): turning what the speech service hears into text
// that fits where the cursor is. Pure, so the Node tests can import it; the
// listening is in ui/dictation.js.

export const DICTATION_LANGUAGES = [
  { id: '', label: "This device's language" },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-MX', label: 'Spanish (Mexico)' },
  { id: 'es-ES', label: 'Spanish (Spain)' },
  { id: 'es-US', label: 'Spanish (US)' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
];

// Spoken commands, only ones that are never ordinary words in a sentence.
const COMMANDS = {
  en: [
    [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
    [/\s*\bnew line\b\s*/gi, '\n'],
  ],
  es: [
    [/\s*\bnuevo p[aá]rrafo\b\s*/gi, '\n\n'],
    [/\s*\bpunto y aparte\b\s*/gi, '.\n'],
    [/\s*\bnueva l[ií]nea\b\s*/gi, '\n'],
    [/\s*\bnuevo rengl[oó]n\b\s*/gi, '\n'],
  ],
  pt: [
    [/\s*\bnovo par[aá]grafo\b\s*/gi, '\n\n'],
    [/\s*\bnova linha\b\s*/gi, '\n'],
  ],
};

/** A phrase with its spoken commands ("new line", "nuevo párrafo", …) turned into line breaks. */
export function applyCommands(phrase, lang = 'en') {
  let text = String(phrase ?? '');
  for (const [re, to] of COMMANDS[lang.slice(0, 2).toLowerCase()] ?? []) text = text.replace(re, to);
  return text.replace(/[ \t]+\n/g, '\n');
}

const upperFirst = (text) => text.replace(/^(\s*)(\p{Ll})/u, (_m, space, letter) => space + letter.toUpperCase());

/**
 * The text to insert for a dictated phrase, given what comes before the cursor:
 * a space when needed, a capital letter at the start of a sentence or line.
 */
export function joinDictated(before, phrase, lang = 'en') {
  let text = applyCommands(phrase.trim(), lang);
  if (!text.trim()) return text.includes('\n') ? text : '';
  const startsLine = !before || /\n\s*$/.test(before);
  const startsSentence = startsLine || /[.!?¡¿]\s*$/.test(before);
  if (startsSentence) text = upperFirst(text);
  // Capitals after the line breaks dictated inside the phrase too.
  text = text.replace(/([.!?]?\n+)(\p{Ll})/gu, (_m, brk, letter) => brk + letter.toUpperCase());
  const needsSpace = before && !/\s$/.test(before) && !/^[\s.,;:!?)]/.test(text);
  return (needsSpace ? ' ' : '') + text;
}
