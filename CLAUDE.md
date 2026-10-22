# Tracker Editor — notes for Claude

A Notepad++-style editor whose files sync through the same private GitHub data repo as Tracker (github.com/divaor/tracking_app). Electron on desktop, PWA on mobile.

## Commands

- `npm test` runs the unit tests (`node:test`, no browser needed). Run it before committing.
- `npm run web` serves `app/` at http://localhost:8080.
- `npm start` launches the Electron app. As root/in containers: `npx electron --no-sandbox .`
- `npm run vendor` re-bundles CodeMirror (from `vendor-src/codemirror.js`, esbuild with code splitting) into `app/vendor/cm/` and copies Preact/htm, marked, DOMPurify and tesseract.js (with its core and the eng/spa models, into `app/vendor/ocr/`). Run it after upgrading any of them, and commit the output.

## Architecture

- `app/` is a no-build ES-module web app. GitHub Pages serves it directly and Electron loads it via the `app://editor` protocol (`electron/main.cjs`). Root `package.json` is `"type": "module"`, so Electron files are `.cjs`.
- Pure modules (no DOM, imported by the Node tests): `model.js`, `sync.js`, `github.js`, `search.js`, `ai.js`, `llm.js`, `asyncLlm.js`, `tracker-model.js`, `format.js`, `versions.js`, `crypto.js`, `naming.js`, `typing.js`, `previews.js`, `speech.js`, `selectionAsk.js`, `snippets.js`, `outline.js`, `logtools.js`, `checklist.js`, `capture.js`, `ocr.js`, `dictation.js`. The `.cjs` helpers `electron/diskFiles.cjs` and `electron/clipHistory.cjs` are tested too.
- Data repo layout:
  - `editor/index.json` lists file records; the text of each is in `editor/files/<id>/<safeName(name)>`.
  - `tracker.json` belongs to the tracker. The editor reads its projects and items, and writes it only for queued tracker ops (new projects, "Send to tracker") and for the sha of a tracker attachment edited here.
- `tracker-model.js` is a verbatim copy of the tracker's `app/js/model.js`. Refresh it when the tracker changes `tracker.json`'s format; never edit it here.
- Sync (`sync.js`) is one Git Data API commit per round:
  - File metadata merges last-write-wins on `updatedAt`. Text is tracked by blob `sha` (computed locally with `gitBlobSha`) against the `baseSha` the device last saw.
  - When both sides changed the text, ours stays and theirs is kept as a copy (`conflictName`). An edit to a file deleted elsewhere comes back as a new file.
  - A non-fast-forward branch update retries the round.
  - Deletions are tombstones, pruned after 180 days. Sync must never overwrite an index or `tracker.json` it cannot parse.
  - `encode`/`decode` hooks get the merged record: `syncManager` passes `vault.js`'s `encodeFor`/`decodeFor`, so encrypted files are stored as ciphertext. Copies made for conflicts keep `encrypted`.
- `store.js` keeps files, texts and the tab session in IndexedDB (`kv.js`) with debounced writes. `applySynced` must keep edits made while a sync was running.
  - Session: `open`, `active`, `closed`, `pinned` (always first in `open`), `side` (the split view's second pane, never `active`) and `collapsed` (folded project groups). `tidySession` keeps those rules.
  - Trash: a deleted file's text is kept in kv as `trash:<id>` (ids in `trashIds`) until its tombstone is pruned; `store.trash()` lists what can come back, the rest is fetched by blob sha.
  - Sealed texts: an encrypted file this device cannot read keeps only its ciphertext (`sealed`, kv `text:<id>` starting with the mark). `store.text()` is '' for it and it cannot be edited.
- Tracker documents: `store.docs()` lists the tracker's attached files from the last sync (`trackerDocs` in `model.js`).
  - Their texts are cached by blob sha (`docTexts`). `syncManager.downloadDocs` fetches missing ones after each sync.
  - Search, quick open and the model index address them as `r:<path>`; `actions.openFile` opens either kind.
- Previews: `previews.js` (pure) decides the kind (`previewKind`) and parses CSV and JSON errors; `ui/preview.js` renders them. HTML goes in a `sandbox=""` srcdoc frame (scripts off; the CSP is inherited anyway).
- Read aloud:
  - `speech.js` (pure) splits text into passages ({ from, to, text, kind, pause }), rewrites it for speech (`naturalize`: dates, abbreviations, asides; word lists for en/es/pt) and ranks voices.
  - `reader.js` speaks one passage at a time with one of two engines:
    - `device`: `speechSynthesis`. Pause cancels and restarts the passage, which works on Android too; a wake lock keeps the screen on.
    - `server`: an OpenAI-compatible `/audio/speech` endpoint. It plays audio, fetches the next passages ahead, sets Media Session metadata and handlers, and uses `localFetch` (the main process on desktop).
  - Highlighting goes through `editor.highlightReading`.
- Sharing to the app: the manifest's `share_target` posts to `share-target`. `sw.js` keeps the items in the `editor-inbox` cache, and `inbox.js` hands them to the app. `file_handlers` with `launchQueue` covers desktop Chrome and Edge.
- Saving:
  - Typing is saved 250 ms after the last key (editor debounce plus store debounce).
  - Pastes, drops and new tabs are saved at once: the editor passes `{ urgent }` and the store saves with ms 0.
  - `kv.js` writes with `durability: 'strict'` and `tx.commit()`.
  - `main.js` flushes pending saves on `pagehide` and when the app is hidden.
  - The Electron crash test kills the app 150 ms after a paste; keep it passing.
- `naming.js` (pure) names untitled tabs (`new N`) from their content: the model's reply via `cleanModelName`, or `nameFromHeading`. With the model it also files new notes: `filingMessages` asks for JSON `{ name, project, tags }`, `parseFiling` keeps only existing projects (their spelling) and at most 3 tags. `app.js` runs it a moment after text changes, once per new file, filling only empty fields, with Undo.
- History and compare: `versions.js` lists a file's versions from the commits API (`path` = the file's folder, which follows renames) and loads one. `editor.createCompareView` is `@codemirror/merge` (side by side, unified on phones); `ui/compare.js` takes the editor's place, `ui/history.js` is the panel.
- Encryption: `crypto.js` (pure, WebCrypto): PBKDF2-SHA256 → AES-GCM; sealed text is `TRACKER-EDITOR-ENCRYPTED v1` then base64(iv + ciphertext). The tracker's connector checks that first line, so keep it. `vault.js`: `editor/vault.json`, the non-extractable key in kv, and a per-file cache so unchanged text keeps its ciphertext (and blob sha).
- Typing into another window (desktop): `typing.js` prepares the text, `electron/typer.cjs` presses the keys (Windows: PowerShell + C# SendInput with scan codes, never into this window, stops on a focus change or Escape; macOS: osascript; Linux: xdotool with a UTF-8 locale, or wtype). IPC `type:start` / `type:stop` / `type:progress`.
- `ui/share.js`: Web Share (as text or file) where available, otherwise and also email/WhatsApp links (long text goes to the clipboard), Teams (copy and open), copy text/link, save.
- Effects that must win races with fast input are layout effects: creating and switching the editor tab, and Escape handlers in Modal and QuickOpen.
- `tabLock.js`: only one browser tab runs the app (Web Locks + BroadcastChannel). A new tab takes over, and the old one flushes, stops syncing and shows "Use it here".
- `editor.js`: one CodeMirror `EditorView`, with an `EditorState` per tab, plus a second view for the split view's side pane (`openSide`/`closeSide`). A tab's state lives in one view at a time and moves with its undo history; commands and reading aloud use the pane typed in last. Languages load lazily from `@codemirror/language-data`.
- `ui/menu.js`: `Menu` (fixed position, so bars that scroll sideways do not clip it) and `MenuButton`; the file bar's More menu and the tab context menu use them.
- The model panel (`ui/askSelection.js`: `AssistPanel`, opened by `AssistBubble` or Ctrl+K; setting `assistBubble`): `selectionAsk.js` lists the actions by group; kind `answer` replies in the panel (follow-ups resend the earlier turns), kind `replace` opens `actions.proposeReplacement` (compare, Accept / As a new file / Copy). `param` actions ask for a value that fills `{param}` (`withParam`). The context is the selection of the pane typed in last, or the whole file (`actions.assistContext`).
- Tab kinds: `f:<id>` (editor files), `r:<path>` (tracker documents), `d:<path>` (files on disk, desktop). Disk tabs:
  - `store.diskTabs` (never synced; only unsaved text is persisted, the rest is read again, `stale`). Changes emit `'disk'`, not `'local'`, so they do not start a sync.
  - `diskTabs.js` saves (refusing when the mtime moved, unless forced), reloads, and follows appends (`readAppended`, a shorter file reloads). Read-only while following or for the tail of a huge file (`editor.setReadOnly`).
  - `electron/diskFiles.cjs` decodes (BOM, CRLF, UTF-8 or latin1) and encodes back. `main.cjs` keeps an allowlist of picked paths (`disk-files.json`) and polls watched files (`fs.watchFile`, `disk:changed`).
- Desktop extras in `main.cjs`, set in Settings → Desktop through `prefs:get`/`prefs:set` (kept in `prefs.json`, applied by `applyPrefs`):
  - Tray: hiding instead of quitting when `background` is on. `quitting` lets Quit pass through the flush on close.
  - Global shortcuts (`registerShortcuts`): quick capture and text from a screenshot, each with a status (`ok`, `taken`, `invalid`, `off`).
  - Quick capture: `capture.html` + `capturePreload.cjs`, a separate page (it must not load the app: tab lock). Captures go through `captures.json` until the main window takes them (`capture:take`), as a new file (not opened) or appended to `Inbox.md` (`capture.js`).
  - Clipboard history: polls `clipboard.readText()` (Electron 44's clipboard API is async), skips concealed formats (`clipHistory.cjs`), stores `clipboard-history.bin` encrypted with `safeStorage` (memory only without it) and deletes it when turned off.
  - Screenshots: `desktopCapturer` of the display under the pointer (this window hidden first), shown in `snip.html` + `snipPreload.cjs`; the picked rectangle comes back as a PNG (`ocr:snip`).
- Text from images: `ocrEngine.js` lazy-loads tesseract.js from `vendor/ocr/` (worker, SIMD LSTM core and the eng/spa models, all same-origin; `workerBlobURL: false`) and keeps one worker. Small images are enlarged first (`ocrScale`). `ui/ocr.js` shows the result to correct. Entry points: pasting or dropping an image in the editor (`onImage`), dropping on the window or sharing (`importFiles`), the ⋯ menu, and screenshots.
- Voice notes: `ui/dictation.js` (Web Speech API, restarted after pauses; phrase by phrase on Android, which repeats results in continuous mode) inserts through `joinDictated` (`dictation.js`: spacing, capitals, spoken line breaks). Not in the desktop app, which has no speech service. `#/voice` and `#/new` are the manifest's home screen shortcuts.
- Local model:
  - `llm.js` is an OpenAI-compatible client (`/models`, streamed `/chat/completions`, `/embeddings`).
  - On desktop, requests go through the main process (`llm:request` / `llm:chunk` IPC), so they avoid CORS. In the browser they go directly.
  - `semantic.js` keeps the embeddings index in IndexedDB and re-embeds only changed files. `llmClient()` returns the async client when `llm.provider` is `'async'`.
  - `asyncLlm.js`: services that answer later, described by a JSON profile (submit/status templates with `{{placeholders}}`, response paths). Keep it generic: nothing about a particular service in the repo. `asyncConnection.js` adds the API key (secret `llm-api-key`) and, on desktop, the webhook receiver (`webhook:listen`, HMAC with secret `llm-webhook-secret`).
  - Main-process requests use `net.fetch` (system certificates and proxy).
- Links:
  - `#/file/<id>` opens one of the editor's files; `#/repo/<path>` opens any text file in the data repo (tracker attachments).
  - The desktop app registers `tracker-editor://file/<id>` and `tracker-editor://repo/<path>`.
  - The tracker builds these links in its `app/js/editorLinks.js`; keep both sides in step.
- The token is read and written through `settings.js` (`getToken`/`setToken`): Electron `safeStorage` via the preload bridge on desktop (secret `github-token`), `localStorage` on web. Other secrets go through `getSecret`/`setSecret` (`SECRET_NAMES`, and `SECRET_KEYS` in `main.cjs`).

## When changing things

- Adding or removing a file under `app/` → update `ASSETS` in `app/sw.js` (CodeMirror chunks are listed in `vendor/cm/files.json` instead, and text recognition in `vendor/ocr/files.json`, cached when first used). `test/app.test.js` enforces this.
- Bumping the version → update `package.json`, `app/js/version.js` and the `CACHE` name in `app/sw.js`. The tests check that they match.
- The manifest `id` is `/tracker-editor/`. Ids resolve against the origin, and the tracker on the same origin (divaor.github.io) owns the origin root. Never change it: a new id makes installed copies a different app.
- The CSP in `app/index.html` allows only same-origin scripts. Fetches may go to any https origin and to `localhost` (the model and speech servers); `media-src` allows `blob:` for speech audio.
  - Do not add inline scripts.
- Browser tests (Playwright) need `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1` in this sandbox so `localhost` is not sent through the proxy. Electron tests need `xvfb-run`; typing into another window needs `xdotool` (`apt-get install xdotool`).
  - Playwright's key presses do not reach Electron menu accelerators: click the menu item through `Menu.getApplicationMenu()` instead.
  - Without a keyring, `safeStorage` is unavailable under xvfb, so the clipboard history stays in memory there.
