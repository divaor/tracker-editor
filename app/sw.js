// Offline support: precache the app shell and every CodeMirror language
// chunk (listed in vendor/cm/files.json), then serve network-first so updates
// show up immediately when online. GitHub and model requests are never intercepted.
// Text recognition (vendor/ocr/, about 9 MB), the terminal (vendor/xterm/,
// desktop only) and the formatters (vendor/format/) are cached the first time they are used.
const CACHE = 'editor-v0.14.0';
const INBOX = 'editor-inbox'; // shared files waiting for the app (see js/inbox.js)
const ASSETS = [
  './',
  'css/styles.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/icon-maskable.svg',
  'icons/icon.svg',
  'index.html',
  'capture.html',
  'help/guide.md',
  'snip.html',
  'js/ai.js',
  'js/app.js',
  'js/asyncConnection.js',
  'js/asyncLlm.js',
  'js/checklist.js',
  'js/commands.js',
  'js/crypto.js',
  'js/editor.js',
  'js/format.js',
  'js/formatter.js',
  'js/github.js',
  'js/inbox.js',
  'js/kv.js',
  'js/llm.js',
  'js/localFetch.js',
  'js/claude.js',
  'js/providers.js',
  'js/logtools.js',
  'js/main.js',
  'js/markdown.js',
  'js/model.js',
  'js/naming.js',
  'js/outline.js',
  'js/codeNav.js',
  'js/problems.js',
  'js/indent.js',
  'js/ui/problems.js',
  'js/gitStatus.js',
  'js/gitGutter.js',
  'js/gitState.js',
  'js/replace.js',
  'js/ui/symbols.js',
  'js/emmet.js',
  'js/htmlTools.js',
  'js/completion.js',
  'js/inlineSuggest.js',
  'js/fileRefs.js',
  'js/runFile.js',
  'js/lsp.js',
  'js/lspTools.js',
  'js/ui/languageServers.js',
  'js/errorHelp.js',
  'js/ui/palette.js',
  'js/previews.js',
  'js/reader.js',
  'js/search.js',
  'js/searchPanel.js',
  'js/selectionAsk.js',
  'js/semantic.js',
  'js/settings.js',
  'js/snippets.js',
  'js/speech.js',
  'js/store.js',
  'js/sync.js',
  'js/syncManager.js',
  'js/tabLock.js',
  'js/theme-boot.js',
  'js/tracker-model.js',
  'js/versions.js',
  'js/ui/askSelection.js',
  'js/ui/assistant.js',
  'js/ui/compare.js',
  'js/ui/components.js',
  'js/ui/dialogs.js',
  'js/ui/encryption.js',
  'js/ui/filterBar.js',
  'js/ui/history.js',
  'js/ui/help.js',
  'js/ui/trash.js',
  'js/ui/typeOut.js',
  'js/ui/icons.js',
  'js/ui/macro.js',
  'js/ui/diskDialogs.js',
  'js/diskTabs.js',
  'js/capture.js',
  'js/capturePage.js',
  'js/snipPage.js',
  'js/ocr.js',
  'js/ocrEngine.js',
  'js/dictation.js',
  'js/dragOut.js',
  'js/where.js',
  'js/servers.js',
  'js/ui/servers.js',
  'js/folders.js',
  'js/folderIndex.js',
  'js/ui/folderPreview.js',
  'js/ui/folders.js',
  'js/ui/ocr.js',
  'js/ui/dictation.js',
  'js/ui/clipboardHistory.js',
  'js/ui/menu.js',
  'js/ui/outline.js',
  'js/ui/usages.js',
  'js/ui/panels.js',
  'js/ui/preview.js',
  'js/ui/readAloud.js',
  'js/ui/settingsView.js',
  'js/ui/share.js',
  'js/ui/snippets.js',
  'js/ui/splitter.js',
  'js/ui/sidebar.js',
  'js/ui/tabs.js',
  'js/typing.js',
  'js/vault.js',
  'js/version.js',
  'manifest.webmanifest',
  'vendor/anthropic.js',
  'vendor/marked.js',
  'vendor/preact-htm.js',
  'vendor/purify.js',
  'js/terminals.js',
  'js/ui/terminal.js',
  'js/ui/folderSearch.js',
  'js/ui/properties.js',
  'js/ui/mirrors.js',
  'js/mirrors.js',
  'js/transfers.js',
  'js/ui/transfers.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      try {
        const chunks = await (await fetch('vendor/cm/files.json', { cache: 'no-cache' })).json();
        await cache.addAll(chunks.map((f) => `vendor/cm/${f}`));
      } catch {
        // Languages are cached the first time they are used instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== INBOX).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Android's Share menu posts text and files here (share_target in the
// manifest); they wait in the inbox until the app opens and takes them.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const inbox = await caches.open(INBOX);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
    const at = (path) => new URL(path, self.registration.scope).href;
    const meta = {
      title: String(form.get('title') ?? ''),
      text: String(form.get('text') ?? ''),
      url: String(form.get('url') ?? ''),
      files: files.map((f, i) => ({ name: f.name || `shared-${i + 1}.txt`, type: f.type, key: at(`inbox/${id}/${i}`) })),
    };
    await Promise.all(files.map((f, i) => inbox.put(meta.files[i].key, new Response(f))));
    await inbox.put(at(`inbox/${id}.json`), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  } catch (err) {
    console.warn('Could not keep the shared items', err);
  }
  return Response.redirect(new URL('./#/inbox', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  // A navigate-mode Request cannot be re-fetched with an init object, so use its URL.
  const network = request.mode === 'navigate' ? fetch(request.url, { cache: 'no-cache' }) : fetch(request, { cache: 'no-cache' });
  event.respondWith(
    network
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }),
  );
});
