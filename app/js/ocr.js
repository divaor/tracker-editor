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

// ---- Text from images with the connected model ----------------------------------

/** Models whose names say they read images (to suggest one in Settings). */
export const looksLikeVisionModel = (name) => /vision|[-_.]vl\b|vl[:\d]|llava|minicpm-v|moondream|gemma3|pixtral|qwen2\.5vl|qwen3-vl|granite.*vision|llama4/i.test(name ?? '');

/**
 * The chat messages that ask a model to read the text in images (data URLs, as
 * OpenAI-compatible servers take them), keeping the layout.
 */
export function visionMessages(dataUrls, { langs = 'eng+spa' } = {}) {
  const languages = langs
    .split('+')
    .map((l) => ({ eng: 'English', spa: 'Spanish' })[l] ?? l)
    .join(' and ');
  return [
    {
      role: 'system',
      content: `You transcribe the text in images exactly as written (most likely in ${languages}). Keep the line breaks and the reading order; write tables as Markdown tables and lists as lists. Do not translate, correct, summarize or describe the image. Reply with only the text; if there is no text, reply with nothing.`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: dataUrls.length > 1 ? `Transcribe the text in these ${dataUrls.length} images, in order, with a line "## Image N" before each.` : 'Transcribe the text in this image.' },
        ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    },
  ];
}

/** The model's reply as text: without a code fence around all of it, or a lead-in like "Here is the text:". */
export function cleanVisionReply(reply) {
  let text = String(reply ?? '').trim();
  text = text.replace(/^(here (is|are) the (transcribed |extracted )?text[^\n:]*:|the text (in|from) the image (is|reads)[^\n:]*:|aquí está el texto[^\n:]*:)\s*/i, '');
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1];
  return text.trim();
}

/** The longest side images are scaled down to before they go to a model (smaller requests, the text still sharp). */
export const VISION_MAX_SIDE = 2000;
export const visionScale = (width, height) => Math.min(1, VISION_MAX_SIDE / Math.max(width, height, 1));
