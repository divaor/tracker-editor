// Documents shown as they look (documents.js and docs/*): the converters on files made by
// real programs (test/fixtures/documents: pandoc, LibreOffice, python-docx, openpyxl,
// python-pptx, from source.md), and on small files built here for the cases they lack.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { convertDocument, documentKind, documentLabel, htmlToText, isDocumentName } from '../app/js/documents.js';
import { DOCUMENT_TYPES } from '../app/js/docTypes.js';
import { cssLooks } from '../app/js/docs/epub.js';
import { readZip, resolvePath, ZipError } from '../app/js/unzip.js';
import { attr, decodeEntities, find, findAll, parseXml, textOf } from '../app/js/xmlLite.js';

const require = createRequire(import.meta.url);
const { zipSync, strToU8 } = require('fflate');
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/documents/${name}`, import.meta.url));
const convert = (name) => convertDocument(documentKind(name), fixture(name));
const zip = (files, level = 6) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [typeof v === 'string' ? strToU8(v) : v, { level }]])));
// A 1×1 PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

test('documents are known by their names, and by their MIME types from other apps', () => {
  assert.equal(documentKind('Report.PDF'), 'pdf');
  assert.equal(documentKind('book.epub'), 'epub');
  assert.equal(documentKind('memo.docm'), 'docx');
  assert.equal(documentKind('deck.ppsx'), 'pptx');
  assert.equal(documentKind('notes.txt'), null);
  assert.equal(documentKind('attachment', 'application/pdf'), 'pdf');
  assert.equal(documentKind('download', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(documentKind('x', 'text/plain'), null);
  assert.equal(documentLabel('a.xlsx'), 'Excel workbook');
  assert.equal(isDocumentName('a.odt'), true);
  assert.equal(isDocumentName('a.md'), false);
});

test('the main process knows the same documents (electron/diskFiles.cjs)', () => {
  const disk = require('../electron/diskFiles.cjs');
  assert.deepEqual(disk.DOCUMENT_EXTS, Object.fromEntries(Object.entries(DOCUMENT_TYPES).map(([ext, t]) => [ext, t.kind])));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  try {
    fs.writeFileSync(path.join(dir, 'book.epub'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
    const info = disk.readTextFile(path.join(dir, 'book.epub'));
    assert.equal(info.doc, 'epub');
    assert.equal(info.text, '');
    assert.equal(info.size, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- The XML reader ----

test('XML: entities, CDATA, comments and a DOCTYPE; names with their prefixes and without', () => {
  const doc = parseXml(`<?xml version="1.0"?><!DOCTYPE html [<!ENTITY x "y">]><!-- note --><w:doc xmlns:w="urn:w"><w:p w:val='1'>a &amp; b &#233;&#x20AC;&nbsp;&hellip;<![CDATA[<raw>]]></w:p><br/><w:t xml:space="preserve"> x </w:t></w:doc>`);
  const p = find(doc, 'p');
  assert.equal(p.name, 'w:p');
  assert.equal(attr(p, 'w:val'), '1');
  assert.equal(attr(p, 'val'), '1');
  assert.equal(textOf(p), 'a & b é€\u00a0…<raw>');
  assert.equal(textOf(find(doc, 't')), ' x ');
  assert.equal(find(doc, 'br').children.length, 0);
  assert.equal(decodeEntities('&unknown; &lt;'), '&unknown; <');
});

test('XML: what a sloppy file leaves open is closed by its parent', () => {
  const doc = parseXml('<body><p>one<p>two</body><p>three</p>');
  const body = find(doc, 'body');
  assert.equal(textOf(body), 'onetwo');
  assert.equal(findAll(doc, 'p').length, 2, 'the first two are nested, as written; the third is outside');
  assert.equal(textOf(doc), 'onetwothree');
});

// ---- Zips ----

test('zips: stored and deflated entries, names looked up loosely, paths resolved', async () => {
  const z = readZip(zip({ 'a/stored.txt': 'plain', 'Word/Doc.xml': 'x'.repeat(5000) }, 0));
  assert.equal(await z.text('a/stored.txt'), 'plain');
  assert.equal((await z.text('word/doc.xml')).length, 5000);
  const d = readZip(zip({ 'big.txt': 'y'.repeat(100000) }, 9));
  assert.equal((await d.text('big.txt')).length, 100000);
  assert.equal(await d.text('missing'), null);
  assert.equal(resolvePath('OEBPS/text/ch1.xhtml', '../img/a%20b.png#x'), 'OEBPS/img/a b.png');
  assert.equal(resolvePath('word/document.xml', '/word/media/x.png'), 'word/media/x.png');
  assert.throws(() => readZip(new Uint8Array(40)), ZipError);
});

test('zips: an entry that expands far past its size stops (a zip bomb)', async () => {
  const z = readZip(zip({ 'bomb.txt': 'z'.repeat(2_000_000) }, 9), { limit: 100_000 });
  await assert.rejects(z.bytes('bomb.txt'), /too large/);
});

// ---- Word ----

test('Word (pandoc): headings, inline styles, lists, a table, a link, a footnote, a picture', async () => {
  const doc = await convert('pandoc.docx');
  assert.equal(doc.title, 'Field Notes');
  assert.match(doc.html, /<h1 id="h-\d+">Introduction<\/h1>/);
  assert.match(doc.html, /<strong>bold<\/strong>/);
  assert.match(doc.html, /<em>italic<\/em>/);
  assert.match(doc.html, /<s>gone<\/s>/);
  assert.match(doc.html, /H<sub>2<\/sub>O/);
  assert.match(doc.html, /mc<sup>2<\/sup>/);
  assert.match(doc.html, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(doc.html, /<li>Second point<ul><li>Nested one<\/li><li>Nested two<\/li><\/ul><\/li>/);
  assert.match(doc.html, /<ol><li>Step one<\/li>/);
  assert.match(doc.html, /<table class="doc-table">/);
  assert.match(doc.html, /<section class="doc-notes">.*The footnote’s text/s);
  const ref = /data-doc-img="([^"]+)"/.exec(doc.html)[1];
  const img = await doc.image(ref);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(doc.toc.map((e) => [e.label, e.depth]).slice(1), [['Introduction', 0], ['A list', 1], ['A table', 1], ['Second chapter', 0]]);
  assert.match(doc.text, /Name\tCount\tNote\nAlpha\t1\tfirst row/);
  assert.match(doc.text, /Text with café, naïve, “quotes” — and 日本語\./);
});

test('Word (python-docx): merged cells span, styles give headings and quotes', async () => {
  const doc = await convert('python-docx.docx');
  assert.match(doc.html, /<td colspan="2"><p>wide<\/p><\/td>/);
  assert.match(doc.html, /<td rowspan="2"><p>tall<\/p><\/td>/);
  assert.match(doc.html, /<p class="doc-quote">Quote text<\/p>/);
  assert.match(doc.html, /<h1 id="h-2">Part one<\/h1>/);
  assert.equal(doc.title, 'Word made');
});

test('Word: hidden instructions of fields are not shown; HYPERLINK fields and bookmarks link', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const body = `<w:document ${W}><w:body>
    <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK \\l "_Toc1" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Go there</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    <w:p><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Here</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rId9"><w:r><w:t>out</w:t></w:r></w:hyperlink><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
    <w:p><w:hyperlink r:id="rId10"><w:r><w:t>sneaky</w:t></w:r></w:hyperlink></w:p>
  </w:body></w:document>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://x/hyperlink" Target="https://example.org/" TargetMode="External"/><Relationship Id="rId10" Type="http://x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`;
  const doc = await convertDocument('docx', zip({ 'word/document.xml': body, 'word/_rels/document.xml.rels': rels }));
  assert.match(doc.html, /<a href="#bm-_Toc1">Go there<\/a>/);
  assert.doesNotMatch(doc.html, /HYPERLINK|PAGE/);
  assert.match(doc.html, /<p>7<\/p>/);
  assert.match(doc.html, /<a id="bm-_Toc1"><\/a>/);
  assert.match(doc.html, /<a href="https:\/\/example.org\/">out<\/a>not bold/);
  assert.doesNotMatch(doc.html, /gone|javascript/);
  assert.match(doc.html, /<p>sneaky<\/p>/);
});

// ---- OpenDocument ----

test('OpenDocument text (pandoc and LibreOffice)', async () => {
  const a = await convert('pandoc.odt');
  assert.match(a.html, /<h1 id="h-\d+">Field Notes<\/h1>/, 'the Title style');
  assert.match(a.html, /<strong>bold<\/strong>/);
  assert.match(a.html, /<li>Second point<ul><li>Nested one<\/li>/);
  assert.match(a.html, /<p class="doc-quote">A quote from someone wise\.<\/p>/);
  assert.match(a.html, /<sup><a class="doc-noteref" id="fnref-1" href="#fn-1">1<\/a><\/sup>/);
  assert.equal((await a.image(/data-doc-img="([^"]+)"/.exec(a.html)[1])).type, 'image/png');
  const b = await convert('libreoffice.odt');
  assert.match(b.html, /<td colspan="2"><p>wide<\/p><\/td>/);
  assert.match(b.html, /<td rowspan="2"><p>tall<\/p><\/td>/);
});

test('OpenDocument spreadsheet and presentation (LibreOffice)', async () => {
  const s = await convert('libreoffice.ods');
  assert.deepEqual(s.toc.map((e) => e.label), ['Budget', 'Empty one', 'Wide']);
  assert.match(s.html, /<td colspan="4">Merged note across four columns<\/td>/);
  assert.match(s.html, /<th>AA<\/th>/);
  assert.match(s.text, /^Budget\nItem\tCost\tDate\tPaid\nRent\t1200\.5/);
  const p = await convert('libreoffice.odp');
  assert.deepEqual(p.toc.map((e) => e.label), ['1. Quarterly review', '2. Highlights', '3. Numbers']);
  assert.match(p.html, /<h2>Highlights<\/h2>/);
  assert.match(p.html, /<div class="doc-slide-notes"><p>Say thanks to the team\.<\/p>/);
  assert.doesNotMatch(p.html, /&lt;number&gt;/);
});

// ---- Excel and PowerPoint ----

test('Excel (openpyxl): strings, numbers as Excel shows them, dates, TRUE/FALSE, merges, formulas without a value', async () => {
  const doc = await convert('openpyxl.xlsx');
  assert.deepEqual(doc.toc.map((e) => e.label), ['Budget', 'Empty one', 'Wide']);
  assert.match(doc.html, /<td>Food &amp; drink<\/td><td class="num">0\.3<\/td><td class="num">2026-10-02 13:30:00<\/td><td class="num">FALSE<\/td>/);
  assert.match(doc.html, /<td class="num">2026-10-01<\/td><td class="num">TRUE<\/td>/);
  assert.match(doc.html, /<td colspan="4">Merged note across four columns<\/td>/);
  assert.match(doc.html, /<span class="doc-formula">=SUM\(B2:B3\)<\/span>/);
  assert.match(doc.html, /This sheet is empty/);
  assert.match(doc.text, /Rent\t1200\.5\t2026-10-01\tTRUE/);
});

test('PowerPoint (python-pptx): slides in order with titles, bullets by level, tables, pictures, notes', async () => {
  const doc = await convert('python-pptx.pptx');
  assert.deepEqual(doc.toc.map((e) => e.label), ['1. Quarterly review', '2. Highlights', '3. Numbers']);
  assert.match(doc.html, /<h2>Highlights<\/h2><ul><li>Revenue up<ul><li>Mostly online<\/li><\/ul><\/li><li>Costs flat<\/li><\/ul>/);
  assert.match(doc.html, /<div class="doc-slide-notes"><p>Say thanks to the team\.<\/p><\/div>/);
  assert.match(doc.html, /<td><p>Q3<\/p><\/td>/);
  assert.equal((await doc.image(/data-doc-img="([^"]+)"/.exec(doc.html)[1])).type, 'image/png');
});

// ---- E-books ----

test('EPUB (pandoc): chapters in order, contents from its navigation, links inside the book, pictures', async () => {
  const doc = await convert('pandoc.epub');
  assert.equal(doc.title, 'Field Notes');
  assert.deepEqual(doc.toc.map((e) => [e.label, e.depth]), [['Introduction', 0], ['A list', 1], ['A table', 1], ['Second chapter', 0]]);
  assert.ok(doc.toc.every((e) => doc.html.includes(` id="${e.target}"`)));
  assert.match(doc.html, /<sup><a href="#c2-fn1" id="c2-fnref1" class="doc-noteref">1<\/a><\/sup>/);
  assert.equal((await doc.image(/data-doc-img="([^"]+)"/.exec(doc.html)[1])).type, 'image/png');
  assert.match(doc.text, /Name\tCount\tNote/);
});

const epub = (chapter, { css = '', extra = {} } = {}) =>
  zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf': `<package><metadata><dc:title>T</dc:title></metadata><manifest><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="s" href="style.css" media-type="text/css"/><item id="p" href="img/p.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    'OPS/text/one.xhtml': `<html><head><style>p{color:red}</style><script>alert(1)</script></head><body>${chapter}</body></html>`,
    'OPS/text/two.xhtml': '<html><body><h1 id="end">Two</h1></body></html>',
    'OPS/style.css': css,
    'OPS/img/p.png': PNG,
    ...extra,
  });

test('EPUB: only safe tags and attributes; scripts, handlers, styles, forms and remote pictures are left out', async () => {
  const doc = await convertDocument(
    'epub',
    epub(`<p class="it" style="position:fixed" onclick="evil()">Hello <a href="javascript:evil()">bad</a> <a href="two.xhtml#end">next</a> <a href="https://example.com/">web</a></p>
      <img src="../img/p.png" alt="pic"/><img src="https://tracker.example/pixel.gif"/><iframe src="x"></iframe><form><input/></form><svg><image xlink:href="../img/p.png"/><script>evil()</script></svg>
      <object data="x"></object><p id="mine">mark<span onmouseover="x">!</span></p>`, { css: '.it { font-style: italic } .c, p.mid { text-align: center }' }),
  );
  assert.doesNotMatch(doc.html, /script|style=|onclick|onmouseover|javascript|iframe|<form|<input|<object|tracker\.example|color:red/);
  assert.match(doc.html, /<p class="doc-i">Hello <a>bad<\/a> <a href="#c2-end">next<\/a> <a href="https:\/\/example.com\/">web<\/a><\/p>/);
  assert.match(doc.html, /<img data-doc-img="OPS\/img\/p.png" alt="pic">/);
  assert.match(doc.html, /<img class="doc-cover" data-doc-img="OPS\/img\/p.png" alt="">/);
  assert.match(doc.html, /<p id="c1-mine">mark<span>!<\/span><\/p>/);
  assert.deepEqual([...cssLooks('.c, p.mid { text-align: center } .x .y { font-weight: bold } .b{font-weight:700}')], [['c', ['al-c']], ['mid', ['al-c']], ['b', ['doc-b']]]);
});

test('EPUB: a book with DRM says so', async () => {
  const locked = epub('<p>x</p>', { extra: { 'META-INF/encryption.xml': '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/text/one.xhtml"/></CipherData></EncryptedData></encryption>' } });
  await assert.rejects(convertDocument('epub', locked), /protected \(DRM\)/);
  // Obfuscated fonts alone are fine.
  const fonts = epub('<p>x</p>', { extra: { 'META-INF/encryption.xml': '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>' } });
  assert.match((await convertDocument('epub', fonts)).html, /<p>x<\/p>/);
});

test('FictionBook (pandoc, and one in windows-1251 with a picture inside)', async () => {
  const doc = await convert('pandoc.fb2');
  assert.equal(doc.title, 'Field Notes');
  assert.match(doc.html, /<strong>bold<\/strong>/);
  assert.ok(!doc.toc.some((e) => e.label === '1'), 'the notes are not in the contents');
  const cyr = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><book-title>'),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    Buffer.from(`</book-title></title-info></description><body><section><title><p>One</p></title><p>Text<image l:href="#i1"/></p></section></body><binary id="i1" content-type="image/png">${Buffer.from(PNG).toString('base64')}</binary></FictionBook>`),
  ]);
  const b = await convertDocument('fb2', cyr);
  assert.equal(b.title, 'Привет');
  assert.equal((await b.image('i1')).type, 'image/png');
});

// ---- RTF ----

test('RTF (LibreOffice and pandoc): headings by style, lists, merged cells, a picture, a footnote', async () => {
  const lo = await convert('libreoffice.rtf');
  assert.equal(lo.title, 'Word made');
  assert.match(lo.html, /<h1 id="h-1"><strong>Part one<\/strong><\/h1>/);
  assert.match(lo.html, /<p> •\tBullet A<\/p>/, 'the Symbol font’s bullet');
  assert.match(lo.html, /<td colspan="2"><p>wide<\/p><\/td>/);
  assert.match(lo.html, /<td rowspan="2"><p>tall<\/p><\/td>/);
  assert.equal((await lo.image('img-1')).type, 'image/png');
  const pd = await convert('pandoc.rtf');
  assert.match(pd.html, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(pd.html, /<section class="doc-notes">.*The footnote’s text/s);
  assert.match(pd.text, /Text with café, naïve, “quotes” — and 日本語\./);
});

test('RTF: code pages, Unicode with its fallback, hidden text and what is not text stay out', async () => {
  // \u written apart, so no tool along the way takes it for an escape.
  const U = '\\' + 'u';
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss Arial;}{\f1\fcharset204 Cyr;}}{\colortbl;\red0\green0\blue0;}{\*\generator Hand;}{\info{\title Plain \'e9t\'e9}}
\pard\qc Caf\'e9 ${U}8364?${U}-3913? and {\f1 \'cf\'f0\'e8} {\v hidden} {\b bold}\b0  done\par
{\*\unknowndest junk}{\field{\*\fldinst{HYPERLINK "javascript:alert(1)"}}{\fldrslt bad}} \line next\par}`;
  const doc = await convertDocument('rtf', new TextEncoder().encode(rtf));
  assert.equal(doc.title, 'Plain été');
  assert.match(doc.html, /<p class="al-c">Café €• and При  <strong>bold<\/strong> done<\/p>/, "U+F0B7, the Symbol font’s bullet");
  assert.doesNotMatch(doc.html, /hidden|junk|Arial|Hand|javascript|href/);
  assert.match(doc.html, /bad <br>next/);
  await assert.rejects(convertDocument('rtf', new TextEncoder().encode('just text')), /not an RTF/);
});

test('the plain text of a page: a line per paragraph, cells apart by tabs, note marks left out', () => {
  assert.equal(
    htmlToText('<h1>T</h1><p>a &amp; b<br>c</p><ul><li>x<ul><li>y</li></ul></li></ul><table><tr><td><p>1</p><p>2</p></td><td>3</td></tr></table><pre>keep\n  this</pre><p>n<a class="doc-noteback" href="#">↩</a></p>'),
    'T\na & b\nc\nx\ny\n1 2\t3\nkeep\nthis\nn',
  );
});

test('a damaged or empty file says so', async () => {
  await assert.rejects(convertDocument('docx', new Uint8Array(0)), /empty/);
  await assert.rejects(convertDocument('docx', new TextEncoder().encode('not a zip at all')), /damaged/);
  await assert.rejects(convertDocument('docx', zip({ 'x.txt': 'no document' })), /no document/);
});
