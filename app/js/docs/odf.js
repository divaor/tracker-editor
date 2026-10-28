// OpenDocument files (LibreOffice, and others) as a page: text documents (.odt) with
// headings, paragraphs, bold, italic, underline, strike-through, super- and subscript, lists,
// tables, pictures, links and notes; spreadsheets (.ods) as a table per sheet; presentations
// (.odp) as a section per slide. Pure.

import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { columnName, esc, outsideUrl, safeId, zipImage } from './common.js';

// A sheet shows at most this much (the text gives all of it).
const MAX_ROWS = 2000;
const MAX_COLS = 80;

/** Text styles (automatic and named): name → { bold, italic, underline, strike, position }, following parents. */
function readStyles(...docs) {
  const raw = new Map();
  for (const doc of docs) {
    if (!doc) continue;
    for (const s of findAll(doc, 'style')) {
      const t = kid(s, 'text-properties');
      const pos = String(attr(t, 'style:text-position') ?? '');
      raw.set(attr(s, 'style:name'), {
        parent: attr(s, 'style:parent-style-name'),
        display: String(attr(s, 'style:display-name') ?? attr(s, 'style:name') ?? '').toLowerCase(),
        bold: t && attr(t, 'fo:font-weight') !== undefined ? /bold|[6-9]00/.test(attr(t, 'fo:font-weight')) : undefined,
        italic: t && attr(t, 'fo:font-style') !== undefined ? /italic|oblique/.test(attr(t, 'fo:font-style')) : undefined,
        underline: t && attr(t, 'style:text-underline-style') !== undefined ? attr(t, 'style:text-underline-style') !== 'none' : undefined,
        strike: t && attr(t, 'style:text-line-through-style') !== undefined ? attr(t, 'style:text-line-through-style') !== 'none' : undefined,
        position: /^super/.test(pos) || /^\d/.test(pos) && Number.parseFloat(pos) > 0 ? 'super' : /^sub/.test(pos) || /^-\d/.test(pos) ? 'sub' : undefined,
        align: attr(kid(s, 'paragraph-properties'), 'fo:text-align'),
      });
    }
  }
  const cache = new Map();
  const info = (name, depth = 0) => {
    if (!name || depth > 20) return {};
    if (cache.has(name)) return cache.get(name);
    const s = raw.get(name);
    // A style the file uses without defining it (the application's own): by its name.
    if (!s) return { title: /^title$/i.test(name), subtitle: /^subtitle$/i.test(name), quote: /quot/i.test(name) };
    const base = info(s.parent, depth + 1);
    const out = {};
    for (const k of ['bold', 'italic', 'underline', 'strike', 'position', 'align']) out[k] = s[k] ?? base[k];
    out.quote = /quot/.test(s.display) || base.quote;
    out.title = s.display === 'title' || base.title;
    out.subtitle = s.display === 'subtitle' || base.subtitle;
    cache.set(name, out);
    return out;
  };
  return info;
}

/** List styles: name → per level whether it is numbered. */
function readListStyles(...docs) {
  const map = new Map();
  for (const doc of docs) {
    if (!doc) continue;
    for (const ls of findAll(doc, 'list-style')) {
      const levels = new Map();
      for (const l of kids(ls)) {
        const level = Number(attr(l, 'text:level') ?? 1);
        if (l.local === 'list-level-style-number') levels.set(level, { ordered: true, type: { a: 'a', A: 'A', i: 'i', I: 'I' }[attr(l, 'style:num-format')] ?? '1' });
        else levels.set(level, { ordered: false });
      }
      map.set(attr(ls, 'style:name'), levels);
    }
  }
  return map;
}

const ALIGN = { center: 'al-c', end: 'al-r', right: 'al-r', justify: 'al-j' };
const unescape_ = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export async function convertOdf(zip, kind) {
  const xml = await zip.text('content.xml');
  if (!xml) throw new Error('There is no content in this file.');
  const doc = parseXml(xml);
  const stylesXml = await zip.text('styles.xml');
  const stylesDoc = stylesXml ? parseXml(stylesXml) : null;
  const style = readStyles(stylesDoc, doc);
  const listStyles = readListStyles(stylesDoc, doc);
  const metaXml = await zip.text('meta.xml');
  const title = metaXml ? textOf(find(parseXml(metaXml), 'title')).trim() : '';
  const toc = [];
  const notes = [];
  let headingNo = 0;

  const span = (el, html) => {
    const s = style(attr(el, 'text:style-name'));
    if (s.position === 'super') html = `<sup>${html}</sup>`;
    else if (s.position === 'sub') html = `<sub>${html}</sub>`;
    if (s.strike) html = `<s>${html}</s>`;
    if (s.underline) html = `<u>${html}</u>`;
    if (s.italic) html = `<em>${html}</em>`;
    if (s.bold) html = `<strong>${html}</strong>`;
    return html;
  };

  // What a paragraph holds: text, spaces, tabs, line breaks, spans, links, notes, pictures.
  const inline = (el, after) => {
    let out = '';
    for (const c of el.children) {
      if (typeof c === 'string') {
        out += esc(c.replace(/\s+/g, ' '));
        continue;
      }
      switch (c.local) {
        case 's':
          out += ' '.repeat(Math.min(200, Number(attr(c, 'text:c') ?? 1) || 1));
          break;
        case 'tab':
          out += '\t';
          break;
        case 'line-break':
          out += '<br>';
          break;
        case 'span':
          out += span(c, inline(c, after));
          break;
        case 'a': {
          const href = attr(c, 'xlink:href') ?? '';
          const target = href.startsWith('#') ? `#bm-${safeId(href.slice(1))}` : outsideUrl(href);
          out += target ? `<a href="${esc(target)}">${inline(c, after)}</a>` : inline(c, after);
          break;
        }
        case 'bookmark':
        case 'bookmark-start':
          out += `<a id="bm-${safeId(attr(c, 'text:name'))}"></a>`;
          break;
        case 'note': {
          notes.push(kid(c, 'note-body'));
          const n = notes.length;
          out += `<sup><a class="doc-noteref" id="fnref-${n}" href="#fn-${n}">${esc(textOf(kid(c, 'note-citation')) || n)}</a></sup>`;
          break;
        }
        case 'frame':
          out += frame(c, after);
          break;
        case 'meta':
        case 'ruby-base':
        case 'date':
        case 'time':
        case 'title':
        case 'subject':
        case 'author-name':
        case 'file-name':
        case 'sequence':
        case 'chapter':
        case 'text-input':
        case 'variable-get':
        case 'user-field-get':
        case 'expression':
        case 'bibliography-mark':
          out += inline(c, after);
          break;
        // Annotations (comments) and tracked deletions are not part of the text.
      }
    }
    return out;
  };

  // A frame: a picture, or a text box (its paragraphs follow the one it is in).
  const frame = (f, after) => {
    let out = '';
    for (const c of kids(f)) {
      if (c.local === 'image') {
        const href = attr(c, 'xlink:href') ?? '';
        if (href && !/^[a-z]+:/i.test(href)) out += `<img data-doc-img="${esc(href.replace(/^\.\//, ''))}" alt="${esc(textOf(kid(f, 'desc')) || textOf(kid(f, 'title')))}">`;
        // One picture per frame: the others are other formats of the same one.
        if (out) break;
      } else if (c.local === 'text-box') after.push(`<div class="doc-box">${blocks(c)}</div>`);
    }
    return out;
  };

  const paragraph = (p, tag = 'p', extra = '') => {
    const after = [];
    const s = style(attr(p, 'text:style-name'));
    const body = inline(p, after).replace(/^ | $/g, '');
    const cls = [ALIGN[s.align], s.quote && 'doc-quote', s.subtitle && 'doc-subtitle', extra].filter(Boolean).join(' ');
    return `<${tag}${cls ? ` class="${cls}"` : ''}>${body || '<br>'}</${tag}>${after.join('')}`;
  };

  const list = (l, depth = 1, styleName) => {
    const name = attr(l, 'text:style-name') ?? styleName;
    const lvl = listStyles.get(name)?.get(depth) ?? { ordered: false };
    const tag = lvl.ordered ? 'ol' : 'ul';
    let out = `<${tag}${lvl.ordered && lvl.type !== '1' ? ` type="${lvl.type}"` : ''}>`;
    for (const item of kids(l)) {
      if (item.local !== 'list-item' && item.local !== 'list-header') continue;
      let inner = '';
      for (const c of kids(item)) {
        if (c.local === 'list') inner += list(c, depth + 1, name);
        else if (c.local === 'p' || c.local === 'h') {
          const after = [];
          const body = inline(c, after).trim();
          inner += `${inner && body ? '<br>' : ''}${body}${after.join('')}`;
        }
        else inner += blocks({ children: [c] });
      }
      // An item holding only a deeper list (how a second level is written): no bullet of its own.
      out += `<li${inner.startsWith('<ul') || inner.startsWith('<ol') ? ' class="doc-nest"' : ''}>${inner || '<br>'}</li>`;
    }
    return `${out}</${tag}>`;
  };

  const table = (t) => {
    let body = '';
    let rows = 0;
    const rowsOf = (el) => kids(el).flatMap((c) => (c.local === 'table-row' ? [c] : ['table-header-rows', 'table-rows', 'table-row-group'].includes(c.local) ? rowsOf(c) : []));
    for (const tr of rowsOf(t)) {
      const repeat = Math.min(Number(attr(tr, 'table:number-rows-repeated') ?? 1) || 1, 50);
      let cells = '';
      for (const tc of kids(tr)) {
        if (tc.local !== 'table-cell') continue;
        const cs = Number(attr(tc, 'table:number-columns-spanned') ?? 1);
        const rs = Number(attr(tc, 'table:number-rows-spanned') ?? 1);
        const reps = Math.min(Number(attr(tc, 'table:number-columns-repeated') ?? 1) || 1, 50);
        const html = `<td${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}>${blocks(tc)}</td>`;
        cells += html.repeat(reps);
      }
      for (let k = 0; k < repeat && rows < MAX_ROWS; k++, rows++) body += `<tr>${cells}</tr>`;
    }
    return `<div class="doc-table-wrap"><table class="doc-table"><tbody>${body}</tbody></table></div>`;
  };

  const blocks = (container) => {
    let out = '';
    for (const c of container.children ?? []) {
      if (typeof c === 'string') continue;
      switch (c.local) {
        case 'h': {
          const level = Math.min(6, Number(attr(c, 'text:outline-level') ?? 1) || 1);
          const id = `h-${++headingNo}`;
          const body = inline(c, []).trim();
          const plain = textOf(c).trim();
          if (plain && level <= 3) toc.push({ label: plain, target: id, depth: level - 1 });
          out += `<h${level} id="${id}">${body}</h${level}>`;
          break;
        }
        case 'p':
          out += style(attr(c, 'text:style-name')).title ? `<h1 id="h-${++headingNo}">${inline(c, []).trim()}</h1>` : paragraph(c);
          break;
        case 'list':
          out += list(c);
          break;
        case 'table':
          out += table(c);
          break;
        case 'section':
        case 'index-body':
          out += blocks(c);
          break;
        case 'table-of-content':
        case 'alphabetical-index':
        case 'illustration-index':
        case 'table-index':
        case 'object-index':
        case 'user-index':
        case 'bibliography':
          out += blocks(kid(c, 'index-body') ?? c);
          break;
        case 'frame':
          out += `<p>${frame(c, [])}</p>`;
          break;
        case 'soft-page-break':
        case 'tracked-changes':
        case 'sequence-decls':
        case 'variable-decls':
        case 'user-field-decls':
          break;
      }
    }
    return out;
  };

  let html = '';
  let text = '';
  const office = find(doc, 'body');
  if (kind === 'ods') {
    const sheets = findAll(office ?? doc, 'table');
    sheets.forEach((t, i) => {
      const name = attr(t, 'table:name') || `Sheet ${i + 1}`;
      const id = `sheet-${i + 1}`;
      toc.push({ label: name, target: id, depth: 0 });
      const sheet = sheetTable(t);
      html += `<section class="doc-sheet"><h2 id="${id}">${esc(name)}</h2>${sheet.html}</section>`;
      text += `${name}\n${sheet.text}\n`;
    });
    if (!sheets.length) html = '<p>This workbook has no sheets.</p>';
  } else if (kind === 'odp') {
    const slides = findAll(office ?? doc, 'page');
    slides.forEach((pg, i) => {
      const id = `slide-${i + 1}`;
      const name = attr(pg, 'draw:name');
      let inner = '';
      let title_ = '';
      const shapes = (el) => {
        for (const c of kids(el)) {
          if (c.local === 'frame') {
            const box = kid(c, 'text-box');
            const cls = attr(c, 'presentation:class');
            if (box && (cls === 'title' || cls === 'subtitle') && !title_) title_ = textOf(box).trim() && `<h2>${kids(box, 'p').map((p) => inline(p, [])).join('<br>')}</h2>`;
            else if (box) inner += blocks(box);
            else if (kid(c, 'table')) inner += table(kid(c, 'table'));
            else inner += `<p>${frame(c, [])}</p>`;
          } else if (['custom-shape', 'rect', 'ellipse', 'polygon'].includes(c.local)) inner += blocks(c);
          else if (c.local === 'g') shapes(c);
        }
      };
      shapes(pg);
      const notesBody = kid(pg, 'notes');
      let notesHtml = '';
      if (notesBody) for (const f of findAll(notesBody, 'text-box')) notesHtml += blocks(f);
      const label = (title_ ? title_.replace(/<[^>]+>/g, ' ') : textOf(find(pg, 'p'))).replace(/\s+/g, ' ').trim().slice(0, 60);
      toc.push({ label: `${i + 1}. ${unescape_(label) || name || `Slide ${i + 1}`}`, target: id, depth: 0 });
      html += `<section class="doc-slide" id="${id}"><p class="doc-slide-no">Slide ${i + 1}</p>${title_}${inner}${notesHtml ? `<div class="doc-slide-notes">${notesHtml}</div>` : ''}</section>`;
    });
  } else {
    html = blocks(find(office ?? doc, 'text') ?? office ?? doc);
  }

  if (notes.length) {
    html += `<section class="doc-notes"><h2>Notes</h2><ol>${notes.map((n, i) => `<li id="fn-${i + 1}">${n ? blocks(n) : ''} <a class="doc-noteback" href="#fnref-${i + 1}" aria-label="Back">↩</a></li>`).join('')}</ol></section>`;
  }
  return { html, ...(kind === 'ods' ? { text: text.trim() } : {}), title, toc, image: (ref) => zipImage(zip, ref) };

  // A sheet: its used part, with the column letters and row numbers.
  function sheetTable(t) {
    const grid = [];
    let width = 0;
    const rowsOf = (el) => kids(el).flatMap((c) => (c.local === 'table-row' ? [c] : ['table-header-rows', 'table-rows', 'table-row-group'].includes(c.local) ? rowsOf(c) : []));
    for (const tr of rowsOf(t)) {
      const repeat = Number(attr(tr, 'table:number-rows-repeated') ?? 1) || 1;
      const cells = [];
      for (const tc of kids(tr)) {
        if (tc.local !== 'table-cell' && tc.local !== 'covered-table-cell') continue;
        const reps = Number(attr(tc, 'table:number-columns-repeated') ?? 1) || 1;
        const text = kids(tc, 'p').map((p) => inline(p, [])).join('<br>');
        const cell = tc.local === 'covered-table-cell' ? { covered: true } : { html: text, cs: Number(attr(tc, 'table:number-columns-spanned') ?? 1), rs: Number(attr(tc, 'table:number-rows-spanned') ?? 1), num: attr(tc, 'office:value-type') && attr(tc, 'office:value-type') !== 'string' };
        for (let k = 0; k < Math.min(reps, MAX_COLS + 1 - cells.length); k++) cells.push(cell);
      }
      for (let k = 0; k < Math.min(repeat, MAX_ROWS + 1 - grid.length); k++) grid.push(cells);
      if (grid.length > MAX_ROWS) break;
    }
    // The used part: up to the last row and column with something in them.
    let last = -1;
    grid.forEach((cells, r) => {
      const used = cells.reduce((m, c, i) => (c.html ? i : m), -1);
      if (used >= 0) last = r;
      width = Math.max(width, used + 1);
    });
    const rows = grid.slice(0, last + 1);
    if (!rows.length) return { html: '<p class="doc-empty">This sheet is empty.</p>', text: '' };
    const plainCell = (c) => (c?.html ?? '').replace(/<br>/g, ' ').replace(/<[^>]+>/g, '');
    const sheetText = rows
      .map((cells) => unescape_(cells.slice(0, width).map(plainCell).join('\t').replace(/\t+$/, '')))
      .filter(Boolean)
      .join('\n');
    width = Math.min(width, MAX_COLS);
    let out = `<div class="doc-table-wrap"><table class="doc-table doc-grid"><thead><tr><th></th>${Array.from({ length: width }, (_, i) => `<th>${columnName(i)}</th>`).join('')}</tr></thead><tbody>`;
    rows.forEach((cells, r) => {
      out += `<tr><th>${r + 1}</th>`;
      for (let i = 0; i < width; i++) {
        const c = cells[i];
        if (!c) out += '<td></td>';
        else if (c.covered) continue;
        else out += `<td${c.cs > 1 ? ` colspan="${c.cs}"` : ''}${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}${c.num ? ' class="num"' : ''}>${c.html}</td>`;
      }
      out += '</tr>';
    });
    out += '</tbody></table></div>';
    if (grid.length > MAX_ROWS) out += `<p class="doc-more">The first ${MAX_ROWS.toLocaleString()} rows.</p>`;
    return { html: out, text: sheetText };
  }
}
