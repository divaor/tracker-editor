// Which files have a reading view, and the parsing behind the simple ones.
// Pure, so the Node tests can import it.

const BY_LANGUAGE = { Markdown: 'markdown', HTML: 'html', JSON: 'json', 'JSON-LD': 'json', XML: 'xml' };
const BY_EXTENSION = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', json: 'json', geojson: 'json', xml: 'xml', svg: 'svg', csv: 'csv', tsv: 'tsv' };

/** The preview for a file: markdown, html, json, xml, svg, csv, tsv, or '' for none. */
export function previewKind(name = '', languageName = '') {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  // The extension decides for svg, csv and tsv (their language is XML or plain text).
  if (['svg', 'csv', 'tsv'].includes(ext)) return BY_EXTENSION[ext];
  return BY_LANGUAGE[languageName] ?? BY_EXTENSION[ext] ?? '';
}

/** Rows of a CSV (or TSV with delimiter "\t") text; quoted fields may hold delimiters, quotes and line breaks. */
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The first syntax error in a JSON text as { message, line, column } (1-based),
 * or null when it is valid. JSON.parse's own messages often say no more than
 * "is not valid JSON", without a place.
 */
export function jsonProblem(text) {
  let i = 0;
  const fail = (message) => {
    throw Object.assign(new Error(message), { at: i });
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail('Line break inside a string');
      i += text[i] === '\\' ? 2 : 1;
    }
    if (i >= text.length) fail('A string is not closed');
    i++;
  };
  const value = () => {
    space();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      space();
      if (text[i] === close) return void i++;
      for (;;) {
        if (c === '{') {
          space();
          if (text[i] !== '"') fail(text[i] === '}' ? 'Extra comma before "}"' : 'Expected a key in "quotes"');
          string();
          space();
          if (text[i] !== ':') fail('Expected ":" after the key');
          i++;
        }
        if (c === '[') {
          space();
          if (text[i] === ']') fail('Extra comma before "]"');
        }
        value();
        space();
        if (text[i] === ',') i++;
        else if (text[i] === close) return void i++;
        else fail(i >= text.length ? `"${close}" is missing at the end` : `Expected "," or "${close}"`);
      }
    }
    if (c === '"') return string();
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (number) return void (i += number[0].length);
    for (const word of ['true', 'false', 'null']) if (text.startsWith(word, i)) return void (i += word.length);
    fail(c === undefined ? 'The text ends too early' : `Unexpected "${c}"`);
  };
  try {
    value();
    space();
    if (i < text.length) fail('Unexpected text after the end');
    return null;
  } catch (err) {
    const lines = text.slice(0, err.at).split('\n');
    return { message: err.message, line: lines.length, column: lines.at(-1).length + 1 };
  }
}
