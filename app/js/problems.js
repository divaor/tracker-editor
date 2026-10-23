// Problems as you type: what is wrong in a file, as [{ from, to, severity, message }].
// JSON and YAML have checks of their own here; code, HTML and XML use the syntax
// errors the editor's parser finds (editor.js walks the tree and passes them in).
// Pure: no DOM, no CodeMirror, so the Node tests use it.
import { jsonProblem } from './previews.js';

/** Languages whose parser reports syntax errors reliably (SQL and Markdown accept anything, or not). */
export const SYNTAX_LANGUAGES = new Set([
  'JavaScript', 'TypeScript', 'JSX', 'TSX', 'JSON', 'YAML', 'XML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less',
  'Python', 'Go', 'Java', 'PHP', 'C', 'C++', 'Rust', 'Vue',
]);
// HTML is forgiving (browsers fix it), so its problems are warnings.
const WARN_ONLY = new Set(['HTML', 'Vue', 'PHP']);

/** JSON files that may have comments and trailing commas, as VS Code reads them. */
export function isJsonc(name = '') {
  const base = name.split(/[\\/]/).pop().toLowerCase();
  return (
    /\.(jsonc|json5|code-workspace)$/.test(base) ||
    /^(ts|js)config(\..*)?\.json$/.test(base) ||
    /^\.?(eslintrc|babelrc|swcrc|jshintrc)(\.json)?$/.test(base) ||
    ['settings.json', 'launch.json', 'tasks.json', 'keybindings.json', 'extensions.json', 'devcontainer.json', '.devcontainer.json', 'deno.json', 'biome.json'].includes(base)
  );
}

// The text with comments and trailing commas made spaces (same length, so places stay).
function blankJsonc(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let lastComma = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      lastComma = -1;
      for (i++; i < text.length && text[i] !== '"' && text[i] !== '\n'; i += text[i] === '\\' ? 2 : 1);
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (c === ',') lastComma = i;
      else if ((c === '}' || c === ']') && lastComma !== -1) out[lastComma] = ' ';
      if (!' \t\r\n,'.includes(c)) lastComma = -1;
      i++;
    }
  }
  return out.join('');
}

const offsetOf = (text, line, column) => {
  let at = 0;
  for (let n = 1; n < line; n++) at = text.indexOf('\n', at) + 1;
  return Math.min(text.length, at + column - 1);
};

/** The first problem in a JSON text (comments and trailing commas allowed with `comments`). */
export function jsonProblems(text, { comments = false } = {}) {
  if (!text.trim()) return [];
  const checked = comments ? blankJsonc(text) : text;
  const problem = jsonProblem(checked);
  if (!problem) return [];
  let from = offsetOf(text, problem.line, problem.column);
  // An extra comma is found at the bracket after it: it is shown at the comma.
  if (problem.message.startsWith('Extra comma')) {
    const comma = text.lastIndexOf(',', from);
    if (comma !== -1 && !text.slice(comma + 1, from).trim()) from = comma;
  }
  const isComment = !comments && text[from] === '/' && (text[from + 1] === '/' || text[from + 1] === '*');
  const lineEnd = text.indexOf('\n', from);
  const to = Math.max(from, Math.min(lineEnd === -1 ? text.length : lineEnd, from + (isComment ? 2 : 1)));
  return [{ from, to, severity: 'error', message: isComment ? 'Comments are not allowed in JSON (they are in .jsonc files)' : problem.message }];
}

/**
 * YAML mistakes the parser lets through: a key twice in the same mapping, tabs in the
 * indentation, and a quoted value left open.
 */
export function yamlProblems(text) {
  const out = [];
  const lines = text.split('\n');
  let offset = 0;
  let scopes = []; // [{ indent, keys: Map(key → line) }], innermost last
  let block = -1; // inside a block scalar (| or >): the indentation of its key
  let flow = 0; // inside [ ] or { } spanning lines
  for (let n = 0; n < lines.length; n++, offset += lines[n - 1].length + 1) {
    const line = lines[n].replace(/\r$/, '');
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (block !== -1) {
      if (!body || indent > block) continue;
      block = -1;
    }
    if (!body || body.startsWith('#')) continue;
    if (/^(---|\.\.\.)(\s|$)/.test(line)) {
      scopes = [];
      flow = 0;
      continue;
    }
    if (/^[ ]*\t/.test(line)) out.push({ from: offset, to: offset + indent, severity: 'error', message: 'Tabs cannot indent YAML: use spaces' });
    if (flow > 0) {
      flow = Math.max(0, flow + depthChange(body));
      continue;
    }
    // Sequence dashes, then maybe a key.
    let at = indent;
    while (/^-(\s|$)/.test(line.slice(at))) {
      scopes = scopes.filter((s) => s.indent <= at);
      at += 1 + (line.slice(at + 1).length - line.slice(at + 1).trimStart().length);
    }
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{}:,][^#:]*?|[^\s#'"[\]{}:,]?)\s*:(\s|$)/.exec(line.slice(at));
    if (m && m[1]) {
      const key = m[1].replace(/^["']|["']$/g, '');
      scopes = scopes.filter((s) => s.indent <= at);
      let scope = scopes[scopes.length - 1];
      if (!scope || scope.indent < at) {
        scope = { indent: at, keys: new Map() };
        scopes.push(scope);
      }
      if (key !== '<<' && scope.keys.has(key)) {
        out.push({ from: offset + at, to: offset + at + m[1].length, severity: 'error', message: `“${key}” is already a key here (line ${scope.keys.get(key)})` });
      } else scope.keys.set(key, n + 1);
      const value = line.slice(at + m[0].length).trim();
      if (/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) block = at;
      else checkValue(value, offset + at + m[0].length + (line.slice(at + m[0].length).length - line.slice(at + m[0].length).trimStart().length), n, at);
    } else checkValue(line.slice(at).trim(), offset + at, n, at);
  }
  return out;

  // A value: brackets spanning lines, or a quote left open before the next key.
  function checkValue(value, from, n, at) {
    if (/^[[{]/.test(value)) flow = Math.max(0, depthChange(value));
    const q = value[0];
    if ((q !== '"' && q !== "'") || closes(value, q)) return;
    for (let k = n + 1; k < lines.length; k++) {
      const next = lines[k];
      if (!next.trim() || next.trim().startsWith('#')) continue;
      if (closes(next, q, true)) return;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= at && /^\s*(-\s|[^\s#:]+:(\s|$))/.test(next)) break;
    }
    out.push({ from, to: from + 1, severity: 'error', message: 'This quoted value is not closed' });
  }
}

// Whether a quoted value opened with `q` closes on this line (from its start, or anywhere when continuing).
function closes(text, q, continuing = false) {
  for (let i = continuing ? 0 : 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') i++;
    else if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") i++;
      else return true;
    }
  }
  return false;
}

function depthChange(text) {
  let d = 0;
  let quote = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

// The token at `from`: a word, or one character.
function tokenAt(text, from) {
  const m = /^(\w+|\S)/.exec(text.slice(from, from + 40));
  return m ? m[0] : '';
}

/**
 * The syntax errors in a parse tree (a Lezer tree; `slice(from, to)` reads the text):
 * [{ from, to, kind, tag, open, before }] for syntaxProblems. Close tags that do not match,
 * and elements left open (at their open tag's name, `before` the close tag that came first).
 */
export function treeErrors(tree, slice, limit = 200) {
  const errors = [];
  const tagName = (node) => {
    const t = node?.getChild('TagName');
    return t ? slice(t.from, t.to) : '';
  };
  tree.iterate({
    enter(n) {
      if (errors.length >= limit) return false;
      const element = n.node.parent?.name === 'Element' ? n.node.parent : null;
      if (n.name === 'MismatchedCloseTag') {
        errors.push({ from: n.from, to: n.to, kind: 'mismatched', tag: tagName(n.node), open: tagName(element?.getChild('OpenTag')) });
      } else if (element && (n.name === 'MissingCloseTag' || (n.type.isError && slice(n.from, n.from + 2) === '</'))) {
        // A close tag for an outer element while this one is open: this one is not closed.
        const open = element.getChild('OpenTag')?.getChild('TagName');
        const before = /^<\/([\w:.-]+)/.exec(slice(n.from, n.from + 60))?.[1] ?? '';
        if (open) errors.push({ from: open.from, to: open.to, kind: 'missing', open: slice(open.from, open.to), before });
        else errors.push({ from: n.from, to: n.to, kind: 'error' });
      } else if (n.type.isError) errors.push({ from: n.from, to: n.to, kind: 'error' });
    },
  });
  return errors;
}

/**
 * Messages for the syntax errors the parser found: [{ from, to, kind: 'error' |
 * 'mismatched' | 'missing', tag, open, before }] → problems (a missing close tag at
 * its open tag's name, `before` the close tag that came first). Several at one place
 * count once.
 */
export function syntaxProblems(text, errors, language = '') {
  const severity = WARN_ONLY.has(language) ? 'warning' : 'error';
  const out = [];
  let last = -1;
  for (const e of [...errors].sort((a, b) => a.from - b.from)) {
    if (out.length >= 100) break;
    if (e.from <= last) continue;
    if (e.kind === 'mismatched') {
      out.push({ from: e.from, to: e.to, severity, message: e.open ? `</${e.tag}> does not close <${e.open}>` : `</${e.tag}> closes nothing` });
    } else if (e.kind === 'missing') {
      // At the open tag's name when the parser says where it is.
      const [from, to] = e.to > e.from ? [e.from, e.to] : [Math.max(0, e.from - 1), Math.max(e.from, 1)];
      out.push({ from, to, severity, message: `<${e.open}> is not closed${e.before ? ` before </${e.before}>` : ''}` });
    } else if (e.from >= text.trimEnd().length) {
      const at = text.trimEnd().length;
      out.push({ from: Math.max(0, at - 1), to: at, severity, message: 'The text ends before something is closed' });
    } else {
      const own = text.slice(e.from, Math.min(e.to, e.from + 40));
      const token = own.trim() ? own.split('\n')[0] : tokenAt(text, e.from);
      if (!token || text[e.from] === '\n') {
        // At a line end: something is missing there.
        out.push({ from: Math.max(0, e.from - 1), to: e.from, severity, message: 'Something is missing at the end of this line' });
      } else {
        const start = text[e.from] === ' ' || text[e.from] === '\t' ? e.from + (text.slice(e.from).length - text.slice(e.from).trimStart().length) : e.from;
        out.push({ from: start, to: start + token.trim().length, severity, message: `Unexpected “${token.trim()}”` });
      }
    }
    last = Math.max(e.from, e.to);
  }
  return out;
}

/**
 * Every problem in a file: `language` (the editor's name for it), `name` (the file name,
 * for JSON with comments) and `errors` (the parser's, see syntaxProblems).
 */
export function problemsFor(text, { language = '', name = '', errors = [] } = {}) {
  if (language === 'JSON') return jsonProblems(text, { comments: isJsonc(name) });
  if (!SYNTAX_LANGUAGES.has(language)) return [];
  const own = language === 'YAML' ? yamlProblems(text) : [];
  // The parser's on lines that already have one of ours are left out (ours say more).
  const lineOf = (pos) => text.slice(0, pos).split('\n').length;
  const ownLines = new Set(own.map((p) => lineOf(p.from)));
  const found = syntaxProblems(text, errors, language).filter((p) => !ownLines.has(lineOf(p.from)));
  return [...own, ...found].sort((a, b) => a.from - b.from);
}
