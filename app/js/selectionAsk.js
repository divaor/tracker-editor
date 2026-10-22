// Asking the model about the selection (Ctrl+K): quick actions that either
// answer (explain) or propose a replacement for the text (rewrite, fix,
// translate…). Pure, so the Node tests can import it.

/** kind 'answer' shows a reply; 'replace' proposes new text for the selection, shown as a diff. */
export const SELECTION_ACTIONS = [
  { id: 'explain', label: 'Explain', icon: 'sparkle', kind: 'answer', prompt: 'Explain what this is and what it does, briefly and concretely.' },
  { id: 'fix', label: 'Fix mistakes', icon: 'check', kind: 'replace', prompt: 'Fix mistakes: spelling and grammar in prose, errors in code. Change nothing else.' },
  { id: 'rewrite', label: 'Rewrite clearly', icon: 'edit', kind: 'replace', prompt: 'Rewrite it to be clearer and more concise. Keep the meaning, the language and any formatting (Markdown, lists, code).' },
  { id: 'shorten', label: 'Shorten', icon: 'replace', kind: 'replace', prompt: 'Make it about half as long, keeping what matters. Keep the language and formatting.' },
  { id: 'format', label: 'Tidy / format', icon: 'code', kind: 'replace', prompt: 'Format it neatly: indentation, line breaks and alignment for its kind of text (SQL, JSON, code, a list…). Do not change what it says or does.' },
  { id: 'english', label: 'To English', icon: 'chat', kind: 'replace', prompt: 'Translate it into English. Keep the formatting; leave code, names and commands as they are.' },
  { id: 'spanish', label: 'To Spanish', icon: 'chat', kind: 'replace', prompt: 'Translate it into Spanish. Keep the formatting; leave code, names and commands as they are.' },
];

const MAX_CHARS = 16000;

/**
 * The chat messages for an action ({ kind, prompt }) or a custom instruction
 * on `text`, from the file `name` (in `language`, when known).
 */
export function selectionMessages({ kind, prompt }, { text, name = '', language = '', whole = false }) {
  const what = whole ? `the file ${name}` : `a part of the file ${name}`;
  const system =
    kind === 'replace'
      ? 'You edit text for the user. Reply with ONLY the new version of the text: no explanations, no introduction, no quotes, and no code fences unless the text itself has them.'
      : 'You help the user understand text from their editor. Be concise and concrete; use Markdown.';
  const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… cut: ${text.length - MAX_CHARS} more characters]` : text;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${prompt}\n\nThe text is ${what}${language ? ` (${language})` : ''}:\n<<<\n${body}\n>>>` },
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
