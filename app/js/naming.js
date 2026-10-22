// Names for untitled tabs ("new 3"), taken from what is in them: by the local
// model when one is connected, otherwise from a heading on the first line.
// The model can also file a new note: one of your projects and a few tags.
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

/**
 * Chat messages asking the model to file a text: a JSON object with `project`
 * (one of `projects`, or ""), `tags` (reusing `tags` when they fit) and, when
 * `name` is true, a file name.
 */
export function filingMessages(text, { ext = '', projects = [], tags = [], name = true } = {}) {
  const fields = name ? '{"name": "...", "project": "...", "tags": ["..."]}' : '{"project": "...", "tags": ["..."]}';
  const list = projects.length ? projects.map((p) => `- ${p.name}${p.area ? ` (${p.area})` : ''}`).join('\n') : '(none)';
  return [
    {
      role: 'system',
      content:
        `You file notes. Reply with only a JSON object: ${fields}. ` +
        (name ? 'name: 2 to 6 words in the language of the text that say what it is, with an extension that fits (.md for notes and prose, .txt for plain text, or the code\'s own). ' : '') +
        'project: exactly one of the projects listed, or "" when none clearly fits. Never invent a project. ' +
        'tags: 0 to 3 short lowercase tags for what the text is about; reuse the existing tags when they fit. No explanation.',
    },
    {
      role: 'user',
      content: `Projects:\n${list}\n\nExisting tags: ${tags.length ? tags.slice(0, 40).join(', ') : '(none)'}\n${ext ? `The editor detected: .${ext}\n` : ''}\nText:\n${text.slice(0, 3000)}`,
    },
  ];
}

const tagSlug = (t) =>
  String(t ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/**
 * The model's filing reply, checked: `project` is one of `projects` in its own
 * spelling (or ""), `tags` at most 3 (an existing tag keeps its spelling), and
 * `name` a safe file name (or ""). Null when the reply has no JSON object.
 */
export function parseFiling(reply, { projects = [], tags = [], ext = 'txt' } = {}) {
  const match = /\{[\s\S]*\}/.exec(String(reply ?? ''));
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const wanted = String(data.project ?? '').trim().toLowerCase();
  const project = (wanted && projects.find((p) => p.name.toLowerCase() === wanted)?.name) || '';
  const existing = new Map(tags.map((t) => [t.toLowerCase(), t]));
  const out = [];
  for (const raw of Array.isArray(data.tags) ? data.tags : []) {
    const slug = tagSlug(raw);
    const tag = existing.get(String(raw ?? '').trim().replace(/^#+/, '').toLowerCase()) ?? existing.get(slug) ?? slug;
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length === 3) break;
  }
  return { name: data.name ? cleanModelName(String(data.name), ext) : '', project, tags: out };
}
