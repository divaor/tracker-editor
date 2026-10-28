// E-books (.epub) as one page: the chapters in reading order (the spine), with their
// contents (the EPUB 3 navigation document, or the EPUB 2 NCX) as the table of contents. The
// chapters' XHTML is rewritten tag by tag into the simple HTML the view shows: only the tags
// and attributes below (no scripts, styles, forms or frames), links inside the book pointed
// at the chapter they lead to, pictures from the book, and the book's own stylesheet read only
// for which classes are italic, bold, underlined or centered. Books with DRM cannot be read. Pure.

import { resolvePath } from '../unzip.js';
import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { DocumentError, esc, outsideUrl, safeId, zipImage } from './common.js';

// Tags kept as they are, or as another (and what they become).
const KEEP = new Set('p div span h1 h2 h3 h4 h5 h6 blockquote pre code em i strong b u s del ins sub sup small br hr ul ol li dl dt dd table thead tbody tfoot tr td th caption figure figcaption q cite abbr mark kbd samp var ruby rt rp section aside address time dfn bdi wbr'.split(' '));
const RENAME = { strike: 's', big: 'span', font: 'span', article: 'section', header: 'div', footer: 'div', nav: 'div', main: 'div', center: 'div', tt: 'code', listing: 'pre', xmp: 'pre', blink: 'span', label: 'span', legend: 'p', fieldset: 'div', details: 'div', summary: 'p', body: 'div' };
// Dropped with everything in them.
const DROP = new Set('script style link meta title head iframe frame frameset object embed applet form input button select option textarea audio video source track canvas noscript template map area param base'.split(' '));
const VOID = new Set(['br', 'hr', 'img', 'wbr']);

// The book's CSS, only for what a class does to the text: { class → [our classes] }.
const LOOKS = [
  [/font-style\s*:\s*(italic|oblique)/i, 'doc-i'],
  [/font-weight\s*:\s*(bold|bolder|[6-9]00)/i, 'doc-b'],
  [/text-decoration[^;]*underline/i, 'doc-u'],
  [/text-decoration[^;]*line-through/i, 'doc-s'],
  [/font-variant\s*:\s*small-caps/i, 'doc-sc'],
  [/text-align\s*:\s*center/i, 'al-c'],
  [/text-align\s*:\s*(right|end)/i, 'al-r'],
  [/text-align\s*:\s*justify/i, 'al-j'],
  [/vertical-align\s*:\s*super/i, 'doc-sup'],
  [/vertical-align\s*:\s*sub\b/i, 'doc-sub'],
];

export function cssLooks(css) {
  const looks = new Map();
  const clean = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const ours = LOOKS.filter(([re]) => re.test(m[2])).map(([, c]) => c);
    if (!ours.length) continue;
    for (const sel of m[1].split(',')) {
      // Simple selectors only: .name, p.name, span.a.b
      const s = sel.trim();
      if (!/^[a-z0-9]*(\.[\w-]+)+$/i.test(s)) continue;
      const names = s.split('.').slice(1);
      if (names.length !== 1) continue;
      looks.set(names[0], [...new Set([...(looks.get(names[0]) ?? []), ...ours])]);
    }
  }
  return looks;
}

export async function convertEpub(zip) {
  const container = await zip.text('META-INF/container.xml');
  const opfPath = (container && attr(find(parseXml(container), 'rootfile'), 'full-path')) || zip.names.find((n) => n.toLowerCase().endsWith('.opf'));
  const opfXml = opfPath && (await zip.text(opfPath));
  if (!opfXml) throw new DocumentError('This e-book has no list of its chapters (its OPF file is missing).');

  // Protected books: their chapters are encrypted (fonts alone may be obfuscated, which is fine).
  const encryption = await zip.text('META-INF/encryption.xml');
  if (encryption) {
    const refs = findAll(parseXml(encryption), 'CipherReference').map((c) => String(attr(c, 'URI') ?? ''));
    if (refs.some((u) => /\.(x?html?|xml)$/i.test(u))) throw new DocumentError('This e-book is protected (DRM), so only the app it was bought for can open it.');
  }

  const opf = parseXml(opfXml);
  const title = textOf(find(find(opf, 'metadata'), 'title')).trim();
  const author = textOf(find(find(opf, 'metadata'), 'creator')).trim();
  const manifest = new Map();
  for (const item of findAll(find(opf, 'manifest'), 'item')) {
    manifest.set(attr(item, 'id'), { path: resolvePath(opfPath, attr(item, 'href')), type: attr(item, 'media-type') ?? '', props: String(attr(item, 'properties') ?? '') });
  }
  const spineEl = find(opf, 'spine');
  const spine = findAll(spineEl, 'itemref')
    .map((r) => manifest.get(attr(r, 'idref')))
    .filter((m) => m && /x?html|xml/i.test(m.type || 'xhtml'));
  if (!spine.length) throw new DocumentError('This e-book has no chapters.');
  const chapterOf = new Map(spine.map((m, i) => [m.path, `c${i + 1}`]));
  const target = (path, frag) => {
    const chapter = chapterOf.get(path);
    if (!chapter) return null;
    return frag ? `${chapter}-${safeId(frag)}` : chapter;
  };

  // What the book's stylesheets say about its classes.
  const looks = new Map();
  for (const m of manifest.values()) {
    if (m.type !== 'text/css') continue;
    const css = await zip.text(m.path);
    if (css) for (const [k, v] of cssLooks(css)) looks.set(k, [...new Set([...(looks.get(k) ?? []), ...v])]);
  }

  let html = '';
  for (const [i, item] of spine.entries()) {
    const xml = await zip.text(item.path);
    if (xml == null) continue;
    const doc = parseXml(xml);
    const body = find(doc, 'body') ?? doc;
    const prefix = `c${i + 1}`;
    const write = (node, pre = false) => {
      // Whitespace as the page shows it (one space), except in preformatted text.
      if (typeof node === 'string') return esc(pre ? node : node.replace(/\s+/g, ' '));
      const tag = node.local.toLowerCase();
      if (DROP.has(tag)) return '';
      if (tag === 'svg') {
        // A cover or a full-page picture inside an SVG: the picture alone.
        return findAll(node, 'image')
          .map((im) => {
            const href = attr(im, 'xlink:href') ?? attr(im, 'href');
            return href && !/^[a-z]+:/i.test(href) ? `<img class="doc-cover" data-doc-img="${esc(resolvePath(item.path, href))}" alt="">` : '';
          })
          .join('');
      }
      if (tag === 'math') return `<span class="doc-math">${esc(textOf(node))}</span>`;
      const inner = () => node.children.map((c) => write(c, pre || tag === 'pre')).join('');
      if (tag === 'img' || tag === 'image') {
        const src = attr(node, 'src') ?? attr(node, 'xlink:href') ?? attr(node, 'href');
        if (!src || /^[a-z]+:/i.test(src)) return '';
        return `<img data-doc-img="${esc(resolvePath(item.path, src))}" alt="${esc(attr(node, 'alt') ?? '')}">`;
      }
      if (tag === 'a') {
        const href = attr(node, 'href');
        let to = null;
        if (href) {
          if (href.startsWith('#')) to = `#${prefix}-${safeId(href.slice(1))}`;
          else if (outsideUrl(href)) to = outsideUrl(href);
          else {
            const t = target(resolvePath(item.path, href), href.split('#')[1]);
            if (t) to = `#${t}`;
          }
        }
        const id = attr(node, 'id') ?? attr(node, 'name');
        const body = inner();
        // A note's mark (epub:type="noteref") is raised, as books' own styles do.
        const noteref = /\bnoteref\b/.test(String(attr(node, 'epub:type') ?? '')) || attr(node, 'role') === 'doc-noteref';
        const a = `<a${to ? ` href="${esc(to)}"` : ''}${id ? ` id="${prefix}-${safeId(id)}"` : ''}${noteref ? ' class="doc-noteref"' : ''}>${body}</a>`;
        return noteref && !body.includes('<sup') ? `<sup>${a}</sup>` : a;
      }
      const out = KEEP.has(tag) ? tag : RENAME[tag];
      if (!out) return inner();
      let attrs = '';
      const id = attr(node, 'id');
      if (id) attrs += ` id="${prefix}-${safeId(id)}"`;
      const classes = String(attr(node, 'class') ?? '')
        .split(/\s+/)
        .flatMap((c) => looks.get(c) ?? []);
      const align = String(attr(node, 'align') ?? '').toLowerCase();
      if (align === 'center') classes.push('al-c');
      else if (align === 'right') classes.push('al-r');
      if (classes.length) attrs += ` class="${[...new Set(classes)].join(' ')}"`;
      for (const name of ['colspan', 'rowspan', 'start']) {
        const v = attr(node, name);
        if (v && /^\d{1,4}$/.test(v)) attrs += ` ${name}="${v}"`;
      }
      const type = attr(node, 'type');
      if (tag === 'ol' && type && /^[1aAiI]$/.test(type)) attrs += ` type="${type}"`;
      const dir = attr(node, 'dir');
      if (dir === 'rtl' || dir === 'ltr') attrs += ` dir="${dir}"`;
      const lang = attr(node, 'xml:lang') ?? attr(node, 'lang');
      if (lang && /^[a-z]{2,3}(-[\w]{2,8})*$/i.test(lang)) attrs += ` lang="${esc(lang)}"`;
      const title_ = attr(node, 'title');
      if (title_ && tag === 'abbr') attrs += ` title="${esc(title_)}"`;
      return VOID.has(out) ? `<${out}${attrs}>` : `<${out}${attrs}>${inner()}</${out}>`;
    };
    html += `<section class="doc-chapter" id="${prefix}">${body.children.map((c) => write(c)).join('')}</section>`;
  }

  // The contents: the navigation document (EPUB 3), else the NCX (EPUB 2).
  const toc = [];
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  const navXml = navItem && (await zip.text(navItem.path));
  if (navXml) {
    const navs = findAll(parseXml(navXml), 'nav');
    const nav = navs.find((n) => /\btoc\b/.test(String(attr(n, 'epub:type') ?? attr(n, 'type') ?? attr(n, 'role') ?? ''))) ?? navs[0];
    const walk = (ol, depth) => {
      for (const li of kids(ol, 'li')) {
        const a = kid(li, 'a') ?? find(li, 'a');
        const href = attr(a, 'href');
        const label = textOf(a ?? kid(li, 'span')).replace(/\s+/g, ' ').trim();
        const t = href && target(resolvePath(navItem.path, href), href.split('#')[1]);
        if (label) toc.push({ label, target: t ?? null, depth });
        const sub = kid(li, 'ol');
        if (sub) walk(sub, depth + 1);
      }
    };
    if (nav) walk(find(nav, 'ol') ?? nav, 0);
  }
  if (!toc.length) {
    const ncxItem = manifest.get(attr(spineEl, 'toc')) ?? [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    const ncxXml = ncxItem && (await zip.text(ncxItem.path));
    if (ncxXml) {
      const walk = (el, depth) => {
        for (const point of kids(el, 'navPoint')) {
          const label = textOf(find(kid(point, 'navLabel'), 'text')).replace(/\s+/g, ' ').trim();
          const src = attr(kid(point, 'content'), 'src');
          const t = src && target(resolvePath(ncxItem.path, src), src.split('#')[1]);
          if (label) toc.push({ label, target: t ?? null, depth });
          walk(point, depth + 1);
        }
      };
      walk(find(parseXml(ncxXml), 'navMap') ?? { children: [] }, 0);
    }
  }
  // Entries that lead nowhere in the book are left out.
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const contents = toc.filter((e) => e.target && ids.has(e.target));

  return { html, title: title || '', author, toc: contents, image: (ref) => zipImage(zip, ref) };
}
