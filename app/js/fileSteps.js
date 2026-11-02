// The model makes and changes files (pure: no DOM; the page and the tests use it). Like Git with
// the model (gitAssist.js): the model is given a picture of the workspace (its base folder, the
// files in it, the file open) and answers in words; to look further or to change something it
// writes a ```file-steps block: a JSON list of steps from STEPS below, nothing else. Looking steps
// run at once and go back to it; changes show as cards with a preview and wait for the person's
// Apply; a terminal step only types a command for the person to run. Paths are relative to the
// base folder and checked here; the main process checks every write again (picked folders only).

import { codeFences, parseJsonLoose, withoutBlocks, wordsBefore } from './fences.js';

/** At most this many rounds (the model answers, looks, answers again) for one question. */
export const MAX_ROUNDS = 8;
/** At most this many changes in one block, and this large a file. */
export const MAX_CHANGES = 80;
export const MAX_FILE = 1_000_000;
/** What one look may give back. */
export const READ_CHARS = 60_000;
export const LIST_ENTRIES = 400;
export const SEARCH_LINES = 120;
/** The open file's text in the picture, at most. */
const CONTEXT_CHARS = 16_000;

/** Folders never listed or searched (the same as the main process's SKIP_DIRS). */
export const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vs', '.next', '.terraform']);

/**
 * Names that hold secrets: never read, searched or written by the model (their names may show in
 * a list). Example files (.env.example, .env.sample, .env.template) are fine.
 */
export function isSecretName(name) {
  const n = String(name ?? '').split(/[\\/]/).pop().toLowerCase();
  if (!n) return false;
  if (/^\.env(\..+)?$/.test(n)) return !/\.(example|sample|template|dist|defaults?)$/.test(n);
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/.test(n)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(n) && !n.endsWith('.pub')) return true;
  return ['.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.htpasswd', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', '.dockercfg', 'service-account.json'].includes(n);
}

const BAD_CHARS = /[\0-\x1f<>:"|?*]/;

/**
 * A path the model named, made plain ("./src\\a.js" → "src/a.js"), or null with `problem`
 * when it is not a path inside the base folder: absolute, "..", empty parts, odd characters.
 */
export function cleanRel(rel) {
  if (typeof rel !== 'string') return { problem: 'no path' };
  let p = rel.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!p) return { problem: 'no path' };
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || /^[a-z][\w+.-]*:\/\//i.test(p)) return { problem: `${rel} is not inside the folder (use a path relative to it)` };
  p = p.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  if (p === '' || p === '.') return { rel: '' };
  const parts = p.split('/');
  if (parts.some((x) => x === '..')) return { problem: `${rel} leads out of the folder ("..")` };
  if (parts.some((x) => x === '.' || x === '' || BAD_CHARS.test(x) || /[ .]$/.test(x))) return { problem: `${rel} has a name the editor cannot use` };
  if (p.length > 1000) return { problem: 'the path is too long' };
  return { rel: parts.join('/') };
}

const str = (v, max = MAX_FILE) => typeof v === 'string' && v.length <= max;
const relOk = (v, { root = false } = {}) => {
  const c = cleanRel(v ?? (root ? '' : undefined));
  return c.problem ? c.problem : !root && !c.rel ? 'the folder itself' : '';
};

/**
 * The steps: kind 'look' runs at once (its output goes back to the model), 'change' waits for
 * Apply ('danger' ones with a warning), 'terminal' types a command for the person. `check(step)`
 * says what is wrong ('' when nothing), `text(step)` is the card's title, `fields` what the model
 * is told the step takes.
 */
export const STEPS = {
  list: {
    kind: 'look',
    fields: '{ "path"?: "src", "depth"?: 2 }',
    check: (s) => (s.path != null && s.path !== '' ? relOk(s.path, { root: true }) : '') || (s.depth != null && !(Number.isInteger(s.depth) && s.depth >= 1 && s.depth <= 4) ? 'depth (1 to 4)' : ''),
    text: (s) => `List ${s.path ? cleanRel(s.path).rel || 'the folder' : 'the folder'}`,
  },
  read: {
    kind: 'look',
    fields: '{ "path": "src/app.js", "from"?: 1, "to"?: 200 }  (lines, both included)',
    check: (s) => relOk(s.path) || (isSecretName(s.path) ? `${s.path} holds secrets: it is never read` : '') || ([s.from, s.to].some((n) => n != null && !(Number.isInteger(n) && n >= 1)) ? 'from/to (line numbers from 1)' : ''),
    text: (s) => `Read ${cleanRel(s.path).rel}${s.from || s.to ? ` (lines ${s.from ?? 1}–${s.to ?? 'end'})` : ''}`,
  },
  search: {
    kind: 'look',
    fields: '{ "text": "createServer", "regex"?: false, "path"?: "src" }',
    check: (s) => (!str(s.text, 500) || !s.text ? 'text' : s.path != null && s.path !== '' ? relOk(s.path, { root: true }) : '') || (s.regex ? regexProblem(s.text) : ''),
    text: (s) => `Search for “${s.text}”${s.path ? ` in ${cleanRel(s.path).rel}` : ''}`,
  },
  'create-folder': {
    kind: 'change',
    fields: '{ "path": "src/routes" }  (folders on the way are made too)',
    check: (s) => relOk(s.path),
    text: (s) => `Make the folder ${cleanRel(s.path).rel}`,
  },
  'create-file': {
    kind: 'change',
    fields: '{ "path": "src/routes/users.js", "text": "…the whole file…" }  (it must not exist yet; folders on the way are made)',
    check: (s) => relOk(s.path) || (isSecretName(s.path) ? `${s.path} would hold secrets: the editor does not write those` : '') || (!str(s.text) ? 'text (at most 1 MB)' : ''),
    text: (s) => `Make ${cleanRel(s.path).rel}`,
  },
  'edit-file': {
    kind: 'change',
    fields: '{ "path": "src/app.js", "edits": [{ "find": "text as it is in the file now", "replace": "its new text" }] }  or  { "path": "…", "text": "the whole new text" }',
    check: (s) =>
      relOk(s.path) ||
      (isSecretName(s.path) ? `${s.path} holds secrets: it is never changed here` : '') ||
      (s.text != null ? (str(s.text) ? '' : 'text (at most 1 MB)') : Array.isArray(s.edits) && s.edits.length > 0 && s.edits.length <= 50 && s.edits.every((e) => e && str(e.find, 200_000) && e.find.length > 0 && str(e.replace, MAX_FILE)) ? '' : 'edits ([{ find, replace }], each find not empty)'),
    text: (s) => `Change ${cleanRel(s.path).rel}${s.text != null ? ' (all of it)' : s.edits?.length > 1 ? ` (${s.edits.length} places)` : ''}`,
  },
  rename: {
    kind: 'change',
    fields: '{ "from": "a.js", "to": "lib/a.js" }  (moves it too)',
    check: (s) => relOk(s.from) || relOk(s.to) || (cleanRel(s.from).rel === cleanRel(s.to).rel ? 'from and to are the same' : '') || (isSecretName(s.from) || isSecretName(s.to) ? 'a file with secrets' : ''),
    text: (s) => `Rename ${cleanRel(s.from).rel} → ${cleanRel(s.to).rel}`,
  },
  delete: {
    kind: 'change',
    danger: true,
    fields: '{ "path": "old.js" }',
    check: (s) => relOk(s.path),
    text: (s) => `Delete ${cleanRel(s.path).rel}`,
  },
  terminal: {
    kind: 'terminal',
    fields: '{ "command": "npm install express" }  (one line, chain with &&; typed in a terminal in the base folder, the person presses Enter)',
    check: (s) => (!str(s.command, 1000) || !s.command.trim() ? 'command' : /[\r\n]/.test(s.command) ? 'the command must be one line (chain with &&)' : ''),
    text: (s) => 'Type a command in a terminal',
  },
};

/** Whether a regular expression compiles (a search the model asked for). */
export function regexProblem(source) {
  try {
    new RegExp(source);
    return '';
  } catch (err) {
    return `not a valid regular expression (${err.message})`;
  }
}

/** The step with its paths made plain (a rename's from/to are paths; a read's are line numbers). */
function normalized(step) {
  const out = { ...step };
  if (typeof out.path === 'string') out.path = cleanRel(out.path).rel ?? out.path;
  if (step.op === 'rename') {
    out.from = cleanRel(out.from).rel;
    out.to = cleanRel(out.to).rel;
  }
  return out;
}

/**
 * One step from the model → { step, kind, risk ('look' | 'ask' | 'danger' | 'type'), text, why,
 * problem }: its op must be known and its fields right (`problem` says what is not).
 */
export function describeStep(raw) {
  const step = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const def = STEPS[step.op];
  if (!def) return { step, problem: `“${String(step.op ?? '?')}” is not a step the editor can do` };
  const bad = def.check(step);
  if (bad) return { step, problem: `${step.op}: ${bad}` };
  const clean = normalized(step);
  return {
    step: clean,
    kind: def.kind,
    look: def.kind === 'look',
    risk: def.kind === 'look' ? 'look' : def.kind === 'terminal' ? 'type' : def.danger ? 'danger' : 'ask',
    text: def.text(clean),
    why: typeof step.why === 'string' ? step.why.slice(0, 300) : '',
  };
}

/**
 * The model's reply → { text (the words, the steps' block taken out), steps (described),
 * problems }. Steps are in ```file-steps fences (a JSON list, or one step); a ```json one whose
 * items all have "op" counts too. At most MAX_CHANGES changes in a reply.
 */
export function parsePlan(reply) {
  const text = String(reply ?? '');
  const steps = [];
  const problems = [];
  const used = [];
  let changes = 0;
  // Fences as CommonMark reads them: a ``` inside a file's text (a README's code) never ends the block.
  for (const block of codeFences(text)) {
    const lang = block.lang;
    if (lang && lang !== 'file-steps' && lang !== 'json') continue;
    let parsed;
    try {
      parsed = parseJsonLoose(block.body);
    } catch {
      if (lang === 'file-steps') problems.push('The steps were not valid JSON.');
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (lang !== 'file-steps' && !items.every((x) => x && typeof x === 'object' && typeof x.op === 'string')) continue;
    used.push(block);
    for (const item of items) {
      const d = describeStep(item);
      if (d.problem) {
        problems.push(d.problem);
        continue;
      }
      if (!d.look && ++changes > MAX_CHANGES) {
        if (changes === MAX_CHANGES + 1) problems.push(`More than ${MAX_CHANGES} changes in one answer: the rest were left out`);
        continue;
      }
      steps.push(d);
    }
  }
  return { text: withoutBlocks(text, used), steps, problems };
}

/** While the answer streams: the words before the steps' block. */
export const wordsSoFar = (text) => wordsBefore(text, ['file-steps', 'json']);

const lf = (s) => String(s ?? '').replace(/\r\n?/g, '\n');
const count = (text, part) => {
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + 1)) n++;
  return n;
};
// "12\tcode" lines copied from a read's output: the numbers are not part of the file.
const withoutLineNumbers = (s) => (s.split('\n').every((l) => /^\s*\d+\t/.test(l)) ? s.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n') : null);

/**
 * An edit-file step's edits on `text` (the file as it is now): each `find` must be in it exactly
 * once, the finds must not overlap, and all refer to the text before the step (str_replace). →
 * { text (the new text), changes: [{ from, to, insert }] (by position, on the old text) } or
 * { error } naming the edit that did not fit. `whole` (a step's "text") replaces everything.
 */
export function applyEdits(text, edits = [], whole = null) {
  const base = lf(text);
  if (whole != null) {
    const next = lf(whole);
    return { text: next, changes: wholeChanges(base, next) };
  }
  const spans = [];
  for (let i = 0; i < edits.length; i++) {
    let find = lf(edits[i].find);
    const replace = lf(edits[i].replace);
    let n = count(base, find);
    if (n === 0) {
      const plain = withoutLineNumbers(find);
      if (plain && count(base, plain) === 1) {
        find = plain;
        n = 1;
      }
    }
    const label = edits.length > 1 ? `Edit ${i + 1}` : 'The edit';
    if (n === 0) return { error: `${label}: its "find" is not in the file as it is now (read the file again and copy it exactly)` };
    if (n > 1) return { error: `${label}: its "find" is in the file ${n} times; give more of the lines around it so it is found once` };
    const from = base.indexOf(find);
    spans.push({ from, to: from + find.length, insert: replace, index: i });
  }
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) return { error: `Edits ${spans[i - 1].index + 1} and ${spans[i].index + 1} overlap: make them one` };
  let next = '';
  let at = 0;
  for (const s of spans) {
    next += base.slice(at, s.from) + s.insert;
    at = s.to;
  }
  next += base.slice(at);
  return { text: next, changes: spans.map(({ from, to, insert }) => ({ from, to, insert })) };
}

/** The smallest change from `before` to `after` (one span: what is the same at both ends kept). */
export function wholeChanges(before, after) {
  if (before === after) return [];
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  return [{ from: start, to: before.length - end, insert: after.slice(start, after.length - end) }];
}

/** Changes ({ from, to, insert } on `text`) as a language server's edits (line, character). */
export function toLspEdits(text, changes) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const pos = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - starts[lo] };
  };
  return changes.map((c) => ({ range: { start: pos(c.from), end: pos(c.to) }, newText: c.insert }));
}

/**
 * The lines a change touches, for its card: [{ line (1-based, in the old text), before: [lines],
 * after: [lines] }], changes on the same lines together, at most `max` groups.
 */
export function diffRows(before, changes, { max = 40 } = {}) {
  const text = lf(before);
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineEnd = (n) => (n + 1 < starts.length ? starts[n + 1] - 1 : text.length);
  const groups = [];
  for (const c of [...changes].sort((a, b) => a.from - b.from)) {
    const first = lineOf(c.from);
    const last = lineOf(Math.max(c.from, c.to - (c.to > c.from && text[c.to - 1] === '\n' ? 1 : 0)));
    const prev = groups.at(-1);
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last);
      prev.changes.push(c);
    } else groups.push({ first, last, changes: [c] });
  }
  return groups.slice(0, max).map((g) => {
    const from = starts[g.first];
    const to = lineEnd(g.last);
    let after = '';
    let at = from;
    for (const c of g.changes) {
      after += text.slice(at, c.from) + c.insert;
      at = c.to;
    }
    after += text.slice(at, to);
    // Lines the same at both ends are not part of the change (a find that took whole lines along).
    const was = text.slice(from, to).split('\n');
    const now = after.split('\n');
    let head = 0;
    while (head < was.length && head < now.length && was[head] === now[head]) head++;
    let tail = 0;
    while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
    return { line: g.first + 1 + head, before: was.slice(head, was.length - tail), after: now.slice(head, now.length - tail) };
  });
}

const sizeText = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * A list of entries ({ rel, dir, size }, "/" between names) as an indented tree for the model,
 * at most `cap` lines; folders first, then files, by name.
 */
export function treeText(entries, { cap = LIST_ENTRIES, truncated = false } = {}) {
  const byRel = new Map();
  for (const e of entries) {
    const parts = e.rel.split('/');
    // The folders on the way (a list of files names them only through their paths).
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!byRel.has(dir)) byRel.set(dir, { rel: dir, dir: true });
    }
    byRel.set(e.rel, { ...byRel.get(e.rel), ...e });
  }
  const kids = new Map();
  for (const e of byRel.values()) {
    const parent = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(e);
  }
  for (const list of kids.values()) list.sort((a, b) => Number(Boolean(b.dir)) - Number(Boolean(a.dir)) || a.rel.localeCompare(b.rel));
  const lines = [];
  let more = 0;
  const walk = (parent, depth) => {
    for (const e of kids.get(parent) ?? []) {
      if (lines.length >= cap) {
        more++;
        continue;
      }
      const name = e.rel.slice(e.rel.lastIndexOf('/') + 1);
      lines.push(`${'  '.repeat(depth)}${name}${e.dir ? '/' : e.size != null ? ` · ${sizeText(e.size)}` : ''}${!e.dir && isSecretName(name) ? ' (secrets: never read)' : ''}`);
      if (e.dir) walk(e.rel, depth + 1);
    }
  };
  walk('', 0);
  if (!lines.length) return '(empty)';
  if (more || truncated) lines.push(`… and more (${more ? `${more} not shown` : 'the list was cut short'}: list a folder to see inside it)`);
  return lines.join('\n');
}

/** A file's text with its line numbers ("12\tcode"), lines `from`–`to`, at most `cap` characters. */
export function numbered(text, { from = 1, to = Infinity, cap = READ_CHARS } = {}) {
  const lines = lf(text).split('\n');
  const first = Math.max(1, from);
  const last = Math.min(lines.length, to);
  const out = [];
  let size = 0;
  for (let n = first; n <= last; n++) {
    const line = `${n}\t${lines[n - 1]}`;
    if (size + line.length > cap) {
      out.push(`… (cut here: ${last - n + 1} more line${last - n + 1 === 1 ? '' : 's'} up to ${last}; read on with "from": ${n})`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join('\n'), lines: lines.length };
}

/** Search results ([{ rel, matches: [{ line, preview }] }]) for the model, at most `cap` lines. */
export function searchText(files, { cap = SEARCH_LINES } = {}) {
  const lines = [];
  let more = 0;
  for (const f of files) {
    for (const m of f.matches ?? []) {
      if (lines.length >= cap) more++;
      else lines.push(`${f.rel}:${m.line}: ${String(m.preview ?? '').trim()}`);
    }
  }
  if (!lines.length) return 'Nothing found.';
  if (more) lines.push(`… and ${more} more`);
  return lines.join('\n');
}

const stepList = () =>
  Object.entries(STEPS)
    .map(([op, d]) => `- ${op} ${d.fields} — ${d.kind === 'look' ? 'looks' : d.kind === 'terminal' ? 'types it for the person' : d.danger ? 'asks first, with a warning' : 'asks first'}`)
    .join('\n');

/** The guide's section about this ("### The model makes and changes files"), for the system message. */
export function filesGuide(guide) {
  const lines = String(guide ?? '').split('\n');
  const out = [];
  let on = false;
  for (const line of lines) {
    if (/^#{1,3} /.test(line)) on = /^### The model makes and changes files/.test(line);
    if (on) out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * The system message: what the model is for, how to look and change, the rules. The same each
 * time (for one guide), so Claude caches it.
 */
export function filesSystem({ guide = '' } = {}) {
  return `You help someone work on their files in Tracker Editor, a text editor: you answer questions about the files and, when asked, create and change files and folders. Every question comes with a picture of the workspace: the base folder (everything you do happens inside it), the files in it, the file open in the editor (or the part selected) and the other tabs open in it.

To look further, or to change something, end your answer with ONE block like this:
\`\`\`file-steps
[{ "op": "read", "path": "src/app.js", "why": "see how the server starts" }]
\`\`\`
Each step is an object with "op", its fields and a short "why". Paths are relative to the base folder, with "/" between names: never absolute, never "..". Only these steps exist:
${stepList()}

How steps run:
- Looking steps (list, read, search) run at once and what they find comes back to you. Put them in a block of their own: changes in the same block are not run. You may look several times.
- Changes wait for the person: each shows as a card with a preview (a new file's text, the lines an edit changes) and Apply / Skip; they may Apply all. Then the results come back to you, with the files as they are now. Every change can be undone by the person.
- A terminal step only types the command in a terminal in the base folder; the person reads it and presses Enter. You never see its output unless they tell you.

Rules:
- Read a file before you edit it, unless all of its text is in the picture already. A read shows line numbers ("12<tab>code"); they are not part of the file: never put them in "find".
- Copy each "find" EXACTLY from the file as it is now (the same spaces and line breaks), with enough lines that it appears once. All finds of one edit-file refer to the file before that step and must not overlap; for many changes to a small file, give "text" (the whole new file) instead.
- Make small, focused changes that do what was asked, and say in a sentence what each one does and why. Keep the file's style and indentation.
- A new project: the folders first, then the files (configuration, then code, then a README), each one whole and working; then, when packages must be installed, one terminal step with the install command; say how to run it.
- Never read, write or show secrets: .env files, keys, certificates, credentials (the editor refuses them anyway; .env.example is fine). Never put real passwords or keys in files: use placeholders and say where they go.
- Commands only through the terminal step. Do not delete anything unless the person asked for it.
- Answer questions that need no change without a block. When the person only wants to know how, or the question is marked Explain only, explain it and list what they should do; do not propose changes to apply.
- When a step failed, read why in the results, look again if needed, and propose a fixed step.${guide ? `\n\nHow the editor shows this to the person (from its guide):\n${guide}` : ''}`;
}

/** Marked on a question when the person turned on Explain only. */
export const EXPLAIN_ONLY = '(Explain only: tell me how to do it myself; do not propose changes to apply.)';

/**
 * The picture of the workspace for one turn: `base` ({ name, where }), `tree` (treeText's text),
 * `file` ({ rel, text, selection: { from, to } (lines) | null }), `tabs` (paths open in it), `kind`
 * ('folder' or 'notes': synced notes have names, no folders), `note` (anything else to say).
 */
export function workspaceText({ base, tree, file = null, tabs = [], kind = 'folder', note = '' }) {
  const out = [`Base folder: ${base.name}${base.where ? ` (${base.where})` : ''}`];
  if (kind === 'notes') out.push('These are synced notes: each has a name (no folders); create-folder, rename, delete and terminal steps do not apply here.');
  out.push(`Files (folders like .git and node_modules left out):\n${tree}`);
  if (file) {
    const body = numbered(file.text, { cap: CONTEXT_CHARS });
    const sel = file.selection ? `, the part selected is lines ${file.selection.from}–${file.selection.to}` : '';
    out.push(`Open in the editor: ${file.rel}${sel} (${body.lines} lines)\n<file path="${file.rel}">\n${body.text}\n</file>`);
  }
  if (tabs.length) out.push(`Other tabs open here: ${tabs.slice(0, 30).join(', ')}`);
  if (note) out.push(note);
  return `<workspace>\n${out.join('\n\n')}\n</workspace>`;
}

/**
 * The messages for one turn: the system, the turns so far, then the question (or the results of
 * the steps) with the picture of the workspace when given.
 */
export function filesMessages(content, workspace, history = [], { explainOnly = false, guide = '' } = {}) {
  return [
    { role: 'system', content: filesSystem({ guide }) },
    ...history,
    { role: 'user', content: `${content}${explainOnly ? `\n\n${EXPLAIN_ONLY}` : ''}${workspace ? `\n\n${workspace}` : ''}` },
  ];
}

/** What came of the steps ([{ text, outcome, output }]), for the model's next turn. */
export function resultsMessage(results) {
  const words = { ok: 'done', failed: 'FAILED', skipped: 'skipped by the person', stopped: 'not done (stopped before it)', shown: 'shown to the person (Explain only)', typed: 'typed in the terminal for the person to run', undone: 'done, then undone by the person' };
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.text} — ${words[r.outcome] ?? r.outcome}`;
    const body = String(r.output ?? '').trim();
    return body ? `${head}\n\`\`\`\n${body.length > READ_CHARS ? `${body.slice(0, READ_CHARS)}\n…` : body}\n\`\`\`` : head;
  });
  return `Results of the steps:\n${lines.join('\n')}`;
}
