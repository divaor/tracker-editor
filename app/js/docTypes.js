// Documents the editor shows as they look, read-only, in a tab of their own: PDFs, e-books,
// word processor files, spreadsheets and slides (documents.js turns them into a page;
// ui/documentView.js shows it). Their text can be had too ("As text"). Pure: the main process
// (through electron/diskFiles.cjs's copy of the list) and the Android app use it as well.

export const DOCUMENT_TYPES = {
  pdf: { kind: 'pdf', label: 'PDF' },
  epub: { kind: 'epub', label: 'E-book (EPUB)' },
  fb2: { kind: 'fb2', label: 'E-book (FictionBook)' },
  docx: { kind: 'docx', label: 'Word document' },
  docm: { kind: 'docx', label: 'Word document' },
  dotx: { kind: 'docx', label: 'Word template' },
  dotm: { kind: 'docx', label: 'Word template' },
  odt: { kind: 'odt', label: 'OpenDocument text' },
  ott: { kind: 'odt', label: 'OpenDocument template' },
  rtf: { kind: 'rtf', label: 'Rich text' },
  xlsx: { kind: 'xlsx', label: 'Excel workbook' },
  xlsm: { kind: 'xlsx', label: 'Excel workbook' },
  xltx: { kind: 'xlsx', label: 'Excel template' },
  ods: { kind: 'ods', label: 'OpenDocument spreadsheet' },
  ots: { kind: 'ods', label: 'OpenDocument template' },
  pptx: { kind: 'pptx', label: 'PowerPoint presentation' },
  pptm: { kind: 'pptx', label: 'PowerPoint presentation' },
  ppsx: { kind: 'pptx', label: 'PowerPoint slide show' },
  potx: { kind: 'pptx', label: 'PowerPoint template' },
  odp: { kind: 'odp', label: 'OpenDocument presentation' },
  otp: { kind: 'odp', label: 'OpenDocument template' },
};

// For files given by other apps without an extension in their name (Android).
const MIME_KINDS = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/x-fictionbook+xml': 'fb2',
  'application/x-fictionbook': 'fb2',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'pptx',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

const extOf = (name) => /\.([^.\\/]+)$/.exec(String(name ?? ''))?.[1]?.toLowerCase() ?? '';

/** The kind of document a file is ('pdf', 'epub', 'docx'…), by its name, else its MIME type; null for others. */
export function documentKind(name, mime = '') {
  return DOCUMENT_TYPES[extOf(name)]?.kind ?? MIME_KINDS[String(mime).toLowerCase().split(';')[0].trim()] ?? null;
}

/** What to call it: "PDF", "Word document"… */
export const documentLabel = (name, mime = '') => DOCUMENT_TYPES[extOf(name)]?.label ?? Object.values(DOCUMENT_TYPES).find((t) => t.kind === documentKind(name, mime))?.label ?? 'Document';

export const isDocumentName = (name) => Boolean(DOCUMENT_TYPES[extOf(name)]);
