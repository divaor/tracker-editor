// Help with the editor itself from the model (the ✦ panel's "Help with the editor", and
// questions about the editor asked there): the guide (help/guide.md) goes with the question,
// whole for an AI provider (in the system message, the same each time, so it is cached), or
// the passages that fit for a model on this computer, plus the commands that fit with their
// keys, so the answer says what the editor really does. Without a model, the passages are the
// answer. Pure: the tests import it.
import { COMMAND_LIST, keysFor } from './commands.js';

export const HELP_GROUP = { id: 'help', label: 'Help with the editor' };

/** The help actions in the panel; `{param}` is what the person types. `trouble` favors Troubleshooting. */
export const HELP_ACTIONS = [
  {
    id: 'help-how', group: 'help', label: 'How do I…?', icon: 'help', kind: 'help',
    param: { label: 'What do you want to do?', placeholder: 'e.g. compare two files · edit a file on a server · fold every function' },
    prompt: 'How do I {param} in Tracker Editor?',
  },
  {
    id: 'help-keys', group: 'help', label: 'Keys for…', icon: 'keyboard', kind: 'help',
    param: { label: 'Which command?', placeholder: 'e.g. split view · select a column · format the document' },
    prompt: 'What are the keys (or the menu) for: {param}?',
  },
  {
    id: 'help-trouble', group: 'help', label: 'Something isn’t working…', icon: 'alert', kind: 'help',
    param: { label: 'What happens?', placeholder: 'e.g. the language server says nothing · typing into another window drops letters' },
    prompt: 'In Tracker Editor: {param}. What is wrong and what can I do?',
    trouble: true,
  },
  { id: 'help-file', group: 'help', label: 'What can I do with this file?', icon: 'file', kind: 'help', prompt: '' },
];

/** The question "What can I do with this file?" asks, for the open file. */
export function fileQuestion({ name = '', language = '' } = {}) {
  const what = language ? `a ${language} file` : 'this kind of file';
  return `What can I do with ${what}${name ? ` (${name})` : ''} in Tracker Editor: its preview, formatting, checks, code tools and anything else made for it?`;
}

// Questions about the editor (as opposed to the text open in it), for the panel's free box.
const ABOUT_EDITOR = /\b(tracker editor|this editor|the editor|this app|the app|shortcuts?|hot ?keys?|keyboard|key ?bindings?|settings?|preferences|menu|toolbar|status bar|sidebar|tab bar|command palette)\b/i;
const HOW_TO = /^\s*(how (do|can|could|would|should) (i|you|we)|how to|where (is|are|do|can|does)|is there (a|any) way|can i|is it possible)\b/i;
const ABOUT_TEXT = /\b(this|it|these|them|that|those)\b/i;

/** Whether a free question is about using the editor ("how do I split the view?") rather than about the text. */
export function looksLikeEditorQuestion(question) {
  const q = String(question ?? '');
  return ABOUT_EDITOR.test(q) || (HOW_TO.test(q) && !ABOUT_TEXT.test(q));
}

const STOP = new Set(
  'a an the to of in on for and or is are was it its i im my me we us do does did can could would should how what where when why which who there this that these those with from by at as be been way use using want like get make editor tracker app please help some any all one not no yes you your into out up about just so if then than but also will have has more most only other own same such too very own need'.split(' '),
);
// Words people use for what the guide names otherwise.
const ALIASES = {
  shortcut: ['keys'], hotkey: ['keys'], keybinding: ['keys'], screen: ['view'], ssh: ['sftp', 'server'], ftp: ['ftp', 'server'], remote: ['server'],
  delete: ['trash', 'delete'], remove: ['trash', 'remove', 'delete'], erase: ['delete'], search: ['find'], lookup: ['find'], locate: ['find'],
  ai: ['model'], llm: ['model'], chatgpt: ['model'], gpt: ['model'], ollama: ['ollama', 'model'], copilot: ['suggest'], autocomplete: ['completion', 'suggest'],
  backup: ['history', 'backup'], restore: ['restore', 'history', 'trash'], revert: ['history', 'restore'], password: ['password', 'passphrase'],
  letter: ['character'], ocr: ['image', 'screenshot'], dictate: ['voice', 'dictat'], speak: ['read aloud', 'listen'], tts: ['read aloud'], split: ['split', 'side'],
  rename: ['rename', 'f2'], tail: ['follow', 'tail'], log: ['log', 'follow', 'filter'], prettify: ['format'], beautify: ['format'], indent: ['indent'],
  multicursor: ['cursor'], multiline: ['cursor', 'column'], rectangular: ['column'], block: ['column'], dark: ['theme'], theme: ['theme', 'appearance'],
};

const stem = (w) => (w.length > 4 ? w.replace(/(ings?|ed|es|s)$/, '') : w);

/** The words of a question to look for, each with the forms it may take in the guide. */
export function queryTerms(question) {
  const words = String(question ?? '')
    .toLowerCase()
    .replace(/[`'’"()[\]{}<>?!.,;:]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && (w.length > 2 || /^f\d+$|^[a-z]\d$/.test(w)));
  return [...new Set(words)].map((w) => [...new Set([stem(w), ...(ALIASES[w] ?? ALIASES[stem(w)] ?? [])])]);
}

/** A Markdown table's separator line for its header row. */
const separatorFor = (head) => `|${' --- |'.repeat(Math.max(1, head.split('|').length - 2))}`;

/**
 * The guide in small passages, each with the heading it is under: paragraphs, list items and
 * table rows (with the table's header: `head`), so a question finds the line that answers it.
 */
export function guideChunks(guide) {
  const chunks = [];
  let h2 = '';
  let h3 = '';
  let block = [];
  let tableHead = '';
  // `body` is what a question is matched against (a table row without its header).
  const flush = (head = '') => {
    const body = block.join('\n').trim();
    if (body) chunks.push({ section: h3 ? `${h2} › ${h3}` : h2, text: head ? `${head}\n${separatorFor(head)}\n${body}` : body, body, head, index: chunks.length });
    block = [];
  };
  for (const line of String(guide ?? '').split('\n')) {
    const heading = /^(#{2,3}) (.+)/.exec(line);
    if (heading) {
      flush();
      tableHead = '';
      if (heading[1] === '##') (h2 = heading[2].trim()), (h3 = '');
      else h3 = heading[2].trim();
      continue;
    }
    if (/^#\s|^---\s*$/.test(line)) continue;
    if (!line.trim()) {
      flush();
      tableHead = '';
      continue;
    }
    // A table: its header goes with each row.
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      flush();
      if (!tableHead) tableHead = line.trim();
      else block.push(line.trim()), flush(tableHead);
      continue;
    }
    // A list item starts a passage of its own (its indented lines stay with it).
    if (/^\s{0,1}[-*] |^\d+\. /.test(line)) flush();
    block.push(line);
  }
  flush();
  return chunks;
}

/**
 * How well a passage fits: each word found counts by how rare it is in the guide (`weight`:
 * "column" says more than "file"), more in the heading; passages with several of the words win.
 */
function scoreOf(text, title, terms, weight = () => 1) {
  const body = text.toLowerCase();
  const head = title.toLowerCase();
  let score = 0;
  let distinct = 0;
  for (const forms of terms) {
    let best = 0;
    for (const f of forms) {
      const count = body.split(f).length - 1;
      const s = weight(f) * ((count ? 1 + Math.min(count - 1, 2) * 0.4 : 0) + (head.includes(f) ? 1 : 0));
      best = Math.max(best, s);
    }
    if (best) (score += best), distinct++;
  }
  // Long passages match words by chance: a little less for them.
  const scaled = score / (1 + text.length / 2500);
  return distinct > 1 ? scaled * (1 + 0.5 * (distinct - 1)) : scaled;
}

/** How rare each word is among the passages (inverse document frequency). */
function rarity(chunks) {
  const texts = chunks.map((c) => `${c.section}\n${c.body ?? c.text}`.toLowerCase());
  const cache = new Map();
  return (f) => {
    if (!cache.has(f)) {
      const df = texts.reduce((n, t) => n + (t.includes(f) ? 1 : 0), 0);
      cache.set(f, Math.log((texts.length + 1) / (df + 1)) + 0.1);
    }
    return cache.get(f);
  };
}

/** The passages that fit the terms, best first ({ c, s }); `trouble` favors the Troubleshooting section. */
export function rankChunks(terms, chunks, { trouble = false } = {}) {
  const weight = rarity(chunks);
  const boost = (c) => (trouble && /troubleshooting/i.test(c.section) ? 1.8 : 1);
  return chunks
    .map((c) => ({ c, s: scoreOf(c.body ?? c.text, c.section, terms, weight) * boost(c) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
}

/**
 * The guide's passages that fit `question`, best first but within `budget` characters, in the
 * guide's order, under their headings (Markdown). '' when nothing fits.
 */
export function guideExcerpts(question, guide, { budget = 8000, chunks = guideChunks(guide), trouble = false } = {}) {
  const terms = queryTerms(question);
  if (!terms.length) return '';
  const ranked = rankChunks(terms, chunks, { trouble });
  const picked = new Map();
  const headed = new Set();
  let used = 0;
  // Each passage counts with the heading it brings.
  const take = (c) => {
    const cost = c.text.length + 2 + (headed.has(c.section) ? 0 : c.section.length + 6);
    if (picked.has(c.index) || used + cost > budget) return;
    picked.set(c.index, c);
    headed.add(c.section);
    used += cost;
  };
  ranked.forEach((r, i) => {
    // The line that introduces one of the best matches' list ("…:") says what it is about.
    const before = chunks[r.c.index - 1];
    if (i < 4 && before && before.section === r.c.section && before.text.length < 400 && /:\s*$/.test(before.text)) take(before);
    take(r.c);
  });
  // Under their headings, the section with the best match first, and in each the best first
  // (a list's intro before it); rows of one table that follow each other under its header once.
  const rank = new Map(ranked.map((r, i) => [r.c.index, i]));
  const sections = new Map();
  for (const c of picked.values()) {
    const s = sections.get(c.section) ?? { best: Infinity, chunks: [] };
    s.best = Math.min(s.best, rank.get(c.index) ?? Infinity);
    s.chunks.push(c);
    sections.set(c.section, s);
  }
  let out = '';
  for (const [section, { chunks: list }] of [...sections].sort((a, b) => a[1].best - b[1].best)) {
    out += `\n\n### ${section}`;
    let lastHead = '';
    for (const c of list) {
      out += c.head && c.head === lastHead ? `\n${c.body}` : `\n\n${c.text}`;
      lastHead = c.head;
    }
  }
  return out.trim();
}

/** The commands that fit `question`, with their keys on this computer ("- Split view on or off: Ctrl+\"). */
export function commandLines(question, { desktop = false, mac = false, max = 12, list = COMMAND_LIST } = {}) {
  const terms = queryTerms(question);
  if (!terms.length) return '';
  return list
    .filter((c) => desktop || c.only !== 'desktop')
    .map((c) => ({ c, s: scoreOf(`${c.label} ${c.hint ?? ''} ${c.group}`, c.label, terms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map(({ c }) => {
      const keys = keysFor(c, { mac, desktop });
      return `- ${c.label}${keys ? `: ${keys}` : ''}${c.hint ? ` (${c.hint})` : ''}${c.only === 'desktop' ? ' [desktop app]' : ''}`;
    })
    .join('\n');
}

/**
 * What goes with a help question: the whole guide (`whole`, for a model that takes it all) or the
 * passages that fit within `budget` characters, the commands that fit, and where the person is.
 */
export function helpContext(question, guide, { whole = false, desktop = false, mac = false, budget = 8000, name = '', language = '', version = '', trouble = false } = {}) {
  const text = String(guide ?? '').trim();
  return {
    guide: whole ? text : '',
    excerpts: whole ? '' : guideExcerpts(question, text, { budget, trouble }),
    commands: commandLines(question, { desktop, mac }),
    desktop,
    mac,
    name,
    language,
    version,
  };
}

function whereLine({ desktop, mac, name, language }) {
  const parts = [desktop ? 'in the desktop app' : 'in the web app (a browser or the phone)'];
  if (mac) parts.push('on a Mac');
  if (name) parts.push(`with ${name}${language ? ` (${language})` : ''} open`);
  return `I am ${parts.join(', ')}.`;
}

const guideTitle = (ctx) => `the Tracker Editor guide${ctx.version ? ` (version ${ctx.version})` : ''}`;

/**
 * The question as it is sent: where the person is, the passages (unless the whole guide goes in
 * the system message) and the commands that fit.
 */
export function helpPrompt(question, ctx) {
  const parts = [question, whereLine(ctx)];
  if (!ctx.guide) parts.push(ctx.excerpts ? `From ${guideTitle(ctx)}:\n<<<\n${ctx.excerpts}\n>>>` : 'The guide has nothing that matches the question.');
  if (ctx.commands) parts.push(`Commands that may fit, with their keys here:\n${ctx.commands}`);
  return parts.join('\n\n');
}

/**
 * The chat for a help question. The whole guide, when it goes, is in the system message, which
 * stays the same from one question to the next (so it is cached); `history` holds the answers
 * and follow-ups since.
 */
export function helpMessages(question, ctx, history = []) {
  const keys = ctx.mac ? 'macOS (Cmd, Option)' : 'Windows and Linux (Ctrl, Alt)';
  const from = ctx.guide ? 'the guide below (every feature, setting and fix, with Troubleshooting near the end)' : 'the guide passages';
  const system =
    `You help people use Tracker Editor, a text and code editor (a desktop app and a web app). Answer from ${from} and the commands given with the question: the exact menu, button, setting or keys, as short numbered steps when there are several. Give keys as on ${keys}; say when something works only in the desktop app. ` +
    `If ${ctx.guide ? 'the guide does' : 'the passages do'} not cover it, say so plainly and point to the closest thing ${ctx.guide ? 'it mentions' : 'they mention'}, or to Help (F1); never invent a feature, a menu or a key. Be brief; use Markdown; answer in the language of the question (the names of menus and buttons as the guide gives them).` +
    (ctx.guide ? `\n\n${guideTitle(ctx).replace(/^t/, 'T')}:\n<<<\n${ctx.guide}\n>>>` : '');
  return [{ role: 'system', content: system }, { role: 'user', content: helpPrompt(question, ctx) }, ...history];
}

/** Without a model: the passages themselves, as the answer to show. */
export function excerptsAnswer(ctx) {
  if (!ctx.excerpts && !ctx.commands) return 'Nothing in the guide matches that. Try other words, or open Help (F1) to browse it.';
  return [ctx.excerpts && `From the guide:\n\n${ctx.excerpts.replace(/^### /gm, '#### ')}`, ctx.commands && `Commands:\n\n${ctx.commands}`].filter(Boolean).join('\n\n');
}
