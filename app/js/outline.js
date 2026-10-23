// The outline of a file (Markdown headings, or the classes, functions and
// tables of code) and [[links]] between notes. Pure, so the Node tests can import it.

const FENCE = /^\s{0,3}(```|~~~)/;

// Code symbols by language family: [pattern, level]. The name is the last group.
const SYMBOLS = {
  script: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 1],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, 1],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 1],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 1],
    // Methods in classes and objects: name(…) { on an indented line.
    [/^\s+(?:(?:static|async|get|set|public|private|protected|override|readonly)\s+)*\*?#?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/, 2],
  ],
  python: [
    [/^(\s*)class\s+([A-Za-z_]\w*)/, 'indent'],
    [/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'indent'],
  ],
  sql: [[/^\s*(?:create|alter)\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|procedure|proc|function|trigger|index|schema)\s+(?:if\s+not\s+exists\s+)?([\w.[\]"`]+)/i, 1]],
  csharp: [
    [/^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/, 1],
    [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|async)\s+)+[\w<>[\],.?]+\s+(\w+)\s*\(/, 2],
  ],
  go: [[/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, 1], [/^\s*type\s+(\w+)\s+(?:struct|interface)/, 1]],
  rust: [[/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 1], [/^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/, 1]],
  shell: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, 1]],
  ini: [[/^\s*\[([^\]]+)\]/, 1]],
  powershell: [[/^\s*function\s+([\w-]+)/i, 1]],
  // Keys at the top and one level in (lists left out).
  yaml: [[/^(\s{0,2})([A-Za-z_][\w.-]*|"[^"\n]+"|'[^'\n]+')\s*:(?:\s|$)/, 'indent2']],
  c: [
    [/^\s*(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, 'indent2'],
    [/^(?!\s*(?:if|for|while|switch|return|else|do|case|sizeof)\b)[A-Za-z_][\w\s*&:<>,~]*?[\s*&]([A-Za-z_~][\w:~]*)\s*\([^;]*$/, 1],
  ],
  php: [
    [/^(\s*)(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/, 'indent2'],
    [/^(\s*)(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)/, 'indent2'],
  ],
  ruby: [
    [/^(\s*)(?:class|module)\s+([\w:]+)/, 'indent2'],
    [/^(\s*)def\s+(?:self\.)?([\w?!=]+)/, 'indent2'],
  ],
  kotlin: [
    [/^(\s*)(?:(?:public|private|internal|protected|open|override|suspend|inline|data|sealed|abstract|final|static|fileprivate|mutating)\s+)*(?:class|interface|object|struct|enum|protocol|extension)\s+(\w+)/, 'indent2'],
    [/^(\s*)(?:(?:public|private|internal|protected|open|override|suspend|inline|static|fileprivate|mutating|@\w+)\s+)*(?:fun|func)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, 'indent2'],
  ],
  lua: [[/^\s*(?:local\s+)?function\s+([\w.:]+)/, 1]],
  perl: [[/^\s*sub\s+(\w+)/, 1], [/^\s*package\s+([\w:]+)/, 1]],
};
// Words that look like a method in `name(…) {` but are not.
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'with', 'foreach', 'elseif', 'using', 'lock', 'synchronized']);
const FAMILY = {
  JavaScript: 'script', TypeScript: 'script', JSX: 'script', TSX: 'script',
  Python: 'python', SQL: 'sql', PostgreSQL: 'sql', MySQL: 'sql', MSSQL: 'sql', SQLite: 'sql', PLSQL: 'sql',
  'C#': 'csharp', Java: 'csharp', Go: 'go', Rust: 'rust', Shell: 'shell', Properties: 'ini', 'Properties files': 'ini', TOML: 'ini', PowerShell: 'powershell',
  YAML: 'yaml', C: 'c', 'C++': 'c', 'Objective-C': 'c', 'Objective-C++': 'c', PHP: 'php', Ruby: 'ruby', Kotlin: 'kotlin', Swift: 'kotlin', Scala: 'kotlin', Lua: 'lua', Perl: 'perl',
};

// The language of a file by its extension, for files read outside the editor (the folders'
// symbols, F12 across files): only those with an outline here.
const BY_EXTENSION = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TSX',
  py: 'Python', pyw: 'Python', sql: 'SQL', cs: 'C#', java: 'Java', go: 'Go', rs: 'Rust', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  ps1: 'PowerShell', psm1: 'PowerShell', yml: 'YAML', yaml: 'YAML', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++',
  m: 'Objective-C', mm: 'Objective-C++', php: 'PHP', rb: 'Ruby', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', scala: 'Scala', lua: 'Lua', pl: 'Perl', pm: 'Perl',
  ini: 'Properties files', properties: 'Properties files', toml: 'TOML', vue: 'JavaScript', svelte: 'JavaScript',
};
/** The language a file name says, when this module outlines it ('' when not). */
export function languageForName(name = '') {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? '';
}

/** [{ line, level, title }] for Markdown headings (outside code blocks), or the symbols of code. */
export function outline(text, language = '') {
  const lines = String(text ?? '').split('\n');
  const out = [];
  if (language === 'Markdown' || language === '') {
    let fenced = false;
    lines.forEach((raw, i) => {
      if (FENCE.test(raw)) fenced = !fenced;
      if (fenced) return;
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
      if (m) out.push({ line: i + 1, level: m[1].length, title: m[2].replace(/[*_`]/g, '') });
    });
    if (language === 'Markdown' || out.length) return out;
  }
  const rules = SYMBOLS[FAMILY[language]];
  if (!rules) return out;
  lines.forEach((raw, i) => {
    for (const [re, level] of rules) {
      const m = re.exec(raw);
      if (!m) continue;
      const name = m[m.length - 1];
      if (CONTROL.has(name)) continue;
      const indent = m.length > 2 ? m[1].replace(/\t/g, '    ').length : 0;
      // 'indent': a level per 4 spaces (Python); 'indent2': indented ones one level in.
      const lvl = level === 'indent' ? 1 + Math.floor(indent / 4) : level === 'indent2' ? (indent ? 2 : 1) : level;
      out.push({ line: i + 1, level: Math.min(lvl, 6), title: FAMILY[language] === 'sql' ? `${m[1].toUpperCase()} ${name}` : name });
      break;
    }
  });
  return out;
}

const LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** The [[links]] in a text: [{ target, alias, from, to }] (offsets of the whole link). */
export function parseLinks(text) {
  return [...String(text ?? '').matchAll(LINK)]
    .map((m) => ({ target: m[1].trim(), alias: (m[2] ?? '').trim(), from: m.index, to: m.index + m[0].length }))
    .filter((l) => l.target);
}

/** How a file is written in a link: its name without .md (other extensions stay). */
export const linkName = (fileName) => fileName.replace(/\.(md|markdown)$/i, '');

/** The file a link points to: same name, or same name without .md, case-insensitive. */
export function resolveLink(target, files) {
  const t = target.trim().toLowerCase();
  return files.find((f) => f.name.toLowerCase() === t) ?? files.find((f) => linkName(f.name).toLowerCase() === t) ?? null;
}

/** Files that link to `file`: [{ file, line, context }], each file once with its first such line. */
export function backlinks(file, files, textOf) {
  const out = [];
  for (const other of files) {
    if (other.id === file.id) continue;
    const text = textOf(other) ?? '';
    if (!text.includes('[[')) continue;
    const hit = parseLinks(text).find((l) => resolveLink(l.target, [file]));
    if (!hit) continue;
    const lineStart = text.lastIndexOf('\n', hit.from) + 1;
    const lineEnd = text.indexOf('\n', hit.to);
    out.push({ file: other, line: text.slice(0, hit.from).split('\n').length, context: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 120) });
  }
  return out;
}

/** The outline entry the cursor is in: the last one at or above `line` (index, or -1). */
export function currentEntry(entries, line) {
  let at = -1;
  for (let i = 0; i < entries.length && entries[i].line <= line; i++) at = i;
  return at;
}
