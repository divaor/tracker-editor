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
  // A frame around the editor in the color of where the file lives (my files, tracker, this computer, a server).
  whereFrame: true,
  // Project filter for the file list (see matchesScope in tracker-model.js).
  projectScope: [],
  // The sidebar (desktop): your files ('files'), or folders on this computer ('folders', not synced):
  // the folder shown, whether dot files are listed, and the order (folders.js FOLDER_SORTS).
  sidebarMode: 'files',
  folder: '',
  showHidden: false,
  folderSort: 'name',
  folderSortReverse: false,
  // 'list' (names, with size and age) or 'details' (columns: name, size, date, sortable by their headers).
  folderView: 'list',
  // Folders starred in the folders view, and the ones visited last (paths here or remote:// on servers).
  folderFavorites: [],
  folderRecent: [],
  // The preview under the list of files (on or off) and its height in pixels.
  folderPreview: false,
  folderPreviewHeight: 260,
  // Servers: permissions (rwxr-xr-x) next to each file in the folders view.
  showPermissions: false,
  // The terminal panel's height (desktop), in pixels.
  terminalHeight: 280,
  // Sizes dragged by hand: the sidebar's width in pixels (0 = the default), and the share of
  // the editor next to a preview or the side view.
  sidebarWidth: 0,
  splitRatio: 0.5,
  // Where links to files point (the tracker opens these).
  appUrl: PUBLIC_APP_URL,
  trackerUrl: TRACKER_APP_URL,
  // The model: a server with an OpenAI-compatible API (Ollama, LM Studio, …), or
  // provider 'async': a service that answers later (asyncLlm.js), described by
  // `profile` (JSON). Its API key and webhook secret are kept with getSecret.
  // `webhook` (desktop app): receive its answers on this port and address.
  llm: {
    enabled: false,
    provider: 'openai',
    baseUrl: DEFAULT_LLM_URL,
    chatModel: '',
    embedModel: '',
    // For text from images (a model that reads pictures); '' = the chat model.
    visionModel: '',
    apiKey: '',
    profile: '',
    webhook: { enabled: false, port: 8765, path: '/llm-webhook', publicUrl: '' },
  },
  // Reading aloud: the device's voices (a voice URI, '' = the best one for the
  // text's language) or a speech server with an OpenAI-compatible API, and the speed.
  tts: {
    engine: 'device',
    voice: '',
    rate: 1,
    // otherVoices: voices for other languages, as "es=ef_dora, pt=pf_dora" (Kokoro voices speak one language each).
    server: { baseUrl: 'http://localhost:8880/v1', apiKey: '', model: 'kokoro', voice: 'af_heart', otherVoices: 'es=ef_dora, pt=pf_dora', instructions: '' },
  },
  // Typing into another window (desktop app): seconds to switch windows, speed (typing.js), whether the
  // other editor indents new lines by itself, and whether to minimize this window meanwhile.
  // `unicode` (Windows): characters instead of key presses, for keyboard layouts that differ from the remote one.
  typing: { countdown: 5, speed: 'normal', autoIndent: false, minimize: false, unicode: false },
  // The round model button at the bottom right of the editor (when a model is connected).
  assistBubble: true,
  // Text from images: the languages to read (ocr.js OCR_LANGUAGES), and who reads them:
  // 'device' (on this device) or 'model' (the connected model, when it reads images).
  ocrLang: 'eng+spa',
  ocrEngine: 'device',
  // Dictation (voice notes): a BCP 47 language, '' = the device's.
  dictationLang: '',
  // Settings migrations already applied on this device.
  version: 2,
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...saved.llm, webhook: { ...DEFAULT_SETTINGS.llm.webhook, ...saved.llm?.webhook } },
    tts: { ...DEFAULT_SETTINGS.tts, ...saved.tts, server: { ...DEFAULT_SETTINGS.tts.server, ...saved.tts?.server } },
    typing: { ...DEFAULT_SETTINGS.typing, ...saved.typing },
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
    llm: { ...settings.llm, ...patch.llm, webhook: { ...settings.llm.webhook, ...patch.llm?.webhook } },
    tts: { ...settings.tts, ...patch.tts, server: { ...settings.tts.server, ...patch.tts?.server } },
    typing: { ...settings.typing, ...patch.typing },
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

// Other secrets (the model service's API key, its webhook secret): the
// keychain on desktop, this browser's storage on the web.
export const SECRET_NAMES = ['llm-api-key', 'llm-webhook-secret'];
const secretCache = new Map();

export async function getSecret(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  if (secretCache.has(name)) return secretCache.get(name);
  const secrets = globalThis.window?.desktop?.secrets;
  let value = '';
  try {
    value = secrets ? ((await secrets.get(name)) ?? '') : (localStorage.getItem(`${TOKEN_KEY}:${name}`) ?? '');
  } catch {
    value = '';
  }
  secretCache.set(name, value);
  return value;
}

export async function setSecret(name, value) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret ${name}`);
  const v = String(value ?? '').trim();
  const secrets = globalThis.window?.desktop?.secrets;
  if (secrets) await secrets.set(name, v);
  else if (v) localStorage.setItem(`${TOKEN_KEY}:${name}`, v);
  else localStorage.removeItem(`${TOKEN_KEY}:${name}`);
  secretCache.set(name, v);
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
