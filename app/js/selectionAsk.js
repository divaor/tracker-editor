// Asking the model about the open file or the selection (the model bubble,
// Ctrl+K): actions that either answer (explain, check the syntax…) or propose
// new text (fix, convert, translate…), plus free questions and follow-ups.
// Pure, so the Node tests can import it.
import { EXPLAIN_ERROR } from './errorHelp.js';

export const ACTION_GROUPS = [
  { id: 'understand', label: 'Understand' },
  { id: 'edit', label: 'Edit' },
  { id: 'format', label: 'Format and convert' },
  { id: 'code', label: 'Code and queries' },
  { id: 'translate', label: 'Translate' },
];

/**
 * kind 'answer' shows a reply; 'replace' proposes new text for the selection
 * (or the file), shown as a comparison. An action with `param` asks for one
 * value first (a format, a language, what to change), which fills {param}.
 */
export const SELECTION_ACTIONS = [
  { id: 'explain', group: 'understand', label: 'Explain', icon: 'sparkle', kind: 'answer', prompt: 'Explain what this is and what it does, briefly and concretely.' },
  { id: 'summarize', group: 'understand', label: 'Summarize', icon: 'list', kind: 'answer', prompt: 'Summarize it in a few bullet points: what matters, decisions, numbers and dates.' },
  { id: 'tasks', group: 'understand', label: 'Action items', icon: 'checklist', kind: 'answer', prompt: 'List the action items in it as a Markdown checklist ("- [ ] …"), with who and when where it says so. Only what it says; if there are none, say so.' },

  { id: 'fix', group: 'edit', label: 'Fix mistakes', icon: 'check', kind: 'replace', prompt: 'Fix mistakes: spelling and grammar in prose, errors in code. Change nothing else.' },
  { id: 'rewrite', group: 'edit', label: 'Rewrite clearly', icon: 'edit', kind: 'replace', prompt: 'Rewrite it to be clearer and more concise. Keep the meaning, the language and any formatting (Markdown, lists, code).' },
  { id: 'shorten', group: 'edit', label: 'Shorten', icon: 'replace', kind: 'replace', prompt: 'Make it about half as long, keeping what matters. Keep the language and formatting.' },
  { id: 'expand', group: 'edit', label: 'Expand', icon: 'plus', kind: 'replace', prompt: 'Expand it with more detail where it is thin. Keep the language, the tone and the formatting, and do not invent facts.' },
  {
    id: 'tone', group: 'edit', label: 'Change the tone…', icon: 'chat', kind: 'replace',
    param: { label: 'Tone', options: ['More formal', 'Friendlier', 'More direct', 'For an email to a client', 'Simpler words'] },
    prompt: 'Rewrite it in this tone: {param}. Keep the meaning, the language and the formatting.',
  },
  {
    id: 'replace', group: 'edit', label: 'Advanced replace…', icon: 'replace', kind: 'replace',
    param: { label: 'What to change', placeholder: 'e.g. every date to YYYY-MM-DD · rename userId to customerId outside strings · prices +10%' },
    prompt: 'Make this change everywhere it applies in the text, and change nothing else: {param}',
  },

  { id: 'format', group: 'format', label: 'Tidy / format', icon: 'code', kind: 'replace', prompt: 'Format it neatly: indentation, line breaks and alignment for its kind of text (SQL, JSON, code, a list…). Do not change what it says or does.' },
  { id: 'markdown', group: 'format', label: 'Make it Markdown', icon: 'doc', kind: 'replace', ext: 'md', prompt: 'Turn this text into well-formatted Markdown: headings, lists, tables, emphasis and code blocks where they fit. Keep all of the content and its language; add and remove nothing.' },
  {
    id: 'convert', group: 'format', label: 'Convert to…', icon: 'columns', kind: 'replace',
    param: { label: 'Format', options: ['JSON', 'YAML', 'CSV', 'Markdown table', 'XML', 'HTML', 'a bullet list', 'SQL INSERT statements'] },
    prompt: 'Convert it into {param}. Keep all of the data.',
  },

  { ...EXPLAIN_ERROR, group: 'code', label: 'Explain an error', icon: 'xCircle' },
  { id: 'syntax', group: 'code', label: 'Check the syntax', icon: 'check', kind: 'answer', prompt: 'Check its syntax. List each problem with its line and how to fix it; if it is valid, say so in one line. If there were problems, end with the whole corrected version in one code block.' },
  { id: 'review', group: 'code', label: 'Find problems', icon: 'alert', kind: 'answer', prompt: 'Review it for bugs, risks and edge cases (for a query: wrong results and slow parts). Be specific: the line, the problem and the fix.' },
  { id: 'comment', group: 'code', label: 'Add comments', icon: 'edit', kind: 'replace', prompt: 'Add short comments that explain the parts that are not obvious, in the comment syntax of its language. Change nothing else.' },
  { id: 'optimize', group: 'code', label: 'Optimize', icon: 'sparkle', kind: 'replace', prompt: 'Make it faster or simpler without changing what it does or returns. Keep its style.' },
  {
    id: 'rewrite-in', group: 'code', label: 'Rewrite in…', icon: 'code', kind: 'replace',
    param: { label: 'Language', options: ['Python', 'JavaScript', 'TypeScript', 'PowerShell', 'Bash', 'C#', 'SQL Server (T-SQL)', 'PostgreSQL', 'MySQL', 'Oracle SQL'] },
    prompt: 'Rewrite it in {param}, doing the same thing.',
  },
  {
    id: 'regex', group: 'code', label: 'Write a regex…', icon: 'search', kind: 'answer',
    param: { label: 'What it should match', placeholder: 'e.g. the order numbers like ORD-12345' },
    prompt: 'Write a regular expression that matches {param} in text like this. Give the expression in a code block, explain it briefly and list what it matches here.',
  },

  { id: 'english', group: 'translate', label: 'To English', icon: 'chat', kind: 'replace', prompt: 'Translate it into English. Keep the formatting; leave code, names and commands as they are.' },
  { id: 'spanish', group: 'translate', label: 'To Spanish', icon: 'chat', kind: 'replace', prompt: 'Translate it into Spanish. Keep the formatting; leave code, names and commands as they are.' },
  {
    id: 'translate', group: 'translate', label: 'To another language…', icon: 'chat', kind: 'replace',
    param: { label: 'Language', options: ['Portuguese', 'French', 'German', 'Italian', 'Chinese', 'Japanese'] },
    prompt: 'Translate it into {param}. Keep the formatting; leave code, names and commands as they are.',
  },
];

/** The action with its {param} filled in (and remembered, for labels and file names). */
export function withParam(action, param) {
  if (!action.param) return action;
  const value = String(param ?? '').trim();
  return { ...action, value, prompt: action.prompt.replaceAll('{param}', value), label: `${action.label.replace(/…$/, '')} ${value}`.trim() };
}

const MAX_CHARS = 16000;

/**
 * The chat messages for an action ({ kind, prompt }) or a custom instruction
 * on `text`, from the file `name` (in `language`, when known). `history` holds
 * the follow-up questions and answers that came after the first reply.
 */
export function selectionMessages({ kind, prompt }, { text, name = '', language = '', whole = false }, history = []) {
  const what = whole ? `the file ${name}` : `a part of the file ${name}`;
  const system =
    kind === 'replace'
      ? 'You edit text for the user. Reply with ONLY the new version of the text: no explanations, no introduction, no quotes, and no code fences unless the text itself has them.'
      : 'You help the user with text from their editor. Be concise and concrete; use Markdown.';
  const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… cut: ${text.length - MAX_CHARS} more characters]` : text;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${prompt}\n\nThe text is ${what}${language ? ` (${language})` : ''}:\n<<<\n${body}\n>>>` },
    ...history,
  ];
}

/**
 * The model's proposed replacement, cleaned: code fences it added around the
 * whole reply are removed, and the original's trailing line break is kept.
 */
export function cleanReplacement(reply, original) {
  let out = String(reply ?? '').replace(/^\s*\n/, '').replace(/\s+$/, '');
  const fenced = /^```[\w+-]*\n([\s\S]*?)\n```$/.exec(out);
  if (fenced && !original.trimStart().startsWith('```')) out = fenced[1];
  // "Here is the text:" before the text itself.
  out = out.replace(/^(?:here(?:'s| is) (?:the|a|your) [^\n:]{0,40}:|aquí (?:está|tienes) [^\n:]{0,40}:)\s*\n/i, '');
  const trailing = /\n+$/.exec(original)?.[0] ?? '';
  return out + trailing;
}

/** The last fenced code block in an answer (e.g. the corrected query), or ''. */
export function lastCodeBlock(answer) {
  const blocks = [...String(answer ?? '').matchAll(/```[\w+#-]*\n([\s\S]*?)\n```/g)];
  return blocks.length ? blocks.at(-1)[1] : '';
}

const EXTENSIONS = {
  json: 'json', yaml: 'yaml', csv: 'csv', 'markdown table': 'md', xml: 'xml', html: 'html', 'a bullet list': 'md', 'sql insert statements': 'sql',
  python: 'py', javascript: 'js', typescript: 'ts', powershell: 'ps1', bash: 'sh', 'c#': 'cs', 'sql server (t-sql)': 'sql', postgresql: 'sql', mysql: 'sql', 'oracle sql': 'sql',
};

/** The extension a result should have as a new file ('' to keep the original's). */
export const resultExtension = (action) => action.ext ?? EXTENSIONS[String(action.value ?? '').toLowerCase()] ?? '';
