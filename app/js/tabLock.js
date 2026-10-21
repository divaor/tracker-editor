// Tracker Editor runs in one browser tab at a time: tabs share the files saved
// on this device, and two would save over each other's unsynced edits. A newly
// opened tab (a file link from the tracker, say) takes over; the older one
// saves, stops syncing and offers to take over again.
const NAME = 'tracker-editor-active';
// An older tab that does not answer (frozen in the background) loses the lock.
const STEAL_AFTER = 4000;

/**
 * Resolves true once this is the active tab, or false if an even newer tab
 * took over while this one was waiting. Later, when a newer tab takes over,
 * stepDown({ saved }) runs: `saved` is false when the lock was taken without
 * asking, and the tab must then stop writing without saving.
 */
export function claimActiveTab(stepDown) {
  if (!navigator.locks || typeof BroadcastChannel !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(NAME);
    const queued = new AbortController();
    let state = 'waiting'; // → 'active' → 'done'
    let stealing = false;
    let release = () => {};
    let timer = null;

    const finish = (result) => {
      state = 'done';
      clearTimeout(timer);
      channel.close();
      resolve(result);
    };
    const leave = async (saved) => {
      if (state !== 'active') return;
      state = 'done';
      channel.close();
      try {
        await stepDown({ saved });
      } finally {
        release();
      }
    };
    const granted = () => {
      if (state !== 'waiting') return undefined;
      state = 'active';
      clearTimeout(timer);
      resolve(true);
      return new Promise((r) => (release = r));
    };
    const lost = () => state === 'active' && leave(false);

    channel.onmessage = (e) => {
      if (e.data !== 'take-over') return;
      if (state === 'active') leave(true);
      else if (state === 'waiting' && !stealing) queued.abort();
    };
    channel.postMessage('take-over');
    navigator.locks.request(NAME, { signal: queued.signal }, granted).catch(() => {
      if (state === 'waiting' && !stealing) finish(false);
      else lost();
    });
    timer = setTimeout(() => {
      if (state !== 'waiting') return;
      stealing = true;
      queued.abort();
      navigator.locks.request(NAME, { steal: true }, granted).catch(lost);
    }, STEAL_AFTER);
  });
}
