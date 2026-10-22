// Format document: which formatter fits a file (by its name or language), and the
// formatting itself. JSON (with comments) and XML are formatted here, keeping every
// token as written (big numbers stay exact); SQL by sql-formatter; JavaScript,
// TypeScript, CSS, HTML, Markdown, YAML and GraphQL by Prettier. Those two load
// from vendor/format/ the first time they are needed. No DOM, so the Node tests use it.

const VENDOR = new URL('../vendor/format/', import.meta.url).href;

const extOf = (name = '') => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

// Prettier: parser and plugins (embedded scripts and styles in HTML use the others).
const PRETTIER = {
  babel: ['babel', 'estree'],
  typescript: ['typescript', 'estree'],
  css: ['postcss'],
  scss: ['postcss'],
  less: ['postcss'],
  html: ['html', 'postcss', 'babel', 'estree'],
  vue: ['html', 'postcss', 'babel', 'estree', 'typescript'],
  markdown: ['markdown', 'babel', 'estree', 'postcss', 'yaml'],
  yaml: ['yaml'],
  graphql: ['graphql'],
};
const BY_EXT = {
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', webmanifest: 'json', har: 'json', ipynb: 'json',
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', xaml: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', plist: 'xml', rss: 'xml', atom: 'xml', wsdl: 'xml', config: 'xml', resx: 'xml', kml: 'xml', gpx: 'xml', pom: 'xml',
  sql: 'sql', psql: 'sql', pgsql: 'sql', mysql: 'sql', tsql: 'sql', plsql: 'sql',
  js: 'babel', mjs: 'babel', cjs: 'babel', jsx: 'babel', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xhtml: 'html', vue: 'vue',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', yaml: 'yaml', yml: 'yaml', graphql: 'graphql', gql: 'graphql',
};
const BY_LANGUAGE = {
  JSON: 'json', 'JSON-LD': 'json', XML: 'xml', SVG: 'xml', SQL: 'sql', MySQL: 'sql', PostgreSQL: 'sql', 'MS SQL': 'sql', SQLite: 'sql', PLSQL: 'sql', 'MariaDB SQL': 'sql',
  JavaScript: 'babel', JSX: 'babel', TypeScript: 'typescript', TSX: 'typescript', CSS: 'css', SCSS: 'scss', LESS: 'less', Less: 'less',
  HTML: 'html', Vue: 'vue', Markdown: 'markdown', YAML: 'yaml', GraphQL: 'graphql',
};
const SQL_DIALECTS = { MySQL: 'mysql', PostgreSQL: 'postgresql', 'MS SQL': 'tsql', SQLite: 'sqlite', PLSQL: 'plsql', 'MariaDB SQL': 'mariadb' };
const LABELS = { json: 'JSON', xml: 'XML', sql: 'SQL', babel: 'JavaScript', typescript: 'TypeScript', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', vue: 'Vue', markdown: 'Markdown', yaml: 'YAML', graphql: 'GraphQL' };

/** The formatter for a file: { kind, label, dialect? } or null. The language picked wins over the name. */
export function formatterFor(name = '', language = '') {
  const kind = BY_LANGUAGE[language] ?? BY_EXT[extOf(name)] ?? null;
  if (!kind) return null;
  return { kind, label: LABELS[kind], ...(kind === 'sql' ? { dialect: SQL_DIALECTS[language] ?? (extOf(name) === 'psql' || extOf(name) === 'pgsql' ? 'postgresql' : 'sql') } : {}) };
}

/** What a text looks like when nothing else says: JSON, XML or nothing. */
export function guessFormatter(text) {
  const t = text.trimStart();
  if (/^[[{]/.test(t)) return formatterFor('x.json');
  if (/^<(\?xml|[A-Za-z_][\w:.-]*[\s>/])/.test(t) && !/^<!doctype html|^<html/i.test(t)) return formatterFor('x.xml');
  return null;
}

/** An error with the line and column of `index` in `text`. */
function failAt(message, text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return Object.assign(new Error(`${message} (line ${line}, column ${column})`), { line, column });
}

/**
 * JSON (and JSON with comments) re-indented: every object and array on its own lines,
 * empty ones as {} and [], tokens kept as written (numbers are not rounded).
 */
export function formatJson(text, indent = '  ') {
  const out = [];
  let depth = 0;
  let i = 0;
  let line = ''; // what is on the line being built
  const stack = [];
  let expectValue = true;
  const newline = () => {
    out.push(line.replace(/\s+$/, ''));
    line = indent.repeat(depth);
  };
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const comment = text.slice(i, end === -1 ? n : end);
      line += line.trim() ? ` ${comment}` : comment;
      newline();
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw failAt('A comment is not closed', text, i);
      line += `${line.trim() ? ' ' : ''}${text.slice(i, end + 2)} `;
      i = end + 2;
      continue;
    }
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      // Empty: kept as {} or [].
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === close) {
        line += c + close;
        i = j + 1;
        expectValue = false;
        continue;
      }
      line += c;
      stack.push(close);
      depth++;
      newline();
      i++;
      expectValue = true;
      continue;
    }
    if (c === '}' || c === ']') {
      if (stack.pop() !== c) throw failAt(`Unexpected ${c}`, text, i);
      depth--;
      if (line.trim()) newline();
      line = indent.repeat(depth) + c;
      i++;
      expectValue = false;
      continue;
    }
    if (c === ',') {
      line += ',';
      newline();
      i++;
      expectValue = true;
      continue;
    }
    if (c === ':') {
      line += ': ';
      i++;
      expectValue = true;
      continue;
    }
    if (c === '"' || c === "'") {
      if (!expectValue) throw failAt('A comma is missing', text, i);
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        else if (text[j] === '\n') throw failAt('A string is not closed', text, i);
        j++;
      }
      if (j >= n) throw failAt('A string is not closed', text, i);
      line += text.slice(i, j + 1);
      i = j + 1;
      expectValue = false;
      continue;
    }
    const m = /^[-+]?(?:\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|Infinity|NaN)|^(?:true|false|null)|^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 400));
    if (!m) throw failAt(`Unexpected ${JSON.stringify(c)}`, text, i);
    if (!expectValue && !/^[A-Za-z_$]/.test(m[0])) throw failAt(`A comma is missing before ${m[0]}`, text, i);
    line += m[0];
    i += m[0].length;
    expectValue = false;
  }
  if (stack.length) throw failAt(`${stack[stack.length - 1]} is missing at the end`, text, n);
  if (line.trim()) out.push(line.replace(/\s+$/, ''));
  return `${out.filter((l, k) => l.trim() || k < out.length - 1).join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * XML re-indented: one element per line, nested by depth; an element holding only
 * text stays on one line; comments, CDATA, processing instructions and the doctype
 * are kept as written; text is trimmed of the spaces around it.
 */
export function formatXml(text, indent = '  ') {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/?[A-Za-z_](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index !== at) throw failAt('Not well formed here', text, at);
    tokens.push(m[0]);
    at = m.index + m[0].length;
  }
  if (at !== text.length) throw failAt('Not well formed here', text, at);
  const out = [];
  const stack = [];
  const pad = () => indent.repeat(stack.length);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.startsWith('<')) {
      const words = t.trim();
      if (words) out.push(pad() + words);
      continue;
    }
    if (t.startsWith('</')) {
      const name = /^<\/\s*([^\s>]+)/.exec(t)[1];
      if (stack[stack.length - 1] !== name) throw failAt(`</${name}> does not close ${stack.length ? `<${stack[stack.length - 1]}>` : 'anything'}`, text, text.indexOf(t));
      stack.pop();
      out.push(pad() + t.trim());
      continue;
    }
    if (/^<(!|\?)/.test(t) || /\/\s*>$/.test(t)) {
      out.push(pad() + t.trim());
      continue;
    }
    const name = /^<\s*([^\s/>]+)/.exec(t)[1];
    // Only text inside (or nothing): on one line.
    const next = tokens[k + 1];
    const after = tokens[k + 2];
    if (next !== undefined && !next.startsWith('<') && after && new RegExp(`^</\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>$`).test(after)) {
      out.push(pad() + t + next.trim() + after.trim());
      k += 2;
      continue;
    }
    if (next && /^<\//.test(next) && new RegExp(`^</\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>$`).test(next)) {
      out.push(pad() + t + next.trim());
      k += 1;
      continue;
    }
    out.push(pad() + t);
    stack.push(name);
  }
  if (stack.length) throw failAt(`<${stack[stack.length - 1]}> is not closed`, text, text.length);
  return `${out.join('\n')}\n`;
}

const loaded = new Map();
const load = (file) => {
  if (!loaded.has(file)) loaded.set(file, import(`${VENDOR}${file}`));
  return loaded.get(file);
};

/**
 * The text formatted for `formatter` (from formatterFor): { text } or throws with the
 * reason (and `line` when it is known). `tabSize` and `useTabs` follow the editor.
 */
export async function formatText(text, formatter, { tabSize = 2, useTabs = false } = {}) {
  const indent = useTabs ? '\t' : ' '.repeat(tabSize);
  if (formatter.kind === 'json') return formatJson(text, indent);
  if (formatter.kind === 'xml') return formatXml(text, indent);
  if (formatter.kind === 'sql') {
    const { format } = await load('sql-formatter.js');
    try {
      return `${format(text, { language: formatter.dialect ?? 'sql', tabWidth: tabSize, useTabs, keywordCase: 'preserve' }).replace(/\s+$/, '')}\n`;
    } catch (err) {
      // Another dialect may know it (a function or a keyword of its own).
      if (formatter.dialect && formatter.dialect !== 'sql') throw err;
      for (const language of ['postgresql', 'tsql', 'mysql', 'plsql']) {
        try {
          return `${format(text, { language, tabWidth: tabSize, useTabs, keywordCase: 'preserve' }).replace(/\s+$/, '')}\n`;
        } catch {
          // the next one
        }
      }
      throw err;
    }
  }
  const prettier = await load('standalone.js');
  const plugins = await Promise.all(PRETTIER[formatter.kind].map((p) => load(`plugins/${p}.js`)));
  try {
    return await prettier.format(text, { parser: formatter.kind, plugins, tabWidth: tabSize, useTabs, printWidth: 100 });
  } catch (err) {
    const where = err.loc?.start;
    throw Object.assign(new Error(String(err.message).split('\n')[0].replace(/\s*\(\d+:\d+\)$/, '') + (where ? ` (line ${where.line}, column ${where.column})` : '')), where ? { line: where.line, column: where.column } : {});
  }
}

/** Every kind of file Format document knows (for the help). */
export const FORMATTABLE = 'JSON, XML, SQL, JavaScript, TypeScript, CSS, SCSS, Less, HTML, Vue, Markdown, YAML, GraphQL';
