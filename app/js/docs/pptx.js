// PowerPoint presentations (.pptx, PresentationML) as a page: a section per slide, in the
// show's order, with its title, its text (bullets as lists), tables and pictures, then the
// speaker's notes. Positions and design are left out. Pure.

import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { esc, outsideUrl, zipImage } from './common.js';
import { coreTitle, mainPart, relsOf } from './docx.js';

// A text body's paragraphs: bullets (with their levels) as lists, the rest as paragraphs.
function textBody(body, rels, { title = false } = {}) {
  let out = '';
  const open = [];
  const close = (to = 0) => {
    while (open.length > to) out += `</li></${open.pop()}>`;
  };
  for (const p of kids(body, 'p')) {
    const pPr = kid(p, 'pPr');
    let html = '';
    for (const c of kids(p)) {
      if (c.local === 'r' || c.local === 'fld') {
        const rPr = kid(c, 'rPr');
        let t = esc(textOf(kid(c, 't')));
        if (!t) continue;
        const baseline = Number(attr(rPr, 'baseline') ?? 0);
        if (baseline > 0) t = `<sup>${t}</sup>`;
        else if (baseline < 0) t = `<sub>${t}</sub>`;
        if (attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike') t = `<s>${t}</s>`;
        if (attr(rPr, 'u') && attr(rPr, 'u') !== 'none') t = `<u>${t}</u>`;
        if (attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true') t = `<em>${t}</em>`;
        if (!title && (attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true')) t = `<strong>${t}</strong>`;
        const link = rels.get(attr(kid(rPr, 'hlinkClick'), 'r:id'));
        const href = link?.external && outsideUrl(link.target);
        html += href ? `<a href="${esc(href)}">${t}</a>` : t;
      } else if (c.local === 'br') html += '<br>';
    }
    const level = Number(attr(pPr, 'lvl') ?? 0);
    // In a body placeholder every paragraph is a bullet unless it says none; elsewhere only those that say one.
    const bullet = !title && !kid(pPr, 'buNone') && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum') || body.bulleted);
    if (!html) {
      if (!bullet) close();
      continue;
    }
    if (bullet) {
      const tag = kid(pPr, 'buAutoNum') ? 'ol' : 'ul';
      while (open.length > level + 1) out += `</li></${open.pop()}>`;
      if (open.length === level + 1) {
        if (open[open.length - 1] !== tag) {
          out += `</li></${open.pop()}><${tag}><li>`;
          open.push(tag);
        } else out += '</li><li>';
      } else {
        while (open.length < level + 1) {
          out += `<${tag}><li>`;
          open.push(tag);
        }
      }
      out += html;
    } else {
      close();
      out += title ? html : `<p>${html}</p>`;
    }
  }
  close();
  return out;
}

const table = (tbl, rels) =>
  `<div class="doc-table-wrap"><table class="doc-table"><tbody>${kids(tbl, 'tr')
    .map(
      (tr) =>
        `<tr>${kids(tr, 'tc')
          .filter((tc) => !['1', 'true'].includes(attr(tc, 'hMerge')) && !['1', 'true'].includes(attr(tc, 'vMerge')))
          .map((tc) => {
            const cs = Number(attr(tc, 'gridSpan') ?? 1);
            const rs = Number(attr(tc, 'rowSpan') ?? 1);
            return `<td${cs > 1 ? ` colspan="${cs}"` : ''}${rs > 1 ? ` rowspan="${rs}"` : ''}>${textBody(kid(tc, 'txBody') ?? { children: [] }, rels)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;

// The shapes of a slide, in their order: the title is taken out to head the slide.
function shapes(tree, rels, out) {
  for (const c of kids(tree)) {
    if (c.local === 'sp') {
      const ph = find(kid(c, 'nvSpPr'), 'ph');
      const type = attr(ph, 'type') ?? (ph ? 'body' : '');
      const body = kid(c, 'txBody');
      if (!body) continue;
      if (type === 'title' || type === 'ctrTitle') out.title ||= textBody(body, rels, { title: true });
      else if (['dt', 'ftr', 'sldNum'].includes(type)) continue;
      else out.body += textBody(Object.assign(body, { bulleted: type === 'body' || (ph && !attr(ph, 'type')) }), rels);
    } else if (c.local === 'pic') {
      const id = attr(find(c, 'blip'), 'r:embed');
      const r = id && rels.get(id);
      if (r && !r.external) out.body += `<p><img data-doc-img="${esc(r.target)}" alt="${esc(attr(find(c, 'cNvPr'), 'descr') ?? '')}"></p>`;
    } else if (c.local === 'graphicFrame') {
      const tbl = find(c, 'tbl');
      if (tbl) out.body += table(tbl, rels);
    } else if (c.local === 'grpSp') shapes(c, rels, out);
    else if (c.local === 'AlternateContent') shapes(kid(c, 'Choice') ?? kid(c, 'Fallback') ?? { children: [] }, rels, out);
  }
}

export async function convertPptx(zip) {
  const pres = await mainPart(zip, 'ppt/presentation.xml');
  const xml = await zip.text(pres);
  if (!xml) throw new Error('There is no presentation in this file.');
  const rels = await relsOf(zip, pres);
  const ids = findAll(find(parseXml(xml), 'sldIdLst'), 'sldId');
  const toc = [];
  let html = '';
  let n = 0;
  for (const s of ids) {
    const part = rels.get(attr(s, 'r:id'))?.target;
    const slideXml = part && (await zip.text(part));
    if (!slideXml) continue;
    n++;
    const slide = parseXml(slideXml);
    if (attr(find(slide, 'sld'), 'show') === '0') continue;
    const slideRels = await relsOf(zip, part);
    const out = { title: '', body: '' };
    shapes(find(slide, 'spTree') ?? { children: [] }, slideRels, out);
    // The speaker's notes: the notes slide's body placeholder.
    let notes = '';
    const notesPart = [...slideRels.values()].find((r) => r.type === 'notesSlide')?.target;
    const notesXml = notesPart && (await zip.text(notesPart));
    if (notesXml) {
      for (const sp of findAll(parseXml(notesXml), 'sp')) {
        if (attr(find(kid(sp, 'nvSpPr'), 'ph'), 'type') === 'body' && kid(sp, 'txBody')) notes += textBody(kid(sp, 'txBody'), slideRels);
      }
    }
    const id = `slide-${n}`;
    const plainTitle = out.title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    toc.push({ label: `${n}. ${plainTitle || `Slide ${n}`}`, target: id, depth: 0 });
    html += `<section class="doc-slide" id="${id}"><p class="doc-slide-no">Slide ${n}</p>${out.title ? `<h2>${out.title}</h2>` : ''}${out.body}${notes ? `<div class="doc-slide-notes">${notes}</div>` : ''}</section>`;
  }
  if (!n) html = '<p>This presentation has no slides.</p>';
  return { html, title: await coreTitle(zip), toc, image: (ref) => zipImage(zip, ref) };
}
