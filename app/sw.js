// Offline support: precache the app shell and every CodeMirror language
// chunk (listed in vendor/cm/files.json), then serve network-first so updates
// show up immediately when online. GitHub and model requests are never intercepted.
const CACHE = 'editor-v0.1.0';
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
  'js/ai.js',
  'js/app.js',
  'js/editor.js',
  'js/format.js',
  'js/github.js',
  'js/kv.js',
  'js/llm.js',
  'js/main.js',
  'js/markdown.js',
  'js/model.js',
  'js/search.js',
  'js/semantic.js',
  'js/settings.js',
  'js/store.js',
  'js/sync.js',
  'js/syncManager.js',
  'js/tabLock.js',
  'js/theme-boot.js',
  'js/tracker-model.js',
  'js/ui/assistant.js',
  'js/ui/components.js',
  'js/ui/dialogs.js',
  'js/ui/icons.js',
  'js/ui/panels.js',
  'js/ui/preview.js',
  'js/ui/settingsView.js',
  'js/ui/sidebar.js',
  'js/ui/tabs.js',
  'js/version.js',
  'manifest.webmanifest',
  'vendor/marked.js',
  'vendor/preact-htm.js',
  'vendor/purify.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
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
