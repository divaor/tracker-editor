// Terminals tabs (0.54): tabs of their own holding one or more terminals, full size (ui/terminalsTab.js).
// Each is a comparison tab of mode 'terminals' (the store's c:<id>, its record terminalSessions.js
// describes) and its own host in terminals.js. Its terminals start the first time it shows in a
// run, as its record says (restorePlan): this computer's in their folders with their shells and
// names, their output from before shown above "— Restored … —", servers' kept in tmux attached
// again, a login each was running (ssh typed into a shell here) offered again, or run again by
// itself when the session says so. From then on its record follows its terminals (their places,
// folders, names, order, split, logins), and their output is kept in kv (`terminalOutput:<id>`,
// the ids in `terminalOutputIds`) a few seconds after it changes and whenever the app goes away, unless
// setting `terminalKeepOutput` is false. Kept on this device only: never synced.
import { kvDelete, kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import { parseKey, store } from './store.js';
import { allTerminals, closeHost, nextEnd, onTerminals, setTerminalLayout, setTerminalOffer, terminalLayout, terminalOutput, terminals, typeInTerminal } from './terminals.js';
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES, restorePlan, tabRecordPatch } from './terminalSessions.js';

const OUTPUT_KEY = (id) => `terminalOutput:${id}`;
const INDEX_KEY = 'terminalOutputIds';
// How often the output is looked at: kept again only for terminals that wrote since (a crash loses at most this much).
const SAVE_EVERY_MS = 5_000;
// id → { ready (restored: its record follows its terminals now), done (the restore), saved (terminal key → its output counter when kept), outputs (terminal key → kept output) }
const started = new Map();
let syncTimer = null;
let saveTimer = null;

export const isTerminalsRecord = (c) => c?.mode === 'terminals';
/** The Terminals tabs open now: [{ id, record }], in the tab bar's order. */
export function openTerminalsTabs() {
  return store.session.open
    .map(parseKey)
    .filter((k) => k?.kind === 'compare' && isTerminalsRecord(store.compare(k.id)))
    .map((k) => ({ id: k.id, record: store.compare(k.id) }));
}
/** Whether a Terminals tab's terminals were started in this run. */
export const terminalsTabStarted = (id) => started.has(id);

/** The record follows the terminals of each tab restored (their places, folders, names, order, split). */
function syncRecords() {
  clearTimeout(syncTimer);
  syncTimer = null;
  for (const [id, entry] of started) {
    const c = store.compare(id);
    if (!entry.ready || !c) continue;
    const patch = tabRecordPatch(terminals(id), terminalLayout(id));
    if (JSON.stringify([c.terminals ?? [], c.layout ?? null]) === JSON.stringify([patch.terminals, patch.layout])) continue;
    store.updateCompare(id, patch, { silent: true });
  }
}
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  onTerminals(() => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncRecords, 500);
  });
  saveTimer = setInterval(() => saveTerminalsTabs().catch(() => {}), SAVE_EVERY_MS);
}

/**
 * Starts a Terminals tab's terminals as its record says (once per run; again after it was closed).
 * `open(connId, cwd, opts)` opens one (app.js's openTerminal, in the tab's host); `hasPlace(connId)`
 * says whether its place still exists; `note(output)` is the line under its old output. Resolves
 * with the plan (restorePlan's: `gone` are the terminals whose place is gone).
 */
export function startTerminalsTab(id, { open, hasPlace = () => true, note = () => '— Restored —' }) {
  wire();
  if (started.has(id)) return started.get(id).done;
  const entry = { ready: false, done: null, saved: new Map(), outputs: {} };
  started.set(id, entry);
  entry.done = (async () => {
    const keepOutput = getSettings().terminalKeepOutput !== false;
    const outputs = keepOutput ? ((await kvGet(OUTPUT_KEY(id)).catch(() => null)) ?? {}) : {};
    const openKeeps = allTerminals().map((s) => s.keep).filter(Boolean);
    const plan = restorePlan(store.compare(id) ?? {}, { hasPlace, outputs, keepOutput, openKeeps });
    const opened = await Promise.all(
      plan.terminals.map(async (t) => {
        const s = await open(t.connId, t.cwd, { host: id, key: t.id, name: t.name, ...(t.shell ? { shell: t.shell } : {}), keep: t.keep, restore: t.output ? { ...t.output, note: note(t.output) } : null, offer: t.offer });
        if (s && t.output) entry.outputs[s.key] = t.output;
        return s && [t, s];
      }),
    );
    setTerminalLayout(id, plan.layout);
    entry.ready = true;
    for (const [t, s] of opened.filter(Boolean)) if (t.autoRun) runOffer(s);
    syncRecords();
    return plan;
  })();
  return entry.done;
}

/**
 * Runs again the login a terminal brought back offers (typed into its shell, as you would): once
 * its shell's first prompt came when it says when (our integration), else at once.
 */
export async function runOffer(s) {
  const offer = s?.offer;
  if (!offer) return;
  setTerminalOffer(s, null);
  if (s.integrated && !s.prompted) await nextEnd(s, 8000);
  else if (!s.id) await new Promise((r) => setTimeout(r, 300));
  typeInTerminal(s, `${offer.line}\r`);
}

/** Keeps every restored tab's output that changed since it was last kept (all of it with `force`), and their records. */
export async function saveTerminalsTabs({ force = false } = {}) {
  syncRecords();
  if (getSettings().terminalKeepOutput === false) return;
  const writes = [];
  for (const [id, entry] of started) {
    if (!entry.ready || !store.compare(id)) continue;
    const list = terminals(id);
    const gone = Object.keys(entry.outputs).some((k) => !list.some((s) => s.key === k));
    if (!force && !gone && list.every((s) => entry.saved.get(s.key) === s.writes)) continue;
    const next = {};
    for (const s of list) {
      // tmux draws its own screen when it attaches again.
      if (s.tmux) continue;
      if (entry.saved.get(s.key) === s.writes && entry.outputs[s.key]) next[s.key] = entry.outputs[s.key];
      else {
        const out = terminalOutput(s, { lines: MAX_OUTPUT_LINES, chars: MAX_OUTPUT_CHARS });
        if (out) next[s.key] = { ...out, at: Date.now() };
      }
      entry.saved.set(s.key, s.writes);
    }
    entry.outputs = next;
    writes.push(kvSet(OUTPUT_KEY(id), next));
  }
  if (writes.length) writes.push(kvGet(INDEX_KEY).then((ids) => kvSet(INDEX_KEY, [...new Set([...(Array.isArray(ids) ? ids : []), ...started.keys()])])));
  await Promise.all(writes);
}

/**
 * A Terminals tab closed: its output and record kept as they are now (Ctrl+Shift+T brings it back,
 * as after a restart), then its terminals end (a server's tmux session too).
 */
export async function endTerminalsTab(id) {
  const entry = started.get(id);
  if (entry?.ready) await saveTerminalsTabs({ force: true }).catch(() => {});
  started.delete(id);
  closeHost(id);
}

/** Forgets the output kept for tabs whose record is gone (closed long ago), as the app starts. */
export async function pruneTerminalOutputs() {
  const ids = await kvGet(INDEX_KEY).catch(() => null);
  if (!Array.isArray(ids)) return;
  const kept = ids.filter((id) => isTerminalsRecord(store.compare(id)));
  await Promise.all(ids.filter((id) => !kept.includes(id)).map((id) => kvDelete(OUTPUT_KEY(id))));
  if (kept.length !== ids.length) await kvSet(INDEX_KEY, kept);
}

/** Keeping output turned off: every kept output goes. */
export async function dropTerminalOutputs() {
  const ids = await kvGet(INDEX_KEY).catch(() => null);
  for (const entry of started.values()) entry.outputs = {};
  await Promise.all([...(Array.isArray(ids) ? ids : []).map((id) => kvDelete(OUTPUT_KEY(id))), kvDelete(INDEX_KEY)]);
}

/** For the tests and a page going away: no timers left. */
export function stopTerminalsTabs() {
  clearTimeout(syncTimer);
  clearInterval(saveTimer);
}
