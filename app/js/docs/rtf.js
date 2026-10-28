// Rich Text Format (.rtf) as a page: paragraphs and headings (by the file's style names),
// bold, italic, underline, strike-through, super- and subscript, alignment, tables, links,
// PNG and JPEG pictures, footnotes, and the text in the file's code pages (\ansicpg and the
// fonts' charsets) or as Unicode (\u). What the reader never sees stays out: font and color
// tables, hidden text, field instructions, headers and footers. Pure.

import { DocumentError, esc, outsideUrl } from './common.js';

// Destinations whose text is not part of the page.
const SKIP = new Set(
  'fonttbl colortbl stylesheet info pict header headerl headerr headerf footer footerl footerr footerf object objdata themedata colorschememapping datastore latentstyles listtable listoverridetable rsidtbl generator xmlnstbl mmathPr fldinst nonshppict bkmkstart bkmkend annotation atnid atnauthor atndate atnref pgdsctbl revtbl filetbl protusertbl userprops docvar xmlopen xmlclose wgrffmtfilter ftnsep ftnsepc ftncn aftnsep aftnsepc aftncn pnseclvl pntxta pntxtb listpicture blipuid passwordhash fontemb fontfile panose falt'.split(' '),
);
// The fonts' charsets → code pages.
const CHARSET_CP = { 0: null, 1: null, 77: 'macintosh', 128: 'shift_jis', 129: 'euc-kr', 130: 'johab', 134: 'gbk', 136: 'big5', 161: 'windows-1253', 162: 'windows-1254', 163: 'windows-1258', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 204: 'windows-1251', 222: 'windows-874', 238: 'windows-1250' };
// Words that stand for a character.
const CHARS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: '\u2003', enspace: '\u2002', qmspace: '\u2005', zwj: '\u200d', zwnj: '\u200c', ltrmark: '\u200e', rtlmark: '\u200f', tab: '\t' };
// The Symbol font's bytes that turn up in lists.
const SYMBOL = { 0xb7: '•', 0xa7: '▪', 0x6f: '○', 0xd8: '➢', 0xfc: '✓', 0x76: '❖', 0x71: '▫', 0xa8: '◆', 0x2d: '–' };

const decoders = new Map();
function decodeBytes(bytes, cp) {
  if (cp === 'symbol') return bytes.map((b) => SYMBOL[b] ?? String.fromCharCode(b)).join('');
  const label = cp || 'windows-1252';
  if (!decoders.has(label)) {
    try {
      decoders.set(label, new TextDecoder(label));
    } catch {
      decoders.set(label, new TextDecoder('windows-1252'));
    }
  }
  return decoders.get(label).decode(new Uint8Array(bytes));
}

const freshChar = () => ({ b: false, i: false, u: false, s: false, sup: false, sub: false, hidden: false });

export function convertRtf(bytes) {
  const src = decodeBytes(Array.from(bytes.subarray ? bytes : new Uint8Array(bytes)), 'iso-8859-1');
  if (!/^\s*\{\\rtf/.test(src)) throw new DocumentError('This is not an RTF file.');

  let codepage = 'windows-1252';
  const fonts = new Map(); // font number → code page
  const styles = new Map(); // style number → { name, outline }
  const images = new Map();
  const notes = [];
  let title = '';
  let noteCount = 0;

  const newOut = () => ({ blocks: [], runs: [], table: null });
  const main = newOut();
  let state = { dest: null, skip: false, ...freshChar(), font: null, uc: 1, align: '', style: 0, outline: null, intbl: false, link: null, field: null, out: main };
  const stack = [];
  let pendingBytes = [];
  let skipChars = 0;
  // Within the stylesheet: the style being read.
  let styleEntry = null;
  // The row being defined (\trowd … \cellx).
  let rowDefs = [];
  let cellFlags = {};
  let rowLeft = 0;

  const cpOf = (s) => (s.font != null && fonts.has(s.font) ? fonts.get(s.font) : codepage);
  const emit = (text) => {
    if (!text) return;
    if (state.skip) {
      if (state.dest === 'fldinst' && state.field) state.field.inst += text;
      else if (state.dest === 'title') title += text;
      else if (state.dest === 'stylename' && styleEntry) styleEntry.name += text;
      return;
    }
    if (state.hidden) return;
    const runs = state.out.runs;
    const fmt = { b: state.b, i: state.i, u: state.u, s: state.s, sup: state.sup, sub: state.sub, link: state.link };
    const last = runs[runs.length - 1];
    if (last && !last.image && !last.ref && sameFmt(last.fmt, fmt)) last.text += text;
    else runs.push({ text, fmt });
  };
  const flushBytes = () => {
    if (!pendingBytes.length) return;
    const text = decodeBytes(pendingBytes, cpOf(state));
    pendingBytes = [];
    emit(text);
  };

  // ---- Paragraphs and tables ----
  const endParagraph = (out = state.out) => {
    const para = { runs: out.runs, align: state.align, heading: headingOf(state), intbl: state.intbl };
    out.runs = [];
    if (para.intbl) {
      out.table ??= { rows: [], row: [], cell: [] };
      out.table.cell.push(para);
      return;
    }
    closeTable(out);
    out.blocks.push(para);
  };
  const closeTable = (out) => {
    const t = out.table;
    if (!t) return;
    if (t.cell.length) t.row.push(t.cell);
    if (t.row.length) t.rows.push({ cells: t.row, defs: [], left: 0 });
    out.blocks.push({ table: layOut(t.rows) });
    out.table = null;
  };
  const endCell = () => {
    const out = state.out;
    out.table ??= { rows: [], row: [], cell: [] };
    if (out.runs.length) {
      out.table.cell.push({ runs: out.runs, align: state.align });
      out.runs = [];
    }
    out.table.row.push(out.table.cell);
    out.table.cell = [];
  };
  const endRow = () => {
    const out = state.out;
    out.table ??= { rows: [], row: [], cell: [] };
    if (out.runs.length) endCell();
    out.table.rows.push({ cells: out.table.row, defs: rowDefs.slice(), left: rowLeft });
    out.table.row = [];
  };
  const headingOf = (s) => {
    const level = s.outline ?? styles.get(s.style)?.outline;
    if (level != null && level < 6) return level + 1;
    const m = /^heading\s*(\d)/i.exec(styles.get(s.style)?.name ?? '');
    return m ? Math.min(6, Number(m[1])) : 0;
  };

  // ---- Control words ----
  const word = (name, param, hasParam) => {
    if (state.dest === 'pict' && state.pict) {
      if (name === 'pngblip') state.pict.type = 'image/png';
      else if (name === 'jpegblip') state.pict.type = 'image/jpeg';
      return;
    }
    if (state.skip && !SKIP_KEEPS.has(name)) return;
    switch (name) {
      case 'ansicpg':
        if (param > 0) codepage = `windows-${param}`;
        if (param === 932) codepage = 'shift_jis';
        else if (param === 936) codepage = 'gbk';
        else if (param === 949) codepage = 'euc-kr';
        else if (param === 950) codepage = 'big5';
        else if (param === 65001) codepage = 'utf-8';
        break;
      case 'mac':
        codepage = 'macintosh';
        break;
      case 'pc':
        codepage = 'ibm437';
        break;
      case 'pca':
        codepage = 'ibm850';
        break;
      case 'f':
        state.font = param;
        if (state.dest === 'fonttbl') state.fontDef = param;
        break;
      case 'fcharset':
        if (state.dest === 'fonttbl' && state.fontDef != null) fonts.set(state.fontDef, param === 2 ? 'symbol' : (CHARSET_CP[param] ?? codepage));
        break;
      case 's':
        if (state.dest === 'stylename' && styleEntry) styleEntry.id = param;
        else if (!state.skip) state.style = param;
        break;
      case 'outlinelevel':
        if (state.dest === 'stylename' && styleEntry) styleEntry.outline = param;
        else if (!state.skip) state.outline = param;
        break;
      case 'uc':
        state.uc = param;
        break;
      case 'u': {
        flushBytes();
        const code = param < 0 ? param + 65536 : param;
        // The Symbol font's characters as Unicode's private ones (U+F0B7 for a bullet).
        emit(code >= 0xf020 && code <= 0xf0ff ? (SYMBOL[code - 0xf000] ?? String.fromCharCode(code - 0xf000)) : String.fromCharCode(code));
        skipChars = state.uc;
        break;
      }
      // A table row's cells: where each ends (\cellx) and how they merge.
      case 'trowd':
        rowDefs = [];
        cellFlags = {};
        rowLeft = 0;
        break;
      case 'trleft':
        rowLeft = param;
        break;
      case 'clvmgf':
        cellFlags.vfirst = true;
        break;
      case 'clvmrg':
        cellFlags.vmerge = true;
        break;
      case 'clmgf':
        cellFlags.hfirst = true;
        break;
      case 'clmrg':
        cellFlags.hmerge = true;
        break;
      case 'cellx':
        rowDefs.push({ right: param, ...cellFlags });
        cellFlags = {};
        break;
      case 'par':
      case 'sect':
      case 'page':
        flushBytes();
        endParagraph();
        break;
      case 'line':
        flushBytes();
        if (!state.skip && !state.hidden) state.out.runs.push({ text: '', br: true, fmt: freshChar() });
        break;
      case 'pard':
        state.align = '';
        state.style = 0;
        state.outline = null;
        state.intbl = false;
        break;
      case 'plain':
        Object.assign(state, freshChar());
        break;
      case 'qc':
        state.align = 'al-c';
        break;
      case 'qr':
        state.align = 'al-r';
        break;
      case 'qj':
        state.align = 'al-j';
        break;
      case 'ql':
        state.align = '';
        break;
      case 'intbl':
        state.intbl = true;
        break;
      case 'cell':
      case 'nestcell':
        flushBytes();
        endCell();
        break;
      case 'row':
      case 'nestrow':
        flushBytes();
        endRow();
        break;
      case 'b':
        state.b = !hasParam || param !== 0;
        break;
      case 'i':
        state.i = !hasParam || param !== 0;
        break;
      case 'ul':
      case 'uld':
      case 'uldb':
      case 'ulw':
      case 'ulwave':
      case 'uldash':
      case 'ulth':
        state.u = !hasParam || param !== 0;
        break;
      case 'ulnone':
        state.u = false;
        break;
      case 'strike':
      case 'striked':
        state.s = !hasParam || param !== 0;
        break;
      case 'super':
        state.sup = true;
        state.sub = false;
        break;
      case 'sub':
        state.sub = true;
        state.sup = false;
        break;
      case 'nosupersub':
        state.sup = state.sub = false;
        break;
      case 'v':
        state.hidden = !hasParam || param !== 0;
        break;
      case 'field':
        state.field = { inst: '' };
        break;
      case 'fldrslt': {
        const m = /HYPERLINK\s+"([^"]+)"/i.exec(state.field?.inst ?? '') ?? /HYPERLINK\s+(\S+)/i.exec(state.field?.inst ?? '');
        state.link = m ? outsideUrl(m[1]) : null;
        state.dest = 'fldrslt';
        break;
      }
      case 'chftn':
        if (state.dest !== 'footnote' && !state.skip) {
          noteCount++;
          state.out.runs.push({ ref: noteCount, text: '', fmt: freshChar() });
        }
        break;
      case 'footnote': {
        const out = newOut();
        notes[noteCount > 0 ? noteCount - 1 : notes.length] = out;
        state.out = out;
        state.dest = 'footnote';
        Object.assign(state, freshChar());
        break;
      }
      case 'title':
        if (stack.some((s) => s.dest === 'info') || state.dest === 'info') {
          state.dest = 'title';
          state.skip = true;
        }
        break;
      default:
        if (CHARS[name] !== undefined) {
          flushBytes();
          emit(CHARS[name]);
        }
    }
  };

  // ---- Reading ----
  let at = 0;
  const len = src.length;
  let groupStart = false; // the next control word may name a destination
  let starred = false;
  while (at < len) {
    const ch = src[at];
    if (ch === '{') {
      flushBytes();
      stack.push(state);
      state = { ...state };
      if (state.dest === 'stylesheet') {
        styleEntry = { id: 0, name: '', outline: null };
        state.dest = 'stylename';
      }
      groupStart = true;
      starred = false;
      skipChars = 0;
      at++;
      continue;
    }
    if (ch === '}') {
      flushBytes();
      const closing = state;
      if (closing.dest === 'pict' && closing.pict && stack[stack.length - 1]?.dest !== 'pict') addPicture(closing.pict, stack[stack.length - 1]);
      if (closing.dest === 'stylename' && styleEntry && stack[stack.length - 1]?.dest === 'stylesheet') {
        const name = styleEntry.name.replace(/;\s*$/, '').trim();
        if (!styles.has(styleEntry.id)) styles.set(styleEntry.id, { name, outline: styleEntry.outline });
        styleEntry = null;
      }
      if (closing.dest === 'footnote' && stack[stack.length - 1]?.dest !== 'footnote') {
        if (closing.out.runs.length) endParagraph(closing.out);
        closeTable(closing.out);
      }
      state = stack.pop() ?? state;
      groupStart = false;
      skipChars = 0;
      at++;
      continue;
    }
    if (ch === '\\') {
      const next = src[at + 1];
      if (next === "'") {
        const hex = src.substr(at + 2, 2);
        at += 4;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (state.dest === 'pict') continue;
        pendingBytes.push(parseInt(hex, 16) || 0);
        continue;
      }
      if (next === '*') {
        starred = true;
        at += 2;
        continue;
      }
      if (/[a-zA-Z]/.test(next ?? '')) {
        const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(at + 1, at + 46));
        at += 1 + m[0].length;
        const name = m[1];
        const hasParam = m[2] !== undefined;
        const param = hasParam ? Number(m[2]) : 0;
        if (name !== 'u') flushBytes();
        // Raw bytes (\binN): skipped, and a picture written that way is left out.
        if (name === 'bin' && hasParam) {
          at += Math.max(0, param);
          if (state.pict) state.pict.type = null;
          starred = false;
          continue;
        }
        if (groupStart) {
          groupStart = false;
          if (name === 'pict') {
            starred = false;
            state.dest = 'pict';
            state.skip = true;
            state.pict = { type: null, hex: [] };
            continue;
          }
          if (SKIP.has(name) || (starred && !KNOWN.has(name))) {
            starred = false;
            state.dest = name;
            state.skip = true;
            if (name === 'fldinst') state.field ??= { inst: '' };
            if (name === 'stylesheet') styleEntry = null;
            if (name === 'fonttbl' || name === 'stylesheet' || name === 'info' || name === 'fldinst') word(name, param, hasParam);
            continue;
          }
          if (name === 'listtext' || name === 'pntext') {
            state.dest = name;
          }
        }
        if (skipChars > 0 && name !== 'u') skipChars = 0;
        starred = false;
        word(name, param, hasParam);
        continue;
      }
      // Control symbols.
      at += 2;
      if (next === '\\' || next === '{' || next === '}') {
        if (skipChars > 0) skipChars--;
        else emit(next);
      } else if (next === '~') emit('\u00a0');
      else if (next === '_') emit('\u2011');
      else if (next === '\n' || next === '\r') {
        flushBytes();
        endParagraph();
      } else if (next === '|' || next === ':') {
        // index and formula marks
      }
      // \- (an optional hyphen) shows nothing.
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      at++;
      continue;
    }
    groupStart = false;
    // Plain text, up to the next special character.
    let end = at;
    while (end < len && src[end] !== '\\' && src[end] !== '{' && src[end] !== '}' && src[end] !== '\r' && src[end] !== '\n') end++;
    let chunk = src.slice(at, end);
    at = end;
    if (state.dest === 'pict' && state.pict) {
      state.pict.hex.push(chunk);
      continue;
    }
    if (skipChars > 0) {
      const n = Math.min(skipChars, chunk.length);
      chunk = chunk.slice(n);
      skipChars -= n;
    }
    flushBytes();
    // Characters above 127 written as they are: in the file's code page.
    if (/[\x80-\xff]/.test(chunk)) {
      const b = Array.from(chunk, (c) => c.charCodeAt(0));
      emit(decodeBytes(b, cpOf(state)));
    } else emit(chunk);
  }
  flushBytes();
  if (main.runs.length) endParagraph(main);
  closeTable(main);

  function addPicture(pict, parent) {
    if (!pict.type || !parent || parent.skip || parent.hidden) return;
    const hex = pict.hex.join('').replace(/[^0-9a-f]/gi, '');
    const data = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    const id = `img-${images.size + 1}`;
    images.set(id, { bytes: data, type: pict.type });
    parent.out.runs.push({ image: id, text: '', fmt: freshChar() });
  }

  // ---- The page ----
  const runsHtml = (runs) => {
    let html = '';
    let link = null;
    for (const r of runs) {
      const l = r.fmt?.link ?? null;
      if (l !== link) {
        if (link) html += '</a>';
        if (l) html += `<a href="${esc(l)}">`;
        link = l;
      }
      if (r.br) html += '<br>';
      else if (r.image) html += `<img data-doc-img="${r.image}" alt="">`;
      else if (r.ref) html += `<sup><a class="doc-noteref" id="fnref-${r.ref}" href="#fn-${r.ref}">${r.ref}</a></sup>`;
      else html += wrap(esc(r.text), r.fmt);
    }
    if (link) html += '</a>';
    return html;
  };
  const blocksHtml = (blocks) =>
    blocks
      .map((b) => {
        if (b.table) {
          return `<div class="doc-table-wrap"><table class="doc-table"><tbody>${b.table
            .map(
              (row) =>
                `<tr>${row
                  .map((c) => `<td${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.paras.map((p) => `<p${p.align ? ` class="${p.align}"` : ''}>${runsHtml(p.runs) || '<br>'}</p>`).join('')}</td>`)
                  .join('')}</tr>`,
            )
            .join('')}</tbody></table></div>`;
        }
        const body = runsHtml(b.runs);
        const cls = b.align ? ` class="${b.align}"` : '';
        if (b.heading) return `<h${b.heading}${cls}>${body}</h${b.heading}>`;
        return `<p${cls}>${body || '<br>'}</p>`;
      })
      .join('');

  // Trailing empty paragraphs are left out.
  while (main.blocks.length && !main.blocks[main.blocks.length - 1].table && !main.blocks[main.blocks.length - 1].runs.some((r) => r.text?.trim() || r.image)) main.blocks.pop();
  const toc = [];
  let headingNo = 0;
  let html = blocksHtml(main.blocks).replace(/<h(\d)( class="[^"]*")?>/g, (m, n, cls) => {
    const id = `h-${++headingNo}`;
    return `<h${n} id="${id}"${cls ?? ''}>`;
  });
  for (const m of html.matchAll(/<h([1-3]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const label = m[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
    if (label) toc.push({ label, target: m[2], depth: Number(m[1]) - 1 });
  }
  if (notes.some(Boolean)) {
    html += `<section class="doc-notes"><h2>Notes</h2><ol>${notes.map((n, i) => `<li id="fn-${i + 1}">${n ? blocksHtml(n.blocks) : ''} <a class="doc-noteback" href="#fnref-${i + 1}" aria-label="Back">↩</a></li>`).join('')}</ol></section>`;
  }
  return { html, title: title.trim(), toc, image: async (ref) => images.get(ref) ?? null };
}

// In skipped destinations only these words are read (fonts' charsets, style names, the title).
const SKIP_KEEPS = new Set(['f', 'fcharset', 's', 'outlinelevel', 'title', 'u', 'uc']);

// Destinations marked \* that are read anyway.
const KNOWN = new Set(['shppict', 'fldinst', 'listtext', 'pntext', 'footnote', 'field', 'fldrslt']);

/**
 * A table's cells laid out: each spans the columns between its edges (\cellx) as all the
 * rows' edges divide them, and merged cells (\clmrg, \clvmrg) widen or lengthen the one
 * they continue.
 */
function layOut(rows) {
  const edges = [...new Set(rows.flatMap((r) => r.defs.map((d) => d.right)))].sort((a, b) => a - b);
  const above = new Map(); // column → the cell a vertical merge continues
  return rows.map((row) => {
    const out = [];
    let col = 0;
    row.cells.forEach((paras, i) => {
      const def = row.defs.length === row.cells.length ? row.defs[i] : null;
      const left = i === 0 ? row.left : row.defs[i - 1]?.right;
      const span = def && left != null ? Math.max(1, edges.filter((e) => e > left && e <= def.right).length) : 1;
      if (def?.hmerge && out.length) {
        out[out.length - 1].colspan += span;
      } else if (def?.vmerge && above.get(col)) {
        above.get(col).rowspan++;
      } else {
        const cell = { paras, colspan: span, rowspan: 1 };
        out.push(cell);
        if (def?.vfirst) above.set(col, cell);
        else above.delete(col);
      }
      col += span;
    });
    return out;
  });
}

function sameFmt(a, b) {
  return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.sup === b.sup && a.sub === b.sub && a.link === b.link;
}

function wrap(html, f) {
  if (!html) return '';
  if (f.sup) html = `<sup>${html}</sup>`;
  else if (f.sub) html = `<sub>${html}</sub>`;
  if (f.s) html = `<s>${html}</s>`;
  if (f.u && !f.link) html = `<u>${html}</u>`;
  if (f.i) html = `<em>${html}</em>`;
  if (f.b) html = `<strong>${html}</strong>`;
  return html;
}
