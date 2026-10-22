// Names for untitled tabs ("new 3"), taken from what is in them: by the local
// model when one is connected, otherwise from a heading on the first line.
// Pure, so the Node tests can import it.
import { safeName, splitName } from './model.js';

export const isUntitled = (name) => /^new \d+$/.test(name);

// Enough text to tell what a file is about.
export const MIN_NAMING_TEXT = 30;

/** A name from a Markdown heading on the first line that has text ("# Plan" → "Plan.md"), else ''. */
export function nameFromHeading(text) {
  const first = text.split('\n').find((line) => line.trim());
  const heading = first && /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(first)?.[1];
  if (!heading) return '';
  const words = heading.replace(/[*_`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return words ? safeName(`${words}.md`) : '';
}

/** Chat messages asking the model for a file name. `ext` is the extension of the detected language, if any. */
export function namingMessages(text, ext = '') {
  return [
    {
      role: 'system',
      content:
        'You name files. Reply with only a file name: 2 to 6 words in the language of the text that say what it is, ' +
        'and an extension that fits (.md for notes and prose, .txt for plain text, or the code\'s own, like .py, .sql or .json). ' +
        'Spaces are fine. No quotes, no path, no explanation.',
    },
    { role: 'user', content: `${ext ? `The editor detected: .${ext}\n` : ''}Text:\n${text.slice(0, 3000)}` },
  ];
}

/** The model's reply as a safe file name with an extension (`ext` when it gave none), or '' when it is unusable. */
export function cleanModelName(reply, ext = 'txt') {
  let name = String(reply ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!name) return '';
  name = name
    .replace(/^(?:file ?name|name|nombre|nome)\s*:\s*/i, '')
    .replace(/^["'`*]+|["'`*]+$/g, '')
    .replace(/[<>:"|?*\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const split = splitName(name);
  // "Plan v2.1" has no extension: one starts with a letter.
  const own = /^\.[a-z][a-z0-9]{0,7}$/i.test(split.ext) ? split.ext.toLowerCase() : '';
  const stem = (own ? split.base : name).trim().slice(0, 60).trim();
  if (!stem || isUntitled(stem)) return '';
  return safeName(`${stem}${own || `.${ext}`}`);
}

/** `name`, or "name (2).ext", "name (3).ext"… when another file already has it. */
export function uniqueName(name, taken) {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const { base, ext } = splitName(name);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
