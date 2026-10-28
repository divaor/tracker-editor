// Documents as a page to read: e-books (EPUB, FictionBook), word processor files (Word,
// OpenDocument, RTF), spreadsheets (Excel, OpenDocument) and slides (PowerPoint,
// OpenDocument) become simple HTML, built here from what the file holds: only the tags and
// attributes written below, never the file's own scripts, styles or remote addresses. The
// page sanitizes it once more before showing it (ui/documentView.js). PDFs are drawn by
// pdf.js instead (pdfDoc.js). Pure, so the Node tests convert sample files.
//
// convertDocument(kind, bytes) gives { html, text, title, toc, image }:
// - html: the page; pictures are <img data-doc-img="ref">, which `image(ref)` gives
//   ({ bytes, type }) for the view to show.
// - text: the plain text ("As text", search, the model).
// - toc: [{ label, target, depth }] (the e-book's contents, a workbook's sheets), `target`
//   being an element id in the html.

import { convertDocx } from './docs/docx.js';
import { convertEpub } from './docs/epub.js';
import { convertFb2 } from './docs/fb2.js';
import { convertOdf } from './docs/odf.js';
import { convertPptx } from './docs/pptx.js';
import { convertRtf } from './docs/rtf.js';
import { convertXlsx } from './docs/xlsx.js';
import { DocumentError, htmlToText } from './docs/common.js';
import { isZip, readZip, ZipError } from './unzip.js';

export { documentKind, documentLabel, isDocumentName } from './docTypes.js';
export { DocumentError, esc, htmlToText } from './docs/common.js';

const CONVERTERS = { docx: convertDocx, epub: convertEpub, odt: convertOdf, ods: convertOdf, odp: convertOdf, xlsx: convertXlsx, pptx: convertPptx };

/** A document (its bytes) as { html, text, title, toc, image(ref) }. Throws a DocumentError saying what is wrong. */
export async function convertDocument(kind, bytes, { limit } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    if (kind === 'rtf') return finish(convertRtf(b));
    if (kind === 'fb2') return finish(await convertFb2(b));
    const convert = CONVERTERS[kind];
    if (!convert) throw new DocumentError('This kind of document cannot be shown here.');
    if (!isZip(b)) throw new DocumentError(b.length ? 'This file is damaged or is not what its name says.' : 'This file is empty.');
    return finish(await convert(readZip(b, limit ? { limit } : {}), kind));
  } catch (err) {
    if (err instanceof DocumentError) throw err;
    if (err instanceof ZipError) throw new DocumentError(err.message);
    throw new DocumentError(`This file could not be read: ${err?.message ?? err}`);
  }
}

function finish(doc) {
  return { title: '', toc: [], image: async () => null, ...doc, text: doc.text ?? htmlToText(doc.html) };
}
