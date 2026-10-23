// Help from the model with errors: the problems the editor found (Problems, the underlines),
// and errors in program output (the terminal, a pasted stack trace). Also the question handed
// to the Claude app, for people who use Claude with their subscription there. Pure: the
// tests import it; app.js and the model panel use it.

/** The problems as lines for a prompt: "- line 3, column 5 (error): Missing ;". */
export function problemsList(problems) {
  return problems.map((p) => `- line ${p.line}, column ${p.column} (${p.severity}): ${p.message}`).join('\n');
}

/** A 'replace' action that fixes the problems the editor found in the file, nothing else. */
export function fixProblemsAction(problems) {
  const n = problems.length;
  return {
    id: 'fix-problems',
    label: `Fix ${n === 1 ? 'the problem' : `${n} problems`}`,
    kind: 'replace',
    prompt: `The editor found ${n === 1 ? 'this problem' : 'these problems'} in the file:\n${problemsList(problems)}\n\nFix ${n === 1 ? 'it' : 'them'}, and change nothing else.`,
  };
}

/** An 'answer' action that explains one problem and how to fix it. */
export function explainProblemAction(problem) {
  return {
    id: 'explain-problem',
    label: 'Explain this problem',
    kind: 'answer',
    prompt: `The editor shows this problem at line ${problem.line}, column ${problem.column}: "${problem.message}". Explain what is wrong in plain words and how to fix it. End with the corrected lines in one code block.`,
  };
}

/** The 'answer' action for an error in output: what went wrong, why, and the fix. */
export const EXPLAIN_ERROR = {
  id: 'error',
  label: 'Explain the error',
  kind: 'answer',
  prompt:
    'This is an error from a program: a message, a stack trace or console output, with the code it points to when there is some. Explain what went wrong and why, in plain words, then how to fix it. When the cause is in the code shown, end with the corrected code in one code block.',
};

/** The 'replace' action that fixes a file for an error seen in its output. */
export function fixForErrorAction(errorText) {
  return {
    id: 'fix-error',
    label: 'Fix the cause of the error',
    kind: 'replace',
    prompt: `Running it gave this error:\n<<<\n${errorText.slice(-4000)}\n>>>\nFix the cause in the file, and change nothing else.`,
  };
}

const PROMPT_LINE = /^\s*(?:\(\w+\)\s*)?[\w.@~:/\\ -]{0,80}[$#>%❯]\s*$/;

/**
 * The part of a terminal worth asking about: the last `max` lines that have something, without
 * the shell's prompt waiting at the end.
 */
export function outputTail(lines, max = 80) {
  const out = [...lines];
  while (out.length && (!out.at(-1).trim() || PROMPT_LINE.test(out.at(-1)))) out.pop();
  return out.slice(-max).join('\n').replace(/[ \t]+$/gm, '');
}

/** Lines `line` ± `radius` of a text, numbered ("12 | code"), the line itself marked with ">". */
export function codeAround(text, line, radius = 6) {
  const lines = String(text).split('\n');
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n === line ? '>' : ' '}${String(n).padStart(width)} | ${lines[n - 1]}`);
  return out.join('\n');
}

/**
 * The text for the model about an error in output: the output, then the code around each
 * place it names (`snippets`: [{ path, line, code }]).
 */
export function errorContextText(output, snippets = []) {
  const parts = [`Output:\n${output}`];
  for (const s of snippets) parts.push(`${s.path}, around line ${s.line}:\n${s.code}`);
  return parts.join('\n\n');
}

const MAX_HANDOFF = 12000;

/**
 * The question for the Claude app: what to do, then the text. For one of the editor's synced
 * files (`editorFile`, its name), Claude can read it and save the fix back through the
 * Tracker connector, when it is connected there.
 */
export function claudeAppPrompt({ action, context, editorFile = '' }) {
  const what = !context ? '' : context.whole ? `the file ${context.name || 'I have open'}` : context.name ? `a part of ${context.name}` : 'this';
  const text = context?.text ?? '';
  const body = text.length > MAX_HANDOFF ? `${text.slice(0, MAX_HANDOFF)}\n[… ${text.length - MAX_HANDOFF} more characters]` : text;
  const fence = body.includes('```') ? '~~~' : '```';
  const parts = [action?.prompt || 'Help me with this.'];
  if (body) parts.push(`It is ${what}${context.language ? ` (${context.language})` : ''}:\n${fence}\n${body}\n${fence}`);
  if (editorFile) parts.push(`This is my Tracker Editor file "${editorFile}". If you have my Tracker connector, you can read it with read_editor_file and save the fixed version with save_editor_file.`);
  return parts.join('\n\n');
}

/** Where to open it: a new chat with the question filled in when it is short enough for a link. */
export function claudeAppUrl(prompt) {
  return prompt.length <= 3500 ? `https://claude.ai/new?q=${encodeURIComponent(prompt)}` : 'https://claude.ai/new';
}
