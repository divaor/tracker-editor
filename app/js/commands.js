// Every command with its shortcut, for Help (F1): the cheat sheet, searchable, where
// a command can also be run. `keys` use "Mod" for Ctrl (Cmd on macOS) and "Alt" for
// Alt (Option); `desktop` keys apply in the desktop app instead; `only` marks commands
// that exist only there ('desktop'). Pure, so the Node tests can check it.

export const COMMAND_GROUPS = ['Files and tabs', 'Find', 'Edit and text', 'View', 'Tools', 'Folders view', 'Terminal'];

/** [{ id, group, label, keys?, desktop?, only?, hint?, run? }]; `run: false` for keys that only work in place. */
export const COMMAND_LIST = [
  { id: 'new', group: 'Files and tabs', label: 'New file', keys: 'Alt+N', desktop: 'Mod+N' },
  { id: 'quick-open', group: 'Files and tabs', label: 'Open a file by name', keys: 'Mod+P' },
  { id: 'disk-open', group: 'Files and tabs', label: 'Open a file from this computer (edit in place)', keys: 'Mod+O', only: 'desktop' },
  { id: 'folder-open', group: 'Files and tabs', label: 'Open a folder', only: 'desktop' },
  { id: 'server-add', group: 'Files and tabs', label: 'Connect to a server', only: 'desktop' },
  { id: 'open-disk', group: 'Files and tabs', label: 'Import files' },
  { id: 'save-copy', group: 'Files and tabs', label: 'Save a copy to disk', desktop: 'Mod+Shift+S' },
  { id: 'close-tab', group: 'Files and tabs', label: 'Close the tab', keys: 'Alt+W', desktop: 'Mod+W' },
  { id: 'reopen-tab', group: 'Files and tabs', label: 'Reopen the closed tab', desktop: 'Mod+Shift+T', only: 'desktop' },
  { id: 'next-tab', group: 'Files and tabs', label: 'Next tab', desktop: 'Ctrl+Tab', only: 'desktop' },
  { id: 'prev-tab', group: 'Files and tabs', label: 'Previous tab', desktop: 'Ctrl+Shift+Tab', only: 'desktop' },
  { id: 'sync', group: 'Files and tabs', label: 'Sync now (or save a file from disk or a server)', keys: 'Mod+S' },
  { id: 'trash', group: 'Files and tabs', label: 'Deleted files (trash)' },
  { id: 'settings', group: 'Files and tabs', label: 'Settings', desktop: 'Mod+,' },

  { id: 'find', group: 'Find', label: 'Find in this file', keys: 'Mod+F' },
  { id: 'replace', group: 'Find', label: 'Replace in this file', keys: 'Mod+H', mac: 'Mod+Alt+F' },
  { id: 'find-next', group: 'Find', label: 'Next / previous match', keys: 'Enter · Shift+Enter (or F3)', run: false },
  { id: 'goto-line', group: 'Find', label: 'Go to line', keys: 'Mod+G' },
  { id: 'find-in-files', group: 'Find', label: 'Find in files', keys: 'Mod+Shift+F' },
  { id: 'filter-lines', group: 'Find', label: 'Filter lines (show or hide the ones that match)', keys: 'Alt+L' },
  { id: 'selectNext', group: 'Find', label: 'Select the next occurrence', keys: 'Mod+D' },
  { id: 'select-all-matches', group: 'Find', label: 'Select every occurrence', keys: 'Mod+Shift+L', run: false },

  { id: 'format', group: 'Edit and text', label: 'Format document (JSON, XML, SQL, JavaScript, CSS, HTML, YAML…)', keys: 'Shift+Alt+F', hint: 'The selection, or the whole file' },
  { id: 'toggleComment', group: 'Edit and text', label: 'Comment or uncomment lines', keys: 'Mod+/' },
  { id: 'duplicateLine', group: 'Edit and text', label: 'Duplicate the line', keys: 'Mod+Shift+D' },
  { id: 'deleteLine', group: 'Edit and text', label: 'Delete the line', keys: 'Mod+Shift+K' },
  { id: 'move-line', group: 'Edit and text', label: 'Move the line up / down', keys: 'Alt+↑ · Alt+↓', run: false },
  { id: 'upperCase', group: 'Edit and text', label: 'UPPER CASE (the selection)' },
  { id: 'lowerCase', group: 'Edit and text', label: 'lower case (the selection)' },
  { id: 'sortLines', group: 'Edit and text', label: 'Sort lines (the selection or the file)' },
  { id: 'removeDuplicateLines', group: 'Edit and text', label: 'Remove duplicate lines' },
  { id: 'trimTrailing', group: 'Edit and text', label: 'Trim trailing spaces' },
  { id: 'undo', group: 'Edit and text', label: 'Undo', keys: 'Mod+Z' },
  { id: 'redo', group: 'Edit and text', label: 'Redo', keys: 'Mod+Y · Mod+Shift+Z' },
  { id: 'indent', group: 'Edit and text', label: 'Indent / outdent', keys: 'Tab · Shift+Tab', run: false },
  { id: 'fold', group: 'Edit and text', label: 'Fold / unfold a block', keys: 'Ctrl+Shift+[ · Ctrl+Shift+]', mac: 'Mod+Alt+[ · Mod+Alt+]', run: false },
  { id: 'cursors', group: 'Edit and text', label: 'More cursors / a rectangle', keys: 'Alt+click · Alt+drag', run: false },

  { id: 'toggle-sidebar', group: 'View', label: 'Show or hide the file list', keys: 'Mod+B' },
  { id: 'folders', group: 'View', label: 'Folders (this computer and servers)', keys: 'Mod+Shift+E', only: 'desktop' },
  { id: 'toggle-wrap', group: 'View', label: 'Word wrap', keys: 'Alt+Z' },
  { id: 'preview', group: 'View', label: 'Preview (Markdown, HTML, JSON, CSV…)' },
  { id: 'split', group: 'View', label: 'Split view', keys: 'Mod+\\' },
  { id: 'outline', group: 'View', label: 'Outline and links', keys: 'Mod+Shift+O' },
  { id: 'terminal', group: 'View', label: 'Terminal on a server', keys: 'Ctrl+`', only: 'desktop' },
  { id: 'read-aloud', group: 'View', label: 'Read aloud, pause or resume', keys: 'Alt+R' },
  { id: 'assistant', group: 'View', label: 'The model', keys: 'Mod+Shift+A' },
  { id: 'help', group: 'View', label: 'Help: commands, shortcuts and the guide', keys: 'F1' },

  { id: 'ask-selection', group: 'Tools', label: 'Ask the model about the selection or the file', keys: 'Mod+K' },
  { id: 'snippets', group: 'Tools', label: 'Insert a snippet', keys: 'Alt+I' },
  { id: 'macro-record', group: 'Tools', label: 'Record a macro (again to stop)', keys: 'Mod+Shift+R' },
  { id: 'macro-play', group: 'Tools', label: 'Play the macro', keys: 'Mod+Shift+P' },
  { id: 'macro-run', group: 'Tools', label: 'Run the macro many times' },
  { id: 'type-out', group: 'Tools', label: 'Type into another window', keys: 'Alt+T', only: 'desktop' },
  { id: 'clipboard-history', group: 'Tools', label: 'Clipboard history', keys: 'Mod+Shift+V', only: 'desktop' },
  { id: 'compare-clipboard', group: 'Tools', label: 'Compare with the clipboard' },
  { id: 'image-ocr', group: 'Tools', label: 'Text from an image' },
  { id: 'screenshot-ocr', group: 'Tools', label: 'Text from a screenshot', only: 'desktop' },
  { id: 'quick-capture', group: 'Tools', label: 'Quick capture, from any app (when turned on)', keys: 'Ctrl+Alt+N', only: 'desktop', run: false },

  { id: 'fv-open', group: 'Folders view', label: 'Open / go up a folder', keys: 'Enter · Backspace', run: false },
  { id: 'fv-tree', group: 'Folders view', label: 'Open / close a folder in place', keys: '→ · ←', run: false },
  { id: 'fv-view', group: 'Folders view', label: 'View the file large (←/→ for the others)', keys: 'Space', run: false },
  { id: 'fv-rename', group: 'Folders view', label: 'Rename', keys: 'F2', run: false },
  { id: 'fv-delete', group: 'Folders view', label: 'Delete (to the Recycle Bin)', keys: 'Del', run: false },
  { id: 'fv-clip', group: 'Folders view', label: 'Copy / cut / paste (with your file explorer too)', keys: 'Mod+C · Mod+X · Mod+V', run: false },
  { id: 'fv-new-folder', group: 'Folders view', label: 'New folder', keys: 'Mod+Shift+N', run: false },
  { id: 'fv-refresh', group: 'Folders view', label: 'Refresh', keys: 'F5', run: false },
  { id: 'fv-properties', group: 'Folders view', label: 'Properties', keys: 'Alt+Enter', run: false },
  { id: 'fv-find', group: 'Folders view', label: 'Find in this folder', keys: 'Mod+Shift+F', run: false },

  { id: 'term-copy', group: 'Terminal', label: 'Copy / paste', keys: 'Ctrl+Shift+C · Ctrl+Shift+V', run: false },
];

/** The keys of a command as this computer shows them (Cmd and Option on macOS; the desktop app's own keys there). */
export function keysFor(command, { mac = false, desktop = false } = {}) {
  const keys = (mac && command.mac) || (desktop && command.desktop) || command.keys || command.desktop || '';
  return mac ? keys.replace(/Mod\+/g, 'Cmd+').replace(/Alt\+/g, 'Option+') : keys.replace(/Mod\+/g, 'Ctrl+');
}

/** The commands for this place (desktop-only ones left out in the browser), matching every word of `query`. */
export function findCommands(query = '', { desktop = false, list = COMMAND_LIST, mac = false } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((c) => (desktop || c.only !== 'desktop') && words.every((w) => `${c.label} ${c.group} ${keysFor(c, { mac, desktop })} ${c.hint ?? ''}`.toLowerCase().includes(w)));
}
