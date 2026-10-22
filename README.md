# Tracker Editor

A Notepad++-style text editor for the notes, snippets, logs and code you paste somewhere and want to find again. Keep dozens of files open in tabs; everything is saved as you type and synced to your **private GitHub data repository**, so you can read it on your phone and your other computers.

It is the companion of [Tracker](https://github.com/divaor/tracking_app) and shares its data repository: the same **projects** (Work / Personal) and **tags**, items sent from the editor show up on the tracker, and the tracker opens files in the editor.

<img src="docs/editor.png" alt="Several files open on a desktop, with projects and tags in the sidebar" width="640"> <img src="docs/phone.png" alt="A Markdown file on a phone in dark mode" width="180">

## Features

- **Many files open at once**: tabs you can reorder, reopen closed tabs (`Ctrl+Shift+T`), untitled `new 1`, `new 2`… files like Notepad++. Your tabs and their text come back exactly as you left them, including untitled ones.
- **Nothing is lost**: pasted text and new tabs are saved to disk immediately, and typing a moment after the last key. Every write waits until it is on disk, so a crash or a power cut keeps your work. The data repo then holds a copy too, synced a few seconds later.
- **Named from their content**: an untitled tab you paste or write into gets a name that says what it is, from the local model when one is connected (for example `Deploy runbook.md`), otherwise from a heading on its first line. Undo keeps "new 1".
- **Synced through GitHub**: every device keeps a full local copy and works offline. Changes are committed to `editor/` in your data repo, a batch at a time. If two devices edit the same file, nothing is lost: the other version is kept as a copy named after its device.
- **Projects and tags**: the tracker's projects and tags, the same Work / Personal filter, and new projects you create here appear in the tracker.
- **Tracker integration**:
  - **Send to tracker** turns a file into a task, idea or doc linked to it.
  - The tracker's documents (proposals, artifacts and other attached files) are listed with your files, under the name of their item. They are downloaded on each sync, so you can read them offline and find them with `Ctrl+P`, Find in files and the local model.
  - The tracker shows **Open in editor** on those items and **Edit in editor** on attached files; your edits are saved back to the tracker.
- **Search that knows where things are**:
  - `Ctrl+P` opens a file by (fuzzy) name or project.
  - `Ctrl+Shift+F` finds text in all files, the filtered ones or the open tabs, with case, whole-word and regex options.
- **A local model on your computer** (Ollama, LM Studio or any OpenAI-compatible server): summarize a file, ask questions about one or all of your files with sources, and **find by meaning** when you don't remember the words. Nothing leaves your machine.
- **Syntax highlighting** for 140+ languages, detected from the file name or the content of pasted text, or picked in the status bar.
- **Editing tools**: find and replace (with regex), go to line, multiple cursors, select next occurrence, comment lines, duplicate/delete/sort lines, remove duplicates, trim trailing spaces, upper/lower case, format JSON, word wrap, visible whitespace, bracket matching, code folding.
- **Preview**: a reading view next to the text (instead of it on phones):
  - Markdown, with clickable checklists
  - HTML pages, in a sandbox with scripts and links off
  - JSON and XML as trees you can fold, with the place of any syntax error
  - SVG as a picture
  - CSV and TSV as a table
- **Read aloud**: **Listen** (or `Alt+R`) reads the file from the cursor, or just the selection, and highlights the passage being read. You can pause, skip, change the speed and pick a voice.
  - It reads the way a person would: Markdown as prose, dates, abbreviations, `#7` and `v2` in words, asides and dashes as short pauses, and longer pauses after headings and paragraphs. Code blocks are skipped.
  - It uses your device's voices, picking the most natural one for the text's language (English, Spanish, Portuguese…).
  - For truly human-sounding voices, connect a speech server; see [5. Natural voices](#5-natural-voices-optional).
- **Share**: send a file by WhatsApp, Teams, email, Quick Share or any app on the phone (as text or as an attachment), or by email, WhatsApp or Teams on a computer. Copy the text, copy a link that opens it in the editor, or save a copy.
- **Share to the editor** (Android): in any app, **Share → Tracker Editor** saves the text or file as a new file that syncs like the rest. On a computer, Chrome and Edge can also open text files with the installed app.
- **Also**: light and dark theme, import files from disk (drag and drop works), save a copy to disk, keyboard shortcuts.

## How it fits together

```
  Work PC  (Electron) ─┐                                    ┌─  tracker.json      (items, projects; shared with the tracker)
  Home PC  (Electron) ─┼──▶  GitHub API  ──▶  private repo  ┼─  editor/index.json (file names, projects, tags)
  Phone    (web app)  ─┘                                    └─  editor/files/<id>/<name>   (the text)
```

The app code (this repo) and your data are kept apart. The editor uses the same data repository and token as the tracker.

---

## 1. Connect to your data repo

1. Set up the tracker first (see its README): a private data repository and a fine-grained token with **Contents: Read and write** on it.
2. In the tracker, open **Settings → Sync with GitHub → Copy setup code** (with the token).
3. In the editor, open **Settings**, paste the code into **Setup code**, press **Apply**, give the device a name and press **Save**.

## 2. Desktop (work PC, home PC)

Download the installer from the **Releases** page:

- **Windows**: an installer, plus a portable `.exe` that needs no admin rights
- **macOS**: a `.dmg`
- **Linux**: an `AppImage`

The builds are not code-signed, so the first launch shows a warning (Windows: *More info → Run anyway*; macOS: right-click → *Open*).

Installing the desktop app also registers `tracker-editor://` links, so the tracker's desktop app opens files straight in it. Without it, links open the web version.

To publish a release, run **Actions → Release desktop app → Run workflow** with a tag such as `v0.1.0` (it must match `package.json`), or push the tag.

## 3. Phone

1. In this repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. The *Deploy web app to GitHub Pages* workflow publishes `app/` on every push to `main`.
2. On your phone, open `https://divaor.github.io/tracker-editor/` and install it (iPhone: Share → **Add to Home Screen**; Android: ⋮ → **Install app**).
3. Connect it with the setup code as in step 1.
4. To send text or files from other apps to the editor, use their **Share** button and pick **Tracker Editor**. If it isn't in the list, remove the app from your home screen and install it again: Android only reads the list of what an app accepts when it is installed.

The tracker's **Open in editor** links point at this address. If you host the editor elsewhere, set the address in the tracker under **Settings → Tracker Editor**, and in the editor under **Settings → This device → Links to files**.

## 4. Local model (optional, desktop)

1. Install [Ollama](https://ollama.com) and start it.
2. Pull a chat model and an embedding model:
   ```sh
   ollama pull llama3.2
   ollama pull nomic-embed-text
   ```
3. In the editor, open **Settings → Local model**, press **Ollama**, then **Test and list models**, pick the two models and press **Save and turn on**.
4. Open the assistant with the ✦ button or `Ctrl+Shift+A`:
   - **Ask**: questions about this file, the filtered files or all files, answered with links to the passages it used.
   - **Find by meaning**: the passages closest in meaning to what you type.
   - **Summarize**: a summary of the open file.

The desktop app talks to the model through its main process, so no extra setup is needed. In the browser, Ollama must allow the site's origin: set `OLLAMA_ORIGINS=https://divaor.github.io` and restart Ollama. LM Studio works too (its server runs on `http://localhost:1234/v1`).

Finding by meaning keeps an index of your files on the device and only re-reads files that changed.

## 5. Natural voices (optional)

Device voices range from robotic to good, depending on the device; **Settings → Read aloud** explains how to install better ones. For voices that sound like a person reading, use a speech server with an OpenAI-compatible API (`/v1/audio/speech`). Its audio plays like music: with controls on the lock screen, and it keeps reading with the screen off.

- **Kokoro on your computer** (free, private): install Docker and run
  ```sh
  docker run -d -p 8880:8880 --restart unless-stopped ghcr.io/remsky/kokoro-fastapi-cpu:latest
  ```
  In **Settings → Read aloud → Speech server**, press **Kokoro (this computer)**, then **Save** and **Hear a sample**. Voices: `af_heart`, `af_bella`, `am_michael`, `bf_emma`… for English, `ef_dora` for Spanish and `pf_dora` for Portuguese. Under *Voices for other languages*, list one per language (`es=ef_dora, pt=pf_dora`) and each file is read in its own language.
- **OpenAI** (paid, works on the phone too): press **OpenAI**, paste an API key, and describe the reading style you like. `gpt-4o-mini-tts` follows it, for example "a warm audiobook narrator with natural pauses".

A server at `localhost` is only reachable from the computer it runs on; on a phone, use one with an `https` address.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Alt+N` (desktop: `Ctrl+N`) | New file |
| `Ctrl+P` | Open a file by name |
| `Ctrl+Shift+F` | Find in files |
| `Ctrl+F` / `Ctrl+H` | Find / replace in this file |
| `Ctrl+G` | Go to line |
| `Ctrl+D` | Select the next occurrence |
| `Ctrl+/` | Comment lines |
| `Alt+Z` | Word wrap |
| `Alt+R` | Read aloud, pause or resume |
| `Ctrl+B` | Show or hide the file list |
| `Ctrl+Shift+A` | Local model |
| `Ctrl+S` | Sync now |
| `Ctrl+W` / `Ctrl+Shift+T` | Close tab / reopen it (desktop) |

## Data format

`editor/index.json` lists the files; the text of each file is stored next to it under `editor/files/<id>/<name>`, so you can also read your files on github.com.

```json
{
  "app": "tracker-editor",
  "schema": 1,
  "updatedAt": "2026-10-21T09:15:00.000Z",
  "files": [
    {
      "id": "mgx1k2-4f9c0a7b1e2d3c4f",
      "name": "deploy-notes.md",
      "project": "Platform",
      "tags": ["GlobalAPI"],
      "language": "",
      "sha": "…",
      "size": 812,
      "modifiedAt": "…",
      "modifiedBy": "Work PC",
      "createdAt": "…",
      "updatedAt": "…",
      "updatedBy": "Work PC"
    }
  ]
}
```

- Names, projects and tags merge per file: the most recent change wins (`updatedAt`).
- Text changes are tracked by the blob `sha`. When two devices changed the same file, the one syncing second keeps its version and the other is saved as a copy.
- Deleted files are kept as small `{ "id", "deleted": true, … }` records for 180 days, so the deletion reaches every device.

## Development

```sh
npm install
npm test          # unit tests (node:test): sync engine, search, local model client
npm run web       # serve the web app at http://localhost:8080
npm start         # run the desktop app
npm run vendor    # re-bundle CodeMirror and copy Preact/htm, marked, DOMPurify into app/vendor/
```

The web app is plain ES modules with no build step. CodeMirror 6 and its languages are bundled once by `npm run vendor` (esbuild, one chunk per language) into `app/vendor/cm/`.

```
app/                  the web app (also loaded by Electron)
  js/model.js         file records, merge rules, paths in the data repo
  js/sync.js          one sync round with the Git Data API (one commit per round, conflict copies)
  js/github.js        GitHub client (Contents and Git Data APIs)
  js/tracker-model.js copy of the tracker's model.js, for tracker.json
  js/store.js         local store (IndexedDB): files, text, open tabs
  js/editor.js        CodeMirror setup, one editor state per tab
  js/search.js        find in files, quick open
  js/llm.js, ai.js, semantic.js   local model client, prompts, the meaning index
  js/ui/              tabs, sidebar, panels, dialogs, assistant, settings
  sw.js               offline cache
electron/             main process + preload (app:// protocol, keychain, model proxy, tracker-editor:// links)
scripts/              vendor bundling, icon rendering, local web server
test/                 unit tests
.github/workflows/    CI, GitHub Pages deploy, desktop release builds
```

## Security notes

- **Token storage**: the desktop app encrypts the token with your operating system's keychain (Electron `safeStorage`); the web app keeps it in that browser's local storage. Use a fine-grained token limited to the data repo.
- **Markdown preview** is sanitized with DOMPurify, and the page runs under a strict Content Security Policy.
- **Desktop app**: the window is sandboxed with context isolation; the model proxy only accepts `http(s)` requests, and outside links open in your default browser.
- **One tab at a time**: in a browser, the editor runs in one tab; opening it again (for example from a tracker link) moves it to the new tab, so two tabs never save over each other.
