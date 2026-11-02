// Where a tab's file lives, at a glance: in my files (synced), a tracker
// document, on this computer, or on a server. Each kind has a color (the CSS
// --kind-* variables), an icon, and a state: synced, not synced yet, saved,
// not saved, changed elsewhere, not connected… Pure, so the tests import it.

export const REMOTE_SCHEME = 'remote://';
export const isRemotePath = (p) => typeof p === 'string' && p.startsWith(REMOTE_SCHEME);
/** A file another Android app gave (Open with, the file picker): edited through its content:// address. */
export const isContentPath = (p) => typeof p === 'string' && p.startsWith('content://');

// Where Android's own apps keep a file, by the address they give it.
const CONTENT_PLACES = {
  'com.android.providers.downloads.documents': 'Downloads',
  'com.android.providers.media.documents': 'Photos and media',
  media: 'Photos and media',
  'com.google.android.apps.nbu.files.provider': 'Files by Google',
  'com.google.android.apps.docs.storage': 'Google Drive',
  'com.google.android.apps.docs.storage.legacy': 'Google Drive',
};

/** Where a content:// file is, for its bar: a folder on the phone ("Documents/notes"), or the app or place that has it. */
export function contentPlace(uri) {
  const m = /^content:\/\/([^/]+)(\/.*)?$/.exec(uri ?? '');
  if (!m) return '';
  const [, authority, rest = ''] = m;
  if (authority === 'com.android.externalstorage.documents') {
    // …/document/primary%3ADocuments%2Fnotes.txt → Documents (on the phone's storage).
    const id = decodeURIComponent(rest.split('/').pop() ?? '');
    const [volume, path = ''] = id.split(':');
    const folder = path.split('/').slice(0, -1).join('/');
    const where = volume === 'primary' ? 'Phone storage' : 'SD card';
    return folder ? `${where} · ${folder}` : where;
  }
  if (CONTENT_PLACES[authority]) return CONTENT_PLACES[authority];
  // Another app's own files: its name from its address (com.mixplorer.file → Mixplorer).
  const GENERIC = ['com', 'org', 'net', 'io', 'android', 'google', 'apps', 'provider', 'providers', 'fileprovider', 'documents', 'document', 'app', 'file', 'files', 'storage'];
  const name = authority.split('.').find((p) => !GENERIC.includes(p.toLowerCase()));
  return name ? `From ${name[0].toUpperCase()}${name.slice(1)}` : 'From another app';
}

const android = () => globalThis.window?.desktop?.platform === 'android';

/** remote://<id>/<path> → { id, path }. */
export function remoteParts(uri) {
  const rest = uri.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf('/');
  return { id: slash === -1 ? rest : rest.slice(0, slash), path: (slash === -1 ? '' : rest.slice(slash)) || '/' };
}
/** The top folder of a server, as the folders view treats it. */
export const remoteRoot = (id) => `${REMOTE_SCHEME}${id}/`;
/** A path on a server as the folders view addresses it. */
export const toRemoteUri = (id, path) => `${REMOTE_SCHEME}${id}${path.startsWith('/') ? path : `/${path}`}`;

export const KINDS = {
  synced: { label: 'My files', icon: 'cloud', hint: 'In your files: saved on this device and synced to your data repo.' },
  doc: { label: 'Tracker', icon: 'paperclip', hint: 'A document attached to a tracker item: synced with the tracker.' },
  disk: {
    get label() {
      return android() ? 'This device' : 'This computer';
    },
    icon: 'disk',
    get hint() {
      return android() ? 'A file on this device, edited where it is: not synced.' : 'A file on this computer, edited where it is: not synced.';
    },
  },
  remote: { label: 'Server', icon: 'server', hint: 'A file on a server, saved back to it: not synced.' },
  // Not where a file lives: a comparison's tab (its sides are files or folders of the kinds above).
  compare: { label: 'Comparison', icon: 'compare', hint: 'Two files or two folders compared, side by side.' },
};

// In local mode (no GitHub) my files and tracker documents stay on this computer.
const LOCAL_HINTS = {
  synced: 'In your files: kept on this computer, with your tracker.',
  doc: 'A document attached to a tracker item, kept on this computer.',
};

/** What a kind means, for tooltips (`local`: the data stays on this computer). */
export const kindHint = (kind, local = false) => (local && LOCAL_HINTS[kind]) || KINDS[kind]?.hint || '';

/** The kind of a tab: 'synced' (f:), 'doc' (r:), 'disk' or 'remote' (d:). */
export function kindOfKey(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('f:')) return 'synced';
  if (key.startsWith('r:')) return 'doc';
  if (key.startsWith('d:')) return isRemotePath(key.slice(2)) ? 'remote' : 'disk';
  return null;
}

const PROTOCOL_NAMES = { sftp: 'SFTP', ftps: 'FTPS', ftp: 'FTP', docker: 'Docker', wsl: 'WSL' };
export const protocolName = (protocol) => PROTOCOL_NAMES[protocol] ?? 'SFTP';

// Docker containers and WSL distributions are places too (electron/places.cjs): connections
// reached through a program on this computer, with files and a shell, but no host.
/** Whether a connection is a Docker container or a WSL distribution. */
export const isPlace = (conn) => conn?.protocol === 'docker' || conn?.protocol === 'wsl';
/** Whether a connection has a shell: terminals, running files and tests, tasks, language servers. */
export const hasShell = (conn) => conn?.protocol === 'sftp' || isPlace(conn);
/** The icon of a connection. */
export const connIcon = (conn) => (conn?.protocol === 'docker' ? 'container' : conn?.protocol === 'wsl' ? 'linux' : 'server');
/** Its name saying what it is: "web-1 (Docker)", "Ubuntu (WSL)"; a server by its name. */
export const connLabel = (conn) => (!conn ? 'Server' : isPlace(conn) ? `${conn.name} (${protocolName(conn.protocol)})` : conn.name);
/** What a connection is, for a tooltip or a line under its name: "SFTP · me@host", "Docker container web-1 · as node", "WSL · Ubuntu". */
export function connDetail(conn) {
  if (!conn) return 'Server';
  const as = conn.user ? ` · as ${conn.user}` : '';
  if (conn.protocol === 'docker') return `Docker container ${conn.container ?? conn.name}${as}`;
  if (conn.protocol === 'wsl') return `WSL distribution ${conn.distro ?? conn.name}${as}`;
  return `${protocolName(conn.protocol)} · ${conn.user ? `${conn.user}@` : ''}${conn.host ?? ''}`;
}

const DEFAULT_PORTS = { sftp: 22, ftp: 21, ftps: 21 };

/**
 * A file on a server as ssh and scp write it, "user@host:/path", or as a URL
 * when the port is not the usual one, "sftp://user@host:2222/path" (just the
 * path without the connection). In a Docker container as docker cp writes it,
 * "web-1:/app/x.js"; in a WSL distribution as Windows reaches it,
 * "\\wsl.localhost\Ubuntu\home\me\x.js".
 */
export function remoteAddress(uri, conn) {
  const { path } = remoteParts(uri);
  if (!conn) return path;
  if (conn.protocol === 'docker') return `${conn.container ?? conn.name}:${path}`;
  if (conn.protocol === 'wsl') return `\\\\wsl.localhost\\${conn.distro ?? conn.name}${path.replace(/\//g, '\\')}`;
  const user = conn.user ? `${conn.user}@` : '';
  if (conn.port && conn.port !== (DEFAULT_PORTS[conn.protocol] ?? 22)) return `${conn.protocol ?? 'sftp'}://${user}${conn.host}:${conn.port}${path}`;
  return `${user}${conn.host}:${path}`;
}

/**
 * The state shown with where a file lives: { text, tone, detail? }, tone one of
 * 'ok', 'pending', 'busy', 'warn', 'error'. `file` (my files), `repo` (a tracker
 * document) or `disk` (this computer or a server) is the tab's record; `sync` is
 * { configured, phase, local }; `server` is { state, error, place } of its connection
 * (`place`: 'docker' or 'wsl' for a container or a distribution, said so). In local
 * mode (`local`: the data stays on this computer) nothing is said about syncing.
 */
export function whereState({ kind, file, repo, disk, sync = {}, server }) {
  if ((kind === 'synced' || kind === 'doc') && sync.local) return { text: 'Saved', tone: 'ok', detail: 'Kept on this computer.' };
  if (kind === 'synced') {
    if (!sync.configured) return { text: 'On this device only', tone: 'pending', detail: 'Sync is not set up: Settings → Sync keeps your files in your data repo.' };
    if (file?.dirty || file?.pending) {
      if (sync.phase === 'syncing') return { text: 'Syncing…', tone: 'busy' };
      if (sync.phase === 'offline') return { text: 'Not synced · offline', tone: 'warn', detail: 'Saved on this device; it syncs when you are back online.' };
      if (sync.phase === 'error') return { text: 'Not synced · sync error', tone: 'error' };
      return { text: 'Not synced yet', tone: 'pending', detail: 'Saved on this device; it syncs in a moment.' };
    }
    return { text: 'Synced', tone: 'ok' };
  }
  if (kind === 'doc') return repo?.dirty ? { text: 'Not synced yet', tone: 'pending', detail: 'Saved on this device; goes to the tracker on the next sync.' } : { text: 'Synced', tone: 'ok' };
  const remote = kind === 'remote';
  if (!disk) return { text: '', tone: 'ok' };
  // Where the file is, in words: on the server, in the container, in WSL.
  const there = { docker: 'in the container', wsl: 'in WSL' }[server?.place] ?? 'on the server';
  const to = server?.place ? there : 'to the server';
  if (remote && (disk.offline || server?.state === 'error' || server?.state === 'disconnected')) {
    if (server?.state === 'connecting') return { text: 'Connecting…', tone: 'busy' };
    // Disconnected with a reason (a container that stopped) is not connected either.
    if (disk.offline || server?.state === 'error' || server?.error) return { text: disk.dirty ? 'Not connected · not saved' : 'Not connected', tone: 'warn', detail: disk.dirty ? `Your edits are kept on this device until you save them ${to}.` : `Reconnect to see changes made ${there}.` };
  }
  if (disk.missing) return { text: remote ? `Not ${there}` : 'Not on disk', tone: 'error', detail: 'Moved, renamed or deleted. Saving puts it back.' };
  if (disk.conflict) return { text: remote ? `Changed ${there}` : 'Changed on disk', tone: 'error', detail: 'Changed elsewhere while you edited it here: compare, reload, or keep yours.' };
  if (disk.saving) return { text: 'Saving…', tone: 'busy' };
  if (disk.dirty) return { text: remote ? `Not saved ${to}` : 'Not saved', tone: 'pending', detail: 'Ctrl+S saves it.' };
  if (disk.follow) return { text: 'Following', tone: 'ok' };
  return { text: remote ? `Saved ${there}` : 'Saved', tone: 'ok' };
}
