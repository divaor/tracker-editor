// Snippets: files marked `snippet` whose text has fields to fill in when used,
// written {{name}} or {{name:default}}. Built-in fields fill themselves:
// {{date}}, {{time}}, {{datetime}}, {{clipboard}}, {{selection}}, and
// {{cursor}} marks where the cursor goes after inserting.
// Pure, so the Node tests can import it.

const FIELD = /\{\{\s*([\p{L}\p{N}_][\p{L}\p{N}_ .-]*?)\s*(?::([^}]*))?\}\}/gu;
export const BUILTIN_FIELDS = ['date', 'time', 'datetime', 'clipboard', 'selection', 'cursor'];
const isBuiltin = (name) => BUILTIN_FIELDS.includes(name.toLowerCase());

/** The fields to ask for, in order of first use: [{ name, default }]. Built-ins are left out. */
export function snippetFields(text) {
  const fields = [];
  for (const m of String(text ?? '').matchAll(FIELD)) {
    const name = m[1];
    if (isBuiltin(name)) continue;
    const known = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
    const fallback = (m[2] ?? '').trim();
    if (!known) fields.push({ name, default: fallback });
    else if (!known.default && fallback) known.default = fallback;
  }
  return fields;
}

/** Built-in fields that need something from the app (the clipboard, the selection). */
export const usesBuiltin = (text, name) => [...String(text ?? '').matchAll(FIELD)].some((m) => m[1].toLowerCase() === name);

const pad = (n) => String(n).padStart(2, '0');

/**
 * The snippet with its fields filled: { text, cursor } where cursor is the
 * offset of {{cursor}} (or the end). `values` are by field name; a field left
 * empty takes its default. `now`, `clipboard` and `selection` fill the built-ins.
 */
export function fillSnippet(text, values = {}, { now = new Date(), clipboard = '', selection = '' } = {}) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const builtins = { date, time, datetime: `${date} ${time}`, clipboard, selection };
  let cursor = -1;
  let out = '';
  let last = 0;
  const src = String(text ?? '');
  for (const m of src.matchAll(FIELD)) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const name = m[1].toLowerCase();
    if (name === 'cursor') {
      if (cursor === -1) cursor = out.length;
      continue;
    }
    if (name in builtins) out += builtins[name];
    else out += lower[name] || (m[2] ?? '').trim();
  }
  out += src.slice(last);
  return { text: out, cursor: cursor === -1 ? out.length : cursor };
}

/** A snippet name from the start of a selection: its first words, as a .txt file. */
export function snippetNameFrom(text) {
  const words = String(text ?? '')
    .replace(FIELD, (_, name) => name)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return words ? `${words.replace(/[<>:"/\\|?*]/g, ' ').trim()}.txt` : 'snippet.txt';
}
