// Turning a checklist in a note into tracker tasks: the open items of a
// Markdown checklist ("- [ ] call the vendor"), or, without checkboxes, its
// bullet lines, or else its non-empty lines. Pure, so the Node tests can import it.

const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Items for the tracker: [{ line, title, due }] (line is 1-based within `text`,
 * plus `firstLine - 1`). Checked boxes are left out; a date in an item becomes its due date.
 */
export function checklistItems(text, { firstLine = 1 } = {}) {
  const lines = String(text ?? '').split('\n');
  const pick = (re, keep) =>
    lines.flatMap((raw, i) => {
      const m = re.exec(raw);
      if (!m || !keep(m)) return [];
      const body = (m.length > 2 ? m[2] : m[1]).trim();
      return body ? [{ line: i + firstLine, body }] : [];
    });
  let found = pick(CHECKBOX, (m) => m[1] === ' ');
  if (!found.length && !lines.some((l) => CHECKBOX.test(l))) found = pick(BULLET, () => true);
  if (!found.length && !lines.some((l) => CHECKBOX.test(l) || BULLET.test(l))) found = pick(/^(.*\S.*)$/, () => true);
  return found.map(({ line, body }) => {
    const due = DATE.exec(body)?.[1] ?? '';
    const title = body
      .replace(/\s*\(?(?:due|para|by)?:?\s*\d{4}-\d{2}-\d{2}\)?/i, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    return { line, title: title || body.slice(0, 140), due };
  });
}
