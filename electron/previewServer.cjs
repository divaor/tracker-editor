'use strict';
// The preview server (0.46): HTML projects served to the preview's frame (Run scripts) and to the
// browser (Run, F5), so a page loads as it would from a web server: its scripts and modules,
// fetch(), styles, pictures and fonts, and links to the site's other pages.
//
// Security (keep it so):
// - It listens on 127.0.0.1 only, on a port the system picks. It starts the first time a page is
//   asked for and stops when the app quits.
// - Every address carries a random token made when it starts and a random id per site:
//   /p/<token>/<site>/<path>. Anything else is 404. A page served here can read its own address,
//   so it knows the token, but not the ids of other sites: it reaches its own site and nothing else.
// - The Host header must name 127.0.0.1 or localhost with this port, so a web page on a name made
//   to point at 127.0.0.1 (DNS rebinding) is refused.
// - GET and HEAD only. Nothing is written or started here.
// - A file is served only when `allowed(file)` holds: main.cjs's checkFile rule, the files the
//   editor itself may open (picked in the open dialog, or inside a picked folder by real path).
//   It must also be inside its site's folder by real path (links cannot lead out), have no dot
//   name on the way (.git, .env) and be a file: folders give their index.html, never a listing.
//   Files on servers (remote://) are never served.
// - The page names a file (checked in main.cjs too), never a folder, a port or a program. A site's
//   folder is worked out here (siteRoot): never above the picked folder that holds the file.
// - A page served here runs as any page in a browser does, in its own origin
//   (http://127.0.0.1:<port>), not the editor's (app://editor): it cannot reach the app, its IPC or
//   its storage. The preview shows it in an iframe sandboxed without allow-top-navigation.
// - Text from the page: the unsaved text of a file shown with its scripts (setText, served instead
//   of the file while set), and notes or files on servers as one page held in memory (notePage).
//   Neither makes another file reachable.
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { isInside, realPath } = require('./folders.cjs');

const MIME = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  xml: 'application/xml', svg: 'image/svg+xml', yaml: 'text/yaml', yml: 'text/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', opus: 'audio/opus', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mov: 'video/quicktime', vtt: 'text/vtt', pdf: 'application/pdf',
  wasm: 'application/wasm', glb: 'model/gltf-binary', gltf: 'model/gltf+json', zip: 'application/zip',
};
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|manifest\+json)$|image\/svg\+xml$|model\/gltf\+json$)/;
const MAX_TEXT = 20 * 1024 * 1024; // unsaved text or a note page held in memory, and HTML read whole
const MAX_TEXTS = 100;
const MAX_NOTES = 20;
const MAX_WATCHED = 300; // files watched per site (the ones its pages loaded)
const MARKERS = ['.git', 'package.json']; // a project's top folder
const INDEX = ['index.html', 'index.htm'];
const UP = 8; // folders walked up at most
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DEBOUNCE_MS = 150;

const mimeOf = (name) => MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'site';
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
let utf8Check = null;
function isUtf8(buf) {
  utf8Check ??= require('buffer').isUtf8 ?? ((b) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  });
  return utf8Check(buf);
}

/** The picked folder that holds the file most closely (null: the file was picked alone). */
function pickedFolderOf(file, tops) {
  const real = realPath(file);
  let best = null;
  let bestLen = -1;
  for (const top of tops) {
    if (typeof top !== 'string' || !path.isAbsolute(top)) continue;
    const realTop = realPath(top);
    if (isInside(realTop, real) && realTop.length > bestLen) [best, bestLen] = [top, realTop.length];
  }
  return best;
}

/**
 * The folder a page's site is served from: going up from the file's folder (never above the
 * picked folder that holds it, at most UP levels), the nearest one with .git or package.json, else
 * the highest one with an index.html, else the file's own folder. A file picked alone: its folder.
 */
function siteRoot(file, tops = []) {
  const start = path.dirname(path.resolve(file));
  const top = pickedFolderOf(file, tops);
  if (!top) return start;
  const realTop = realPath(top);
  let best = null;
  let dir = start;
  for (let i = 0; i < UP; i++) {
    if (!isInside(realTop, realPath(dir))) break;
    if (MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    if (INDEX.some((n) => isFile(path.join(dir, n)))) best = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return best ?? start;
}

/** The page a stylesheet or a script belongs to: an index.html in its folder or above, up to its site's folder. */
function pageOf(file, { tops = [], allowed = () => true } = {}) {
  const root = siteRoot(file, tops);
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i <= UP && isInside(root, dir); i++) {
    for (const name of INDEX) {
      const page = path.join(dir, name);
      if (isFile(page) && allowed(page)) return page;
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return null;
}

/** A name in an address: refused (null) when it could step out of the site or name what is not served. */
function cleanName(segment) {
  let name;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!name || name === '.' || name === '..' || /[\\/\x00]/.test(name)) return null;
  // Dot names (.git, .env, .ssh) are never served; .well-known is a web convention.
  if (name.startsWith('.') && name !== '.well-known') return null;
  if (process.platform === 'win32' && (/[:*?"<>|]/.test(name) || /[. ]$/.test(name) || RESERVED.test(name))) return null;
  return name;
}

/** A note's or a server file's name as its page is served: ends with .html, nothing that could be a path. */
function pageName(name) {
  let clean = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f:*?"<>|#%]/g, '').trim();
  if (!clean || clean.startsWith('.')) clean = `page${clean}`;
  if (!/\.x?html?$/i.test(clean)) clean = `${clean.replace(/[. ]+$/, '') || 'page'}.html`;
  return clean.slice(-120);
}

/** HTML with the browser's live reload added (before </body>, else at the end); unchanged when it is UTF-16. */
function withLiveScript(buf, tag) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return buf;
  const lower = buf.toString('latin1').toLowerCase();
  let at = lower.lastIndexOf('</body>');
  if (at < 0) at = lower.lastIndexOf('</html>');
  if (at < 0) at = buf.length;
  return Buffer.concat([buf.subarray(0, at), Buffer.from(tag, 'utf8'), buf.subarray(at)]);
}

/** The editor's text of a file is what the file holds already (line endings and a BOM aside). */
function sameAsDisk(file, text) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_TEXT) return false;
    let disk = buf.toString('utf8');
    if (disk.charCodeAt(0) === 0xfeff) disk = disk.slice(1);
    return disk.replace(/\r\n?/g, '\n') === text.replace(/\r\n?/g, '\n');
  } catch {
    return false;
  }
}

/**
 * The server. `allowed(file)`: may the editor open this file (main.cjs's checkFile rule);
 * `tops()`: the picked folders; `onChange({ site, files })`: files of a site changed (the app
 * reloads its frame; browser pages reload themselves).
 */
function createPreviewServer({ allowed, tops = () => [], onChange = () => {} } = {}) {
  if (typeof allowed !== 'function') throw new Error('allowed is needed');
  const token = randomId(18);
  const sites = new Map(); // id → { id, root, note, page, named, clients, watching, pending, timer, owner }
  const byRoot = new Map(); // folder → site
  const notes = new Map(); // tab key → site held in memory
  const texts = new Map(); // file → { text, owner }: unsaved text served instead of the file
  let server = null;
  let starting = null;
  let port = 0;
  const origin = () => `http://127.0.0.1:${port}`;

  function start() {
    starting ??= new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        try {
          handle(req, res);
        } catch {
          if (!res.headersSent) send(res, 500, 'Something went wrong.');
          else res.destroy();
        }
      });
      s.once('error', (err) => {
        starting = null;
        reject(err);
      });
      s.listen(0, '127.0.0.1', () => {
        server = s;
        port = s.address().port;
        resolve(port);
      });
    });
    return starting;
  }

  function makeSite(root, note = false) {
    const id = `${note ? 'note' : slug(path.basename(root))}-${randomId(9)}`;
    const site = { id, root, note, page: null, named: new Set(), clients: new Set(), watching: new Map(), pending: new Set(), timer: null, owner: null };
    sites.set(id, site);
    if (root) byRoot.set(root, site);
    return site;
  }
  function closeSite(site) {
    clearTimeout(site.timer);
    for (const res of site.clients) res.end();
    for (const w of site.watching.values()) w.close();
    site.clients.clear();
    site.watching.clear();
    sites.delete(site.id);
    if (site.root && byRoot.get(site.root) === site) byRoot.delete(site.root);
  }

  /** Pages of the site reload: browser pages through their event stream, the app's frame through onChange. */
  function notify(site, file) {
    site.pending.add(file);
    clearTimeout(site.timer);
    site.timer = setTimeout(() => {
      const files = [...site.pending];
      site.pending.clear();
      for (const res of site.clients) res.write('data: reload\n\n');
      try {
        onChange({ site: site.id, files });
      } catch {
        // the window is gone
      }
    }, DEBOUNCE_MS);
    site.timer.unref?.();
  }
  const sitesHolding = (file) => [...sites.values()].filter((s) => !s.note && isInside(s.root, file));

  /** A file a page loaded is watched until it changes (then its pages reload; loading it again watches it again). */
  function watchServed(site, file, stat) {
    if (site.watching.has(file) || site.watching.size >= MAX_WATCHED) return;
    let watcher;
    const stop = () => {
      watcher?.close();
      site.watching.delete(file);
    };
    try {
      watcher = fs.watch(file, { persistent: false }, () => {
        // Some systems report a read or a touch: only a real change reloads.
        let now = null;
        try {
          now = fs.statSync(file);
        } catch {
          // removed or renamed: a change
        }
        if (now && now.mtimeMs === stat.mtimeMs && now.size === stat.size) return;
        stop();
        notify(site, file);
      });
      watcher.on('error', stop);
      site.watching.set(file, watcher);
    } catch {
      // cannot be watched: saving still shows after a reload by hand
    }
  }

  // ---- Answers ----
  const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
  function send(res, status, text, headers = {}) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
    res.end(res.req?.method === 'HEAD' ? undefined : body);
  }
  function redirect(res, location) {
    res.writeHead(307, { ...BASE_HEADERS, Location: location, 'Content-Length': 0 });
    res.end();
  }
  function sendBody(req, res, type, body) {
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const textType = (type, body) => (TEXTUAL.test(type) && isUtf8(body) ? `${type}; charset=utf-8` : type);
  // The browser's live reload goes into pages opened at the top of a window (Sec-Fetch-Dest
  // document, or a browser that does not say), never into the app's frame (iframe) or what a
  // script fetches.
  const wantsLive = (req) => {
    const dest = req.headers['sec-fetch-dest'];
    return dest === undefined || dest === 'document';
  };
  const liveTag = (site) => `<script src="/p/${token}/__live.js?site=${encodeURIComponent(site.id)}"></script>`;

  function handle(req, res) {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return send(res, 403, 'Not allowed.');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET and HEAD only.', { Allow: 'GET, HEAD' });
    const raw = req.url ?? '/';
    if (raw.length > 4096) return send(res, 414, 'That address is too long.');
    const q = raw.indexOf('?');
    const pathname = q < 0 ? raw : raw.slice(0, q);
    const search = q < 0 ? '' : raw.slice(q);
    const parts = pathname.split('/');
    const ours = parts[1] === 'p' && parts[2] === token;
    if (ours && parts.length === 4 && parts[3] === '__reload') return events(req, res, search);
    if (ours && parts.length === 4 && parts[3] === '__live.js') return liveScript(req, res, search);
    const site = ours ? sites.get(parts[3]) : null;
    if (site) return serve(req, res, site, parts.slice(4), pathname, search);
    // An address from the top of the site ("/style.css", fetch('/data.json')) in a page served
    // here: the site's own, as on a web server. Only with a page of a known site as the referrer.
    const from = refererSite(req, host);
    if (from) return redirect(res, `/p/${token}/${from.id}/${(ours ? parts.slice(3) : parts.slice(1)).join('/')}${search}`);
    return send(res, 404, 'Not found.');
  }
  function refererSite(req, host) {
    let url;
    try {
      url = new URL(req.headers.referer);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== host) return null;
    const p = url.pathname.split('/');
    return p[1] === 'p' && p[2] === token ? (sites.get(p[3]) ?? null) : null;
  }
  const siteOfQuery = (search) => sites.get(new URLSearchParams(search.slice(1)).get('site') ?? '') ?? null;

  function liveScript(req, res, search) {
    const site = siteOfQuery(search);
    if (!site) return send(res, 404, 'Not found.');
    const stream = `/p/${token}/__reload?site=${encodeURIComponent(site.id)}`;
    const js = `// Tracker Editor: this page reloads when a file it loaded changes, or as you edit it there.\n(() => {\n  const events = new EventSource(${JSON.stringify(stream)});\n  events.addEventListener('message', (e) => e.data === 'reload' && location.reload());\n})();\n`;
    sendBody(req, res, 'text/javascript; charset=utf-8', Buffer.from(js, 'utf8'));
  }
  function events(req, res, search) {
    const site = siteOfQuery(search);
    if (!site) return send(res, 404, 'Not found.');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    if (req.method === 'HEAD') return res.end();
    res.write('retry: 3000\n\n');
    site.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    ping.unref?.();
    req.on('close', () => {
      clearInterval(ping);
      site.clients.delete(res);
    });
  }

  function serve(req, res, site, segments, pathname, search) {
    // The site's top without its slash: to it with the slash, so the page's links resolve inside.
    if (segments.length === 0) return redirect(res, `${pathname}/${search}`);
    const wantsFolder = segments[segments.length - 1] === '';
    const names = [];
    for (const segment of segments) {
      if (segment === '') continue;
      const name = cleanName(segment);
      if (name === null) return send(res, 404, 'Not found.');
      names.push(name);
    }
    if (site.note) {
      const page = site.page;
      if (!page || !(names.length === 0 || (names.length === 1 && names[0] === page.name))) return send(res, 404, 'Not found.');
      const body = Buffer.from(page.text, 'utf8');
      return sendBody(req, res, 'text/html; charset=utf-8', wantsLive(req) ? withLiveScript(body, liveTag(site)) : body);
    }
    const file = path.join(site.root, ...names);
    if (!isInside(site.root, file)) return send(res, 404, 'Not found.');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return send(res, 404, 'Not found.');
    }
    if (stat.isDirectory()) {
      if (!wantsFolder) return redirect(res, `${pathname}/${search}`);
      for (const name of INDEX) {
        const index = path.join(file, name);
        if (servable(site, index)) return sendFile(req, res, site, index, fs.statSync(index));
      }
      return send(res, 404, 'Not found.');
    }
    if (!stat.isFile() || !servable(site, file)) return send(res, 404, 'Not found.');
    return sendFile(req, res, site, file, stat);
  }
  /** The editor may open it, and its real path is inside the site's (or the page asked for it by name). */
  function servable(site, file) {
    if (!isFile(file) || !allowed(file)) return false;
    return site.named.has(file) || isInside(realPath(site.root), realPath(file));
  }

  function sendFile(req, res, site, file, stat) {
    const type = mimeOf(file);
    const html = type === 'text/html' || type === 'application/xhtml+xml';
    const live = texts.get(file);
    watchServed(site, file, stat);
    if (live || html || (TEXTUAL.test(type) && stat.size <= MAX_TEXT)) {
      let body = live ? Buffer.from(live.text, 'utf8') : stat.size <= MAX_TEXT ? fs.readFileSync(file) : null;
      if (body) {
        const ctype = live ? `${type}; charset=utf-8` : textType(type, body);
        if (html && wantsLive(req)) body = withLiveScript(body, liveTag(site));
        return sendBody(req, res, ctype, body);
      }
    }
    // Pictures, sound, video, fonts, large files: streamed, with byte ranges (seeking in a video).
    const size = stat.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (range && (range[1] || range[2])) {
      if (range[1] === '') {
        start = Math.max(0, size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
      }
      if (start > end || start >= size) return send(res, 416, 'Not in the file.', { 'Content-Range': `bytes */${size}` });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  return {
    /** The address of a file the editor may open (main.cjs checked it): { url, site }. */
    async url(file) {
      await start();
      const full = path.resolve(file);
      const root = siteRoot(full, tops());
      const site = byRoot.get(root) ?? makeSite(root);
      site.named.add(full);
      const rel = path.relative(root, full).split(path.sep).map(encodeURIComponent).join('/');
      return { url: `${origin()}/p/${token}/${site.id}/${rel}`, site: site.id };
    },
    /**
     * A note, a tracker document or a file on a server shown with its scripts: its text as one
     * page held in memory (files next to it do not load). `text` null forgets it.
     */
    async notePage(key, name, text, owner = null) {
      if (typeof key !== 'string' || !key || key.length > 4096) throw new Error('Not allowed');
      if (text === null || text === undefined) {
        const site = notes.get(key);
        if (site) closeSite(site);
        notes.delete(key);
        return null;
      }
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('That page is too long to show with its scripts.');
      await start();
      const site = notes.get(key) ?? makeSite(null, true);
      notes.delete(key);
      notes.set(key, site); // the newest last: the one used longest ago goes first
      while (notes.size > MAX_NOTES) {
        const [oldKey, old] = notes.entries().next().value;
        closeSite(old);
        notes.delete(oldKey);
      }
      site.page = { name: pageName(name), text };
      site.owner = owner;
      return { url: `${origin()}/p/${token}/${site.id}/${encodeURIComponent(site.page.name)}`, site: site.id };
    },
    /**
     * The unsaved text of a file, served instead of it while set (null: the file again). Pages
     * of its site reload, unless it only says what the file holds. True when they do.
     */
    setText(file, text, owner = null) {
      const full = path.resolve(file);
      const before = texts.get(full);
      if (text === null || text === undefined) {
        texts.delete(full);
        return false;
      }
      if (typeof text !== 'string' || text.length > MAX_TEXT) throw new Error('That file is too long to show unsaved.');
      if (before?.text === text) return false;
      texts.delete(full);
      texts.set(full, { text, owner });
      while (texts.size > MAX_TEXTS) texts.delete(texts.keys().next().value);
      if (!before && sameAsDisk(full, text)) return false;
      for (const site of sitesHolding(full)) notify(site, full);
      return true;
    },
    /** A file changed (saved here): pages of its site reload (once: its watch, which would say so too, ends). */
    changed(file) {
      const full = path.resolve(file);
      for (const site of sitesHolding(full)) {
        site.watching.get(full)?.close();
        site.watching.delete(full);
        notify(site, full);
      }
    },
    /** A page went (reloaded, closed): its unsaved texts and notes go with it. */
    forget(owner) {
      for (const [file, entry] of texts) if (entry.owner === owner) texts.delete(file);
      for (const [key, site] of notes) {
        if (site.owner !== owner) continue;
        closeSite(site);
        notes.delete(key);
      }
    },
    /** An address served here (main.cjs tells the preview frame's links out from its own). */
    owns(url) {
      return Boolean(port) && typeof url === 'string' && (url.startsWith(`${origin()}/`) || url.startsWith(`http://localhost:${port}/`));
    },
    /** The site of an address served here ('' when it is not one). */
    siteOf(url) {
      if (!this.owns(url)) return '';
      const [, p, tok, id] = new URL(url).pathname.split('/');
      return p === 'p' && tok === token && sites.has(id) ? id : '';
    },
    get port() {
      return port;
    },
    stop() {
      for (const site of [...sites.values()]) closeSite(site);
      notes.clear();
      texts.clear();
      server?.closeAllConnections?.();
      server?.close();
      server = null;
      starting = null;
      port = 0;
    },
  };
}

module.exports = { createPreviewServer, siteRoot, pageOf, pageName, cleanName, mimeOf, withLiveScript, MAX_TEXT };
