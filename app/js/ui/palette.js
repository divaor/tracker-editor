import { isLocal } from '../settings.js';
import { html, useState } from '../../vendor/preact-htm.js';
import { COMMAND_GROUPS, findCommands } from '../commands.js';
import { wordRanges } from '../quickRows.js';
import { shownKeys } from '../keys.js';
import { isMac, Keys } from './help.js';
import { PickList } from './symbols.js';
import { Marked } from './listNav.js';
import { isAndroidApp, isDesktopApp } from '../platform.js';

// A color per group of commands (the file type colors), so a group is found at a glance.
const GROUP_TINTS = ['blue', 'cyan', 'purple', 'indigo', 'orange', 'red', 'green', 'teal', 'brown', 'pink'];
const tintOf = (group) => GROUP_TINTS[Math.max(0, COMMAND_GROUPS.indexOf(group)) % GROUP_TINTS.length];

/**
 * Ctrl+Shift+P (as in VS Code): every command by name, run with Enter. The same list as
 * Help (F1), which also shows the keys that only work in place.
 */
export function CommandPalette({ initial = '', onRun, onClose }) {
  const [query, setQuery] = useState(initial);
  const mac = isMac();
  const desktop = isDesktopApp();
  const rows = findCommands(query, { desktop, android: isAndroidApp(), mac, local: isLocal(), keysOf: shownKeys }).filter((c) => c.run !== false);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return html`<${PickList} title="Run a command" placeholder="Type part of a command (format, fold, problems…)" query=${query} setQuery=${setQuery} rows=${rows}
    onClose=${onClose} onPick=${(c) => onRun(c)} empty="No command matches." action="run" icon="keyboard"
    render=${(c) => html`<span class="qo-name palette-label"><${Marked} text=${c.label} ranges=${wordRanges(c.label, words)} /></span><span class="qo-place" />
      <span class="qo-chip palette-group ft-${tintOf(c.group)}">${c.group}</span><${Keys} keys=${shownKeys(c)} />`} />`;
}
