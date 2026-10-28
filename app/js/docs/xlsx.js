// Excel workbooks (.xlsx, SpreadsheetML) as a page: a table per sheet with the column letters
// and row numbers, the values as Excel shows the plain ones (shared and inline strings,
// numbers, dates, TRUE/FALSE, errors), merged cells. Formulas show their last value. Pure.

import { attr, find, findAll, kid, kids, parseXml, textOf } from '../xmlLite.js';
import { columnIndex, columnName, esc } from './common.js';
import { coreTitle, mainPart, relsOf } from './docx.js';

const MAX_ROWS = 2000;
const MAX_COLS = 80;

// Number formats that are dates (Excel's built-in ids), and custom ones with day, month or year parts.
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateFormat = (code) => /[dmy]/i.test(String(code).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^[#0.,%\s]+$/.test(code);

/** A date from Excel's day number (1900 system, or 1904). */
function excelDate(serial, date1904) {
  const days = date1904 ? serial + 1462 : serial;
  const ms = Math.round((days - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  const time = iso.slice(11, 19);
  return time === '00:00:00' ? iso.slice(0, 10) : days < 1 ? time : `${iso.slice(0, 10)} ${time}`;
}

const plainNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
};

export async function convertXlsx(zip) {
  const book = await mainPart(zip, 'xl/workbook.xml');
  const bookXml = await zip.text(book);
  if (!bookXml) throw new Error('There is no workbook in this file.');
  const bookDoc = parseXml(bookXml);
  const rels = await relsOf(zip, book);
  const relOf = (type) => [...rels.values()].find((r) => r.type === type)?.target;
  const date1904 = ['1', 'true'].includes(String(attr(find(bookDoc, 'workbookPr'), 'date1904') ?? ''));

  // Shared strings: each a text, or rich runs.
  const strings = [];
  const sstXml = await zip.text(relOf('sharedStrings') ?? 'xl/sharedStrings.xml');
  if (sstXml) for (const si of findAll(parseXml(sstXml), 'si')) strings.push(richText(si));

  // Which cell styles are dates.
  const dateStyles = new Set();
  const stylesXml = await zip.text(relOf('styles') ?? 'xl/styles.xml');
  if (stylesXml) {
    const st = parseXml(stylesXml);
    const custom = new Map(findAll(st, 'numFmt').map((f) => [Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '']));
    const xfs = kids(find(st, 'cellXfs'), 'xf');
    xfs.forEach((xf, i) => {
      const id = Number(attr(xf, 'numFmtId') ?? 0);
      if (DATE_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
    });
  }

  const toc = [];
  let html = '';
  let text = '';
  const sheets = findAll(bookDoc, 'sheet');
  for (const [i, sheet] of sheets.entries()) {
    const name = attr(sheet, 'name') || `Sheet ${i + 1}`;
    const target = rels.get(attr(sheet, 'r:id'))?.target;
    const id = `sheet-${i + 1}`;
    toc.push({ label: name, target: id, depth: 0 });
    const xml = target && (await zip.text(target));
    const grid = new Map(); // row → Map(col → { value, num })
    const merges = [];
    let width = 0;
    let height = 0;
    let more = false;
    if (xml) {
      const doc = parseXml(xml);
      let r = 0;
      for (const row of findAll(doc, 'row')) {
        r = Number(attr(row, 'r') ?? r + 1);
        if (r > MAX_ROWS) {
          more = true;
          continue;
        }
        let c = -1;
        for (const cell of kids(row, 'c')) {
          const ref = /^([A-Z]+)(\d+)$/i.exec(attr(cell, 'r') ?? '');
          c = ref ? columnIndex(ref[1]) : c + 1;
          const value = cellValue(cell, strings, dateStyles, date1904);
          if (value === '' || c >= MAX_COLS) continue;
          if (!grid.has(r)) grid.set(r, new Map());
          grid.get(r).set(c, value);
          width = Math.max(width, c + 1);
          height = Math.max(height, r);
        }
      }
      for (const m of findAll(doc, 'mergeCell')) {
        const ref = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(attr(m, 'ref') ?? '');
        if (ref) merges.push({ c0: columnIndex(ref[1]), r0: Number(ref[2]), c1: columnIndex(ref[3]), r1: Number(ref[4]) });
      }
    }
    text += `${name}\n`;
    if (!height) {
      html += `<section class="doc-sheet"><h2 id="${id}">${esc(name)}</h2><p class="doc-empty">This sheet is empty.</p></section>`;
      continue;
    }
    // Merged cells: the first holds the value and spans; the rest are not drawn.
    const spans = new Map();
    const hidden = new Set();
    for (const m of merges) {
      if (m.r0 > height || m.c0 >= width) continue;
      spans.set(`${m.r0}:${m.c0}`, { cs: Math.min(m.c1, width - 1) - m.c0 + 1, rs: Math.min(m.r1, height) - m.r0 + 1 });
      for (let r = m.r0; r <= Math.min(m.r1, height); r++) for (let c = m.c0; c <= Math.min(m.c1, width - 1); c++) if (r !== m.r0 || c !== m.c0) hidden.add(`${r}:${c}`);
    }
    let rowsHtml = '';
    for (let r = 1; r <= height; r++) {
      const cells = grid.get(r);
      rowsHtml += `<tr><th>${r}</th>`;
      const line = [];
      for (let c = 0; c < width; c++) {
        if (hidden.has(`${r}:${c}`)) continue;
        const v = cells?.get(c);
        const span = spans.get(`${r}:${c}`);
        rowsHtml += `<td${span?.cs > 1 ? ` colspan="${span.cs}"` : ''}${span?.rs > 1 ? ` rowspan="${span.rs}"` : ''}${v?.num ? ' class="num"' : ''}>${v ? v.html : ''}</td>`;
        line.push(v ? v.text : '');
      }
      rowsHtml += '</tr>';
      if (line.some(Boolean)) text += `${line.join('\t').replace(/\t+$/, '')}\n`;
    }
    const head = `<tr><th></th>${Array.from({ length: width }, (_, c) => `<th>${columnName(c)}</th>`).join('')}</tr>`;
    html += `<section class="doc-sheet"><h2 id="${id}">${esc(name)}</h2><div class="doc-table-wrap"><table class="doc-table doc-grid"><thead>${head}</thead><tbody>${rowsHtml}</tbody></table></div>${more ? `<p class="doc-more">The first ${MAX_ROWS.toLocaleString()} rows.</p>` : ''}</section>`;
    text += '\n';
  }
  if (!sheets.length) html = '<p>This workbook has no sheets.</p>';
  return { html, text: text.trim(), title: await coreTitle(zip), toc };
}

// A shared or inline string: plain, or rich runs (bold and italic kept).
function richText(si) {
  const runs = kids(si, 'r');
  if (!runs.length) {
    const t = textOf(kid(si, 't'));
    return { html: esc(t).replace(/\n/g, '<br>'), text: t };
  }
  let html = '';
  let text = '';
  for (const r of runs) {
    const t = textOf(kid(r, 't'));
    const rPr = kid(r, 'rPr');
    let h = esc(t).replace(/\n/g, '<br>');
    if (kid(rPr, 'i')) h = `<em>${h}</em>`;
    if (kid(rPr, 'b')) h = `<strong>${h}</strong>`;
    html += h;
    text += t;
  }
  return { html, text };
}

function cellValue(cell, strings, dateStyles, date1904) {
  const type = attr(cell, 't') ?? 'n';
  const raw = textOf(kid(cell, 'v'));
  if (type === 'inlineStr') return withNum(richText(kid(cell, 'is') ?? { children: [] }), false);
  // A formula the file was saved without the value of (made by a program, not opened in Excel): the formula.
  if (raw === '' && kid(cell, 'f') && textOf(kid(cell, 'f'))) return { html: `<span class="doc-formula">=${esc(textOf(kid(cell, 'f')))}</span>`, text: `=${textOf(kid(cell, 'f'))}`, num: false };
  if (raw === '') return '';
  if (type === 's') return withNum(strings[Number(raw)] ?? { html: '', text: '' }, false);
  if (type === 'b') return withNum(plain(raw === '1' ? 'TRUE' : 'FALSE'), true);
  if (type === 'e' || type === 'str') return withNum(plain(raw), false);
  if (type === 'd') return withNum(plain(raw.replace('T', ' ').replace(/\.000Z?$|Z$/, '')), true);
  if (dateStyles.has(Number(attr(cell, 's') ?? 0)) && Number.isFinite(Number(raw))) return withNum(plain(excelDate(Number(raw), date1904)), true);
  return withNum(plain(plainNumber(raw)), true);
}

const plain = (t) => ({ html: esc(t), text: t });
const withNum = (v, num) => (v.text === '' && v.html === '' ? '' : { ...v, num });
