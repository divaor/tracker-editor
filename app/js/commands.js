// Every command with its shortcut, for Help (F1): the cheat sheet, searchable, where
// a command can also be run. `keys` use "Mod" for Ctrl (Cmd on macOS) and "Alt" for
// Alt (Option); `desktop` keys apply in the desktop app instead; `only` marks commands
// that exist only there ('desktop'). Pure, so the Node tests can check it.

export const COMMAND_GROUPS = ['Files and tabs', 'Find', 'Edit and text', 'Code', 'Git', 'Debug', 'View', 'Tools', 'Folders view', 'Terminal'];

/**
 * [{ id, group, label, keys?, desktop?, only?, hint?, run?, local?, when? }]; `run: false` for keys that only work in place;
 * `local`: the label in local mode (no GitHub), or false to leave it out there; `when: 'debugging'`:
 * its keys work only while a program is debugged (and may be another command's otherwise: F5).
 * Keys can be changed (keybindings.js, Settings → Keys): a command with `keys` here gets them with
 * nothing else to wire, through the window's key handler and `actions.command`.
 */
export const COMMAND_LIST = [
  { id: 'new', group: 'Files and tabs', label: 'New file', keys: 'Alt+N', desktop: 'Mod+N' },
  { id: 'quick-open', group: 'Files and tabs', label: 'Open a file by name', keys: 'Mod+P' },
  { id: 'disk-open', group: 'Files and tabs', label: 'Open a file from this computer (edit in place)', keys: 'Mod+O', only: 'desktop' },
  { id: 'folder-open', group: 'Files and tabs', label: 'Open a folder', only: 'desktop' },
  { id: 'folder-beside', group: 'Folders view', label: 'Folders side by side: add some (here or on servers), reorder, close', only: 'desktop', hint: 'Each one under its own header: drag the headers to change the order' },
  { id: 'server-add', group: 'Files and tabs', label: 'Connect to a server', only: 'desktop' },
  { id: 'open-disk', group: 'Files and tabs', label: 'Import files' },
  { id: 'save-copy', group: 'Files and tabs', label: 'Save a copy to disk', desktop: 'Mod+Shift+S' },
  { id: 'close-tab', group: 'Files and tabs', label: 'Close the tab', keys: 'Alt+W', desktop: 'Mod+W' },
  { id: 'tab-middle', group: 'Files and tabs', label: 'Close a tab', keys: 'Middle-click', run: false },
  { id: 'tab-pin', group: 'Files and tabs', label: 'Pin or unpin a tab', keys: 'Double-click', run: false },
  { id: 'tab-menu', group: 'Files and tabs', label: 'The tab menu (pin, a new pane, close others…)', keys: 'Right-click', hint: 'On a phone: ⋯ on the open tab, or a long press', run: false },
  { id: 'tab-scroll', group: 'Files and tabs', label: 'Scroll through many tabs (the mouse over them)', keys: 'Mouse wheel', run: false },
  { id: 'reveal-tab', group: 'Files and tabs', label: 'Show the open tab in the tab bar', hint: 'When many tabs are open, the arrow at the edge with a dot leads to it too' },
  { id: 'tab-list', group: 'Files and tabs', label: 'All open tabs: a list to pick one from', hint: 'The ▾ at the end of the tab bar' },
  { id: 'reopen-tab', group: 'Files and tabs', label: 'Reopen the closed tab', desktop: 'Mod+Shift+T', only: 'desktop' },
  { id: 'next-tab', group: 'Files and tabs', label: 'Next tab', desktop: 'Ctrl+Tab', only: 'desktop' },
  { id: 'prev-tab', group: 'Files and tabs', label: 'Previous tab', desktop: 'Ctrl+Shift+Tab', only: 'desktop' },
  { id: 'tab-view', group: 'Files and tabs', label: 'Which tabs show: a project, a folder, notes, other files, or several', keys: 'Alt+V', hint: 'The switcher at the left of the tab bar' },
  { id: 'tab-group-next', group: 'Files and tabs', label: 'Show the next group of tabs', keys: 'Mod+Alt+PageDown' },
  { id: 'tab-group-prev', group: 'Files and tabs', label: 'Show the previous group of tabs', keys: 'Mod+Alt+PageUp' },
  { id: 'tab-view-all', group: 'Files and tabs', label: 'Show all tabs', keys: 'Mod+Alt+Home' },
  { id: 'tab-view-only', group: 'Files and tabs', label: 'Only the tabs of the open tab’s group (its project or folder)' },
  { id: 'tab-move-group', group: 'Files and tabs', label: 'Move the open tab to another group…' },
  { id: 'sync', group: 'Files and tabs', label: 'Sync now (or save a file from disk or a server)', local: 'Save a file from disk or a server', keys: 'Mod+S' },
  { id: 'trash', group: 'Files and tabs', label: 'Deleted files (trash)' },
  { id: 'settings', group: 'Files and tabs', label: 'Settings', desktop: 'Mod+,' },

  { id: 'find', group: 'Find', label: 'Find in this file', keys: 'Mod+F' },
  { id: 'replace', group: 'Find', label: 'Replace in this file', keys: 'Mod+H', mac: 'Mod+Alt+F' },
  { id: 'find-next', group: 'Find', label: 'Next / previous match', keys: 'Enter · Shift+Enter (or F3)', run: false },
  { id: 'goto-line', group: 'Find', label: 'Go to line', keys: 'Mod+G' },
  { id: 'find-in-files', group: 'Find', label: 'Find in files', keys: 'Mod+Shift+F' },
  { id: 'ask-find', group: 'Find', label: 'Find by asking: a question about your files, documents, tracker items and folders', hint: 'Or type a question in Ctrl+P (✦ Ask); with a model on' },
  { id: 'ask-results', group: 'Find', label: 'The last Find by asking results' },
  { id: 'filter-lines', group: 'Find', label: 'Filter lines (show or hide the ones that match)', keys: 'Alt+L' },
  { id: 'selectNext', group: 'Find', label: 'Select the next occurrence', keys: 'Mod+D' },
  { id: 'select-all-matches', group: 'Find', label: 'Select every occurrence', keys: 'Mod+Shift+L', run: false },

  { id: 'format', group: 'Edit and text', label: 'Format document (JSON, XML, SQL, JavaScript, CSS, HTML, YAML…)', keys: 'Shift+Alt+F', hint: 'The selection, or the whole file; with a language server, its formatter (gofmt, clangd…)' },
  { id: 'toggleComment', group: 'Edit and text', label: 'Comment or uncomment lines', keys: 'Mod+/' },
  { id: 'duplicateLine', group: 'Edit and text', label: 'Duplicate the line', keys: 'Mod+Shift+D' },
  { id: 'deleteLine', group: 'Edit and text', label: 'Delete the line', keys: 'Mod+Shift+K' },
  { id: 'move-line', group: 'Edit and text', label: 'Move the line up / down', keys: 'Alt+↑ · Alt+↓', run: false },
  { id: 'selectLine', group: 'Edit and text', label: 'Select the line (again: the next one too)', keys: 'Mod+L' },
  { id: 'line-menu', group: 'Edit and text', label: 'Select a line and copy, cut or paste it', keys: 'Click a line number', hint: 'A tap on a phone. Shift+click: up to that line. Right-click or a long press: the menu for the selection', run: false },
  { id: 'edit-bar', group: 'Edit and text', label: 'Keys a phone lacks: Tab, Ctrl, arrows, symbols, copy and paste', keys: 'The edit bar', hint: "It takes the status bar's place while you type on a touch screen; Settings → Editor turns it off", run: false },
  { id: 'upperCase', group: 'Edit and text', label: 'UPPER CASE (the selection)' },
  { id: 'lowerCase', group: 'Edit and text', label: 'lower case (the selection)' },
  { id: 'sortLines', group: 'Edit and text', label: 'Sort lines (the selection or the file)' },
  { id: 'removeDuplicateLines', group: 'Edit and text', label: 'Remove duplicate lines' },
  { id: 'trimTrailing', group: 'Edit and text', label: 'Trim trailing spaces' },
  { id: 'undo', group: 'Edit and text', label: 'Undo', keys: 'Mod+Z' },
  { id: 'redo', group: 'Edit and text', label: 'Redo', keys: 'Mod+Y · Mod+Shift+Z' },
  { id: 'indent', group: 'Edit and text', label: 'Indent / outdent', keys: 'Tab · Shift+Tab', run: false },
  { id: 'cursors', group: 'Edit and text', label: 'More cursors / a rectangle', keys: 'Mod+click · Alt+drag', hint: 'In code, Ctrl+click on a name goes to its declaration: Ctrl+Alt+click adds the cursor there', run: false },
  { id: 'column-select', group: 'Edit and text', label: 'Select a column (a rectangle) with the keys, to edit several lines at once', keys: 'Shift+Alt+↑ ↓ ← →', mac: 'Mod+Shift+Alt+↑ ↓ ← →', hint: 'Also Ctrl+Shift+Alt+arrows, as in VS Code', run: false },
  { id: 'addCursorAbove', group: 'Edit and text', label: 'Add a cursor on the line above', keys: 'Mod+Alt+↑' },
  { id: 'addCursorBelow', group: 'Edit and text', label: 'Add a cursor on the line below', keys: 'Mod+Alt+↓' },
  { id: 'emmet', group: 'Edit and text', label: 'Expand an Emmet abbreviation (HTML, XML, JSX: ul>li*3, div.card, !)', keys: 'Tab', run: false },
  { id: 'auto-tags', group: 'Edit and text', label: 'Close tags as you type ">"; renaming a tag renames its other end', keys: '> · type in a tag name', run: false },
  { id: 'indent-spaces', group: 'Edit and text', label: 'Indent this file with spaces', hint: 'Or click “Spaces” / “Tab size” in the status bar' },
  { id: 'indent-tabs', group: 'Edit and text', label: 'Indent this file with tabs' },
  { id: 'indent-to-spaces', group: 'Edit and text', label: 'Convert the indentation to spaces' },
  { id: 'indent-to-tabs', group: 'Edit and text', label: 'Convert the indentation to tabs' },
  { id: 'indent-detect', group: 'Edit and text', label: 'Indentation from the text again (detect it)', hint: 'Or from the .editorconfig of a file on disk' },

  { id: 'goto-definition', group: 'Code', label: 'Go to where the name at the cursor is declared', keys: 'F12', hint: 'In this file, else your other files and the folders open in Folders. On the declaration itself: its usages' },
  { id: 'find-usages', group: 'Code', label: 'Find usages of the name at the cursor', keys: 'Shift+F12', hint: 'In this file (the panel can look in all files); across the project with a language server' },
  { id: 'rename-symbol', group: 'Code', label: 'Rename the name at the cursor (every use)', keys: 'F2', hint: 'In this file; with a language server, everywhere in the project (you see every change first)' },
  { id: 'quick-fix', group: 'Code', label: 'Quick fixes and refactorings here (language server)', keys: 'Mod+.', only: 'desktop', hint: 'Add a missing import, fix a problem, extract a function… Or the 💡 at the end of a line with a problem' },
  { id: 'organize-imports', group: 'Code', label: 'Organize imports (language server)', keys: 'Shift+Alt+O', only: 'desktop', hint: 'Sorts them and removes the unused ones' },
  { id: 'definition-click', group: 'Code', label: 'Go to where a name is declared', keys: 'Mod+click', run: false, hint: 'In code: functions, methods, attributes, variables, classes. The name is underlined while Ctrl is held; Settings → Editor turns it off' },
  { id: 'text-menu', group: 'Code', label: 'The text’s menu: definition, references, rename, format, cut, copy, paste, comment, run, the model', keys: 'Right-click', run: false, hint: 'Or Shift+F10 at the cursor. Plain text and Markdown get a shorter one; a long press on a phone keeps its own' },
  { id: 'signature-help', group: 'Code', label: 'Show the parameters of the call here', keys: 'Mod+Shift+Space', run: false, hint: 'With a language server; they also show as you type "("' },
  { id: 'language-servers', group: 'Code', label: 'Language servers: their state and messages', only: 'desktop', hint: 'Restart or stop one; or click the server in the status bar' },
  { id: 'goto-symbol', group: 'Code', label: 'Go to a function, class or section', keys: 'Mod+P, then @' },
  { id: 'goto-symbol-all', group: 'Code', label: 'Go to a function, class or section in any file', desktop: 'Mod+T', keys: 'Mod+P, then #', hint: 'Your files and the folders open in Folders' },
  { id: 'matchingBracket', group: 'Code', label: 'Go to the matching bracket', keys: 'Mod+Shift+\\' },
  { id: 'fold', group: 'Code', label: 'Fold the block here', keys: 'Ctrl+Shift+[', mac: 'Mod+Alt+[', hint: 'Or click the arrow next to the line' },
  { id: 'unfold', group: 'Code', label: 'Unfold the block here', keys: 'Ctrl+Shift+]', mac: 'Mod+Alt+]' },
  { id: 'foldAll', group: 'Code', label: 'Fold everything (collapse all functions)', keys: 'Alt+0', hint: 'Blocks inside blocks too' },
  { id: 'unfoldAll', group: 'Code', label: 'Unfold everything (expand all)', keys: 'Alt+Shift+0' },
  { id: 'foldTop', group: 'Code', label: 'Fold the outer blocks (classes, top-level functions)', keys: 'Alt+1' },
  { id: 'foldLevel2', group: 'Code', label: 'Fold one level in (methods in classes)', keys: 'Alt+2' },
  { id: 'foldLevel3', group: 'Code', label: 'Fold two levels in', keys: 'Alt+3' },
  { id: 'problems', group: 'Code', label: 'Problems in this file (errors as you type)', keys: 'Mod+Shift+M', hint: 'JSON, YAML, XML, HTML, CSS and code' },
  { id: 'git-compare', group: 'Git', label: 'Compare with the last commit (Git)', only: 'desktop', hint: 'A file on this computer in a Git repository; or click ±N in the status bar' },
  { id: 'git-ask', group: 'Git', label: 'Ask the model about Git: explain, fix, or do it for you', only: 'desktop', hint: 'It sees the repository; steps that are hard to undo wait for your Run and are backed up first. Or ✦ in the Git panel' },
  { id: 'git-panel', group: 'Git', label: 'Git panel: stage, commit, pull, push, stash', keys: 'Mod+Shift+G', only: 'desktop', hint: 'For the repository of the open file, or of the folder in Folders' },
  { id: 'git-init', group: 'Git', label: 'Make a folder a Git repository (git init)…', only: 'desktop', hint: 'The folder in Folders; or right-click a folder in Folders, or the Git panel of a folder that is not in one' },
  { id: 'git-branch', group: 'Git', label: 'Switch branch, or make a new one (Git)', only: 'desktop', hint: 'Or click the branch in the status bar' },
  { id: 'git-stage-change', group: 'Git', label: 'Stage the change at the cursor (Git)', only: 'desktop', hint: 'That block alone; or click its mark next to the line numbers' },
  { id: 'git-fetch', group: 'Git', label: 'Fetch (Git): see what is new on the remote', only: 'desktop' },
  { id: 'git-pull', group: 'Git', label: 'Pull (Git): bring the remote’s commits in', only: 'desktop' },
  { id: 'git-push', group: 'Git', label: 'Push (Git): send your commits', only: 'desktop' },
  { id: 'nextProblem', group: 'Code', label: 'Next problem', keys: 'F8' },
  { id: 'previousProblem', group: 'Code', label: 'Previous problem', keys: 'Shift+F8' },

  { id: 'toggle-sidebar', group: 'View', label: 'Show or hide the file list', keys: 'Mod+B' },
  { id: 'folders', group: 'View', label: 'Folders (this computer and servers)', keys: 'Mod+Shift+E', only: 'desktop' },
  { id: 'toggle-wrap', group: 'View', label: 'Word wrap', keys: 'Alt+Z' },
  { id: 'text-larger', group: 'View', label: 'Larger text', keys: 'Mod+=', hint: 'Also Ctrl+mouse wheel, a pinch on a phone, or Aa in the status bar' },
  { id: 'text-smaller', group: 'View', label: 'Smaller text', keys: 'Mod+-', hint: 'Fits more on a small screen' },
  { id: 'text-reset', group: 'View', label: 'The usual text size', keys: 'Mod+0' },
  { id: 'preview', group: 'View', label: 'Preview (Markdown, HTML, JSON, CSV…)' },
  { id: 'split', group: 'View', label: 'Split view: the next tab in a new pane (up to four side by side)', keys: 'Mod+\\', hint: 'Or right-click a tab → Open in a new pane, or drag a tab to the right edge of the editor' },
  { id: 'pane-1', group: 'View', label: 'Go to the main pane', keys: 'Mod+1' },
  { id: 'pane-2', group: 'View', label: 'Go to pane 2 (opens one when there is none)', keys: 'Mod+2' },
  { id: 'pane-3', group: 'View', label: 'Go to pane 3', keys: 'Mod+3' },
  { id: 'pane-4', group: 'View', label: 'Go to pane 4', keys: 'Mod+4' },
  { id: 'pane-move-next', group: 'View', label: 'Move the tab to the next pane (it swaps with that pane’s)', keys: 'Mod+Alt+→' },
  { id: 'pane-move-prev', group: 'View', label: 'Move the tab to the previous pane', keys: 'Mod+Alt+←' },
  { id: 'pane-close', group: 'View', label: 'Close this pane (its tab stays open)', hint: 'Or × on the pane’s head' },
  { id: 'panes-close', group: 'View', label: 'Only the main pane: close the others' },
  { id: 'outline', group: 'View', label: 'Outline and links', keys: 'Mod+Shift+O' },
  { id: 'terminal', group: 'View', label: 'Terminal (this computer or a server)', keys: 'Ctrl+`', only: 'desktop' },
  { id: 'terminal-split', group: 'View', label: 'Two terminals side by side (or one again)', only: 'desktop', hint: 'Or drag a terminal tab onto the left or right half of the panel' },
  { id: 'tasks', group: 'Terminal', label: 'Tasks: run a project’s npm scripts, Makefile targets, pyproject or Composer scripts', keys: 'Mod+Shift+B', only: 'desktop', hint: 'From the open file’s project and the folders in Folders; each in a terminal of its own' },
  { id: 'terminal-rename', group: 'View', label: 'Rename the terminal', only: 'desktop', hint: 'Or double-click its tab' },
  { id: 'terminal-tabs-keys', group: 'View', label: 'Terminal tabs: reorder, or show one on a side of the panel', keys: 'Drag the tab', only: 'desktop', run: false, hint: 'Along the tabs to reorder; onto the left or right half to show two; a side’s name back onto the tabs shows one again' },
  { id: 'explain-error', group: 'Tools', label: 'Ask the model about the error in the terminal', only: 'desktop', hint: 'The selection, or the last output, with the code it points to' },
  { id: 'fix-problems', group: 'Tools', label: 'Fix the problems in this file with the model', hint: 'Or Explain / Fix with the model in a problem’s tooltip' },
  { id: 'open-in-claude', group: 'Tools', label: 'Ask in the Claude app (your Claude subscription)', hint: 'Opens Claude with the selection or the file; the question is copied too' },
  { id: 'test-at-cursor', group: 'Tools', label: 'Run the test at the cursor (or its suite)', keys: 'Mod+F5', only: 'desktop', hint: 'Jest, Vitest, Mocha, node:test, pytest, unittest, go test, cargo test, PHPUnit, Pest, dotnet test; or click ▶ next to a test' },
  { id: 'test-file', group: 'Tools', label: 'Run this file’s tests', keys: 'Mod+Shift+F5', only: 'desktop', hint: 'Failures show at their lines and in the Tests panel' },
  { id: 'test-again', group: 'Tools', label: 'Run the tests again (the last ones run)', only: 'desktop' },
  { id: 'tests-panel', group: 'Tools', label: 'Tests panel: the last run’s results', only: 'desktop' },
  { id: 'run-file', group: 'Tools', label: 'Run this file in the terminal (Python, Node, shell, Go…)', keys: 'F5', only: 'desktop', hint: 'The command per type is in Settings → Editor → Run commands' },
  { id: 'debug-file', group: 'Debug', label: 'Debug this file (Python, JavaScript, TypeScript)', keys: 'Alt+F5', only: 'desktop', hint: 'Python through debugpy, JavaScript and TypeScript through js-debug: it stops at the breakpoints' },
  { id: 'debug-test', group: 'Debug', label: 'Debug the test at the cursor', keys: 'Mod+Alt+F5', only: 'desktop', hint: 'pytest, unittest, node:test, Vitest and Jest; or right-click the ▶ next to a test' },
  { id: 'breakpoint-toggle', group: 'Debug', label: 'Toggle a breakpoint on this line', keys: 'F9', only: 'desktop', hint: 'Or click left of the line number; right-click there for a condition, a hit count or a log message' },
  { id: 'debug-continue', group: 'Debug', label: 'Continue (while debugging)', keys: 'F5', only: 'desktop', when: 'debugging', hint: 'When nothing is being debugged, F5 runs the file' },
  { id: 'debug-pause', group: 'Debug', label: 'Pause the program being debugged', only: 'desktop', when: 'debugging' },
  { id: 'debug-step-over', group: 'Debug', label: 'Step over (to the next line)', keys: 'F10', only: 'desktop', when: 'debugging' },
  { id: 'debug-step-into', group: 'Debug', label: 'Step into (the call on this line)', keys: 'F11', only: 'desktop', when: 'debugging', hint: 'While debugging; otherwise F11 is full screen' },
  { id: 'debug-step-out', group: 'Debug', label: 'Step out (back to the caller)', keys: 'Shift+F11', only: 'desktop', when: 'debugging' },
  { id: 'debug-restart', group: 'Debug', label: 'Restart debugging (or debug the last file again)', only: 'desktop', when: 'debugging' },
  { id: 'debug-stop', group: 'Debug', label: 'Stop debugging', keys: 'Shift+F5', only: 'desktop', when: 'debugging' },
  { id: 'debug-panel', group: 'Debug', label: 'Debug panel: the call stack, variables, watch, breakpoints, the debug console', only: 'desktop', hint: 'Or the Debug item in the status bar while a run goes on' },
  { id: 'breakpoints-toggle-all', group: 'Debug', label: 'Turn all breakpoints off (or on again)', only: 'desktop' },
  { id: 'breakpoints-remove-all', group: 'Debug', label: 'Remove all breakpoints', only: 'desktop' },
  { id: 'indent-guides', group: 'View', label: 'Indentation guides (on or off)' },
  { id: 'bracket-colors', group: 'View', label: 'Colored bracket pairs (on or off)' },
  { id: 'sticky-scroll', group: 'View', label: 'Sticky scroll: the function or section you are in stays on top (on or off)' },
  { id: 'breadcrumbs-toggle', group: 'View', label: 'Breadcrumbs: where the file is and the code around the cursor, over the text (on or off)' },
  { id: 'breadcrumbs-focus', group: 'View', label: 'Go to the breadcrumbs', keys: 'Mod+Shift+.', hint: '←/→ move between them, Enter or ↓ opens what is next to one, Esc goes back to the text' },
  { id: 'minimap-toggle', group: 'View', label: 'Minimap: the file at a glance beside the scrollbar (on or off)', hint: 'Click or drag the box to move; problems and changed lines on its edge' },
  { id: 'read-aloud', group: 'View', label: 'Read aloud, pause or resume', keys: 'Alt+R' },
  { id: 'assistant', group: 'View', label: 'The model', keys: 'Mod+Shift+A' },
  { id: 'help', group: 'View', label: 'Help: commands, shortcuts and the guide', keys: 'F1' },
  { id: 'keys-settings', group: 'View', label: 'Keys: change any command’s keys, or use VS Code’s or Notepad++’s', hint: 'Settings → Keys: record a key, take one from another command, reset' },
  { id: 'help-ask', group: 'View', label: 'Ask the model how to do something in the editor', hint: 'It answers from the guide. Also in the ✦ panel: Help with the editor' },
  { id: 'command-palette', group: 'View', label: 'Run a command by name (command palette)', keys: 'Mod+Shift+P', hint: 'Or Ctrl+P, then >' },

  { id: 'ask-selection', group: 'Tools', label: 'Ask the model about the selection or the file', keys: 'Mod+K' },
  { id: 'assist-files', group: 'Tools', label: 'Ask the model to make or change files…', hint: 'In the open file’s folder (or the folder in Folders, or a synced note’s project): each change waits for your Apply; Folders’ menus: Ask the model about this folder…' },
  { id: 'snippets', group: 'Tools', label: 'Insert a snippet', keys: 'Alt+I' },
  { id: 'macro-record', group: 'Tools', label: 'Record a macro (again to stop)', keys: 'Mod+Shift+R' },
  { id: 'macro-play', group: 'Tools', label: 'Play the macro', keys: 'Alt+Shift+P' },
  { id: 'macro-run', group: 'Tools', label: 'Run the macro many times' },
  { id: 'type-out', group: 'Tools', label: 'Type into another window', keys: 'Alt+T', only: 'desktop' },
  { id: 'clipboard-history', group: 'Tools', label: 'Clipboard history', keys: 'Mod+Shift+V', only: 'desktop' },
  { id: 'compare-with', group: 'Tools', label: 'Compare with another file…', hint: 'An open tab (the ones next to it first), a file in your folders, my files, or Browse…' },
  { id: 'compare-clipboard', group: 'Tools', label: 'Compare with the clipboard' },
  { id: 'compare-folders', group: 'Tools', label: 'Compare two folders…', only: 'desktop', hint: 'The folder open in Folders with another one (here or on a server); or a folder’s menu → Compare with another folder…' },
  { id: 'two-panes', group: 'Tools', label: 'Two panes: two folders side by side…', only: 'desktop', hint: 'The folder open in Folders and another one (here or on a server), to copy and move files between them, like WinSCP' },
  { id: 'two-panes-keys', group: 'Tools', label: 'In two panes: copy / move to the other side, new folder, delete, the other side', keys: 'F5 / F6 / F7 / F8 / Tab', run: false },
  { id: 'compare-saved', group: 'Tools', label: 'Open a saved comparison…', hint: 'The comparisons saved with their ☆' },
  { id: 'compare-keys', group: 'Tools', label: 'In a comparison: next / previous change, copy it to the right / left', keys: 'Alt+↓ / Alt+↑ / Alt+→ / Alt+←', run: false },
  { id: 'image-ocr', group: 'Tools', label: 'Text from an image' },
  { id: 'screenshot-ocr', group: 'Tools', label: 'Text from a screenshot', only: 'desktop' },
  { id: 'quick-capture', group: 'Tools', label: 'Quick capture, from any app (when turned on)', keys: 'Ctrl+Alt+N', only: 'desktop', run: false },

  { id: 'fv-open', group: 'Folders view', label: 'Open / go up a folder', keys: 'Enter · Backspace', run: false, hint: 'Pictures and PDFs show large (Settings → Desktop → Folders)' },
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

/**
 * The commands for this place (desktop-only ones left out in the browser), matching every
 * word of `query` (in the label, group, hint or keys: `keysOf`, the keys in effect); while
 * searching, the ones whose label matches come first.
 */
export function findCommands(query = '', { desktop = false, list = COMMAND_LIST, mac = false, local = false, keysOf = (c) => keysFor(c, { mac, desktop }) } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Local mode: nothing about syncing.
  if (local) list = list.filter((c) => c.local !== false).map((c) => (typeof c.local === 'string' ? { ...c, label: c.local } : c));
  const found = list.filter(
    (c) => (desktop || c.only !== 'desktop') && words.every((w) => `${c.label} ${c.group} ${keysOf(c)} ${c.hint ?? ''}`.toLowerCase().includes(w)),
  );
  if (!words.length) return found;
  const rank = (c) => {
    const label = c.label.toLowerCase();
    return label.startsWith(words.join(' ')) ? 0 : words.every((w) => label.includes(w)) ? 1 : 2;
  };
  return found.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/** The groups to show for `found`: in their usual order, or while searching in the order of their best match. */
export function groupsOf(found, searching) {
  return searching ? [...new Set(found.map((c) => c.group))] : COMMAND_GROUPS.filter((g) => found.some((c) => c.group === g));
}
