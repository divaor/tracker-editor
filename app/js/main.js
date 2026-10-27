import { html, render } from '../vendor/preact-htm.js';
import { App } from './app.js';
import { requestPersistence } from './kv.js';
import { applyTheme, getSettings, onSettings } from './settings.js';
import { closeStore, flush, store } from './store.js';
import { startSync, stopSync } from './syncManager.js';
import { claimActiveTab } from './tabLock.js';
import { loadVault } from './vault.js';

const root = document.getElementById('root');
const applyFont = (s) => document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`);

function showInactive() {
  render(
    html`<div class="welcome">
      <div class="welcome-card">
        <h1>Open in another tab</h1>
        <p class="muted">Tracker Editor works in one tab at a time so your files are never saved over. It’s now open in a newer tab; your changes from here are saved.</p>
        <div class="welcome-actions"><button type="button" class="btn primary" onClick=${() => location.reload()}>Use it here</button></div>
      </div>
    </div>`,
    root,
  );
}

// A newer tab took over: hand over the latest text and stop for good.
async function stepDown({ saved }) {
  window.dispatchEvent(new Event('editor:flush'));
  await stopSync();
  await closeStore({ save: saved });
  render(null, root);
  showInactive();
}

try {
  applyTheme();
  applyFont(getSettings());
  onSettings((s) => {
    applyTheme(s.theme);
    applyFont(s);
  });
  if (await claimActiveTab(stepDown)) {
    await Promise.all([store.load(), loadVault()]);
    render(html`<${App} />`, root);
    startSync();
    requestPersistence();
    // Changes wait a moment before they are saved; save them right away when the app is hidden or closed.
    const saveNow = () => {
      window.dispatchEvent(new Event('editor:flush'));
      flush();
    };
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow());
    window.addEventListener('pagehide', saveNow);
  } else showInactive();
} catch (err) {
  console.error(err);
  root.textContent = `Tracker Editor could not start: ${err?.message ?? err}`;
  root.className = 'fatal';
}

const canUseServiceWorker = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
// The Android app carries its own files: a service worker's cache would keep old ones after an update.
if (window.desktop?.platform === 'android') navigator.serviceWorker?.getRegistrations?.().then((all) => all.forEach((r) => r.unregister()));
else if ('serviceWorker' in navigator && canUseServiceWorker) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
}
