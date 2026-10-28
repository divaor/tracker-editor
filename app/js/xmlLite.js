// A small, forgiving XML parser for the documents the editor shows (documents.js): Word and
// OpenDocument files, e-books (XHTML, FictionBook). It builds a plain tree: elements
// { name, local, attrs, children } and strings for text. It never fetches anything (no DTDs,
// no external entities), knows HTML's common named entities (some e-books use &nbsp;), and
// closes what a sloppy file leaves open. Pure, so the Node tests use it too.

// HTML's named entities that turn up in e-books' XHTML; the five of XML too.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad', zwnj: '\u200c', zwj: '\u200d',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', prime: '′', Prime: '″',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§',
  euro: '€', pound: '£', yen: '¥', cent: '¢', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', dagger: '†', Dagger: '‡', permil: '‰',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È', acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', atilde: 'ã', otilde: 'õ', ntilde: 'ñ', Ntilde: 'Ñ',
  ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß', aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', oelig: 'œ', OElig: 'Œ', eth: 'ð', thorn: 'þ',
};

/** Text with its entities replaced (&amp;, &#233;, &#xE9;, &nbsp;…); unknown ones stay as they are. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name] ?? whole;
  });
}

const localOf = (name) => name.slice(name.indexOf(':') + 1);
const NAME_END = /[\s/>]/;

function readAttrs(src, out) {
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/**
 * The tree of an XML text: { name: '#document', children } with elements { name (as written,
 * "w:p"), local ("p"), attrs, children } and strings. Comments, processing instructions and
 * the DOCTYPE are left out; CDATA is text.
 */
export function parseXml(text) {
  const root = { name: '#document', local: '#document', attrs: {}, children: [] };
  const stack = [root];
  let at = 0;
  const len = text.length;
  const addText = (s) => {
    if (!s) return;
    const kids = stack[stack.length - 1].children;
    const t = decodeEntities(s);
    if (typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] += t;
    else kids.push(t);
  };
  while (at < len) {
    const lt = text.indexOf('<', at);
    if (lt === -1) {
      addText(text.slice(at));
      break;
    }
    if (lt > at) addText(text.slice(at, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      at = end === -1 ? len : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const kids = stack[stack.length - 1].children;
      const t = text.slice(lt + 9, end === -1 ? len : end);
      if (typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] += t;
      else if (t) kids.push(t);
      at = end === -1 ? len : end + 3;
      continue;
    }
    if (text[lt + 1] === '?') {
      const end = text.indexOf('?>', lt + 2);
      at = end === -1 ? len : end + 2;
      continue;
    }
    if (text[lt + 1] === '!') {
      // <!DOCTYPE …> with an internal subset in brackets: skipped whole.
      let depth = 0;
      let i = lt + 2;
      for (; i < len; i++) {
        const c = text[i];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      at = i + 1;
      continue;
    }
    // A tag: the end is the first > outside quotes.
    let i = lt + 1;
    let quote = '';
    for (; i < len; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const body = text.slice(lt + 1, i);
    at = i + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      // Closes the nearest open element of that name (and what was left open inside it).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const self = body.endsWith('/');
    const inner = self ? body.slice(0, -1) : body;
    const m = NAME_END.exec(inner);
    const name = m ? inner.slice(0, m.index) : inner;
    if (!name) continue;
    const el = { name, local: localOf(name), attrs: m ? readAttrs(inner.slice(m.index), {}) : {}, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!self) stack.push(el);
  }
  return root;
}

// ---- Looking things up (by local name: the prefixes files use vary) ----

/** An attribute: by its name as written ("w:val"), else by its local name ("val"). */
export function attr(el, name) {
  if (!el?.attrs) return undefined;
  if (name in el.attrs) return el.attrs[name];
  const local = localOf(name);
  for (const k of Object.keys(el.attrs)) if (localOf(k) === local) return el.attrs[k];
  return undefined;
}

/** The child elements (with that local name, if given). */
export const kids = (el, local) => (el?.children ?? []).filter((c) => typeof c !== 'string' && (!local || c.local === local));
/** The first child element with that local name. */
export const kid = (el, local) => (el?.children ?? []).find((c) => typeof c !== 'string' && c.local === local) ?? null;

/** The first element with that local name below `el`, depth first. */
export function find(el, local) {
  for (const c of el?.children ?? []) {
    if (typeof c === 'string') continue;
    if (c.local === local) return c;
    const deeper = find(c, local);
    if (deeper) return deeper;
  }
  return null;
}

/** Every element with that local name below `el` (not inside one another's matches unless `nested`). */
export function findAll(el, local, out = [], nested = false) {
  for (const c of el?.children ?? []) {
    if (typeof c === 'string') continue;
    if (c.local === local) {
      out.push(c);
      if (!nested) continue;
    }
    findAll(c, local, out, nested);
  }
  return out;
}

/** All the text below an element, as it is. */
export function textOf(el) {
  if (typeof el === 'string') return el;
  let out = '';
  for (const c of el?.children ?? []) out += typeof c === 'string' ? c : textOf(c);
  return out;
}
