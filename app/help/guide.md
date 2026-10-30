# Tracker Editor guide

Tracker Editor is a Notepad++-style editor for the notes, snippets, logs and code you paste somewhere and want to find again. Keep dozens of files open in tabs. Everything is saved the moment you paste or type, on this computer with the tracker, or, once you turn on sync, in the same private GitHub data repo as the tracker, so your files are on your computers and your phone.

Version 0.34.2 · Download: https://github.com/divaor/tracker-editor/releases/tag/v0.34.2 · Web app: https://divaor.github.io/tracker-editor/

---

## 1. Get it and connect it

### Desktop (work PC, home PC)

Download from **https://github.com/divaor/tracker-editor/releases/latest**:

| System | File |
| --- | --- |
| Windows | `Tracker Editor Setup 0.34.2.exe` (installer) or `Tracker Editor-0.34.2-portable.exe` (no install, no admin rights) |
| macOS | `Tracker Editor-0.34.2-arm64.dmg` |
| Linux | `Tracker Editor-0.34.2.AppImage` |

The builds are not code-signed, so the first launch warns you. On Windows, choose *More info → Run anyway*. On macOS, right-click the app → *Open*. Installing the desktop app also registers `tracker-editor://` links, so the tracker's **Open in editor** opens files straight in it.

**Tracker Editor as your editor (Windows).** The installed app adds itself to Explorer: right-click a text or code file → **Open with → Tracker Editor** (it never becomes their default program unless you choose that), **Edit with Tracker Editor** on any file, and **Open in Tracker Editor** on folders (Windows 11: under **Show more options**). The file opens as a tab edited in place; a folder opens in Folders. Turn it on or off in **Settings → Desktop → Tracker Editor in Explorer** (the portable app starts with it off). To make it the default for a type: right-click a file → **Open with → Choose another app → Tracker Editor → Always**. On macOS it is in Finder's **Open With** for text and code files; a file given on the command line (`"Tracker Editor.exe" notes.txt`) opens too.

### Android: the app

The editor as an Android app, with what a web page cannot do: **Open with** from other apps, **Folders** on the phone, **servers** and **terminals**. For Android 7 and later on 64-bit phones (nearly all from the last ten years).

1. Install **Obtainium** (from https://github.com/ImranR98/Obtainium/releases or F-Droid). It installs apps from their GitHub releases and keeps them up to date.
2. In Obtainium: **Add app**, paste `https://github.com/divaor/tracker-editor`, **Add**, then **Install** (`Tracker-Editor-0.34.2.apk`). The first time, Android asks to let Obtainium install apps: allow it.
3. Obtainium tells you when there is a new version and installs it over the old one; your files and settings stay. (Or download the `.apk` from the releases page and open it; then updates are by hand.)

What the app adds:
- **Open with**: in Files, a file manager, Gmail or Drive, open a text or code file with **Tracker Editor**: it opens as a tab edited where it is, and **Save** writes it back (a file the other app only lets you read says **Read-only**). The tab's ⋯ → **Open with another app** hands it on. PDFs, e-books, Word, OpenDocument, RTF, spreadsheets and presentations open too, shown as they look (see [Documents](#documents-pdfs-e-books-word-and-more)).
- **Share** text, links or files to **Tracker Editor**: they become new files. Select text in any app → ⋮ → **Tracker Editor**: a new note with it. Long-press the app's icon for **New note** and **Voice note**.
- **Folders** (the sidebar's **Folders**): folders on the phone and its memory card, as on a computer (see [Folders](#folders-a-file-explorer)). **Open a folder…** asks the first time for **All files access** (Android's permission for file managers: allow it for Tracker Editor, then come back and tap it again; the editor only opens the folders you pick). Then choose **Phone storage**, **Documents**, **Download**, the memory card, or **Another folder…**. **Tap** a folder or a file to open it; a **long press** gives its menu, where **Select** lets you tap others to pick them too (**Done** when finished). **Delete** is for good here: Android has no Trash for these files.
- **Compare two folders** and **two panes** (a folder's long-press menu): on the phone, on a server or one of each, laid out for a phone, and **Sideways** turns the app to landscape for them (see [Comparisons on a phone](#comparisons-on-a-phone)).
- **Servers**: SFTP, FTP and FTPS, their terminals, find in a folder, transfers and mirrors, as on a computer (see 11). Saved passwords are encrypted with a key kept in the phone's secure hardware.
- **A terminal on the phone**: the status bar's **Terminal** opens Android's own shell in the open file's folder, with its basic commands (`ls`, `cat`, `grep`, `cp`, `mv`…). With an SSH server set up, **+** in the panel opens a terminal there.
- **A model on your computer** (Ollama, LM Studio) answers the phone over your network, without CORS settings: see [Option A](#option-a-a-model-on-this-computer-ollama-lm-studio).
- **Back** closes what is open (a dialog, a panel, the sidebar), then leaves the app.
- **Something not working?** Long-press the app's icon → **Send a log** (it works even when the app is stuck), or **Settings** → **Send a log** at the bottom. It opens the share sheet with a text file: send it by email, WhatsApp, Drive… It says what the app did and what Android recorded about its crashes and freezes; it has file paths and server names, never passwords or the text of your files.

The app keeps its own data, apart from the web app in the phone's browser: to have your files in it, sync with GitHub there too (**Settings → Where your data is**).

### Phone: the web app (iPhone, or without installing the app)

1. Open https://divaor.github.io/tracker-editor/ on the phone.
2. Install it: Android ⋮ → **Install app**; iPhone Share → **Add to Home Screen**.
3. To send text or files from other apps to the editor (Android), use their **Share** button and pick **Tracker Editor**. If it isn't listed, remove the app from the home screen and install it again.

### Your data: on this computer, or synced with GitHub

**A new install keeps everything on this computer**, with nothing about syncing shown. On the desktop that is a data folder, `Documents/Tracker data`, which **Tracker** on the same computer shares: its projects and tags are yours, its documents open here, and **Send to tracker** lands there at once. In the browser it is the browser's storage, shared with the tracker opened in the same browser. **Settings → Where your data is** says where (on the desktop, **Show the folder**; copying it is a backup). History is kept there too, for 180 days.

**To sync across your devices** (phone, other computers, the Claude connector): **Settings → Where your data is → Sync across your devices with GitHub…**:

1. In the **tracker**, open **Settings → Sync with GitHub → Copy setup code** (with the token), or create a token (see the tracker's guide).
2. Paste it into **Setup code**, press **Apply**, name the device (e.g. *Work PC*) and press **Copy my data to GitHub and sync**.

Everything on this computer is copied to the repo first, so nothing is lost; a repo that already has data from other devices is merged (the newest edit of each item wins; files from both stay). The tracker on this computer then offers to follow. The editor uses the tracker's repo, token and projects; its own files go to `editor/` in that repo. **Stop syncing with GitHub and keep everything on this computer…** goes back (the repo keeps its copy).

On an iPhone, apps added to the home screen each keep their own storage: the editor and the tracker work together there in Safari, or through GitHub.

---

## 2. The basics

- **New file**: `Alt+N` (desktop: `Ctrl+N`), the **+** at the end of the tabs, or double-click the empty tab bar. Untitled files are `new 1`, `new 2`… like Notepad++.
- **Saved at once**: pasted text and new tabs are written to disk immediately; typing a quarter of a second after the last key. A crash or a power cut keeps your work, and your tabs come back exactly as you left them.
- **Synced**: a few seconds after you stop typing, every few minutes, when you come back online, and with `Ctrl+S`. The badge at the top shows *Synced*, *Syncing…*, *N unsynced* or *Offline*. A dot on a tab means it has changes not synced yet.
- **Two devices edited the same file?** Nothing is lost: the version synced second is kept, and the other becomes a copy named after its device.
- **Where each file lives**: at a glance, by color. Every tab has a colored top line, the file bar starts with a chip, the status bar starts with a colored box, and the editor has a thin frame in the same color:

  | Color | Where | The chip says |
  | --- | --- | --- |
  | Green | **My files**: synced to your data repo | Synced · Not synced yet · Not synced · offline |
  | Blue | **Tracker**: a document attached to a tracker item | Synced · Not synced yet |
  | Amber | **This computer**: a file edited where it is, not synced | Saved · Not saved · Changed on disk · Following |
  | Pink | **A server** (SFTP, FTP): saved back to the server, not synced | Saved on the server · Not saved to the server · Saving… · Changed on the server · Not connected |

  Hover the chip for more. Turn the frame off in **Settings → Editor**.
- **What kind of file**: in **My files** and **Folders** each file has an icon in the color of its kind, so you see it without reading the extension: letters for code (**JS**, **PY**, **C#**…), braces for JSON, `#` for CSS, `</>` for HTML, a table for CSV, a picture, a box for archives, a key for keys and `.env` files… Untitled files take theirs from their language. Hover an icon for the kind. Turn them off in **Settings → Editor → File type icons**.
- **Names from the content**: an untitled tab you paste or write into gets a name that says what it is: from the model when one is connected (e.g. `Deploy runbook.md`), otherwise from a heading on its first line. The message has **Undo**.

### Finding things

- `Ctrl+P` **Open a file**: type part of a name or project (fuzzy). Enter on a name that doesn't exist creates it. In the desktop app it also finds the files in the folders open in **Folders** (on this computer and on connected servers), by name or by path (`lib/util`); they show the folder they are in and open in place.
- `Ctrl+Shift+F` **Find in files**: in all files, the filtered ones or the open tabs, with case, whole word and regex options. Tick the files found and press **Open N selected**, or **Open all**: each opens at its first match, the first one in front. The ↗ button opens one file; the list button folds the results to file names. On a phone the panel closes so you see the file.
- `Ctrl+F` **Find in this file**: a bar over the text. **Aa** (match case), **ab** (whole word) and **.\*** (regular expression) are toggles inside the field; next to it, how many matches there are and which one you are on ("3 of 12"). `Enter` / `Shift+Enter` (or ↓ / ↑) go to the next / previous one, the third button selects them all (`Alt+Enter`), × or `Escape` closes it.
- `Ctrl+H` **Replace** (macOS: `Cmd+Alt+F`), or the chevron at the left of the bar: a second line with the replacement. **Replace** changes the next match in one click (`Enter` in the field), **Replace all** every one (`Ctrl+Enter`). The line stays open next time until you close it with the chevron.
- `Ctrl+G`: go to a line.
- **The sidebar** (`Ctrl+B`): every file, newest first, or by name or project. Filter by text or by a tag. **All / Work / Personal / Projects** at the top limits the list to some projects, as in the tracker.

### Projects and tags

- The tracker's projects and tags. In the file bar, **Add project** or **Tags**, or open **⋯ → Details…** for the name, project, tags and language.
- New projects created here appear in the tracker.
- With the model on, a new note gets one of your projects and a few tags by itself (see 6).

### Your layout

- **Text size**: smaller to fit more on a small screen, larger to read easily. On a phone, **pinch** the text with two fingers (the page itself stays as it is). On a computer, `Ctrl+=` / `Ctrl+-` (Mac `Cmd`), or `Ctrl` and the mouse wheel over the text; `Ctrl+0` goes back to the usual 14 px. Or tap **Aa** in the status bar for **A−** / **A+** and **Usual size**. Each device keeps its own size (also in **Settings → Editor → Text size**). The desktop's **View** menu has them too; zooming the whole window (menus and lists too) is there as well, without keys. On a phone the line numbers take less room too (smaller numbers, problems as a thin colored bar next to them); turning off **Settings → Editor → Line numbers and folding** hides the numbers altogether.
- **The sidebar's width**: drag its right edge, for example to see long names in folders. Double-click the edge to go back to the default width.
- **Text and preview (or the side view)**: drag the line between them to give either side more room; double-click it for half and half.
- **Clearing a filter**: the × at the end of a search or filter field empties it (`Escape` too in the sidebar's filters).

### Editing tools

- **Format document** (`Shift+Alt+F`, ⋯ menu, or **Edit → Format Document**): tidies the file, or only the selection (for example the JSON inside a log line). **JSON** on one line becomes one value per line (numbers and text exactly as written, comments kept); also **XML**, **SQL** (by dialect: pick PostgreSQL, MySQL, MS SQL… in the status bar), **JavaScript**, **TypeScript**, **CSS/SCSS/Less**, **HTML**, **Vue**, **Markdown**, **YAML** and **GraphQL**. It uses the file's name or the language picked in the status bar; text with no name is formatted when it looks like JSON or XML. A file with a language server that formats (Go, C, Rust…) uses the server's (see Language servers). Something it cannot read says what and where; `Ctrl+Z` takes a format back.
- **Line numbers**: click one (on a phone, tap it) to select that line and open a small menu by it: **Copy**, **Cut**, **Paste** and **Select all**, and under **⋯** **Duplicate**, **Comment**, **Delete** and **Ask** (the model, about those lines). `Shift+click` selects from the selection up to that line; a right-click (a long press on a phone) opens the menu for what is selected. On a phone the keyboard stays down, so it does not cover the text. `Ctrl+L` selects the line too; again, the next one as well.
- **The edit bar (phones and tablets)**: while you type, a bar takes the status bar's place right above the keyboard, with the keys a phone keyboard lacks: **Tab**, **Ctrl** (the next key or letter comes with it: Ctrl, then `a` selects all, `z` undoes, `/` comments, `f` finds, `s` saves; Ctrl, then → jumps a word), **Select** (the arrows select, as with Shift), the **arrows** (hold one to keep going), **Undo** and **Redo**. **{ }** switches to a row of symbols (brackets and quotes close as when typed; swipe it sideways for more), and the keyboard icon goes back. **⋯** shows the tools: Copy, Cut and Paste (with nothing selected, the whole line), Select all, Select line, Find, Save (a file on disk; Sync for files synced with GitHub), Comment, Duplicate, Delete line, Line up / down, Outdent / Indent, Line start / end, Go to line, Esc, Ask (the model) and **Hide keyboard**. When the keyboard goes down (the phone's Back), the status bar comes back. Turn it off in **Settings → Editor → Edit bar while typing on a touch screen**.
- **Text tools** (⋯ → **Text tools**, **Edit → Text**, or Help): UPPER and lower case, sort lines, remove duplicate lines, trim trailing spaces, duplicate or delete a line, comment lines.
- **Indentation**: each file keeps its own, tabs or spaces and how many: from its text, or from an `.editorconfig` next to a file on disk or on a server. The status bar shows it (**Spaces: 2**, **Tab size: 4**); click it to indent with tabs or spaces, pick the width, **convert** the whole file, or go back to what the text uses. What you pick is remembered for the file. Files that say nothing use **Settings → Editor → Indentation**.
- **Edit several lines at once**: `Shift+Alt+↓` (or `↑`) puts a cursor on each line as you go (as in Notepad++; `Ctrl+Shift+Alt+arrows` as in VS Code; on a Mac `Cmd+Shift+Option+arrows`); `Shift+Alt+→` / `←` widen or narrow the column, so you select a rectangle. Type, paste or delete and every line changes. Shorter lines get their cursor at the end. `Ctrl+Alt+↑` / `↓` (Mac `Cmd+Option+↑` / `↓`) add one cursor above or below. With the mouse: `Alt+drag` draws the rectangle, `Ctrl+click` (Mac `Cmd+click`) adds a cursor. `Escape` goes back to one cursor.
- Multiple cursors, `Ctrl+D` select the next occurrence, `Ctrl+/` comment lines, bracket matching, `Alt+Z` word wrap, visible whitespace. Syntax highlighting for 140+ languages, from the file name, from pasted text, or picked in the status bar.
- **HTML, XML and JSX**: type an **Emmet** abbreviation and press `Tab`: `ul>li*3` makes a list of three items, `div.card#main` a div with that class and id, `a[href=#]{Home}` a link with its text, `table>tr*2>td*3` a table, `!` (in an empty HTML file) a whole page; `>` goes inside, `+` next to it, `^` back up, `$` numbers the copies. Words that aren't tag names are left alone, and `Tab` indents as usual. **Tags close themselves** when you type the `>` of an opening tag (or `</`), and **renaming a tag renames its other end** (`<div>` … `</div>` → `<section>` … `</section>`; one `Ctrl+Z` takes both back). Both can be turned off in **Settings → Editor**.
- **Help** (`F1`, or the **?** at the top): every command with its shortcut, searchable (type "sort" or "Ctrl+K"); click one, or press `Enter`, to run it. **Print** gives a one-page cheat sheet. The **Guide** tab is this guide. With a model, the ✦ panel answers questions about the editor from this guide (see [Help with the editor](#help-with-the-editor-ask-how-to-do-something)).
- **Run a command by name** (`Ctrl+Shift+P`, or `Ctrl+P` then `>`), as in VS Code: type part of it ("wrap", "fold", "problems") and press `Enter`.

### Code tools

Not a full IDE, but enough to find your way in a code file (**Edit → Code** on the desktop):

- **Fold and unfold**: click the arrow next to a line number, or `Ctrl+Shift+[` / `Ctrl+Shift+]`. `Alt+0` folds everything (open a class and its methods are still folded), `Alt+Shift+0` unfolds everything. `Alt+1` folds the outer blocks (classes, top-level functions), `Alt+2` the ones one level in (the methods of a class), `Alt+3` two levels in. Code folds by its braces or blocks; YAML by its keys; plain text and languages without their own folding by indentation.
- **Go to the declaration** (`F12`): of the name at the cursor: the function, class, variable, parameter, import, key or table it names. Several with the same name (a `data` in each function)? It goes to the nearest one above. On the declaration itself, `F12` shows its usages. Not declared in this file? It looks in your other files and, in the desktop app, in the folders open in **Folders** (here and on connected servers): one place opens, several are listed to pick from.
- **Go to a function, class or section in any file** (`Ctrl+T` in the desktop app, or `Ctrl+P` then `#`): type part of its name; it looks in your files and in every code file of the folders open in Folders.
- **Usages** (`Shift+F12`): every line that uses the name, the declarations marked; click one to go there. **Edit all together** selects them all; **Find in all files** looks in your other files.
- **Rename in this file** (`F2`): every use of the name gets a cursor; type the new name, `Escape` goes back to one cursor.
- **Go to a function or section**: `Ctrl+P`, then type `@` and part of its name. The outline (`Ctrl+Shift+O`) lists them too.
- **Where you are**: the status bar names the class and function the cursor is in (`Store › save`), or the YAML key or Markdown section; click it to go to another.
- The name under the cursor is highlighted wherever else it appears. `Ctrl+Shift+\` jumps to the matching bracket.
- **Run it** (`F5`, desktop) in a terminal in its folder, and click the `file:line` an error prints to go there (see [A terminal, and running a file](#a-terminal-and-running-a-file)). **Suggestions as you type** from the model: see [6](#suggestions-as-you-type).
- **Problems as you type**: mistakes are underlined, with a mark next to the line; hover one to read it. In JSON (comments are fine in `tsconfig.json`, `.jsonc` and other files that allow them), YAML (also a key written twice in the same place, tabs in the indentation, a quote left open), XML, HTML, CSS, and code: JavaScript, TypeScript, Python, Go, Java, PHP, C, C++, Rust. The status bar counts errors and warnings (on a phone the count shows once there is one); click it (or `Ctrl+Shift+M`) for the **Problems** list, click one to go there. `F8` goes to the next one, `Shift+F8` to the one before. With a model connected, it can explain them or fix them for you: see [Help with errors](#help-with-errors).
- **Easier to read**: thin **guides** at each indentation level, **brackets colored** by how deep they are (strings and comments aside), and **sticky scroll**: when you scroll inside a long function, the lines that start it (and its class) stay at the top; click one to go there. Each can be turned off in **Settings → Editor** (or the **View** menu).

### Language servers (desktop): code that knows its types

For code files, the editor uses a **language server**, the same kind of program VS Code uses, when one is installed: for files opened from **Folders** on this computer, for files on an **SSH server** (the server runs there), and for **your own files and tracker documents**:

| Files | Server | Install it with |
| --- | --- | --- |
| TypeScript, JavaScript | TypeScript 7 (its own), or typescript-language-server | `npm install -g typescript` |
| Python | Pyright (or basedpyright) | `npm install -g pyright` or `pip install pyright` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| C, C++ | clangd | `winget install LLVM.LLVM`, `brew install llvm`, `sudo apt install clangd` |
| JSON, CSS/SCSS/Less, HTML | vscode-langservers-extracted | `npm install -g vscode-langservers-extracted` |
| YAML | yaml-language-server | `npm install -g yaml-language-server` |
| Bash | bash-language-server (problems from ShellCheck) | `npm install -g bash-language-server` |
| Java | Eclipse JDT (jdtls); needs Java 25 and Python 3 | `brew install jdtls`, `scoop install jdtls`, or download it |
| C# | csharp-ls; needs the .NET SDK | `dotnet tool install --global csharp-ls` |

The status bar names it (**TypeScript 7.0.2 · ready**, **gopls · ready**, **Pyright · Indexing 40%**). Then:

- **Problems** are underlined as you type, with the server's own message, and the **Problems** list says where each one comes from (`ts`, `Pyright`, `compiler`…).
- **Completion** lists members, with their types and docs (`Math.` shows `abs`, `floor`…).
- **Hover** a name for its type and documentation.
- **Typing `(`** shows the parameters, the current one in bold; `Ctrl+Shift+Space` shows them again, `Escape` hides them.
- **Quick fixes** (`Ctrl+.`): on a line with a problem, a 💡 shows at its end; click it, or press `Ctrl+.` anywhere, for what the server offers: add a missing import, fix a problem, extract a function… A problem's tooltip has **Quick fix…** too. **Organize imports** (`Shift+Alt+O`) sorts them and drops the unused ones.
- **`F12`** goes to the declaration in any file of the project, **`Shift+F12`** lists the uses across files (click one to go there), and **`F2`** renames the name everywhere it is used: a dialog asks for the new name.
- **Changes to other files** (a rename, a quick fix that moves code to a new file) are **shown first**: each file with its changed lines, ticked to take part. **Apply** changes the open files as an edit `Ctrl+Z` takes back (not saved yet), and **saves** the files that are not open, each only if it did not change since it was read; new files are made inside the folder you opened. **Undo**, in the message afterwards, takes it all back.
- **Format document** (`Shift+Alt+F`) uses the server's formatter (gofmt for Go, clangd's for C…) when it has one; **Settings → Language servers** can put Prettier and the editor's own first. When the one chosen cannot format a file, the other does.
- **`Ctrl+T`** also lists the servers' symbols for the projects they run for (classes, functions…, with their kind).
- **JSON** files are checked against their schema: `package.json`, `tsconfig.json`, `.eslintrc`, `appsettings.json` and other well-known files, or any file with a `"$schema"`. **YAML**: GitHub Actions workflows, Compose files and many others by their schema; Kubernetes files in `k8s/`, `kubernetes/` or `manifests/` folders, or named `*.k8s.yaml`; a first line `# yaml-language-server: $schema=<url>` picks one for any file.
- A file with no server, or a name the server does not know, works as before.

**Setting one up.** When a file has none, the status bar says **Set up Go…** (or the language): it shows the command to install one, and **Type it in a terminal** opens a terminal with the command typed in, for you to press Enter. Nothing is downloaded or run behind your back. Then **It is installed: start it**. A project with its own copy in `node_modules` uses that one.

**Servers of your own** (Settings → **Language servers** → **Add a server…**): for another language (Lua, Ruby, PHP, Kotlin…), give a name, the file extensions, the program (its name, found on PATH, or its full path) and its arguments (most want `--stdio`). Before it is kept, the app shows the exact program it found and asks you to allow it; it runs only that one. **Change** and **Remove** are next to it.

- Each server runs for one **project folder** (the nearest folder with a `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`…, never above the folder you opened in Folders); JSON, CSS, HTML, YAML and Bash run once for the whole folder you opened. At most six run at once, and one stops 10 minutes after its last file is closed.
- Click the server in the status bar for the **Language servers** panel: what runs for which folder, **Restart**, **Stop**, and **Show its messages** for when something goes wrong. A server that keeps crashing stops after three times; the status bar then offers **Start**.
- Turn them off in **Settings → Language servers**.

**Files on an SSH server.** A code file opened from a server (SFTP) gets the server's own language server, running **there**: it sees the project as it is on the server, with its packages, so problems, completion, `F12` and renames are the real ones. The editor looks for it in the server's login PATH, the usual install folders (`~/.local/bin`, `~/.npm-global/bin`, `~/go/bin`, `~/.cargo/bin`, `~/.dotnet/tools`…) and the project's `node_modules`. The project folder is the nearest one with its markers, up to your home folder there. When none is installed, **Set up…** types the install command into a terminal **on that server**. Only the servers in the table run there (never one of your own), nothing is installed by itself, and the status bar says where: **Pyright on Box · ready**. If the connection drops, the server stops; it starts again when the connection is back. FTP and Windows servers have none. Turn it off with **Also for files on SSH servers** in Settings.

**Your own files and tracker documents.** A synced file or a tracker document with a code name (`script.py`, `query.ts`) gets a server on this computer too, for that one file: problems, completion, hover, and `F2` within the file. There is no project around it, so imports of your other files are not known. Encrypted files never go to a server. Turn it off with **Also for my files and tracker documents**.

**Java and C#** take a while the first time: they read the whole project (Maven or Gradle for Java, the `.sln` or `.csproj` for C#) before problems show. jdtls keeps what it learns in a cache folder of its own, not in your project.

---

## 3. Tabs, pinning, groups and the split view

### Tab views: one project at a time, or several

Every tab belongs to a **group**, worked out from where its file lives:

| The tab | Its group |
| --- | --- |
| A file in a folder you opened in **Folders** (desktop) | That folder, e.g. **tracker-editor** (the folder you picked, even while you browse inside it; on a server, the server) |
| A folder **linked to a project** | The project: its folder's files, its notes and its tracker documents together |
| One of your files with a project | That project |
| One of your files with no project | **Notes**: quick notes, `new 3`, snippets |
| A tracker document | Its item's project, else Notes |
| Any other file on this computer or a server | **Other files** |

The **switcher at the left end of the tab bar** (it appears once there are two groups) says which tabs show: **All tabs** (on a phone just its ☰ icon), **● Tracker Editor**, **Notes + 2**… Click it, or press `Alt+V`:

- **Click a name** to show only that group. **Tick its box** to add it to the ones showing (two projects, Notes and Other files…). Type to find a group and press `Enter`.
- `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` go to the next or previous group, and `Ctrl+Alt+Home` shows all tabs again.
- Also: right-click a tab → **Only the … tabs** / **All tabs**; in Folders, a folder's header menu → **Only its tabs**; the group's name in the status bar shows only its tabs.
- **Nothing is closed.** Hidden tabs keep their edits; `Ctrl+P` and the **▾** list find them (the ▾ list by group). Each view remembers the tab you were on.
- A file opened from another group (with `Ctrl+P`, from Folders, a link) shows as a **guest**, dashed, until you go to another tab; right-click it to add its group to the view or move it into the one showing.
- In a view, `Ctrl+Tab`, **Close others** and **Close all** work on the tabs showing; a **new file** is filed under the view's project.
- **Pinned tabs show in every view** (turn it off in the switcher or Settings → Editor).
- **Move a tab to another group**: right-click → **Move to group…** (for example a log while you work on a project).
- **Colors**: each project has its color (as in the tracker) and each folder one of its own, which Folders uses on the folder's header. When tabs of two or more show, a line in their color runs under each tab (the top line still tells where the file lives). Change it in the switcher: *When 2+ groups show*, *Always* or *Off*.
- **Link a folder to a project**: when a folder's name matches a project (`tracker-editor` and *Tracker Editor*), the editor offers it once. Any time: a folder's header menu in Folders → **Its tabs: link to a project, color…** (also in the switcher's **⋯** next to a folder).
- The switcher's **Group headers in the tab bar** gathers each group's tabs behind a header that folds them.

### The tab menu


**Right-click a tab** for its menu (on a phone: the **⋯** on the open tab, or a long press on any tab):

| Item | What it does |
| --- | --- |
| Pin / Unpin | Pinned tabs go first, have no close button and stay when you close others. |
| Open to the side | Shows the tab in a second pane next to the current one (wide screens). |
| History, Compare with… | See section 5. |
| Save this comparison… | On a comparison tab: keep it, to open it again later (see [Saved comparisons](#saved-comparisons)). |
| Copy for Claude | A file on disk: its path, which Claude Code reads where it is. Other files: the name and the text in a code block, to paste into a chat. |
| Copy path, Show its folder in Folders, Show in the file explorer, Open a terminal in its folder | Files on disk and on servers (desktop). **Show its folder in Folders** puts the file's folder in the Folders view next to the others (or opens the folders down to it in one shown already) with the file picked; a folder you have not opened here before is asked about first. A server file's path is `user@host:/path`. |
| Close, Close others, Close tabs to the right, Close the *Project* tabs, Close all | Pinned tabs are kept, except by Close. In a view, they work on the tabs showing. |
| Only the *…* tabs, All tabs, Move to group… | Tab views, above. |
| Group headers in the tab bar | One header per group in the tab bar; click a header to fold its tabs. |

- `Ctrl+W` closes a tab (desktop), and so does a **middle-click** on it; `Ctrl+Shift+T` reopens the last closed one, `Ctrl+Tab` goes to the next one. **Double-click a tab to pin it** (again to unpin). Drag tabs to reorder them.
- **Many tabs open**: scroll the tab bar with the mouse wheel (or swipe sideways on a touchpad or a phone). At its ends, an arrow with a number says how many tabs are past it; click it to scroll that way.
- **Lost the open tab?** When it is scrolled out of sight, the arrow on its side says **open tab**: click it and the tab comes back into view. The **▾** at the end of the tab bar lists every open tab (the open one checked), and your saved comparisons under them; pick one to go to it. Both are in Help (`F1`) and the **View** menu too.
- **Drag a tab out of the window** (desktop) to give it to another app as a file. The app decides what to do with it:
  - **Desktop or a folder**: a copy (a synced file is copied under its tab name). The original is never moved.
  - **A terminal with Claude Code**: its path is typed in (for a synced file, the path of a copy), so Claude reads it.
  - **The Claude app**: attached to the message.
  - A drop can't make Explorer open the folder where a file lives: use **Show in the file explorer** instead.
  - Encrypted files are never written out; their tabs only move within the bar. Copies of synced files go to a temporary folder and are removed after a week.
  - In the web app, a dragged tab carries its text: drop it into a chat box to paste it.
- **Split view** (`Ctrl+\`, or *View → Split View*): two files side by side, both editable. The side pane's header can **swap** the panes or close the split. A tab moves between panes with its undo history. Clicking the side tab in the tab bar takes you to the side pane.
- Group headers, pinned tabs in every view and the tab colors are also in **Settings → Editor**.

---

## 4. The file bar

Above the text, for the open file:

- **Where it lives** (the colored chip at the start): my files, tracker, this computer or a server, and how it stands (see 2). Click it to sync now, or for a file on disk or a server, to show its folder.
- **Preview**: a reading view next to the text (instead of it on phones). Markdown with clickable checklists, HTML in a sandbox, JSON and XML as foldable trees (with where a syntax error is), SVG as a picture, CSV/TSV as a table. Its bar has **Listen** (Markdown: reads the preview from its top, or what you selected in it, highlighting the sentence being read and scrolling along; again to pause), **Full view** (only the preview, in the editor's place; again to go back), **Full screen** (only the preview, with the player at the bottom; `Escape`, Back or the button again leave it) and × to close it. While the preview hides the text (Full view, full screen, or on a phone), `Alt+R` and the file bar's **Listen** read the preview too. Drag the line between the text and the preview to resize them.
- **Listen** (`Alt+R`): reads the file from the cursor, or the selection, highlighting the passage. Pause, skip, speed and voice in the bar that appears. The voice list shows each voice by name with what it is (accent, female or male, the model such as Kokoro or Piper, and whether it needs internet), the text's language first; type to find one. The Android app speaks with the phone's own voices and makes the next sentences ready while one plays, so slower, more natural voices read without stopping between sentences. Another engine you install (**VoxSherpa**, with Kokoro and Piper voices that work offline) can be chosen under **Engine** at the top of the voice list, without changing the phone's settings. For human-sounding voices on any device, connect a speech server in **Settings → Read aloud** (Kokoro on your computer, or OpenAI).
- **Share**: WhatsApp, Teams, email, Quick Share or any app on the phone, as text or as a file; on a computer email, WhatsApp, Teams, copy the text, copy a link that opens the file in the editor, or save a copy.
- **Summarize** (with the model on).
- **Send to tracker**: makes the file a task, idea or doc on the tracker, linked to it. *On tracker* shows when it already is.
- **⋯ More**: Details…, Outline and links, Filter lines, macros, History, Compare with…, Compare with clipboard, Text from an image…, Text from a screenshot… (desktop), Dictate (phone), Send checklist to tracker, Type into another window (desktop), Copy for Claude, Ask the model (`Ctrl+K`), Insert snippet / Save as snippet / Use as a snippet, Suggest project and tags (model on), Encrypt / Stop encrypting, Move to trash. Files opened from disk or from a server have their own bar: see 10 and 11.

---

## 5. History, compare and trash

### History

**⋯ → History** lists every synced version of the file (or tracker document): when, and on which device or by Claude. Choose one to **compare** it with the text now: side by side on a computer, one text with the changes marked on a phone. Use the arrows to jump between changes. Then:

- **Restore this version**: puts it in the editor as your own edit, synced like any other. **Undo** (or `Ctrl+Z`) takes it back.
- **Copy**: the old version to the clipboard.
- **Open as a new file**: e.g. `plan (2026-10-21 14.03).md`.

History comes from your data repo, so it needs sync set up and shows only versions that were synced.

### Compare two files

**⋯ → Compare with…** (also the tab menu, or **Compare with another file…** in `Ctrl+Shift+P`) and pick the other file. The list is in sections:

- **Open tabs** first, the tabs right next to this one at the top (marked **next to it**): put the two files side by side in the tab bar and the other one is the first row, so `Enter` compares them. Then the tabs further away, and the ones the tab bar's view hides.
- **In your folders** (desktop), as you type: files in the folders open in Folders, like `Ctrl+P`.
- **My files** and **Tracker documents**, the latest first.

Each row shows the whole name, the folder it is in under it in grey (for a file on disk, the full path; for my files, the project), and the color of its project or folder, as in the tab bar. Type to narrow every section down (part of the name, a folder, a project); `↑` `↓` and `Enter`. Nothing there? **Browse…** picks any file (on a computer, also when nothing matches: `Enter`).

The two files open **in a tab of their own** (indigo, with the compare icon, named "left ↔ right"): this file on the left, the other on the right, side by side with the changes marked. Both sides can be edited, as in any tab. Their headers say where each file is.

- **Go through the changes**: `Alt+↓` / `Alt+↑` (or the arrows in the bar) go to the next / previous one; the bar says which (**Change 2 of 5**).
- **Copy a change across**: the **→** and **←** buttons between the sides, next to each change, copy it to the other side. `Alt+→` / `Alt+←` copy the change at the cursor; so do **Copy →** and **← Copy** in the bar.
- **Copy a whole file across**: **⋯** → **Copy the whole left side to the right** (or the right to the left). ⋯ also has **Swap the sides**, **Read both again** and **Open *name* in a tab**.
- **Save** above a side writes it where it came from: one of my files or a tracker document as an edit (its tab, if open, follows; `Ctrl+Z` there takes it back), a file on disk or on a server back to it. When the file changed meanwhile, saving is refused: **Read both again** and copy your changes over. A side with unsaved changes puts a dot on the tab, and closing the tab asks first.
- **Compare with clipboard** (⋯) works the same way, the clipboard on the right. That side has **Copy** instead of Save. To use the clipboard text: ⋯ → **Copy the whole right side to the left**, then **Save**.
- Close the tab like any other (`Ctrl+W`): you are back in the file you compared. `Ctrl+Shift+T` reopens it.

History, a fix from the model and **Compare** in "changed on disk" still open over the file, with their own buttons (**Restore this version**, **Accept**, **Keep mine and save**).

### Compare two folders (desktop, Android app)

Right-click a folder in Folders (long-press it in the Android app; or empty space in it, or a header when several are shown) → **Compare with another folder…**, then pick the other one: the folders next to it (another copy of the project), the ones in Folders, picked before, favorites and recent ones, a server's start folder or recent folders there, a path on a server (its folders are suggested as you type), or **Pick a folder…**. With two folders shown side by side, the menu offers **Compare with *the other one*** at once; with two folders selected, **Compare the two folders**. Also ⋯ → **Compare this folder with another…** and `Ctrl+Shift+P` → **Compare two folders…**. A folder on this computer and one on a server compare like any two.

The comparison opens in a tab: the first folder on the left, the other on the right, in one tree that lines them up file by file (size and date on each side), with a mark between them: **≠** different, **◧** only on the left, **◨** only on the right, **=** the same. A folder takes the mark of what is inside it.

- **What shows**: the list in the bar: **Differences** (the start), **Everything**, **Only on the left**, **Only on the right**. The counts next to it add up the differences. `.git`, `node_modules` and the like are left out unless ⋯ → **Include .git, node_modules…**; hidden files follow ⋯ → **Show hidden files**.
- **Same size, another date**: those files are compared byte for byte in the background (**Checking contents…**), so a copy with a new date shows as the same.
- **Pick a file** (click, or `↑` `↓`): it shows compared below the tree, with everything above (go through the changes, copy them across, save either side). A file on one side only shows its text, with **Copy to the right** (or left). Drag the line between the tree and the file to share the space. Double-click (or `Enter`) opens the two files in a comparison tab of their own. Edited below and not saved? Picking another file asks first.
- **Next difference**: `Alt+↓` / `Alt+↑` (or the arrows in the bar), opening the folders on the way.
- **Copy across**: select files or folders (`Ctrl`+click, `Shift`+click, `Ctrl+A`), then **Copy →** or **← Copy**. A folder goes with what is different or missing inside it. Before replacing anything, it says how many; the old ones go to the Recycle Bin (on a server, and in the Android app, they are deleted). Copies to and from a server run in the background (see Transfers); the tree reads both sides again when they end.
- **Make one side like the other**: ⋯ → **Make the right like the left…** (or the left like the right) lists what is copied, and what is only on that side. Those are deleted only when you tick **Delete them too**.
- **Change a side**: the pencil in a folder's header picks another folder for that side. ⋯ → **Swap the sides**, **Open both folders in Folders**; ⟳ reads both again.
- **Two panes** (the button next to ☆): the same two folders as two file lists, to browse them and move files around (below); **Compare these folders** there comes back.

### Two panes: two folders side by side (desktop, Android app)

Two folders in a tab, each a file list you browse on its own, like WinSCP or Total Commander: your project here and its copy on the server, two projects, a folder and a backup. Files go from one to the other with a key.

Open it from Folders: right-click a folder (long-press it in the Android app) → **Open in two panes…** and pick the other one (the folders next to it, the ones in Folders, favorites and recent ones, a server's folder or a path on a server, or **Pick a folder…**). With two folders shown side by side in Folders, a header's menu offers **Two panes with *the other one***; with two folders selected, **Open the two in two panes**. Also Folders' ⋯ → **Two panes…** and `Ctrl+Shift+P` → **Two panes: two folders side by side…**. The tab is named after both (`site | site`), and its name follows as you go into folders.

Each side has its header (in the color of where it is: amber this computer, pink a server, with its connection dot), the path to click back up, and **Name**, **Size** and **Modified** columns that sort. `..` at the top goes up (not above the folder you picked in Folders; on a server, up to `/`). The side in use is the stronger one; `Tab` goes to the other.

| To | Do |
| --- | --- |
| Move around | `↑` `↓`, `Home`, `End`, `PageUp` `PageDown`; `Enter` or a double-click opens a folder (or `→`), `Backspace` (or `←`, or `..`) goes up. Typing the start of a name goes to it. |
| Pick | Click; `Ctrl`+click to add; `Shift`+click (or `Shift`+arrows) for a range; `Insert` marks the one at the cursor and goes down; `Ctrl+A` all; `Escape` none. |
| Copy to the other side | `F5`, or **Copy →** in the bar (the arrow points where it goes). What is picked on the side in use goes into the folder shown on the other one. |
| Move to the other side | `F6`, or **Move →**. Open tabs of moved files follow them. |
| Drag | Drop on the other list (or on a folder in either list, or a part of a path): within this computer or one server it moves, between this computer and a server (or two servers, or two drives) it copies; hold `Ctrl` to copy, `Shift` to move. Files dropped from your file explorer are copied in. |
| Already there | The same question as in Folders: **Replace** (the old ones to the Recycle Bin; on a server deleted), **Keep both** ("name (2)") or **Skip**. |
| New folder, rename, delete | `F7` (or `Ctrl+Shift+N`), `F2`, `F8` (or `Del`, after asking). Right-click empty space for **New file**. |
| Open | A text file opens in its tab (edited where it is); pictures show large (`Space`); documents open as they look; other files with their program. |
| The same folder on both sides | Right-click a folder → **Open it on the right too** (or the left); ⋯ → **The left folder on the right too**. |
| Compare | Right-click a file or folder with the same name on the other side → **Compare with the one on the right**. **Compare these folders** in the bar turns the tab into their comparison (above), and its **Two panes** button turns it back. |
| Change a side | The pencil in its header: another folder, here or on a server. ⋯ → **Swap the sides**. |

- Copies and moves on this computer have **Undo** in their message. To and from servers they go on in the background (the **Transfers** card), and both sides are read again when they end.
- Both lists follow changes made elsewhere (on a server, every few seconds while connected); ⟳ reads both again.
- **☆** saves the tab like a comparison (the folders shown when you save it), to open again from the ▾ tab list, `Ctrl+Shift+P` or Folders' ⋯.

### Comparisons on a phone

Held upright, a phone has room for one side, so comparisons change their layout (in a narrow window too):

- **Two files**: one text with the changes marked: the left side's lines in red, above the right side's in green. The text you edit is the right side. By each change, **→** puts the left side's lines there (the right becomes like the left) and **←** takes the change into the left side. **Save** above either side, as before. Turn the phone and the two sides show next to each other again; what you typed stays.
- **Two folders**: one tree, each name once, with each side's size and date under it (◧ the left, ◨ the right, "not here" where it is missing). The bar takes two lines, and the folders' headers are one under the other. Pick a file and it shows compared below, as one text.
- **Two panes**: one pane at a time. The switch above them (◧ and ◨, with the folders' names) shows the other one; **Copy →** and **Move →** send what is picked to the side not shown. **New folder**, **Rename**, **Delete** and **Read both folders again** are in **⋯**.
- **Sideways** (the bar of a folder comparison or two panes, on a phone held upright): turns the app to landscape while that tab shows, so the two folders fit side by side. **Upright** lets the phone turn again. It is remembered: the next comparison turns by itself until you press **Upright**. Leaving the tab gives the phone back its own way (going from a comparison to its two panes keeps it sideways). In a phone's browser it goes full screen first (browsers only turn there); where it cannot (an iPhone), it says to turn the phone yourself, with the screen's rotation unlocked.

### Saved comparisons

A comparison you come back to (your project here and on the server, two copies of a site) can be kept: click **☆** at the start of its bar, give it a name (it is the tab's name too) and **Save**. Open it again from:

- the **▾** at the end of the tab bar: **Saved comparisons**, below the open tabs (**Rename or remove…** under them);
- `Ctrl+Shift+P` → **Open a saved comparison…**;
- Folders' **⋯** → **Saved comparisons…**.

It reads both sides fresh each time, with what it showed and whether it included `.git` and the like (two panes open at the folders saved). The filled ☆ means it is saved; click it to rename it or **Remove** it (the folders and files stay). A comparison with the clipboard, or a file picked with Browse…, cannot be saved (that text was taken once).

### Trash

**Move to trash** (⋯ menu, or Details → Delete) removes a file from every device, with **Undo** in the message. The **trash button** at the bottom of the sidebar lists deleted files for 180 days, with when and where they were deleted. **Restore** brings one back where it was: from this device's copy, or from the data repo. Also in *File → Trash…* on desktop.

---

## 6. The model

The model is optional. Connect one in **Settings → Model**, in one of three ways: [on this computer](#option-a-a-model-on-this-computer-ollama-lm-studio) (free, nothing leaves it), [an AI provider with your API key](#option-b-an-ai-provider-with-your-api-key-claude-openai-gemini) (Claude, OpenAI, Gemini…; works on the phone too) or [a service that answers later](#option-c-a-model-service-that-answers-later). With a [Claude subscription](#your-claude-subscription) you can also ask in the Claude app.

### The ✦ bubble: help with the text

With a model connected, a round ✦ button sits at the bottom right of the editor (or press `Ctrl+K`). It works on **the selection**, or **the whole file** when nothing is selected; the chip at the top says which.

- **Understand**: Explain, Summarize, Action items.
- **Edit**: Fix mistakes, Rewrite clearly, Shorten, Expand, **Change the tone…**, **Advanced replace…** (say what to change: "every date to YYYY-MM-DD", "rename userId to customerId outside strings", "prices +10%").
- **Format and convert**: Tidy / format, **Make it Markdown** (a plain text file becomes headings, lists and tables), **Convert to…** JSON, YAML, CSV, a Markdown table, XML, HTML, a bullet list or SQL INSERTs.
- **Code and queries**: **Check the syntax** (problems by line, then the corrected version), Find problems, **Explain an error** (a pasted message, stack trace or console output), Add comments, Optimize, **Rewrite in…** another language or SQL dialect (Python, PowerShell, T-SQL, PostgreSQL…), **Write a regex…**.
- **Translate**: To English, To Spanish, To another language….
- **Or ask anything**: type in the box at the bottom. **Answer** replies in the panel; **Change the text** applies it ("make this a table", "sort by date"). After an answer you can **ask a follow-up**.

What comes back:
- **A new version of the text** opens as a comparison: **Accept** replaces the selection (Undo takes it back), **As a new file** keeps it separately with the right extension (`.json`, `.md`, `.ps1`…), or **Copy**.
- **An answer** can be copied, **inserted below** the text, **saved as a note**, or, when it has a code block (like a corrected query), used with **Use the code**.
- **Ask in the Claude app**: the same question in Claude instead (see [Your Claude subscription](#your-claude-subscription)).

Turn the bubble off in **Settings → Model**; `Ctrl+K` still works.

### Help with the editor: ask how to do something

The ✦ panel also answers questions about the editor itself, from this guide (every feature, setting and fix, Troubleshooting included) and the list of commands with their keys on your computer. Its first section, **Help with the editor**:

- **How do I…?**: say what you want to do ("compare two files", "edit a file on a server", "fold every function").
- **Keys for…**: the keys (or the menu) for a command.
- **Something isn't working…**: say what happens; the Troubleshooting part of the guide comes first.
- **What can I do with this file?**: what the editor has for the kind of file open (preview, formatting, checks, code tools…).

Or type the question in the box: **About the editor** asks about the editor, and in **Answer** a question like "how do I split the view?" goes to the guide by itself (**Ask about the text instead** asks about your text after all). With no file open, `Ctrl+K` (or **Ask the model how to do something in the editor** in Help or the command palette) opens the panel on these questions alone. Follow-ups work as usual, and the answer says the menu, button or keys to use.

- **What is sent**: with an AI provider or a service, the whole guide goes with the question (about 20,000 tokens; Claude keeps it cached for a few minutes, so follow-ups cost much less); a model on this computer gets the parts of the guide that fit the question. None of your text is sent, only the open file's name and language.
- **Without a model**: type the question and press **Find in the guide** for the passages that answer it, **Ask in the Claude app** (the question goes with those passages), or **Open the guide**.

### Help with errors

- **Problems the editor finds** (the underlines, see [Code tools](#code-tools)): hover one and choose **Explain** (what is wrong and how to fix it, with the corrected lines) or **Fix with the model**. The **Problems** list (`Ctrl+Shift+M`) has a ✦ next to each problem and **Fix with the model** at the top for all of them. A fix opens as a comparison, changing only what the problems need: **Accept** puts it in (`Ctrl+Z` takes it back).
- **Errors in the terminal** (desktop): when a program fails, press ✦ (**Ask about the error**) in the terminal's bar, or right-click → **Ask the model about the error**. It sends the selection, or the last output, with the lines of code the error points to (files in your folders). The answer says what went wrong and why; **Fix app.js** (the file the error names) opens it with a fixed version to compare and accept. Then `F5` to run it again.
- **An error from somewhere else** (a log, a CI run, a message someone sent): paste it into a file, select it, `Ctrl+K` → **Explain an error**.

### The assistant

Open the assistant with the ✦ button in the top bar or `Ctrl+Shift+A`:

- **Ask**: questions about this file, the filtered files or all files, answered with links to the passages used.
- **Find by meaning**: passages close in meaning to what you type (needs an embedding model).
- **Summarize**: a summary of the open file or the selection.

With the model on, **new notes are named and filed**: one call names an untitled note and picks one of your existing projects (never a new one) and up to three tags, reusing the tags you already use. Only empty fields are filled, once per new file, and the message has **Undo**. Turn it off in **Settings → Editor → File new notes under a project, with tags**. **⋯ → Suggest project and tags** does it on demand for any file.

### Suggestions as you type

Turn on **Settings → Editor → Suggest the rest as you type**: a moment after you stop typing at the end of a line, the model's guess appears in grey after the cursor. `Tab` takes it, `Ctrl+→` takes one word, `Escape` (or typing something else) drops it; typing what it says keeps the rest. A bracket or quote closed for you after the cursor is taken care of: the suggestion replaces it.

- It works best with a small code model that **fills in the middle** (it also reads what comes after the cursor): in Ollama for example `ollama pull qwen2.5-coder:1.5b`, then pick it in **Settings → Model → Model for suggestions**. Other models are asked like a chat, which is slower.
- It needs a model that answers at once (options A and B below), not a service that answers later. Encrypted files are never sent. With an AI provider, every suggestion is a paid request: pick a fast, cheap model for it (for Claude, `claude-haiku-5-5`).

### Option A: a model on this computer (Ollama, LM Studio)

1. Install Ollama (ollama.com) and start it.
2. `ollama pull llama3.2` (chat) and `ollama pull nomic-embed-text` (find by meaning).
3. **Settings → Model → This computer → Ollama → Test and list models**, pick both, **Save and turn on**.

Nothing leaves your computer. The desktop app needs no extra setup; in a browser, Ollama must allow the site (`OLLAMA_ORIGINS=https://divaor.github.io`). **The Android app** reaches a model on a computer on the same network by its address (`http://192.168.1.20:11434/v1`), without CORS settings; Ollama must listen on the network for that (`OLLAMA_HOST=0.0.0.0`; LM Studio: **Serve on Local Network**). The web app on a phone cannot reach it: use option B there.

### Option B: an AI provider with your API key (Claude, OpenAI, Gemini…)

Works everywhere, the phone included, without installing anything. **Settings → Model → AI provider**:

1. Pick the provider: **Claude (Anthropic)**, **OpenAI**, **Google Gemini**, **OpenRouter** (many models with one key), **Mistral**, **Groq**, or **Another one** (any OpenAI-compatible address).
2. **Get a key** opens the provider's page for API keys; paste it in **API key**.
3. **Test and list models**, pick the chat model (and optionally the ones for images and suggestions), **Save and turn on**.

- The key stays on the device: in the keychain on desktop, in the browser's storage on the web and the phone. It is never synced, never in the settings, never in the data repo. Set it up once on each device.
- You pay the provider per use, on their own terms. Their prices and limits apply, and the text you ask about goes to them.
- **Claude** goes through Anthropic's official SDK. Finding by meaning needs an embedding model, which Claude, OpenRouter and Groq do not offer: keyword search stays, or use OpenAI, Gemini or Mistral (or option A) for it.

### Your Claude subscription

A Claude Pro or Max subscription cannot be connected to the editor: Anthropic allows signing in with it only in its own apps (Claude, Claude Code). The Claude API (option B) is billed separately, per use, with a key from the Claude Console. To use your subscription instead:

- **Ask in the Claude app**: in the ✦ panel (also without a model connected), after an answer, or in Help (`F1`). It opens a new chat in Claude with the question and the text filled in, and copies them too: if the question is too long for a link, or the app opens instead of the browser, paste it. On the phone it opens Claude in the browser, or in the Claude app when the phone sends claude.ai links there.
- **With the Tracker connector in Claude**: Claude can read your editor files and save a fixed version back (the question names the file). Say "fix it and save it to my editor": the fix comes back with the next sync.
- Encrypted files are never handed over.

### Option C: a model service that answers later

For services where a request gives back a task id and the answer comes later, from a status call or a webhook. **Settings → Model → Answers later**:

1. **Connection profile (JSON)**: describes the service; **Start from the example** shows the shape. The profile says:
   - `submit`: the address, method and body that send a question, and `taskId`, where the task id is in the answer (e.g. `data.0.id`).
   - `status`: the address and body that ask how it's going; `state`, `answer`, `error` (and optional `sources`) are where those are in its answer; `done` / `failed` the states that end it. With `rev`, the service can hold the call open until the task changes; otherwise the app asks every `interval` seconds.
   - Placeholders: `{{prompt}}`, `{{model}}`, `{{task_id}}`, `{{rev}}`, `{{webhook_url}}`, `{{date}}`, `{{purpose}}` (ask, summarize, name, file, test), `{{app}}`. A value that is just a placeholder keeps its type and is left out when empty.
   - Optional: `auth` (the API key's header and prefix), `headers`, `ok` (a field that must be true in every answer), `errorMessage`, `timeout` (seconds) and `webhook`.
2. **Model or agent name**: fills `{{model}}`.
3. **API key**: kept in the computer's keychain, never in the profile or the settings.
4. **Send a test question**, then **Save and turn on**.
5. Optional, desktop: **Receive answers by webhook**. Choose a port and the address the service can reach this computer at (it fills `{{webhook_url}}`), and set the **webhook secret**. Events must then carry the HMAC-SHA256 of their body in the header the profile's `webhook.signatureHeader` names; anything else is refused. The app keeps checking the status now and then anyway, since deliveries can be lost.

Requests go through the desktop app's main process with your system's certificates and proxy, so services on the company network work (option B's providers too). Find by meaning needs an embedding model, so it stays with options A or B.

---

## 7. Encrypted files

For files whose text should not be readable in the GitHub repo:

1. **Settings → Encryption → Set the passphrase** (twice). It is the same on every device. **Nothing can recover encrypted files if you forget it**: write it down somewhere safe.
2. In a file's **⋯ → Encrypt**. From the next sync its text is stored in the repo as AES-GCM ciphertext. The name, project and tags are not encrypted, and earlier versions in the repo's history stay as they were.
3. On your other devices, open the file (it shows a lock with a passphrase field) or go to **Settings → Encryption**, and unlock once.

- Encrypted files show a 🔒 on their tab and in the sidebar. History and the trash decrypt them on an unlocked device.
- An unlocked device keeps their text so they work offline. **Lock this device** keeps only the ciphertext there until you unlock again (it syncs first).
- The Claude connector lists encrypted files but cannot read or change them.
- **Stop encrypting** stores the text in the clear again from the next sync.

---

## 8. Typing into another window (desktop)

For remote desktops (RDP), VM consoles and other windows that don't take pasted text:

1. **Select** the text to type, or select nothing to type the **whole file**.
2. Press **`Alt+T`** (or *Edit → Type into Another Window*, or **⋯ → Type into another window**).
3. Within the countdown (**5 seconds**), **click into the window** where it should be typed. A bar under the file bar shows the countdown, then the progress.

It types real key presses into whichever window has the focus when the countdown ends:

- It **never types into the editor itself**: if the editor still has the focus, nothing is typed.
- It **stops** when another window takes the focus, when you **hold Escape** (Windows), or with **Stop**.
- Line breaks become Enter, tabs become Tab.

**Settings → Typing into other windows**:

| Setting | When to change it |
| --- | --- |
| Time to switch windows | 3, 5 or 10 seconds. |
| Speed | Fast, Normal, or **Slow, for laggy connections** if characters go missing. |
| The other editor indents new lines by itself | Turn it on when the window you type into indents new lines on its own (VS Code, Visual Studio, SSMS, Notepad++, most editors over a remote desktop): after each line break, whatever indentation it added is cleared and the text's own is typed, so YAML, Python and code keep exactly their indentation. Without it, such editors pile up the indentation. |
| Minimize Tracker Editor while it types | The window behind it (often the remote desktop) gets the focus. |
| Send characters instead of key presses (Windows) | If symbols come out wrong because your keyboard layout differs from the remote one. |

- **Windows**: works as is.
- **macOS**: the first time, allow Tracker Editor in **System Settings → Privacy & Security → Accessibility**.
- **Linux**: needs `xdotool` (X11) or `wtype` (Wayland).
- If the other editor also **closes brackets and quotes** by itself (`(` becomes `()`), you may get doubles: turn that off there while typing, or type into a plain editor (Notepad) and copy from there.

---

## 9. Snippets, outline, macros and checklists

- **Snippets** (`Alt+I`): mark a file as a snippet (⋯ → **Use as a snippet**), or select text and choose **Save as snippet**. Write `{{name}}` where a value changes (`{{name:default}}` for a default), plus `{{date}}`, `{{time}}`, `{{clipboard}}`, `{{selection}}` and `{{cursor}}`. `Alt+I` finds a snippet by name, asks for its fields, then **Insert**, **Copy** or **Type into another window**.
- **Outline and links** (`Ctrl+Shift+O`): the headings of a Markdown file, or the classes, functions and tables of code; click one to jump there. Write `[[another note]]` to link notes: `Ctrl+click` opens it (or offers to create it), typing `[[` suggests names, and the panel lists this file's links and the files that link to it.
- **Macros**: `Ctrl+Shift+R` starts recording your typing and shortcuts, `Ctrl+Shift+R` again stops. `Alt+Shift+P` plays it from the cursor; **⋯ → Run the macro…** runs it N times or to the end of the file.
- **Compare with clipboard** (⋯): what you copied against the file, in a comparison tab (see [Compare two files](#compare-two-files)).
- **Send checklist to tracker** (⋯): the open `- [ ]` items of the selection or the file become tracker tasks linking back to the line; dates like `(due 2026-10-30)` become due dates, and items already sent start unticked.

## 10. Logs, files on disk and folders (desktop, Android app)

- **File → Open File (Edit in Place)** (`Ctrl+O`): edit a file where it is (a config file, a script, a log). It is not synced. `Ctrl+S` saves it back with its line endings (CRLF/LF), BOM and encoding, shown in the status bar.
- **Changed elsewhere**: with no unsaved edits it reloads by itself. With edits, a yellow notice offers **Compare**, **Reload (lose my edits)** or **Keep mine and save over it**. Saving never silently overwrites another program's change.
- **Follow** (like `tail -f`): new lines appear as they are written and the view stays at the end; the tab is read-only meanwhile. A rotated log is read again.
- **Huge files** (over 20 MB) open by their last 5 MB, read-only.
- **Filter lines** (`Alt+L`): show only the lines that match, or hide them; with match case and regex (`ERROR|WARN`). **Copy** or **New file** with the lines shown. Files over 3 MB or 60,000 lines open in a lighter mode (no highlighting or wrapping) that stays fast.
- **Paste a file to open it**: copy a file in Explorer or Finder (`Ctrl+C`) and paste it here (`Ctrl+V`, in a file or anywhere in the window): it opens where it is, as a tab of its own (a guest in a view of one group), not as a copy. Pictures are read as text instead (see 13). A folder pasted opens in Folders.
- **Paste a path**: paste `C:\folder\file.txt` (Explorer's **Copy as path** too, with its quotes) or `/home/me/file.txt` into a file and it is pasted as text, with **Open** in the message to open that file. Or paste it into `Ctrl+P` and press `Enter`. Outside a file (no tab open), pasting a path opens it at once. A file or folder not opened here before is asked about first, in a window of your system.
- ⋯ → **Show its folder in Folders**, **Show in the file explorer**, **Copy path**, **Copy into my files** (a synced copy). Closing a tab with unsaved edits asks first.

### A terminal, and running a file

- `` Ctrl+` `` (or **View → Terminal**) opens a terminal in a panel under the editor: on this computer (your usual shell: PowerShell on Windows, zsh or bash on Mac and Linux) in the folder of the open file or the one shown in Folders, or on the server when the open file is on one. **Terminal** at the right of the status bar opens one in the open file's folder (or brings back the one already there). Right-click a folder → **Open a terminal here**, or a file → **Open a terminal in its folder** (in Folders, or on a tab); **+** in the panel opens more (this computer or a server). See [Terminal on a server](#terminal-on-a-server) for the keys.
- **Run this file** (`F5`, or **View → Run This File**): saves it, then runs it in a terminal of its own (**Run · …**), in the file's folder: `python3` for `.py` (`python` on Windows), `node` for `.js`, `bash` for `.sh`, PowerShell for `.ps1`, `go run`, `ruby`, `php`, `npx tsx` for `.ts` and more; `.html` opens in the browser. On a server it runs there, over SSH. Change or add commands in **Settings → Editor → Run commands**, one per line: `py: uv run {file}` (`{file}` the file, `{dir}` its folder, `{name}` its name; `js:` with nothing after turns a type off).
- **`file:line` opens the file there**: in a terminal, the places programs print (`src/app.js:12:5`, `File "main.py", line 7`, `Foo.cs:line 42`, `a.ts(12,5)`) are links; click one. In the text (a log, a pasted stack trace), `Ctrl+click` one. Relative paths start from the terminal's folder, or the file's. Files outside the folders you opened in Folders do not open (open their folder first).
- **When it fails**, ✦ in the terminal's bar asks the model about the error, and offers to fix the file it points to: see [Help with errors](#help-with-errors).

### Terminal tabs: names, order, two side by side (desktop)

Each terminal is a tab in the panel. With a few open (a server, this computer, a build running), these keep them apart:

- **Rename**: double-click a tab (or right-click it → **Rename…**, or the command **Rename the terminal** for the one in use). Type the name and press `Enter`; `Escape` keeps the old one. An empty name goes back to the usual one (**This computer · folder**, or the server's name). Hover a renamed tab to see where it is.
- **Reorder**: drag a tab along the others; a line shows where it goes. Right-click → **Move left** / **Move right** does the same.
- **Two side by side**: drag a tab onto the left or right half of the panel (the two halves light up while you hold it there), or right-click it → **Show on the left** / **Show on the right**, or the panel's **Two side by side** button (the one in use and the next one), or the command **Two terminals side by side**, which with only one terminal opens a second one in the same place. Each side has its name on top, and its tab a ◧ or ◨.
  - Click into a side to type there; that one is in use (its name is underlined). Clicking a tab that is not showing puts it on the side in use.
  - Drag the line between them to give one side more room (double-click it: halves again). The width is remembered.
  - Drag a side's name onto the other side to swap them, or onto the tabs to show that one alone. **Show only this one** (⛶ on a side's name), the panel's **One terminal again** button and the command do the same.
  - Closing a terminal on a side puts the next one there; with no other left, the panel shows one again.
- Phones and narrow windows show one terminal at a time.

### Folders: a file explorer

The sidebar has two views on the desktop: **My files** (synced) and **Folders** (on this computer). **View → Folders** (`Ctrl+Shift+E`) shows it; **File → Open Folder…** or the welcome screen's **Open a folder** adds one. Pick a folder in the system dialog (the buttons start it in Documents, Desktop or Downloads). The editor can only reach what is inside the folders you picked.

| To | Do |
| --- | --- |
| Select | Click; `Ctrl`+click to add; `Shift`+click for a range; `Ctrl+A` for all; arrow keys (`Shift` to extend); or type the start of a name. The bottom line counts what is selected. |
| Open | Double-click or `Enter`. A folder opens in the view (`Backspace` or ↑ goes back; click the path at the top to jump). A text file opens **in place** like `Ctrl+O` (not synced, `Ctrl+S` saves, Follow works). **Pictures show large here** (as with `Space`; `Enter` there opens them with their program). **Documents** (PDFs, e-books, Word, OpenDocument, RTF, spreadsheets, presentations) **open in a tab, shown as they look** (see [Documents](#documents-pdfs-e-books-word-and-more)). To open pictures and documents with their program straight away, choose that in **Settings → Desktop → Folders**. Other formats open **with their own program**. |
| Make | **New file**, **New folder** (`Ctrl+Shift+N`): type the name in the list, `Enter`. |
| Rename | `F2`, type, `Enter` (`Escape` cancels). |
| Copy, move | `Ctrl+C` / `Ctrl+X`, then `Ctrl+V` in another folder (or **Paste into this folder** on a folder). **Duplicate** makes "name - Copy". Or drag onto a folder or onto part of the path at the top: moves, with `Ctrl` copies. Dropped on a file inside an opened folder, it goes into that folder (the folder is outlined). |
| Long lists | While you drag, bands at the top and bottom of the list say **Scroll up** / **Scroll down**: hold the pointer there and the list scrolls, faster nearer the edge. Hold a drag over a closed folder for a moment and it opens in place, so you can drop deeper. |
| With your file explorer | Files you copy (`Ctrl+C`) or cut (`Ctrl+X`) here can be pasted in Explorer, Finder or your Linux file manager (cut moves them there). Copy files in Explorer or Finder, then `Ctrl+V` here: they are copied in. Drop files from another app: copied in. Drop a tab on a folder: a copy of it is saved there. Text copied anywhere and pasted becomes a new file (name it first). |
| Delete | `Del` or the bin button: after asking, to the Recycle Bin (macOS: the Trash), where you can restore it. |
| Undo | Rename, move, copy and paste show **Undo** in their message. |
| Side by side | Several folders at once, each a root of the tree. The **⫼** button in the folder's bar (also ⋯ → **Folders side by side…**, **File → Folders Side by Side…**) lists the ones shown, in order, and what you can add: the folders you picked before, favorites and recent folders (here and on servers), each server's start folder (it connects first), any folder on a server by its path (its folders are suggested as you type: `/var/www/`…), or **Pick a folder…**. Click several to add them all at once; drag them (or ↑ ↓) into the order you want, × takes one out; **Show** puts them in the tree. Right-clicking a folder offers **Open beside** too. **Drag a header** above or below another to change the order in the tree. Each one has a header in the color of where it is (amber: this computer, pink: a server, with its connection dot) that stays at the top while you scroll through it; the one you are working in is stronger, and the path above and the toolbar are its own. Click a header's arrow to **collapse** it to one line, click the header to open it and work there; right-click it for **Show only this one** (the others collapse), **Expand all**, **Collapse all**, **Up one folder**, **New file here**, **Paste here**, **Move up/down** and **Close here**. The × on a header closes it in the view (nothing is deleted). Drag, cut, copy and paste between them as between any folders (to and from servers in the background). The filter looks in all of them. They are remembered, collapsed or not. |
| Tree | The chevron next to a folder opens it in place, with what is inside under it (`→` opens, `←` closes or goes to the folder above). Select, copy and move across the folders you opened. **New file**, **Paste**, **Duplicate**, **Compress** and **Text from the image** work in the folder of what you picked: an opened folder that is picked, or the folder something picked is in, not the top of the tree. |
| Filter | The field under the path: what matches shows as you type, here and **in the folders inside, closed ones too** (on servers as well), under its folders opened for it; the line under the field says how many were found inside. `*.yml` or `test?.js` work as patterns. `.git` and `node_modules` are skipped; hidden files only when shown. |
| Details | The columns button (right of the toolbar): **Name**, **Size** and **Modified** in columns (**Permissions** on servers when shown). Click a header to sort by it, click again to turn the order around. Folders stay first. |
| Favorites | ☆ in the folder's bar adds it to the favorites (or right-click a folder → **Add to favorites**); they show under its name, one click away. Drop files on one to move them there. Right-click one to remove it. |
| Recent | 🕘 in the folder's bar: the folders you visited last. |
| Preview | The eye button: the file you pick shows under the list: pictures, documents (PDFs, e-books, Word…), Markdown, HTML, CSV and JSON as they look, the start of any other text file; other formats say what they are, with **Open with its program**. Drag the top edge of the preview to make it taller. On a phone, while the preview shows, a tap on a file shows it there; tap it again to open it (folders open with one tap). For a picture, the scan button in the preview's bar reads its text (**Text from the image**). |
| View large | `Space` (or right-click → **View it large**, or ⛶ in the preview): the file over the whole window (the whole screen on a phone), like Quick Look. `←` / `→` go through the folder's files, `Enter` opens it (a document in its tab, a picture with its program), `Space` or `Escape` closes it. For a picture, the scan button reads its text (**Text from the image**). |
| Already there | When names you paste, drop or move are already in that folder, it asks once for all of them: **Replace** (the old ones go to the Recycle Bin; on a server they are deleted), **Keep both** (the new ones get " (2)") or **Skip** (those are left out). **Cancel** does nothing. Moving something into the folder it is already in says so. |
| Compare | Select two text files, right-click → **Compare the two**: side by side in a comparison tab. Two folders: right-click one → **Compare with another folder…** (see [Compare two folders](#compare-two-folders-desktop)). |
| Two panes | Right-click a folder → **Open in two panes…**: it and another folder (here or on a server) as two lists in a tab, to copy (`F5`) and move (`F6`) files between them (see [Two panes](#two-panes-two-folders-side-by-side-desktop)). |
| Zip | Right-click → **Compress to name.zip** (or **Compress N items to a zip**: `Archive.zip`) makes it next to them. On a `.zip`: **Extract into a new folder** unpacks it beside it ("name", or "name (2)" when taken). Unsafe names (that would land outside that folder) are left out, and an archive that unpacks to far more than its size is refused. On this computer only. |
| Pictures | Right-click → **Text from the image…** reads the text on this computer; **Save as photo.txt here** keeps it next to the picture (or insert it, copy it, or make a synced file). |
| Find text | `Ctrl+Shift+F` in the list (or 🔍, or right-click a folder → **Find in this folder…**): type, `Enter`. It looks in the folder and the folders inside it; **Files** narrows it (`*.log, !debug*`), **Hidden** includes dot files. Click a line to open the file there. **Stop** stops a long one. `.git`, `node_modules`, non-text and very large files are skipped. |
| Replace in files | In Find in this folder, the arrow at the left of the field shows **Replace with**: each line found shows what it becomes (old struck out, new in green). Untick the files to leave alone, then **Replace in N files** (or `Enter`). With `.*` (a regular expression), `$1` puts back a group and `\n` a new line. The message has **Undo** (it puts back only files nobody changed since). Files open with unsaved edits are left out; open tabs show the new text. On servers too. |
| Git | In a folder that is a Git repository (on this computer), the branch shows next to the folder's name, and files show what changed since the last commit: **M** changed, **U** new, **A** added, **R** renamed, **C** in conflict; folders with changes inside have a dot. Hover the branch for how many files changed and what is to push or pull. Right-click a changed file → **Compare with the last commit**. It uses the `git` program installed on the computer and only reads. |
| Properties | `Alt+Enter` or right-click → **Properties**: where it is, size (**Count what is inside** for a folder), dates, owner, permissions. On Mac/Linux tick Read/Write/Run for Owner/Group/Others or type `644`, **Save permissions**; for a folder, **Also for everything inside**. On Windows: **Read-only**. |
| Terminal | Right-click a folder → **Open a terminal here** (a file: **Open a terminal in its folder**), near the top of the menu: a terminal in the panel under the editor, in that folder. **Open in the system’s terminal** opens your system's own (Windows Terminal or PowerShell, Terminal, …) there instead. |

- **Files in a Git repository**: lines changed since the last commit have a bar next to their number (green added, blue changed, a red mark where lines were removed), and the status bar shows the branch with how many lines changed (**main ±3**); click it to compare with the last commit (also **Edit → Code → Compare with the Last Commit**).
- **Open tabs follow**: rename or move a file (or its folder) and its tab follows, unsaved edits included. Deleting a file closes its tab, unless it has unsaved edits.
- **Programs are never started**: `.exe`, `.bat`, `.ps1`, `.lnk` and other programs, scripts and shortcuts don't open with a double-click (scripts open as text). Use **Show in the file explorer** for those.
- **Right-click** a file for **Open with its program**, **Copy path**, **Copy for Claude** (the paths, quoted as a terminal takes them), **Copy into my files** (a synced copy; the file on disk stays as it is) and **Show in the file explorer**. Right-click empty space for New, Paste, the order and hidden files.
- **⋯** next to the folder's name: switch between your folders, add another, sort by name, date modified, size or type, show hidden files, or **Forget** a folder.
- **Remembered**: the width of the sidebar, list or details, the order, the favorites and recent folders, and whether the preview shows and how tall it is.
- The list follows changes made in other apps. The folders, where you were, the order and the open files are remembered.

### Documents: PDFs, e-books, Word and more

PDFs, e-books (EPUB, FictionBook), Word and OpenDocument text (`.docx`, `.odt`), RTF, spreadsheets (`.xlsx`, `.ods`) and presentations (`.pptx`, `.odp`) open in a tab of their own, **shown as they look** and read-only: from Folders (a double-click, `Enter`, or a tap on a phone), from **Open with** in other apps on Android, with `Ctrl+O`, or on a server.

- **Full screen**: the ⛶ button in the document's bar shows only the document (on a phone the status and navigation bars hide too); `Escape`, Back or the button again leave it.
- **Listen** (`Alt+R`, or **Listen** in its bar): reads the document aloud from the top of the screen (from a PDF's page you are on), or only the paragraphs you selected. The sentence being read is highlighted in its paragraph and kept in view (a PDF: its page). Not for spreadsheets. In full screen the player shows at the bottom.
- **Bookmark**: the bookmark button keeps your place (a PDF's page; in an e-book, Word file or sheet, the paragraph at the top of the screen). The document then **opens there every time**, on any screen size, until you clear it: tap the filled bookmark for **Go to the bookmark**, **Move the bookmark here** or **Clear the bookmark**. One bookmark per file, kept on this device; it follows the file when you rename or move it in Folders.
- **PDFs**: the pages are drawn as you scroll. **−** and **+** zoom (so do `Ctrl`+wheel and two fingers on a touch screen), **Fit** fits the width, **3 / 20** is the page you are on and **Contents** lists its bookmarks. Select text on a page to copy it. A PDF with a password asks for it.
- **E-books** read as one page, chapter after chapter, in the editor's text size (`Ctrl+=` and `Ctrl+-`, **Aa** in the status bar, or a pinch). **Contents** goes to a chapter, and the links inside the book work. Books with DRM cannot be opened: only the app they were bought for can.
- **Word, OpenDocument and RTF**: headings, bold, italic, lists, tables (merged cells too), pictures, links and footnotes. Their fonts and page layout are left to the editor's look. **Contents** lists the headings.
- **Spreadsheets**: each sheet as a table with its column letters and row numbers (the first 2,000 rows and 80 columns). **Contents** goes to a sheet. Values show as they were saved; a formula saved without its value shows the formula.
- **Presentations**: each slide with its title, text, tables and pictures, then its speaker notes.
- **As text** (in the file bar) puts its text in the editor: select it, search it (`Ctrl+F`), copy it, read it aloud. **As it looks** goes back. Its text is also what Find in files, **Copy for Claude** and the model use.
- **Its program** (or ⋯ → **Open with its program**) opens it in the app made for it, for what this view leaves out. ⋯ → **Copy its text into my files** keeps its text as a note.
- Changed elsewhere, it is shown again; **Reload** reads it again. Nothing here changes the file.
- Not shown here: old `.doc`, `.xls` and `.ppt` files and Pages, Numbers and Keynote files (they open with their program). Pictures in Windows-only formats (EMF, WMF) show as **[picture]**.

## 11. Files on servers (desktop, Android app)

Edit files on your servers as if they were here: **SFTP** (over SSH), **FTPS** (FTP over TLS) or **FTP** (not encrypted; only where nothing else is available).

1. **File → Connect to a Server…** (or **Connect to a server…** in the Folders view). Fill in the server, port, user name and how to sign in: **Password**, **Key file** (choose it; type its passphrase if it has one) or **SSH agent**. Give it a short name: it shows on tabs. Optionally a folder to start in.
2. **Test** tries it. The first time, SFTP shows the server's **key fingerprint**: compare it with the one the server shows (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there, or ask its administrator), then **Trust and connect**.
3. **Save and open**: the server opens in Folders, in your home folder.

Working there:
- Everything in the Folders view works on a server: open, new file and folder, rename (`F2`), cut/copy/paste, duplicate, drag onto folders, and drop or paste files from your computer to upload them. **Delete** is for good on a server (no Recycle Bin), so it asks first. Copy and paste also work between your computer and a server, both ways.
- **Uploads and downloads go on in the background**: the **Transfers** card (bottom left) shows each one with a progress bar, how much, how fast and which file; keep working meanwhile (on FTP too: transfers use a connection of their own). **Stop** stops one: what got there stays, the file it was on is removed there. Make the card smaller with its arrow; finished ones go by themselves, **Show** opens where they went. A move to or from a server takes its open tabs along.
- A server file opens in a **pink tab**. The file bar shows the server's name and **Saved on the server** or **Not saved to the server**; the status bar shows `SFTP · user@host:/path` and a dot (filled: connected).
- **Ctrl+S** saves it to the server. Or turn on **Save to the server automatically** in the server's settings (⋯ next to its name → Edit), and it saves a moment after you stop typing.
- **Changed on the server?** Tabs you haven't edited update by themselves. With your edits, you get **Compare**, **Reload** or **Keep mine and save over it**. **Follow** shows lines added to a log on the server.
- **The server hung up?** FTP servers close a connection left idle for a few minutes (and networks drop them): the next thing you do (open a folder, Refresh, open or save a file) connects again by itself.
- **Server unreachable?** Your edits stay on this device, even if you close the app; the tab says **Not connected · not saved**. **Reconnect** (in the file bar) and then **Ctrl+S**.
- Pictures show large here and documents open in a tab, as on this computer; other files (and pictures and documents with **Open with its program**) open with their program from a downloaded copy (changes made there are not sent back). Pictures can also have their text read (see 13).
- Your password and key passphrase are kept in this computer's keychain and never shown again; the editor only uses key files you choose (or the ones your SSH config names).
- ⋯ next to the server's name: switch between folders and servers, edit or disconnect the server, add another, **Show permissions** (`rw-r--r--` next to each file), **Mirrors…**.
- **Find in this folder**, **Properties** (with permissions you can change) and the rest of the Folders view work on servers too.

### Signing in

- **No saved password?** Leave it blank: it is asked when you connect, with **Remember on this computer** if you want it kept. A wrong one is asked again.
- **A code (two-step sign-in)**: when the server asks for a verification code (after your key or your password), a window shows its question; type the code, **Sign in**. Codes are never kept.
- **A key with a passphrase you didn't save**: the passphrase is asked.
- **A jump host / bastion**: in the server's settings, **Reach it through** → another SFTP server set up here. It connects first and opens the way (like `ssh -J`).
- **From your SSH config**: ⋯ → **Servers from your SSH config…** (or **File → Servers from the SSH Config…**). Tick the hosts in `~/.ssh/config` to set up; keys (`IdentityFile`) and jump hosts (`ProxyJump`) come along, and ones you have already are reused. Their passwords are asked the first time.
- Take your time with a key fingerprint or a code: the connection waits.

### Terminal on a server

`` Ctrl+` `` (or **View → Terminal**, or right-click a folder on an SFTP server → **Open a terminal here**, or ⋯ in a server file's bar → **Open a terminal in its folder**): a shell on the server opens in a panel under the editor, in that folder, signed in like its files. (Terminals on this computer work the same way: see [A terminal, and running a file](#a-terminal-and-running-a-file).)

- **+** opens another (one tab each); drag the panel's top edge to make it taller. Tabs can be renamed, reordered and shown two side by side: see [Terminal tabs](#terminal-tabs-names-order-two-side-by-side-desktop).
- Its colors follow the app's theme. In light mode each of the shell's colors is a darker shade, so green and yellow text (prompts, `ls`, test results) stays readable on white.
- Keys go to the shell: `Ctrl+C` stops a command (copies if text is selected), `Ctrl+V` pastes; `Ctrl+Shift+C` / `Ctrl+Shift+V` also copy and paste; right-click for Copy, Paste, Clear.
- `` Ctrl+` `` again (or ⌄) hides the panel; the shells keep running. When one ends (`exit`), `Enter` starts it again. **×** on a tab closes that shell.
- FTP servers have no terminal.

### Mirrors: a server folder on this computer

For when you want the server's files in a folder here (to use other tools on them) and kept the same.

1. On a server in Folders, right-click a folder → **Keep on this computer (mirror)…**.
2. **Choose…** the folder here (or make one), pick the **Direction** (**Both ways**, **Server → here**, **Here → server**), what to **Leave out**, and **Keep them the same automatically**.
3. **Save and sync now**. The files come down; from then on, changes go across.

- **Automatically**: while the server is connected, every minute, and a few seconds after you change something here.
- Inside a mirrored folder, a bar shows it (**Mirrored here as site**, **Mirror of Test box /var/www/site**) with when it last synced and a **Sync now** button. Files from it have a ⇄ badge in the file bar (click: sync now). ⋯ → **Mirrors…** lists them all.
- **Deleted on the server** → here it goes to the Recycle Bin.
- **Deleted here** → you're asked first (**Review**): **Delete on the server** or **Bring them back here**. Until then they stay on the server.
- **Changed on both sides** → yours keeps its name and the server's is kept next to it as `name (server copy 2026-10-22 15.04).ext`, on both sides.
- If one side suddenly looks empty (a drive not plugged in, a wrong folder), nothing is changed and the bar says so.

## 12. Quick capture, clipboard history and screenshots (desktop)

Turn them on in **Settings → Desktop**.

- **Keep running in the tray when the window is closed**: closing hides the window; quit from the tray icon. Needed for the shortcuts to work with the window closed.
- **Quick capture** (default `Ctrl+Alt+N`, anywhere): a small window to jot something down. `Ctrl+Enter` saves it as a **new note** (without switching what you're doing) or **adds it to Inbox.md** under the date and time; the choice is remembered, and `Ctrl+Shift+Enter` uses the other one. **Paste clipboard** adds what you copied. `Escape` closes it and keeps the draft. To change the shortcut, click the field and press the keys; it says if another app already uses them.
- **Text from a screenshot** (optional shortcut, default `Ctrl+Alt+O`, or **Edit → Text from a Screenshot**, or the tray): the editor steps aside, the screen dims, you drag around the text, and it is read (see 13). `Escape` or a right-click cancels.
- **Clipboard history** (`Ctrl+Shift+V`): everything you copy in any app, newest first, up to 20–200 entries. Type to search; `Enter` inserts the chosen one at the cursor; or **Copy**, **New file**, **Type into another window**. **Pin** keeps an entry when the list is full or cleared. It stays on this computer, encrypted with its keychain, skips passwords copied from password managers, and turning it off deletes it.

## 13. Text from images and voice notes

- **Text from an image**: paste an image into a file (`Ctrl+V` with a screenshot on the clipboard, e.g. after Win+Shift+S), drop one on the window, use **⋯ → Text from an image…** (on a phone: take a photo or pick one), right-click a picture in the Folders view, or **Share → Tracker Editor** from the gallery. The text is read **on the device**, in English and Spanish; the image is not sent anywhere. **With a model that reads images** (e.g. `llama3.2-vision`, `qwen2.5vl`, `gemma3`: **Settings → Model → Model for images**), the dialog's **Read by** can switch to it: often better for photos, handwriting and tables (kept as Markdown tables). The image then goes to your model server (a local one keeps it on your computer); the choice is remembered. Fix anything misread in the box, then **Insert at the cursor**, **New file** or **Copy** (from the Folders view also **Save as name.txt here**). The first time downloads about 9 MB from the editor's own site; after that it works offline (the Android app has it built in). It is a text-recognition tool (Tesseract), not a model: it needs no model, account or connection. Choosing one language (English or Spanish) can read better.
- **Voice notes** (phone, and Chrome/Edge/Safari on a computer): the 🎤 button at the top dictates into the open file at the cursor, or a new note when none is open. What it hears shows in a bar; phrases go in with spaces and capitals. Say "new line" / "new paragraph" ("nueva línea", "nuevo párrafo", "punto y aparte"). **Stop** ends it. On Android, long-press the app's icon for **Voice note** to start one directly. Pick the language in **Settings → Voice notes**. It uses the browser's speech service (Google's on Android), so it needs a connection; the desktop app doesn't have it.

---

## 14. With the tracker and Claude

- **The tracker's documents** (proposals, artifacts and other text attachments) are listed with your files under their item's name, downloaded on each sync so you can read and search them offline. Edits you make are saved back to the tracker; if Claude sent a new version meanwhile, yours is kept as a copy.
- **Pictures, PDFs and other files attached in the tracker** are not downloaded here (they would be no use as text). In the tracker, a PDF, Word, Excel, PowerPoint or OpenDocument file's **Open in editor** shows it here as it looks, in a tab of its own (read-only, as documents are); pictures stay in the tracker.
- In the tracker, items show **Open in editor** and text attachments **Edit in editor**.
- **Send to tracker** turns a file into a task, idea or doc linked to it.
- **Claude** (through the tracker's connector) can list, search, read and save your editor files: "save this as a note in my editor", "what's in my deploy notes?". It can't read or change encrypted files.
- **Asking Claude with your subscription**: **Ask in the Claude app** in the ✦ panel opens Claude with the question ready; with the connector, Claude can save its fix back to the file. See [Your Claude subscription](#your-claude-subscription).
- **Giving a file to Claude yourself**: drag its tab (or files from the Folders view) into Claude Code's terminal (it gets the path) or the Claude app (it gets the file), or right-click → **Copy for Claude** and paste: the path of a file on disk, or the name and text of the others.

---

## 15. Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Alt+N` (desktop `Ctrl+N`) | New file |
| `Ctrl+P` | Open a file by name |
| `Alt+V` | Which tabs show: a project, a folder, Notes, Other files, several, or all |
| `Ctrl+Alt+PageDown` / `Ctrl+Alt+PageUp` / `Ctrl+Alt+Home` | The next / previous group of tabs / all tabs |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+O` | Open a file from disk to edit in place (desktop) |
| `Ctrl+Shift+E` | Folders on this computer and on servers (desktop) |
| In the folders view | `Enter` open, `Backspace` up, `→` / `←` open / close a folder in place, `Space` view large, `F2` rename, `Del` delete, `Ctrl+C` / `Ctrl+X` / `Ctrl+V`, `Ctrl+A`, `Ctrl+Shift+N` new folder, `F5` refresh, `Alt+Enter` properties, `Ctrl+Shift+F` find in this folder |
| `` Ctrl+` `` | Terminal (this computer or a server): show or hide (desktop) |
| `F5` | Run this file in the terminal (desktop) |
| `Tab` / `Ctrl+→` / `Escape` | With a grey suggestion: take it / take a word / drop it |
| `Ctrl+click` on `file:line` | Open that file at that line (in a terminal, a plain click) |
| In the terminal | `Ctrl+Shift+C` / `Ctrl+Shift+V` copy / paste; `Ctrl+C` copies a selection, `Ctrl+V` pastes |
| Terminal tabs | Double-click: rename; drag along the tabs: reorder; drag onto the left or right half: two side by side; a side's name back onto the tabs: one again |
| `F1` | Help: every command and shortcut (and this guide) |
| `Ctrl+Shift+P` (or `Ctrl+P`, then `>`) | Run a command by name |
| `Tab` in HTML, XML, JSX | Expand an Emmet abbreviation (`ul>li*3`, `div.card`, `!`) |
| `Shift+Alt+F` | Format document (or the selection) |
| `Ctrl+L` | Select the line (again: the next one too); or click its number for Copy, Cut, Paste, Select all |
| `Ctrl+F` / `Ctrl+H` | Find / replace in this file (`Enter` next, `Shift+Enter` previous, `Alt+Enter` select all; in the replace field `Enter` replaces, `Ctrl+Enter` replaces all) |
| `Ctrl+G` | Go to line |
| In a comparison | `Alt+↓` / `Alt+↑` the next / previous change (folders: difference), `Alt+→` / `Alt+←` copy the change at the cursor to the right / left |
| In two panes | `F5` copy / `F6` move to the other side, `F7` new folder, `F2` rename, `F8` delete, `Tab` the other side, `Enter` open, `Backspace` up, `Insert` mark |
| `Ctrl+Shift+M` / `F8` / `Shift+F8` | Problems in this file / the next one / the one before |
| `F12` / `Shift+F12` / `F2` | In code: go to the declaration / its usages / rename it (with a language server: across the project) |
| `Ctrl+.` | Quick fixes and refactorings here (language server) |
| `Shift+Alt+O` | Organize imports (language server) |
| `Ctrl+Shift+Space` | With a language server: the parameters of the call at the cursor |
| `Ctrl+P`, then `@` | Go to a function, class or section of this file |
| `Ctrl+T` (or `Ctrl+P`, then `#`) | Go to a function, class or section in any file (desktop: also the folders open in Folders) |
| `Alt+0` / `Alt+Shift+0` | Fold everything / unfold everything (`Alt+1`, `Alt+2`, `Alt+3`: fold one level) |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Fold / unfold the block here |
| `Shift+Alt+↑ ↓ ← →` (or `Ctrl+Shift+Alt+arrows`) | Select a column: a cursor on each line, then as wide as you go |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | Add a cursor above / below |
| `Ctrl+D` | Select the next occurrence |
| `Ctrl+/` | Comment lines |
| `Alt+Z` | Word wrap |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Larger / smaller text / the usual size (also `Ctrl`+wheel, a pinch on a phone, **Aa** in the status bar) |
| `Alt+R` | Read aloud, pause or resume |
| `Alt+T` | Type the selection or file into another window (desktop) |
| `Ctrl+K` | The ✦ model panel: about the selection or the file (no file open: how to do something in the editor) |
| `Alt+I` | Insert a snippet |
| `Alt+L` | Filter lines |
| `Ctrl+Shift+O` | Outline and links |
| `Ctrl+Shift+R` / `Alt+Shift+P` | Record a macro / play it |
| `Ctrl+Shift+V` | Clipboard history (desktop) |
| `Ctrl+Alt+N` / `Ctrl+Alt+O` | Quick capture / text from a screenshot, anywhere (desktop, when turned on) |
| `Ctrl+\` | Split view on or off |
| `Ctrl+B` | Show or hide the file list |
| `Ctrl+Shift+A` | The model |
| `Ctrl+S` | Sync now (with what you just typed), or save a file opened from disk or a server |
| `Ctrl+W` / `Ctrl+Shift+T` | Close tab / reopen it (desktop) |
| Middle-click / double-click a tab | Close it / pin or unpin it |
| Mouse wheel over the tabs | Scroll through them |
| `Ctrl+Tab` | Next tab |

---

## 16. Troubleshooting

- **"Open in another tab"**: the editor runs in one browser tab at a time; it moved to the newest one. **Use it here** brings it back.
- **A file shows a lock**: it is encrypted and this device isn't unlocked. Enter the passphrase.
- **History says to set up sync**: versions come from the data repo; connect it in Settings.
- **Typing put nothing in the other window**: the editor still had the focus. Start again and click into the other window before the countdown ends.
- **Typing drops or changes characters**: choose *Slow*, or on Windows *Send characters instead of key presses*.
- **The model service test fails with 403**: check the API key and that it has access to the knowledge base or agent named in *Model or agent name*.
- **Android says "already installed" but doesn't open**: remove it from the home screen and install again from the web address.
- **Obtainium says the app cannot be updated ("signatures do not match")**: an APK built elsewhere (or a test build) is installed. Uninstall Tracker Editor and install it again from Obtainium (sync with GitHub first, or your files on the phone go with it).
- **Android app: Open a folder does nothing**: it needs **All files access**. Allow it in Android's settings (Apps → Tracker Editor → Permissions, or the screen it opened), come back and tap **Open a folder…** again.
- **Android app: nothing responds, or it closes by itself**: long-press its icon → **Send a log** and send it to whoever helps you with it.
- **Android app: "The app's file access did not start"**: Folders, servers and terminals need it; the rest of the editor works without it. **Send a log** (the message's reason is in it too).
- **Android app: "The app's access to files and servers stopped"**: Android ended its file access while the app was in the background. Do it again: it starts again. Terminals on the phone and on servers end with it.
- **Android app: the terminal opens blank, with only the cursor**: before 0.28.1 the shell's prompt could be lost on fast phones. Update the app; in an older one, press `Enter` and the prompt shows. "Starting the shell…" while it waits means the app's file access is starting (the first time after opening the app).
- **Android app: no Compare with another folder… or Two panes in a folder's menu**: they came to the app in 0.33.0: update it.
- **Sideways does nothing, or says to turn the phone**: in a browser it needs full screen, which some (an iPhone's) do not give a page. Turn the phone yourself (unlock the screen's rotation in the quick settings); the layout follows. In the Android app, Sideways works even with rotation locked.
- **Android app: a file opened with Tracker Editor is Read-only**: the app that gave it allows reading only (Gmail attachments, many file managers' "Open with"). Save a copy with ⋯ → **Download**, or open it from Folders instead.
- **Android app: Extract fails with "EBADF: bad file descriptor, close"**: before 0.34.2 the app could not extract zip files (its Node.js lacked a checksum the extraction used, and the message hid that). Update the app.
- **A PDF or document from the tracker opens as text (`%PDF-1.4` …)**: versions before 0.34 opened every tracker attachment as text. Update the app. From 0.34.1 a tab like that left by an older version opens as the document, and the file in your data is never written over.
- **A document shows a message instead of its pages**: "protected (DRM)": only the app it was bought for opens it. "damaged or is not what its name says": the file is broken, or a different format with that name (an old `.doc` renamed `.docx`, say). Either way **Its program** tries the app made for it.
- **A document looks plainer than in Word or LibreOffice**: this view shows its text, structure and pictures, not its fonts, colors or page layout. **Its program** shows all of it.
- **The menu bar appears (Windows, Linux)**: it shows when `Alt` is pressed and let go on its own, as in other Windows programs; press `Alt` again to hide it. Holding `Alt` for `Alt+drag` or a shortcut does not show it.
- **"The file changed on disk since you opened it"**: another program saved it. Use **Compare**, then reload or keep yours.
- **The capture shortcut "is used by another app"**: click the field and press another combination.
- **The screenshot is black (macOS)**: allow Tracker Editor under System Settings → Privacy & Security → Screen Recording, then restart it.
- **Paste in the edit bar or the line-number menu says the browser did not let it read the clipboard**: allow the clipboard for the site when the browser asks, or long-press in the text and choose **Paste**.
- **Dictation says to allow the microphone**: allow it for the site or app in the browser's settings. "Needs a connection": the speech service is online.
- **"This browser cannot read aloud" in the Android app**: versions before 0.27.0 had no voices there: update it. If it now says the phone has no text-to-speech engine, install **Speech Services by Google** from the Play Store (or choose another engine in Android's settings → Text-to-speech output). No voice in your language: add it in the engine's settings.
- **Full screen covers the status bar and its buttons can't be reached (Android app)**: fixed in 0.27.0; update it.
- **The voices in the list all look the same ("English (en)")**: versions before 0.28.0 showed only their language; update it. Now each shows its name and what it is.
- **A voice pauses before each sentence**: on-device AI voices (Kokoro in VoxSherpa) take a moment per sentence; from 0.28.0 the app prepares the next ones while one plays. If it still pauses, the phone makes speech slower than it plays: choose a Piper voice, or Kokoro on your computer as a speech server.
- **The speech server on my computer doesn't answer the phone**: in the Android app, use the computer's address on your network (`http://192.168.1.20:8880/v1`, not `localhost`, which is the phone), both on the same Wi-Fi, and the computer on. The web app in a phone's browser can only use a server with an https address.
- **Text from an image reads badly**: crop to the text, choose one language, or use a sharper photo.
- **Text from an image says it could not start**: close the dialog and try again; if it keeps saying so, restart the app (on Android, long-press its icon → **Send a log** if it still fails). Versions before 0.26.0 of the Android app stayed on "Starting…": update it.
- **No ✦ bubble**: connect a model in Settings → Model and check *Model button at the bottom right*.
- **The model's help answer says the guide does not cover it**: ask with other words (the names the editor uses: *split view*, *fold*, *server*), or open Help (`F1`) → **Guide** and search it.
- **"Claude did not accept the API key"**: copy it again from the Claude Console (it starts with `sk-ant-`), paste it in Settings → Model → AI provider and **Test and list models**. "Too many requests… or its spending limit": wait a minute, or raise the limit in the Console.
- **Can I sign in with my Claude Pro or Max subscription?** No: Anthropic allows it only in its own apps. Use **Ask in the Claude app**, or an API key (paid separately). See [Your Claude subscription](#your-claude-subscription).
- **Ask in the Claude app opened an empty chat**: the question was too long for a link; it is on the clipboard, paste it.
- **Pasting a file copied in Explorer or Finder pastes nothing (web app)**: the browser can't open files where they are. Use the desktop app, or drop the file on the window to add a copy to my files.
- **`Ctrl+=` zooms the whole window, or does nothing**: it changes the text's size in the editor (an older desktop version zoomed the window). In a browser, click into the text first. To zoom the whole window: **View → Zoom the Whole Window In**.
- **Compare with… doesn't list a file on disk**: type part of its name (files in the folders open in Folders show as you type), or use **Browse…**.
- **Two files show as different in a folder comparison, but the comparison below finds no changes**: their sizes differ in what you don't see, usually line endings (Windows' CRLF against LF) or a byte order mark. Copy one across to make them the same.
- **"More than 50,000 files and folders"** when comparing folders: compare a folder further down, or leave out `.git`, `node_modules` and the like (⋯ → **Include .git, node_modules…** unticked).
- **A folder comparison doesn't show a copy you made to a server yet**: copies to and from servers run in the background; the tree reads both sides again when they end (⟳ reads them now). The same goes for two panes.
- **F5 in two panes did nothing, or ran a file**: the keys go to the list in use; click a file in one of the two lists first. (Elsewhere, `F5` runs the open file.)
- **A folder says "That file was not opened here"**: it is a link to a place outside the folder you picked, or the folder was forgotten. Open that place with **Open another folder…**.
- **Dragging a tab out does nothing**: encrypted files are never written out (their tabs only move within the bar); use **Copy for Claude** or copy the text instead.
- **"A program or a script; the editor does not start those"**: open it from your file explorer (**Show in the file explorer**).
- **"A folder you picked cannot be changed here"**: the folders you picked are renamed, moved or deleted in your file explorer, then picked again.
- **A server says "did not accept the user name and password"**: check them in the server's settings (⋯ → Edit); a blank password field keeps the saved one.
- **"The server's key changed"**: if the server was not reinstalled, don't connect and ask its administrator. If it was, **Trust the new key** (or Edit → forget its key).
- **FTPS: "certificate is not trusted"**: for a server with its own certificate, turn on **Allow self-signed certificates** in its settings.
- **A pink tab says "Not connected"**: the server can't be reached; your edits are kept here. **Reconnect** when it's back.
- **"The server only accepts publickey"** (or another way): edit the server and choose a key file or the SSH agent.
- **"No SSH agent is running"**: on Windows start the *OpenSSH Authentication Agent* service (and `ssh-add` your key), or sign in with a key file.
- **"Box could not reach …"**: the jump host is connected but can't reach the server behind it; check that server's host and port as seen from the jump host.
- **`Ctrl+W` doesn't close the tab**: the terminal has the keys (it's the shell's "delete word"). Click into the editor first.
- **Typing goes to the other terminal** (two side by side): the keys go to the side in use, the one with its name underlined. Click into the side you want.
- **F5 says "No run command for …"**: add one for that type in **Settings → Editor → Run commands** (`rs: cargo run`). "Run works on files in a folder": open the file from Folders (a synced file has no folder to run in).
- **`python3` (or `node`…) is not found when running a file**: the terminal uses your usual shell and its PATH; install the program, or put its full path in **Run commands**.
- **The status bar says "Set up TypeScript…" but it is installed**: the editor looks on the PATH of your login shell and in the project's `node_modules`. For TypeScript it needs version 7 or later (`tsc --version`), or `typescript-language-server` with an older one. Install it for everyone (`npm install -g typescript`), then **It is installed: start it**.
- **A language server says nothing, or stopped**: click it in the status bar → **Show its messages**; **Restart** starts it again. For Python, open the project's folder (the one with `pyproject.toml`) so Pyright reads its settings there (`[tool.pyright]`, or a `pyrightconfig.json`, which also says which virtual environment to use).
- **"Set up Python…" for a file on a server, but it is installed there**: the editor looks on the server's login PATH and the usual folders (`~/.local/bin`, `~/.npm-global/bin`…). Check with `command -v pyright-langserver` in the server's terminal; a program in a folder of its own needs that folder on the PATH your `~/.profile` (or `~/.bashrc`) sets.
- **"The connection to Box closed. Restart … once it is connected again"**: the server's connection dropped; it starts by itself when the connection is back, or click **Restart** then.
- **Java says nothing, or "requires Java 25"**: current jdtls versions need Java 25 (`java -version`; `JAVA_HOME` wins over `java` on PATH). The first look at a big project takes a minute or two.
- **C#: "csharp-ls" will not install**: the newest csharp-ls wants the newest .NET SDK. With .NET 8, install an older one: `dotnet tool install --global csharp-ls --version 0.16.0`. Problems show once it has loaded the solution.
- **No grey suggestions**: turn on **Settings → Editor → Suggest the rest as you type**, connect a model in Settings → Model (a local one; a service that answers later can't), and type at the end of a line. Slow ones: pick a small code model as **Model for suggestions**.
- **A mirror says the folder is empty or missing**: one side looks wiped out (a drive not plugged in, a server folder moved), so nothing was changed. Fix it, or remove the mirror and set it up again.
- **A mirror waits with "deleted here: delete on the server too?"**: click **Review** and choose.

---

## 17. Where your data lives

- On this computer only (the default): the same files as below, in the data folder (`Documents/Tracker data`) or the browser's storage, kept as versions (not readable files); old versions go after 180 days.
- `editor/index.json` in your data repo lists the files (name, project, tags, language, who changed them when).
- `editor/files/<id>/<name>` holds each file's text, readable on github.com, except encrypted files, which start with `TRACKER-EDITOR-ENCRYPTED v1`.
- `editor/vault.json` holds the encryption salt and a check value, never the passphrase.
- Each device also keeps a full copy in the app's storage, so everything works offline.
- Settings, the GitHub token, the model's API keys (one per provider) and webhook secret stay on each device (the keychain on desktop; in the Android app encrypted with a key kept in the phone's secure hardware, and left out of Android's backups).
- Files opened from disk, from the Folders view or from a server stay where they are and are never synced. Mirrors (which folders, not your files) are listed in the app's folder on this computer, with what each side looked like at the last sync. Servers you set up (not their passwords) are listed in the app's own folder on this computer; passwords and key passphrases are in its keychain. The clipboard history stays on the computer, encrypted. Images for text recognition never leave the device, unless you choose your model to read them.
