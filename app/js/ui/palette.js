import { isLocal } from '../settings.js';
import { html, useState } from '../../vendor/preact-htm.js';
import { findCommands } from '../commands.js';
import { shownKeys } from '../keys.js';
import { isMac, Keys } from './help.js';
import { PickList } from './symbols.js';
import { isDesktopApp } from '../platform.js';

/**
 * Ctrl+Shift+P (as in VS Code): every command by name, run with Enter. The same list as
 * Help (F1), which also shows the keys that only work in place.
 */
export function CommandPalette({ initial = '', onRun, onClose }) {
  const [query, setQuery] = useState(initial);
  const mac = isMac();
  const desktop = isDesktopApp();
  const rows = findCommands(query, { desktop, mac, local: isLocal(), keysOf: shownKeys }).filter((c) => c.run !== false);
  return html`<${PickList} title="Run a command" placeholder="Type part of a command (format, fold, problems…)" query=${query} setQuery=${setQuery} rows=${rows}
    onClose=${onClose} onPick=${(c) => onRun(c)} empty="No command matches."
    render=${(c) => html`<span class="quick-name palette-label">${c.label}</span><span class="muted small palette-group">${c.group}</span><span class="spacer" /><${Keys} keys=${shownKeys(c)} />`} />`;
}
