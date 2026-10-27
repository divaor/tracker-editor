// Text and files shared to the editor from other apps. Android's Share menu
// posts them to the service worker (share_target in the manifest), which keeps
// them in a cache until the app takes them; desktop Chrome and Edge hand over
// files opened with the installed app through the launch queue. In the Android
// app, its native side hands them over (androidApp.js `shared`).
export const INBOX = 'editor-inbox';

let taking = Promise.resolve([]);

async function takeOnce() {
  const shared = (await globalThis.window?.desktop?.shared?.take?.().catch(() => [])) ?? [];
  if (typeof caches === 'undefined') return shared;
  const inbox = await caches.open(INBOX);
  for (const request of await inbox.keys()) {
    if (!request.url.endsWith('.json')) continue;
    const meta = await (await inbox.match(request)).json();
    const files = [];
    for (const f of meta.files ?? []) {
      const response = await inbox.match(f.key);
      if (response) files.push(new File([await response.blob()], f.name, { type: f.type }));
      await inbox.delete(f.key);
    }
    await inbox.delete(request);
    shared.push({ title: meta.title ?? '', text: meta.text ?? '', url: meta.url ?? '', files });
  }
  return shared;
}

/** Everything waiting in the inbox, once: [{ title, text, url, files: [File] }]. */
export function takeShared() {
  taking = taking.then(takeOnce, takeOnce);
  return taking;
}

/** Calls `onFiles(files)` with files opened with the installed app (desktop Chrome and Edge). */
export function onLaunchFiles(onFiles) {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async ({ files = [] }) => {
    const opened = await Promise.all(files.map((handle) => handle.getFile()));
    if (opened.length) onFiles(opened);
  });
}
