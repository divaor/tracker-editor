// Quick capture (desktop): notes written in the small window a global shortcut
// opens, kept as a new file or added to the Inbox note. Pure, so the Node
// tests can import it.

export const INBOX_NAME = 'Inbox.md';

const pad = (n) => String(n).padStart(2, '0');
/** "2026-10-22 14:05" in local time. */
export const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The Inbox note's text with a capture added at the end, under its time. */
export function appendToInbox(existing, text, date = new Date()) {
  const base = existing?.trim() ? existing.replace(/\s*$/, '\n\n') : '# Inbox\n\n';
  return `${base}## ${stamp(date)}\n\n${text.trim()}\n`;
}

/** The Inbox note among the files (by name, any case), or null. */
export const findInbox = (files) => files.find((f) => f.name.toLowerCase() === INBOX_NAME.toLowerCase()) ?? null;
