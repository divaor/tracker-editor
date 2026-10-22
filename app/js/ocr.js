// Text from images (OCR): the languages offered and tidying what tesseract
// reads. Pure, so the Node tests can import it; ocrEngine.js does the reading.

export const OCR_LANGUAGES = [
  { id: 'eng+spa', label: 'English and Spanish' },
  { id: 'eng', label: 'English' },
  { id: 'spa', label: 'Spanish' },
];

/** Line breaks kept, trailing spaces and runs of blank lines removed, ligatures spelled out. */
export function cleanOcrText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How much to enlarge an image before reading it: screenshots of small text
 * read much better at 2–3×. Large photos stay as they are.
 */
export function ocrScale(width, height) {
  if (!width || !height || width >= 1800 || height >= 1800) return 1;
  // At most about 4 megapixels.
  return Math.max(1, Math.min(3, 1800 / width, Math.sqrt(4_000_000 / (width * height))));
}

/** How sure the reading is, from tesseract's 0–100 confidence. */
export const confidenceLabel = (confidence) => (confidence >= 85 ? 'Read clearly' : confidence >= 60 ? 'Mostly clear: check the text' : 'Hard to read: check the text carefully');
