// Typing text into another window (desktop app): for remote desktops and
// consoles that block pasting, the text goes in as key presses after a short
// countdown. The main process presses the keys (electron/typer.cjs); this
// prepares the text. Pure, so the Node tests can import it.

export const TYPING_SPEEDS = [
  { id: 'fast', label: 'Fast', delay: 5 },
  { id: 'normal', label: 'Normal', delay: 15 },
  { id: 'slow', label: 'Slow, for laggy connections', delay: 40 },
];

export const typingDelay = (speed) => (TYPING_SPEEDS.find((s) => s.id === speed) ?? TYPING_SPEEDS[1]).delay;

/**
 * The text as it will be typed: line breaks as Enter (LF only). Indentation stays
 * as it is: when the other editor indents new lines by itself, the typer clears what
 * it adds after each Enter (`lineStart`), so every line keeps exactly its own.
 */
export function prepareTyping(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** About how long typing `length` characters takes, in seconds. */
export const typingSeconds = (length, delay) => Math.ceil((length * (delay + 3)) / 1000);

/** "1 min 20 s", "45 s" */
export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
