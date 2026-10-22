// User preferences (synchronous, localStorage) and the GitHub token (kept in
// the OS keychain via Electron's safeStorage on desktop, localStorage on web).
import { DEFAULT_LLM_URL } from './llm.js';

const KEY = 'editor.settings.v1';
const TOKEN_KEY = 'editor.token';

function defaultDevice() {
  const desktop = globalThis.window?.desktop;
  if (desktop) return `Desktop (${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[desktop.platform] ?? desktop.platform})`;
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/iPhone|Android.*Mobile/.test(ua)) return 'Phone';
  if (/iPad|Android/.test(ua)) return 'Tablet';
  return 'Browser';
}

export const PUBLIC_APP_URL = 'https://divaor.github.io/tracker-editor/';
export const TRACKER_APP_URL = 'https://divaor.github.io/tracking_app/';

export const DEFAULT_SETTINGS = {
  // Data repo (the same one the tracker syncs to) and the tracker's data file.
  owner: '',
  repo: '',
  branch: '',
  trackerPath: 'tracker.json',
  device: defaultDevice(),
  autoSync: true,
  // Appearance and editing.
  theme: 'system',
  fontSize: 14,
  tabSize: 4,
  // Untitled tabs get a name from their content (by the local model when it is on).
  autoName: true,
  // New files without a project or tags get them from the local model (when it is on).
  autoFile: true,
  // Phones wrap long lines; on a computer you scroll sideways like Notepad++.
  wordWrap: typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches,
  showWhitespace: false,
  lineNumbers: true,
  // Tabs gathered by project in the tab bar, each group foldable.
  groupTabs: false,
  // Project filter for the file list (see matchesScope in tracker-model.js).
  projectScope: [],
  // Where links to files point (the tracker opens these).
  appUrl: PUBLIC_APP_URL,
  trackerUrl: TRACKER_APP_URL,
  // Local model with an OpenAI-compatible API (Ollama, LM Studio, …).
  llm: { enabled: false, baseUrl: DEFAULT_LLM_URL, chatModel: '', embedModel: '', apiKey: '' },
  // Reading aloud: the device's voices (a voice URI, '' = the best one for the
  // text's language) or a speech server with an OpenAI-compatible API, and the speed.
  tts: {
    engine: 'device',
    voice: '',
    rate: 1,
    // otherVoices: voices for other languages, as "es=ef_dora, pt=pf_dora" (Kokoro voices speak one language each).
    server: { baseUrl: 'http://localhost:8880/v1', apiKey: '', model: 'kokoro', voice: 'af_heart', otherVoices: 'es=ef_dora, pt=pf_dora', instructions: '' },
  },
  // Settings migrations already applied on this device.
  version: 2,
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm },
    tts: { ...DEFAULT_SETTINGS.tts, ...saved.tts, server: { ...DEFAULT_SETTINGS.tts.server, ...saved.tts?.server } },
  };
  // Version 2: phones wrap long lines by default (earlier versions stored `false` for everyone).
  if ((saved.version ?? 1) < 2) settings = { ...settings, wordWrap: DEFAULT_SETTINGS.wordWrap || settings.wordWrap, version: 2 };
} catch {
  // keep defaults
}

const listeners = new Set();

export const getSettings = () => settings;

export function saveSettings(patch) {
  settings = {
    ...settings,
    ...patch,
    llm: { ...settings.llm, ...patch.llm },
    tts: { ...settings.tts, ...patch.tts, server: { ...settings.tts.server, ...patch.tts?.server } },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or blocked: settings stay in memory for this session
  }
  for (const fn of listeners) fn(settings);
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isSyncConfigured = (s = settings) => Boolean(s.owner && s.repo);

export function resolvedTheme(theme = settings.theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme = settings.theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

let tokenCache;

export async function getToken() {
  if (tokenCache !== undefined) return tokenCache;
  const secrets = globalThis.window?.desktop?.secrets;
  try {
    tokenCache = secrets ? ((await secrets.get('github-token')) ?? '') : (localStorage.getItem(TOKEN_KEY) ?? '');
  } catch {
    tokenCache = '';
  }
  return tokenCache;
}

export async function setToken(value) {
  const token = value.trim();
  const secrets = globalThis.window?.desktop?.secrets;
  if (secrets) await secrets.set('github-token', token);
  else if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  tokenCache = token;
}

/** The tracker's setup code ("tracker-setup:" + base64 JSON) works here too. */
export function parseSetupCode(code) {
  const raw = code.trim().replace(/^(tracker|editor)-setup:/, '');
  const binary = atob(raw.replace(/\s+/g, ''));
  const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object' || !data.owner || !data.repo) throw new Error('Not a setup code');
  return {
    owner: String(data.owner),
    repo: String(data.repo),
    branch: String(data.branch ?? ''),
    trackerPath: String(data.path ?? data.trackerPath ?? 'tracker.json'),
    token: typeof data.token === 'string' ? data.token : '',
  };
}
