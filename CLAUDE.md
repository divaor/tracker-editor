# Tracker Editor — notes for Claude

A Notepad++-style editor whose files sync through the same private GitHub data repo as Tracker (github.com/divaor/tracking_app). Electron on desktop, PWA on mobile.

## Commands

- `npm test` runs the unit tests (`node:test`, no browser needed). Run it before committing.
- `npm run web` serves `app/` at http://localhost:8080.
- `npm start` launches the Electron app. As root/in containers: `npx electron --no-sandbox .`
- `npm run vendor` re-bundles CodeMirror (from `vendor-src/codemirror.js`, esbuild with code splitting) into `app/vendor/cm/` and copies Preact/htm, marked and DOMPurify. Run it after upgrading any of them, and commit the output.

## Architecture

- `app/` is a no-build ES-module web app. GitHub Pages serves it directly and Electron loads it via the `app://editor` protocol (`electron/main.cjs`). Root `package.json` is `"type": "module"`, so Electron files are `.cjs`.
- Pure modules (no DOM, imported by the Node tests): `model.js`, `sync.js`, `github.js`, `search.js`, `ai.js`, `llm.js`, `tracker-model.js`, `format.js`.
- Data repo layout:
  - `editor/index.json` lists file records; the text of each is in `editor/files/<id>/<safeName(name)>`.
  - `tracker.json` belongs to the tracker. The editor reads its projects and items, and writes it only for queued tracker ops (new projects, "Send to tracker") and for the sha of a tracker attachment edited here.
- `tracker-model.js` is a verbatim copy of the tracker's `app/js/model.js`. Refresh it when the tracker changes `tracker.json`'s format; never edit it here.
- Sync (`sync.js`) is one Git Data API commit per round:
  - File metadata merges last-write-wins on `updatedAt`. Text is tracked by blob `sha` (computed locally with `gitBlobSha`) against the `baseSha` the device last saw.
  - When both sides changed the text, ours stays and theirs is kept as a copy (`conflictName`). An edit to a file deleted elsewhere comes back as a new file.
  - A non-fast-forward branch update retries the round.
  - Deletions are tombstones, pruned after 180 days. Sync must never overwrite an index or `tracker.json` it cannot parse.
- `store.js` keeps files, texts and the tab session in IndexedDB (`kv.js`) with debounced writes. `applySynced` must keep edits made while a sync was running.
- `tabLock.js`: only one browser tab runs the app (Web Locks + BroadcastChannel). A new tab takes over, and the old one flushes, stops syncing and shows "Use it here".
- `editor.js`: one CodeMirror `EditorView`, with an `EditorState` per tab. Languages load lazily from `@codemirror/language-data`.
- Local model:
  - `llm.js` is an OpenAI-compatible client (`/models`, streamed `/chat/completions`, `/embeddings`).
  - On desktop, requests go through the main process (`llm:request` / `llm:chunk` IPC), so they avoid CORS. In the browser they go directly.
  - `semantic.js` keeps the embeddings index in IndexedDB and re-embeds only changed files.
- Links:
  - `#/file/<id>` opens one of the editor's files; `#/repo/<path>` opens any text file in the data repo (tracker attachments).
  - The desktop app registers `tracker-editor://file/<id>` and `tracker-editor://repo/<path>`.
  - The tracker builds these links in its `app/js/editorLinks.js`; keep both sides in step.
- The token is read and written through `settings.js` (`getToken`/`setToken`): Electron `safeStorage` via the preload bridge on desktop (secret `github-token`), `localStorage` on web.

## When changing things

- Adding or removing a file under `app/` → update `ASSETS` in `app/sw.js` (CodeMirror chunks are listed in `vendor/cm/files.json` instead). `test/app.test.js` enforces this.
- Bumping the version → update `package.json`, `app/js/version.js` and the `CACHE` name in `app/sw.js`. The tests check that they match.
- The CSP in `app/index.html` allows only same-origin scripts. Fetches may go to any https origin and to `localhost` (the model server).
  - Do not add inline scripts.
- Browser tests (Playwright) need `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1` in this sandbox so `localhost` is not sent through the proxy. Electron tests need `xvfb-run`.
