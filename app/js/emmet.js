// Emmet abbreviations for HTML and XML, the way VS Code expands them with Tab:
// ul>li.item*3, div#main.box>p{Hello}+a[href=#], (header>nav)+main, h$*3, ! for a page.
// Pure: the tests use it; editor.js expands at the cursor with it.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img', 'input', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'textarea', 'time', 'u', 'var', 'wbr', 'button', 'option']);
// The tag a ".class" alone means inside a parent.
const IMPLICIT = { ul: 'li', ol: 'li', table: 'tr', tbody: 'tr', thead: 'tr', tfoot: 'tr', tr: 'td', select: 'option', optgroup: 'option', dl: 'dt', audio: 'source', video: 'source', map: 'area', picture: 'source' };
// Attributes some tags get empty, for the cursor to stop in.
const DEFAULT_ATTRS = { a: [['href', '']], img: [['src', ''], ['alt', '']], link: [['rel', 'stylesheet'], ['href', '']], script: [['src', '']], input: [['type', 'text']], form: [['action', '']], label: [['for', '']], iframe: [['src', '']], source: [['src', '']] };
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
\t<meta charset="UTF-8">
\t<meta name="viewport" content="width=device-width, initial-scale=1.0">
\t<title>\${1:Document}</title>
</head>
<body>
\t\${0}
</body>
</html>`;

// HTML elements: a plain word expands only when it is one of them (Tab after other words indents).
export const HTML_TAGS = new Set(
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(' '),
);

/** Whether Tab should expand `abbr`: an operator or a known element (or "!"); XML needs an operator. */
export function isAbbreviation(abbr, { xml = false } = {}) {
  if (!abbr) return false;
  if (/[.#>+^*[{(]/.test(abbr)) return true;
  if (xml) return false;
  return abbr === '!' || HTML_TAGS.has(abbr.toLowerCase().replace(/\$+$/, ''));
}

/** The abbreviation that ends at the cursor in `line` (text before the cursor), or ''. */
export function abbreviationBefore(before) {
  // Back over what an abbreviation may hold; text in {} and [] may have spaces.
  let i = before.length;
  let braces = 0;
  let brackets = 0;
  while (i > 0) {
    const c = before[i - 1];
    if (c === '}') braces++;
    else if (c === '{') {
      if (!braces) break;
      braces--;
    } else if (c === ']') brackets++;
    else if (c === '[') {
      if (!brackets) break;
      brackets--;
    } else if (!braces && !brackets && !/[\w.#>+^*$@!:()\-%]/.test(c)) break;
    i--;
  }
  let abbr = before.slice(i);
  // Right after "<": the start is a tag's name, and what follows its ">" is the abbreviation.
  if (before[i - 1] === '<' || before.slice(i - 2, i) === '</') abbr = abbr.includes('>') ? abbr.slice(abbr.indexOf('>') + 1) : '';
  if (!abbr || /^[>+^*]/.test(abbr) || braces || brackets) return '';
  return abbr;
}

/**
 * Expands an abbreviation: { text, cursor } (cursor: where the first empty place is in
 * `text`), or null when it is not one. `indent` is one level ("\t" or spaces); `xml`
 * keeps every tag as written (no implicit tags or empty-element rules).
 */
export function expandAbbreviation(abbr, { indent = '\t', xml = false, jsx = false } = {}) {
  if (!abbr) return null;
  if (abbr === '!' && !xml) return withCursor(PAGE.replace(/\t/g, indent));
  let nodes;
  try {
    nodes = parse(abbr);
  } catch {
    return null;
  }
  if (!nodes.length) return null;
  // A lone word that is no element is not expanded unless it looks like an abbreviation.
  if (!/[.#>+^*[{(]/.test(abbr) && !/^[a-z][\w:-]*$/i.test(abbr)) return null;
  const out = render(nodes, { indent, xml, jsx, parent: '' }, 0, 1);
  return withCursor(out);
}

// "${1:x}" and "${0}" mark empty places; the first one is where the cursor goes.
function withCursor(text) {
  let cursor = -1;
  const clean = text.replace(/\$\{(\d+)(?::([^}]*))?\}/g, (_, _n, value = '', offset) => {
    if (cursor === -1) cursor = offset;
    return value;
  });
  // Offsets shift as earlier markers go: find the first again in the clean text.
  if (cursor !== -1) {
    const first = /\$\{(\d+)(?::([^}]*))?\}/.exec(text);
    let removed = 0;
    text.replace(/\$\{(\d+)(?::([^}]*))?\}/g, (m, _n, value = '', offset) => {
      if (offset < first.index) removed += m.length - value.length;
      return m;
    });
    cursor = first.index - removed;
  }
  return { text: clean, cursor: cursor === -1 ? clean.length : cursor };
}

// ---- Parsing: a tree of { name, id, classes, attrs, text, count, children } ----
function parse(abbr) {
  let i = 0;
  const peek = () => abbr[i];
  function group() {
    // A sequence of siblings, with > (child), + (sibling), ^ (up).
    const roots = [];
    let parents = [{ children: roots }];
    let last = null;
    for (;;) {
      const item = element();
      parents[parents.length - 1].children.push(item);
      last = item;
      const op = peek();
      if (op === '>') {
        i++;
        parents.push(last.group ? last.lastLeaf : last);
      } else if (op === '+') i++;
      else if (op === '^') {
        while (peek() === '^') {
          i++;
          if (parents.length > 1) parents.pop();
        }
      } else break;
    }
    return roots;
  }
  function element() {
    if (peek() === '(') {
      i++;
      const children = group();
      if (peek() !== ')') throw new Error('unclosed group');
      i++;
      const node = { group: true, children, count: count() };
      node.lastLeaf = deepest(children[children.length - 1]);
      return node;
    }
    const node = { name: '', id: '', classes: [], attrs: [], text: null, count: 1, children: [] };
    const name = /^[A-Za-z!][\w:.$@-]*?(?=[.#[{*>+^)]|$)/.exec(abbr.slice(i));
    if (name) {
      node.name = name[0];
      i += name[0].length;
    }
    for (;;) {
      const c = peek();
      if (c === '.') {
        i++;
        node.classes.push(word());
      } else if (c === '#') {
        i++;
        node.id = word();
      } else if (c === '[') {
        i++;
        const end = abbr.indexOf(']', i);
        if (end === -1) throw new Error('unclosed [');
        node.attrs.push(...attributes(abbr.slice(i, end)));
        i = end + 1;
      } else if (c === '{') {
        const end = abbr.indexOf('}', i);
        if (end === -1) throw new Error('unclosed {');
        node.text = abbr.slice(i + 1, end);
        i = end + 1;
      } else break;
    }
    node.count = count();
    if (!node.name && !node.id && !node.classes.length && !node.attrs.length && node.text === null) throw new Error('nothing');
    return node;
  }
  function count() {
    if (peek() !== '*') return 1;
    i++;
    const m = /^\d+/.exec(abbr.slice(i));
    if (!m) throw new Error('count');
    i += m[0].length;
    return Math.min(Number(m[0]), 500);
  }
  function word() {
    const m = /^[\w$@:-]+/.exec(abbr.slice(i));
    if (!m) throw new Error('name');
    i += m[0].length;
    return m[0];
  }
  const nodes = group();
  if (i !== abbr.length) throw new Error('left over');
  return nodes;
}

function deepest(node) {
  if (node.group) return deepest(node.children[node.children.length - 1]);
  return node;
}

function attributes(spec) {
  const out = [];
  const re = /([^\s=]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S*)))?/g;
  for (let m = re.exec(spec); m; m = re.exec(spec)) out.push([m[1], m[2] ?? m[3] ?? m[4] ?? '']);
  return out;
}

// $ numbering: "$" is the number, "$$" two digits, "$@-" counting down.
const number = (s, n, total) =>
  s.replace(/(\$+)(@(-)?(\d+)?)?/g, (_, dollars, at, down, start) => {
    const base = start ? Number(start) : 1;
    const value = down ? base + total - n : base + n - 1;
    return String(value).padStart(dollars.length, '0');
  });

function render(nodes, ctx, depth, _mult) {
  const pad = ctx.indent.repeat(depth);
  const parts = [];
  for (const node of nodes) {
    for (let n = 1; n <= node.count; n++) {
      if (node.group) {
        parts.push(render(node.children.map((c) => numbered(c, n, node.count)), ctx, depth, n));
        continue;
      }
      parts.push(element(numbered(node, n, node.count), ctx, depth, pad));
    }
  }
  return parts.join('\n');
}

// "$" is the number of the nearest repeated element (or group) around it: a repeated one
// numbers itself and the ones inside it that are not repeated themselves.
function numbered(node, n, total) {
  if (total <= 1) return node;
  const inner = (c) => (c.count > 1 ? c : numbered(c, n, total));
  if (node.group) return { ...node, children: node.children.map(inner) };
  return {
    ...node,
    name: number(node.name, n, total),
    id: number(node.id, n, total),
    classes: node.classes.map((c) => number(c, n, total)),
    attrs: node.attrs.map(([k, v]) => [number(k, n, total), number(v, n, total)]),
    text: node.text === null ? null : number(node.text, n, total),
    children: node.children.map(inner),
  };
}

function element(node, ctx, depth, pad) {
  const name = node.name || (ctx.xml ? 'div' : IMPLICIT[ctx.parent] ?? (INLINE.has(ctx.parent) ? 'span' : 'div'));
  // As VS Code writes them: the tag's usual attributes first (a value given replaces its
  // default there), then id and class, then the others given.
  const given = new Map(node.attrs);
  const attrs = [];
  if (!ctx.xml) for (const [k, v] of DEFAULT_ATTRS[name] ?? []) attrs.push([k, given.has(k) ? given.get(k) : v]);
  if (node.id) attrs.push(['id', node.id]);
  if (node.classes.length) attrs.push(['class', node.classes.join(' ')]);
  for (const [k, v] of node.attrs) if (!attrs.some(([a]) => a === k)) attrs.push([k, v]);
  // JSX: className and htmlFor, and empty elements closed with "/>".
  const attrName = (k) => (ctx.jsx ? ({ class: 'className', for: 'htmlFor' })[k] ?? k : k);
  const open = `<${name}${attrs.map(([k, v]) => ` ${attrName(k)}="${v === '' ? '${1}' : v}"`).join('')}`;
  if (!ctx.xml && VOID.has(name)) return `${pad}${open}${ctx.jsx ? ' />' : '>'}`;
  const text = node.text ?? '';
  if (!node.children.length) return `${pad}${open}>${text || '${0}'}</${name}>`;
  const inner = render(node.children, { ...ctx, parent: name }, depth + 1, 1);
  return `${pad}${open}>${text ? `${text}` : ''}\n${inner}\n${pad}</${name}>`;
}
