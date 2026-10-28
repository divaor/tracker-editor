// Word documents (.docx, WordprocessingML) as a page: headings by their styles, paragraphs
// with bold, italic, underline, strike-through, super- and subscript and highlights, lists
// (bulleted and numbered, nested), tables (merged cells too), pictures, links (and the TOC's
// links inside the document), text boxes, footnotes and endnotes. Page layout, fonts and
// colors are left to the page's own look. Pure.

import { resolvePath } from '../unzip.js';
import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { esc, outsideUrl, safeId, zipImage } from './common.js';

const W_OFF = new Set(['0', 'false', 'off', 'none']);
/** A toggle property (w:b, w:i…): on when there, unless its value says off. */
const on = (props, local) => {
  const el = kid(props, local);
  return Boolean(el) && !W_OFF.has(String(attr(el, 'w:val') ?? '').toLowerCase());
};

/** The relationships of a part ("word/document.xml" → its rels): id → { target, external, type }. */
export async function relsOf(zip, part) {
  const dir = part.slice(0, part.lastIndexOf('/') + 1);
  const xml = await zip.text(`${dir}_rels/${part.slice(dir.length)}.rels`);
  const map = new Map();
  if (!xml) return map;
  for (const r of findAll(parseXml(xml), 'Relationship')) {
    const external = attr(r, 'TargetMode') === 'External';
    const target = attr(r, 'Target') ?? '';
    map.set(attr(r, 'Id'), { target: external ? target : resolvePath(part, target), external, type: String(attr(r, 'Type') ?? '').split('/').pop() });
  }
  return map;
}

/** The main part an Office file names in its _rels/.rels (word/document.xml, ppt/presentation.xml…). */
export async function mainPart(zip, fallback) {
  for (const r of (await relsOf(zip, '')).values()) if (r.type === 'officeDocument') return r.target;
  return fallback;
}

/** The title in docProps/core.xml (dc:title), if any. */
export async function coreTitle(zip) {
  const xml = await zip.text('docProps/core.xml');
  return xml ? textOf(find(parseXml(xml), 'title')).trim() : '';
}

const LIST_TYPES = { decimal: '1', decimalZero: '1', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

/** Paragraph styles: id → { heading, quote, title, numPr, bold, italic } (following basedOn). */
function readStyles(xml) {
  const raw = new Map();
  if (xml) {
    for (const s of findAll(parseXml(xml), 'style')) {
      const pPr = kid(s, 'pPr');
      const rPr = kid(s, 'rPr');
      raw.set(attr(s, 'w:styleId'), {
        name: String(attr(kid(s, 'name'), 'w:val') ?? '').toLowerCase(),
        basedOn: attr(kid(s, 'basedOn'), 'w:val'),
        outline: attr(kid(pPr, 'outlineLvl'), 'w:val'),
        numPr: kid(pPr, 'numPr'),
        bold: kid(rPr, 'b') ? on(rPr, 'b') : undefined,
        italic: kid(rPr, 'i') ? on(rPr, 'i') : undefined,
      });
    }
  }
  const cache = new Map();
  const info = (id, depth = 0) => {
    if (!id || depth > 20) return {};
    if (cache.has(id)) return cache.get(id);
    const s = raw.get(id);
    if (!s) return {};
    const base = info(s.basedOn, depth + 1);
    const h = /^heading\s*(\d)$/.exec(s.name) ?? /^heading(\d)$/i.exec(id);
    const out = {
      heading: h ? Number(h[1]) : s.outline !== undefined && Number(s.outline) < 9 ? Number(s.outline) + 1 : s.name === 'title' ? 1 : base.heading,
      title: s.name === 'title' || id === 'Title' || base.title,
      subtitle: s.name === 'subtitle' || base.subtitle,
      quote: /quote/.test(s.name) || base.quote,
      numPr: s.numPr ?? base.numPr,
      bold: s.bold ?? base.bold,
      italic: s.italic ?? base.italic,
    };
    cache.set(id, out);
    return out;
  };
  return info;
}

/** Lists: (numId, level) → { ordered, type, start }. */
function readNumbering(xml) {
  const abstract = new Map();
  const nums = new Map();
  if (xml) {
    const doc = parseXml(xml);
    for (const a of findAll(doc, 'abstractNum')) {
      const levels = new Map();
      for (const l of kids(a, 'lvl')) levels.set(Number(attr(l, 'w:ilvl') ?? 0), { fmt: attr(kid(l, 'numFmt'), 'w:val') ?? 'decimal', start: Number(attr(kid(l, 'start'), 'w:val') ?? 1) });
      abstract.set(attr(a, 'w:abstractNumId'), levels);
    }
    for (const n of findAll(doc, 'num')) nums.set(attr(n, 'w:numId'), attr(kid(n, 'abstractNumId'), 'w:val'));
  }
  return (numId, level) => {
    const lvl = abstract.get(nums.get(numId))?.get(level) ?? { fmt: 'bullet', start: 1 };
    const ordered = lvl.fmt !== 'bullet' && lvl.fmt !== 'none';
    return { ordered, type: LIST_TYPES[lvl.fmt] ?? '1', start: lvl.start, key: `${numId}:${level}:${ordered}` };
  };
}

export async function convertDocx(zip) {
  const part = await mainPart(zip, 'word/document.xml');
  const xml = await zip.text(part);
  if (!xml) throw new Error('There is no document in this file.');
  const rels = await relsOf(zip, part);
  const partOf = (type, fallback) => [...rels.values()].find((r) => r.type === type)?.target ?? fallback;
  const style = readStyles(await zip.text(partOf('styles', 'word/styles.xml')));
  const list = readNumbering(await zip.text(partOf('numbering', 'word/numbering.xml')));
  const notes = { footnote: new Map(), endnote: new Map() };
  const used = { footnote: [], endnote: [] };
  const toc = [];
  let headingNo = 0;

  // ---- Text runs ----
  const fields = []; // Word's fields (HYPERLINK, PAGE…): only what they show is kept
  const inInstruction = () => fields.some((f) => !f.shown);

  const linkOpen = (instr) => {
    const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]*)"/i.exec(instr);
    if (!m) return '';
    const internal = /\\l/.test(instr) || !/^[a-z]+:/i.test(m[1]);
    const href = internal ? `#bm-${safeId(m[1].replace(/^#/, ''))}` : outsideUrl(m[1]);
    return href ? `<a href="${esc(href)}">` : '';
  };

  const pictures = (el, rels_) => {
    let out = '';
    for (const blip of [...findAll(el, 'blip'), ...findAll(el, 'imagedata')]) {
      const id = attr(blip, 'r:embed') ?? attr(blip, 'r:id');
      const r = id && rels_.get(id);
      if (!r || r.external) continue;
      const pr = find(el, 'docPr');
      out += `<img data-doc-img="${esc(r.target)}" alt="${esc(attr(pr, 'descr') || attr(pr, 'title') || '')}">`;
    }
    return out;
  };

  const run = (r, ctx) => {
    const rPr = kid(r, 'rPr');
    const char = style(attr(kid(rPr, 'rStyle'), 'w:val'));
    let text = '';
    for (const c of r.children) {
      if (typeof c === 'string') continue;
      switch (c.local) {
        case 'fldChar': {
          const type = attr(c, 'w:fldCharType');
          if (type === 'begin') fields.push({ instr: '', shown: false, close: '' });
          else if (type === 'separate' && fields.length) {
            const f = fields[fields.length - 1];
            f.shown = true;
            const open = linkOpen(f.instr);
            if (open) (text += open), (f.close = '</a>');
          } else if (type === 'end' && fields.length) text += fields.pop().close;
          continue;
        }
        case 'instrText':
          if (fields.length) fields[fields.length - 1].instr += textOf(c);
          continue;
      }
      if (inInstruction()) continue;
      switch (c.local) {
        case 't':
          text += esc(textOf(c));
          break;
        case 'tab':
        case 'ptab':
          text += '\t';
          break;
        case 'br':
        case 'cr':
          if (attr(c, 'w:type') !== 'page' && attr(c, 'w:type') !== 'column') text += '<br>';
          break;
        case 'noBreakHyphen':
          text += '\u2011';
          break;
        case 'softHyphen':
          text += '\u00ad';
          break;
        case 'sym': {
          const code = parseInt(attr(c, 'w:char') ?? '', 16);
          if (code > 0) text += esc(String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code));
          break;
        }
        case 'drawing':
        case 'pict':
        case 'object':
          text += pictures(c, ctx.rels);
          for (const box of findAll(c, 'txbxContent')) ctx.after.push(`<div class="doc-box">${blocks(box, ctx)}</div>`);
          break;
        case 'AlternateContent': {
          const pick = kid(c, 'Choice') ?? kid(c, 'Fallback');
          if (pick) text += run({ ...r, children: [rPr, ...pick.children].filter(Boolean) }, ctx);
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference': {
          const kind = c.local === 'footnoteReference' ? 'footnote' : 'endnote';
          const id = attr(c, 'w:id');
          used[kind].push(id);
          const n = used[kind].length;
          const p = kind === 'footnote' ? 'fn' : 'en';
          text += `<sup><a class="doc-noteref" id="${p}ref-${safeId(id)}" href="#${p}-${safeId(id)}">${kind === 'endnote' ? toRoman(n) : n}</a></sup>`;
          break;
        }
        case 'footnoteRef':
        case 'endnoteRef':
          break;
      }
    }
    if (!text) return '';
    const bold = kid(rPr, 'b') ? on(rPr, 'b') : (char.bold ?? false);
    const italic = kid(rPr, 'i') ? on(rPr, 'i') : (char.italic ?? false);
    const u = kid(rPr, 'u');
    const valign = attr(kid(rPr, 'vertAlign'), 'w:val');
    const highlight = attr(kid(rPr, 'highlight'), 'w:val');
    if (highlight && highlight !== 'none') text = `<mark>${text}</mark>`;
    if (valign === 'superscript') text = `<sup>${text}</sup>`;
    else if (valign === 'subscript') text = `<sub>${text}</sub>`;
    if (on(rPr, 'strike') || on(rPr, 'dstrike')) text = `<s>${text}</s>`;
    if (u && !W_OFF.has(String(attr(u, 'w:val') ?? 'single'))) text = `<u>${text}</u>`;
    if (italic) text = `<em>${text}</em>`;
    if (bold) text = `<strong>${text}</strong>`;
    return text;
  };

  const inline = (el, ctx) => {
    let out = '';
    for (const c of el.children) {
      if (typeof c === 'string') continue;
      switch (c.local) {
        case 'r':
          out += run(c, ctx);
          break;
        case 'hyperlink': {
          const r = ctx.rels.get(attr(c, 'r:id'));
          const anchor = attr(c, 'w:anchor');
          const href = r?.external ? outsideUrl(r.target) : anchor ? `#bm-${safeId(anchor)}` : null;
          const body = inline(c, ctx);
          out += href ? `<a href="${esc(href)}">${body}</a>` : body;
          break;
        }
        case 'fldSimple': {
          const open = linkOpen(attr(c, 'w:instr') ?? '');
          out += open ? `${open}${inline(c, ctx)}</a>` : inline(c, ctx);
          break;
        }
        case 'bookmarkStart': {
          const name = attr(c, 'w:name');
          if (name && name !== '_GoBack') out += `<a id="bm-${safeId(name)}"></a>`;
          break;
        }
        case 'sdt':
          out += inline(kid(c, 'sdtContent') ?? c, ctx);
          break;
        case 'ins':
        case 'smartTag':
        case 'customXml':
        case 'moveTo':
        case 'dir':
        case 'bdo':
          out += inline(c, ctx);
          break;
        case 'oMath':
        case 'oMathPara':
          out += `<span class="doc-math">${esc(findAll(c, 't').map(textOf).join(''))}</span>`;
          break;
        case 'AlternateContent': {
          const pick = kid(c, 'Choice') ?? kid(c, 'Fallback');
          if (pick) out += inline(pick, ctx);
          break;
        }
      }
    }
    return out;
  };

  // ---- Paragraphs, lists, tables ----
  const ALIGN = { center: 'al-c', right: 'al-r', end: 'al-r', both: 'al-j', distribute: 'al-j' };

  const blocks = (container, ctx) => {
    let out = '';
    const open = []; // the lists open: { tag, level, key }
    const closeLists = (to = 0) => {
      while (open.length > to) out += `</li></${open.pop().tag}>`;
    };
    const walk = (el) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (c.local === 'p') paragraph(c);
        else if (c.local === 'tbl') {
          closeLists();
          out += table(c, ctx);
        } else if (c.local === 'sdt') walk(kid(c, 'sdtContent') ?? c);
        else if (['customXml', 'ins', 'moveTo'].includes(c.local)) walk(c);
        else if (c.local === 'AlternateContent') walk(kid(c, 'Choice') ?? kid(c, 'Fallback') ?? { children: [] });
        else if (c.local === 'bookmarkStart' && attr(c, 'w:name') !== '_GoBack') out += `<a id="bm-${safeId(attr(c, 'w:name'))}"></a>`;
      }
    };
    const paragraph = (p) => {
      const pPr = kid(p, 'pPr');
      const st = style(attr(kid(pPr, 'pStyle'), 'w:val'));
      const numPr = kid(pPr, 'numPr') ?? st.numPr;
      const numId = attr(kid(numPr, 'numId'), 'w:val');
      const level = Number(attr(kid(numPr, 'ilvl'), 'w:val') ?? 0);
      const align = ALIGN[attr(kid(pPr, 'jc'), 'w:val')] ?? '';
      const own = { ...ctx, after: [] };
      const body = inline(p, own);
      if (numId && numId !== '0' && !st.heading) {
        const l = list(numId, level);
        while (open.length && open[open.length - 1].level > level) out += `</li></${open.pop().tag}>`;
        if (open.length && open[open.length - 1].level === level && open[open.length - 1].key !== l.key) out += `</li></${open.pop().tag}>`;
        if (open.length && open[open.length - 1].level === level) out += '</li><li>';
        else {
          const tag = l.ordered ? 'ol' : 'ul';
          out += l.ordered ? `<ol${l.type !== '1' ? ` type="${l.type}"` : ''}${l.start !== 1 ? ` start="${l.start}"` : ''}><li>` : '<ul><li>';
          open.push({ tag, level, key: l.key });
        }
        out += `${body || '<br>'}${own.after.join('')}`;
        return;
      }
      closeLists();
      if (st.heading) {
        const n = Math.min(6, st.heading);
        const id = `h-${++headingNo}`;
        const plain = body.replace(/<[^>]+>/g, '').trim();
        if (plain && n <= 3 && !ctx.inTable) toc.push({ label: plain.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), target: id, depth: n - 1 });
        out += `<h${n} id="${id}"${align ? ` class="${align}"` : ''}>${body}</h${n}>`;
      } else {
        const cls = [align, st.quote && 'doc-quote', st.subtitle && 'doc-subtitle'].filter(Boolean).join(' ');
        out += `<p${cls ? ` class="${cls}"` : ''}>${body || '<br>'}</p>`;
      }
      out += own.after.join('');
    };
    walk(container);
    closeLists();
    return out;
  };

  const table = (tbl, ctx) => {
    const inner = { ...ctx, inTable: true };
    const rows = [];
    const active = []; // per grid column: the cell a vertical merge continues
    for (const tr of rowsOf(tbl)) {
      const trPr = kid(tr, 'trPr');
      const header = Boolean(kid(trPr, 'tblHeader'));
      let col = Number(attr(kid(trPr, 'gridBefore'), 'w:val') ?? 0);
      const cells = [];
      for (const tc of cellsOf(tr)) {
        const tcPr = kid(tc, 'tcPr');
        const span = Math.max(1, Number(attr(kid(tcPr, 'gridSpan'), 'w:val') ?? 1) || 1);
        const vm = kid(tcPr, 'vMerge');
        if (vm && attr(vm, 'w:val') !== 'restart') {
          if (active[col]) active[col].rowspan++;
          col += span;
          continue;
        }
        const cell = { html: blocks(tc, inner), colspan: span, rowspan: 1, header };
        for (let k = 0; k < span; k++) active[col + k] = vm ? cell : null;
        cells.push(cell);
        col += span;
      }
      rows.push(cells);
    }
    const body = rows
      .map(
        (cells) =>
          `<tr>${cells.map((c) => `<${c.header ? 'th' : 'td'}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.html}</${c.header ? 'th' : 'td'}>`).join('')}</tr>`,
      )
      .join('');
    return `<div class="doc-table-wrap"><table class="doc-table"><tbody>${body}</tbody></table></div>`;
  };

  const ctx = { rels, after: [] };
  const doc = parseXml(xml);
  const body = find(doc, 'body');
  let html = blocks(body ?? doc, ctx);

  // Footnotes and endnotes, in the order they are referred to.
  for (const kind of ['footnote', 'endnote']) {
    if (!used[kind].length) continue;
    const notesPart = partOf(`${kind}s`, `word/${kind}s.xml`);
    const notesXml = await zip.text(notesPart);
    if (!notesXml) continue;
    const notesCtx = { rels: await relsOf(zip, notesPart), after: [] };
    for (const n of findAll(parseXml(notesXml), kind)) notes[kind].set(attr(n, 'w:id'), n);
    const p = kind === 'footnote' ? 'fn' : 'en';
    const items = used[kind]
      .map((id) => {
        const n = notes[kind].get(id);
        return n ? `<li id="${p}-${safeId(id)}">${blocks(n, notesCtx)} <a class="doc-noteback" href="#${p}ref-${safeId(id)}" aria-label="Back">↩</a></li>` : '';
      })
      .join('');
    html += `<section class="doc-notes"><h2>${kind === 'footnote' ? 'Notes' : 'Endnotes'}</h2><ol${kind === 'endnote' ? ' type="i"' : ''}>${items}</ol></section>`;
  }

  return { html, title: await coreTitle(zip), toc, image: (ref) => zipImage(zip, ref) };
}

// Rows and cells, also inside content controls (w:sdt) and custom XML.
function rowsOf(tbl) {
  const out = [];
  const walk = (el) => {
    for (const c of kids(el)) {
      if (c.local === 'tr') out.push(c);
      else if (c.local === 'sdt') walk(kid(c, 'sdtContent') ?? c);
      else if (c.local === 'customXml') walk(c);
    }
  };
  walk(tbl);
  return out;
}

function cellsOf(tr) {
  const out = [];
  const walk = (el) => {
    for (const c of kids(el)) {
      if (c.local === 'tc') out.push(c);
      else if (c.local === 'sdt') walk(kid(c, 'sdtContent') ?? c);
      else if (c.local === 'customXml') walk(c);
    }
  };
  walk(tr);
  return out;
}

function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of map) while (n >= v) (out += s), (n -= v);
  return out;
}
