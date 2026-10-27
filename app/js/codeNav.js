// Finding your way in one code file, without a language server: the name at the
// cursor, where it is declared (by how declarations are written in most languages)
// and where it is used. Pure, so the Node tests can import it.

import { WORD_CHARS } from './search.js';

const NAME_CHAR = new RegExp(`[${WORD_CHARS}_$]`, 'u');
// In CSS, YAML, shell and the like names have dashes too: a name with one keeps them.
const NAME_CHAR_DASH = new RegExp(`[${WORD_CHARS}_$-]`, 'u');

/** The name at `pos` (or just before it): { word, from, to }, or null on spaces and symbols. */
export function wordAt(text, pos, { dashes = false } = {}) {
  const isName = (ch) => (dashes ? NAME_CHAR_DASH : NAME_CHAR).test(ch ?? '');
  let from = pos;
  let to = pos;
  while (from > 0 && isName(text[from - 1])) from--;
  while (to < text.length && isName(text[to])) to++;
  // A dash at either end is punctuation, not part of the name.
  while (dashes && text[from] === '-' && from < to) from++;
  while (dashes && text[to - 1] === '-' && to > from) to--;
  const word = text.slice(from, to);
  return word && !/^\d/.test(word) ? { word, from, to } : null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every place `word` appears as a whole name (case matters): [{ from, to, line, column,
 * text }] with `text` the line it is on. At most `limit`.
 */
export function occurrences(text, word, { limit = 5000 } = {}) {
  if (!word) return [];
  const edge = word.includes('-') ? `[${WORD_CHARS}_$-]` : `[${WORD_CHARS}_$]`;
  const re = new RegExp(`(?<!${edge})${escapeRe(word)}(?!${edge})`, 'gu');
  const out = [];
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const m of text.matchAll(re)) {
    // Line numbers counted as the matches go.
    for (let i = text.indexOf('\n', scanned); i !== -1 && i < m.index; i = text.indexOf('\n', i + 1)) {
      line++;
      lineStart = i + 1;
    }
    scanned = m.index;
    const lineEnd = text.indexOf('\n', m.index);
    out.push({ from: m.index, to: m.index + word.length, line, column: m.index - lineStart + 1, text: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd) });
    if (out.length >= limit) break;
  }
  return out;
}

// What comes right before a declared name, in most languages.
const KEYWORD_BEFORE =
  /(?:^|[^\w$.])(?:function\*?|class|def|fn|func|fun|sub|procedure|proc|interface|type|typedef|enum|struct|union|trait|impl|module|namespace|record|macro|let|const|var|val|local|my|our|alias|package|object|extends\s+\w+\s+as|import|as|in\s+\w+\s+as)\s+[&*]*$/i;
const GO_METHOD = /\bfunc\s*\([^)]*\)\s*$/;
const SQL_BEFORE = /\b(?:create|alter)\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:table|view|procedure|proc|function|trigger|index|schema|type|sequence)\s+(?:if\s+not\s+exists\s+)?(?:[\w"`[\]]+\.)?["`[]?$/i;
// Words that come before a name without declaring it.
const NOT_TYPES = new Set(['return', 'new', 'else', 'throw', 'await', 'yield', 'case', 'in', 'of', 'typeof', 'instanceof', 'delete', 'echo', 'print', 'not', 'and', 'or', 'is', 'goto', 'using', 'go', 'defer', 'select', 'from', 'where', 'when', 'then', 'do', 'if', 'while', 'for', 'elif', 'raise', 'assert', 'with', 'export', 'default', 'public', 'private', 'protected', 'static']);
const MODIFIERS = /^\s*(?:(?:export|default|declare|public|private|protected|internal|static|final|readonly|abstract|override|virtual|async|sealed|partial|const|let|var|local|my|our|val|auto|mut|pub|unsafe|extern|inline|get|set)\s+)*#?$/;

const COMMENT_LINE = /^\s*(?:\/\/|#(?![!{\w[])|--|\*|\/\*|;|')/;

/**
 * How the name at `column` (1-based) of `line` is declared there, if it is: 'strong'
 * after a keyword (function, class, def, const, let, type…), typed (int count =, String
 * name(), as a key (name: in YAML, JSON, objects), a method (name(…) {), an import, a
 * parameter or a loop variable; 'assign' for name = … at the start of a line (Python,
 * shell, Ruby: the first one declares it). null when it is only used there.
 */
export function declarationKind(line, column, word) {
  if (COMMENT_LINE.test(line)) return null;
  const before = line.slice(0, column - 1);
  const after = line.slice(column - 1 + word.length);
  if (KEYWORD_BEFORE.test(before) || GO_METHOD.test(before) || SQL_BEFORE.test(before)) return 'strong';
  // import { a, b as c } from …, from x import a, b, export { a }
  if (/^\s*(?:import\b|from\s+\S+\s+import\b|export\s+\{)/.test(line) && !/\bfrom\s*['"][^'"]*$/.test(before) && !/^\s*from\s+$/.test(before)) return 'strong';
  // A key: "name": / name: (YAML, JSON, object literals on their own line).
  if (/^["']?\s*:(?!:)/.test(after) && /^\s*(?:-\s+)?["']?$/.test(before)) return 'strong';
  // name(…) { or name(…): T { — a method or function (a call ends with ; or nothing).
  if (MODIFIERS.test(before) && /^\s*(?:<[^>]*>)?\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::\s*[^={;]+)?\s*(?:throws\s+[\w.,\s]+)?(?:\{|=>|:\s*$|->)/.test(after)) return 'strong';
  // Shell: name() {
  if (/^\s*(?:function\s+)?$/.test(before) && /^\s*\(\)\s*\{?/.test(after)) return 'strong';
  // Typed: int count = / String name( / List<String> items; / Foo *p
  const typed = /(?:^|[\s(,])([A-Za-z_][\w$]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(?:\[\])*\??[*&]*)\s+[*&]*$/.exec(before);
  if (typed && !NOT_TYPES.has(typed[1].toLowerCase()) && /^\s*(?:=(?!=)|;|,|\(|\)|\[|:(?!:))/.test(after) && /^\s*[A-Za-z_]/.test(before)) return 'strong';
  // A parameter: function f(a, b), def f(self, name), (a, b) =>, x =>, catch (e), for x in / for (const x of
  if (/\b(?:function\*?|def|fn|func|fun|sub)\b[^()]*\([^()]*$/.test(before) && /^[^()]*\)/.test(after)) return 'strong';
  if (/\(\s*(?:[\w$]+\s*(?::[^,()]+)?,\s*)*$/.test(before) && /^\s*(?::[^,()]+)?(?:,\s*[\w$]+\s*(?::[^,()]+)?)*\)\s*(?::\s*[^=]+)?=>/.test(after)) return 'strong';
  if (/^\s*=>/.test(after)) return 'strong';
  if (/\bcatch\s*\(\s*$/.test(before) || /\bfor\s+(?:each\s+)?\(?\s*(?:(?:const|let|var|my|local)\s+)?$/.test(before)) return 'strong';
  // name = … (with modifiers before it, or at the start of a line).
  if (MODIFIERS.test(before) && /^\s*(?::\s*[\w<>[\]|., ?]+)?\s*(?:=(?![=>~])|:=)/.test(after)) return 'assign';
  return null;
}

export const isDeclaration = (line, column, word) => declarationKind(line, column, word) !== null;

/**
 * Where `word` is declared, as seen from `pos`: the nearest declaration at or before it
 * (inner scopes come later in a file), else the first after it; assignments count only
 * when there is no other kind, and then the first one. null when there is none.
 */
export function findDefinition(text, word, pos = 0, found = occurrences(text, word)) {
  const kinds = found.map((o) => [o, declarationKind(o.text, o.column, word)]);
  const strong = kinds.filter(([, k]) => k === 'strong').map(([o]) => o);
  if (strong.length) {
    const before = strong.filter((o) => o.from <= pos);
    return before.length ? before[before.length - 1] : strong[0];
  }
  return kinds.find(([, k]) => k === 'assign')?.[0] ?? null;
}

/** The usages of `word` with the declarations marked: [{ ...occurrence, declaration }]. */
export function usages(text, word, opts) {
  return occurrences(text, word, opts).map((o) => ({ ...o, declaration: declarationKind(o.text, o.column, word) !== null }));
}

/** Which names can have dashes (CSS, YAML, shell, HTML and the like). */
export const DASHED_LANGUAGES = new Set(['CSS', 'SCSS', 'Sass', 'LESS', 'Stylus', 'YAML', 'Shell', 'PowerShell', 'HTML', 'XML', 'Common Lisp', 'Clojure', 'Scheme', 'Makefile', 'Dockerfile', 'TOML', 'Properties files']);

/** Where line `line` (1-based) of `text` starts. */
export function lineStart(text, line) {
  let at = 0;
  for (let n = 1; n < line && at !== -1; n++) at = text.indexOf('\n', at) + 1 || -1;
  return Math.max(0, at);
}

/** Symbols (outline entries) matching `query`: every word of it in the name, best first. */
export function matchSymbols(symbols, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return symbols;
  const hits = symbols.filter((s) => words.every((w) => s.title.toLowerCase().includes(w)));
  const rank = (s) => (s.title.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hits.map((s, i) => [rank(s), i, s]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}
