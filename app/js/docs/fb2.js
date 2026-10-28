// FictionBook e-books (.fb2: one XML file, pictures inside it in base64) as a page: the
// book's title and author, its sections with their titles (the contents), paragraphs with
// emphasis, poems, quotes, epigraphs, tables, pictures and notes. Pure.

import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { DocumentError, esc, outsideUrl, safeId, sniffImage } from './common.js';

const INLINE = { emphasis: 'em', strong: 'strong', strikethrough: 's', sub: 'sub', sup: 'sup', code: 'code' };

function decodeBase64(text) {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

// FictionBook files say their encoding in the XML declaration (often windows-1251).
function decodeXml(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const enc = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(enc).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export async function convertFb2(bytes) {
  const doc = parseXml(decodeXml(bytes));
  const book = find(doc, 'FictionBook');
  if (!book) throw new DocumentError('This is not a FictionBook e-book.');
  const info = find(find(book, 'description'), 'title-info');
  const title = textOf(kid(info, 'book-title')).trim();
  const authors = kids(info, 'author').map((a) => ['first-name', 'middle-name', 'last-name'].map((k) => textOf(kid(a, k)).trim()).filter(Boolean).join(' ')).filter(Boolean);
  const binaries = new Map(kids(book, 'binary').map((b) => [attr(b, 'id'), b]));
  const toc = [];
  let headingNo = 0;

  const href = (el) => attr(el, 'l:href') ?? attr(el, 'xlink:href') ?? attr(el, 'href') ?? '';
  const picture = (el) => {
    const h = href(el);
    return h.startsWith('#') && binaries.has(h.slice(1)) ? `<img data-doc-img="${esc(h.slice(1))}" alt="${esc(attr(el, 'alt') ?? '')}">` : '';
  };

  const inline = (el) => {
    let out = '';
    for (const c of el.children) {
      if (typeof c === 'string') {
        out += esc(c);
        continue;
      }
      if (INLINE[c.local]) out += `<${INLINE[c.local]}>${inline(c)}</${INLINE[c.local]}>`;
      else if (c.local === 'a') {
        const h = href(c);
        const to = h.startsWith('#') ? `#n-${safeId(h.slice(1))}` : outsideUrl(h);
        const note = attr(c, 'type') === 'note';
        const body = inline(c);
        out += to ? `${note ? '<sup>' : ''}<a href="${esc(to)}">${body}</a>${note ? '</sup>' : ''}` : body;
      } else if (c.local === 'image') out += picture(c);
      else out += inline(c);
    }
    return out;
  };

  const blocks = (el, depth) => {
    let out = '';
    for (const c of kids(el)) {
      const id = attr(c, 'id') ? ` id="n-${safeId(attr(c, 'id'))}"` : '';
      switch (c.local) {
        case 'title': {
          const n = Math.min(6, depth + 1);
          const hid = `h-${++headingNo}`;
          const label = kids(c, 'p').map(textOf).join(' ').replace(/\s+/g, ' ').trim();
          if (label && depth <= 3 && !inNotes) toc.push({ label, target: hid, depth: Math.max(0, depth - 1) });
          out += `<h${n} id="${hid}">${kids(c, 'p').map(inline).join('<br>')}</h${n}>`;
          break;
        }
        case 'p':
          out += `<p${id}>${inline(c) || '<br>'}</p>`;
          break;
        case 'subtitle':
          out += `<p class="doc-subtitle"${id}>${inline(c)}</p>`;
          break;
        case 'empty-line':
          out += '<p><br></p>';
          break;
        case 'image':
          out += `<p class="al-c"${id}>${picture(c)}</p>`;
          break;
        case 'epigraph':
        case 'cite':
          out += `<blockquote${id}>${blocks(c, depth)}${kids(c, 'text-author').map((a) => `<p class="al-r"><em>${inline(a)}</em></p>`).join('')}</blockquote>`;
          break;
        case 'poem':
          out += `<div class="doc-poem"${id}>${blocks(c, depth)}</div>`;
          break;
        case 'stanza':
          out += `<p class="doc-stanza">${kids(c, 'v').map(inline).join('<br>')}</p>`;
          break;
        case 'text-author':
          if (el.local !== 'epigraph' && el.local !== 'cite') out += `<p class="al-r"><em>${inline(c)}</em></p>`;
          break;
        case 'table':
          out += `<div class="doc-table-wrap"><table class="doc-table"><tbody>${kids(c, 'tr')
            .map((tr) => `<tr>${kids(tr).map((td) => `<${td.local === 'th' ? 'th' : 'td'}${/^\d+$/.test(attr(td, 'colspan') ?? '') ? ` colspan="${attr(td, 'colspan')}"` : ''}>${inline(td)}</${td.local === 'th' ? 'th' : 'td'}>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`;
          break;
        case 'section':
          out += `<section${id}>${blocks(c, depth + 1)}</section>`;
          break;
        case 'annotation':
          out += `<div class="doc-annotation"${id}>${blocks(c, depth)}</div>`;
          break;
      }
    }
    return out;
  };

  // The title and author are the bar's; books repeat them in their first title anyway.
  let html = '';
  const annotation = kid(info, 'annotation');
  if (annotation) html += `<div class="doc-annotation">${blocks(annotation, 1)}</div>`;
  let inNotes = false;
  for (const body of kids(book, 'body')) {
    inNotes = attr(body, 'name') === 'notes' || attr(body, 'name') === 'comments';
    html += `<section class="${inNotes ? 'doc-notes' : 'doc-chapter'}">${blocks(body, inNotes ? 1 : 0)}</section>`;
  }

  return {
    html,
    title,
    author: authors.join(', '),
    toc,
    image: async (ref) => {
      const b = binaries.get(ref);
      if (!b) return null;
      const bytes = decodeBase64(textOf(b));
      const type = attr(b, 'content-type') ?? sniffImage(bytes);
      return type && /^image\/(png|jpe?g|gif|webp|svg\+xml|bmp)$/.test(type) ? { bytes, type: type.replace('jpg', 'jpeg') } : null;
    },
  };
}
