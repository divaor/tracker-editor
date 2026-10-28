// A document shown as it looks, read-only: in its tab in the editor (PDFs, e-books, Word,
// OpenDocument, RTF, spreadsheets and slides), and in the folders view's preview and viewer.
// PDFs are drawn by pdf.js (pdfDoc.js), page by page as they scroll into view, zoomed with
// the buttons, Ctrl+wheel or two fingers. The others are converted to a page (documents.js),
// sanitized once more here, and follow the editor's text size. Their text goes to `onText`
// (the tab's text: "As text", search, the model). Where a document is read (its tab, the
// viewer) it can go full screen and keep a bookmark (docBookmarks.js) that it opens at.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import DOMPurify from '../../vendor/purify.js';
import { BOOKMARK_BLOCKS, bookmarkLabel, bookmarkOf, placeAt, topOf, withBookmark, withoutBookmark } from '../docBookmarks.js';
import { documentLabel } from '../docTypes.js';
import { isAndroidApp } from '../platform.js';
import { getSettings, saveSettings } from '../settings.js';
import { toast } from './components.js';
import { Icon } from './icons.js';
import { Menu } from './menu.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
// pdf.js's document and its worker, let go (never throwing: the view is going away).
const closePdf = (pdf) => Promise.resolve().then(() => pdf.loadingTask?.destroy()).catch(() => {});

// What the converted page may hold (documents.js writes only these; this is the second check).
const PURIFY = {
  ALLOWED_TAGS: 'a abbr address aside b bdi blockquote br caption cite code dd del dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s samp section small span strong sub sup table tbody td tfoot th thead time tr u ul var wbr'.split(' '),
  ALLOWED_ATTR: ['id', 'href', 'class', 'alt', 'colspan', 'rowspan', 'start', 'type', 'dir', 'lang', 'title', 'data-doc-img'],
  // Links only to the web, mail and phones, or inside the page; values that are no address
  // (colspan="2", the pictures' marks) pass as DOMPurify's own rule lets them.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ALLOW_DATA_ATTR: false,
};

/**
 * `load()` gives the bytes; `version` (the file's time) reads them again when it changes.
 * `compact`: the folders view's preview (a slimmer bar). `onOpenOutside`: its own program.
 * `bookmarkKey` (the file's path) keeps a bookmark for it.
 */
export function DocumentView({ name, kind, version, load, onText, onAsText, onOpenOutside, compact = false, bookmarkKey }) {
  const [state, setState] = useState({ status: 'loading' });
  const [password, setPassword] = useState(null); // { wrong } while one is asked
  const root = useRef(null);
  const [full, setFull] = useState(false);
  // The view shown says where the reader is and goes to a place: { here(), go(place) }.
  const nav = useRef(null);
  const marked = Boolean(bookmarkKey) && !compact;
  const [mark, setMark] = useState(() => (marked ? bookmarkOf(getSettings().docBookmarks, bookmarkKey) : null));
  useEffect(() => setMark(marked ? bookmarkOf(getSettings().docBookmarks, bookmarkKey) : null), [bookmarkKey, marked]);
  const run = (pass) => {
    let stale = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const bytes = new Uint8Array(await load());
        if (stale) return;
        if (kind === 'pdf') {
          const { openPdf, PdfPasswordNeeded, pdfLib } = await import('../pdfDoc.js');
          try {
            const pdf = await openPdf(bytes, { password: pass });
            if (stale) return closePdf(pdf);
            setPassword(null);
            setState({ status: 'ready', pdf, pdfjs: await pdfLib() });
          } catch (err) {
            if (err instanceof PdfPasswordNeeded) {
              if (!stale) (setPassword({ wrong: err.wrong }), setState({ status: 'password', bytes }));
              return;
            }
            throw err;
          }
          return;
        }
        const { convertDocument } = await import('../documents.js');
        const doc = await convertDocument(kind, bytes);
        if (stale) return;
        setState({ status: 'ready', doc });
        onText?.(doc.text);
      } catch (err) {
        if (!stale) setState({ status: 'error', error: message(err) });
      }
    })();
    return () => {
      stale = true;
    };
  };
  useEffect(() => run(undefined), [name, kind, version]);
  // A PDF's document is let go with the view.
  useEffect(() => () => state.pdf && closePdf(state.pdf), [state.pdf]);

  // Full screen: the view over the whole window (and the screen itself where the browser lets
  // it: not in Android's WebView, where the system bars hide instead). Escape or Back leave it.
  useLayoutEffect(() => {
    if (!full) return;
    const el = root.current;
    let real = false;
    if (!isAndroidApp() && document.fullscreenEnabled && el?.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => (real = true),
        () => {},
      );
    }
    window.desktop?.android?.bars?.(false);
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setFull(false);
    };
    const onChange = () => real && !document.fullscreenElement && setFull(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      if (el && document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      window.desktop?.android?.bars?.(true);
    };
  }, [full]);

  const setBookmark = () => {
    const place = nav.current?.here();
    if (!place) return;
    saveSettings({ docBookmarks: withBookmark(getSettings().docBookmarks, bookmarkKey, place) });
    setMark(place);
    toast(`Bookmark at ${bookmarkLabel(place)}: ${name} opens there until you clear it.`);
  };
  const clearBookmark = () => {
    saveSettings({ docBookmarks: withoutBookmark(getSettings().docBookmarks, bookmarkKey) });
    setMark(null);
    toast(`Bookmark cleared: ${name} opens at the start.`);
  };

  const label = documentLabel(name);
  const bar = (extra) => html`<div class="doc-bar ${compact ? 'compact' : ''}">
    ${!compact && html`<span class="doc-kind">${label}</span>`}
    ${extra}
    <span class="spacer" />
    ${marked && state.status === 'ready' && html`<${BookmarkButton} mark=${mark} onSet=${setBookmark} onGo=${() => nav.current?.go(mark)} onClear=${clearBookmark} />`}
    ${!compact &&
    html`<button type="button" class="icon-btn sm doc-full-btn" aria-pressed=${full} aria-label=${full ? 'Leave full screen' : 'Full screen'} title=${full ? 'Leave full screen (Esc)' : 'Full screen'}
      onClick=${() => setFull(!full)}><${Icon} name=${full ? 'fullscreenExit' : 'fullscreen'} size=${15} /></button>`}
    ${onAsText && html`<button type="button" class="btn ghost sm doc-aside" title="Its text in the editor (to select, search, copy)" aria-label="As text" onClick=${onAsText}><${Icon} name="file" size=${15} /><span class="label">As text</span></button>`}
    ${onOpenOutside && html`<button type="button" class="btn ghost sm doc-aside" title="Open it with its own program" aria-label="Its program" onClick=${onOpenOutside}><${Icon} name="external" size=${15} /><span class="label">Its program</span></button>`}
  </div>`;
  const view = (body, cls = '') => html`<div class="doc-view ${cls} ${full ? 'full' : ''}" ref=${root}>${body}</div>`;

  if (state.status === 'error') {
    return view(html`${!compact && bar()}<div class="doc-message"><${Icon} name="alert" size=${compact ? 24 : 32} /><p>${state.error}</p>
      ${onOpenOutside && html`<button type="button" class="btn sm" onClick=${onOpenOutside}><${Icon} name="external" size=${15} />Open it with its program</button>`}</div>`);
  }
  if (state.status === 'password') {
    return view(html`${!compact && bar()}<${PasswordForm} wrong=${password?.wrong} name=${name} onSubmit=${(p) => run(p)} />`);
  }
  if (state.status === 'loading') return view(html`${!compact && bar()}<div class="doc-message waiting"><p class="muted">Opening ${name}…</p></div>`);
  if (state.pdf) return html`<${PdfView} pdf=${state.pdf} pdfjs=${state.pdfjs} compact=${compact} bar=${bar} view=${view} nav=${nav} start=${mark} onText=${onText} />`;
  return html`<${HtmlDocument} doc=${state.doc} compact=${compact} bar=${bar} view=${view} nav=${nav} start=${mark} />`;
}

/** The bookmark: set it here, or (once set) go to it, move it here or clear it. */
function BookmarkButton({ mark, onSet, onGo, onClear }) {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  if (!mark) {
    return html`<button type="button" class="icon-btn sm doc-bookmark" aria-label="Bookmark this place" title="Bookmark this place: the document opens here until the bookmark is cleared" onClick=${onSet}>
      <${Icon} name="bookmark" size=${15} /></button>`;
  }
  return html`<button type="button" ref=${button} class="icon-btn sm doc-bookmark on" aria-haspopup="menu" aria-expanded=${Boolean(at)} aria-label="Bookmark" title=${`Bookmark: ${bookmarkLabel(mark)}`}
      onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAt(at ? null : { x: r.left, y: r.bottom + 4 });
      }}><${Icon} name="bookmark" size=${15} /></button>
    ${at &&
    html`<${Menu} label="Bookmark" at=${at} owner=${button} onClose=${() => setAt(null)}
      items=${[
        { key: 'go', label: 'Go to the bookmark', hint: bookmarkLabel(mark), icon: 'bookmark', run: onGo },
        { key: 'move', label: 'Move the bookmark here', icon: 'pin', run: onSet },
        { key: 'clear', label: 'Clear the bookmark', hint: 'Open at the start', icon: 'x', run: onClear },
      ]} />`}`;
}

// The reader scrolling (or zooming) by hand: a place being kept is let go.
const HAND = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
function useHandScroll(scroller, onHand) {
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    HAND.forEach((t) => el.addEventListener(t, onHand, { passive: true }));
    return () => HAND.forEach((t) => el.removeEventListener(t, onHand));
  }, []);
}

function PasswordForm({ wrong, name, onSubmit }) {
  const [value, setValue] = useState('');
  return html`<form class="doc-message" onSubmit=${(e) => (e.preventDefault(), onSubmit(value))}>
    <${Icon} name="lock" size=${32} />
    <p>${wrong ? 'That password is not right. Try again:' : `${name} is protected by a password.`}</p>
    <div class="input-row"><input type="password" value=${value} autofocus aria-label="Password" onInput=${(e) => setValue(e.currentTarget.value)} />
      <button type="submit" class="btn primary sm" disabled=${!value}>Open</button></div>
  </form>`;
}

/** The contents (an e-book's chapters, a workbook's sheets, a PDF's outline) as a menu. */
function ContentsButton({ entries, onGo }) {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  if (!entries?.length) return null;
  return html`<button type="button" ref=${button} class="btn ghost sm" aria-haspopup="menu" aria-expanded=${Boolean(at)} title="Contents"
      onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAt(at ? null : { x: r.left, y: r.bottom + 4 });
      }}><${Icon} name="list" size=${15} /><span class="label">Contents</span></button>
    ${at && html`<${Menu} className="doc-contents" label="Contents" at=${at} owner=${button} onClose=${() => setAt(null)}
      items=${entries.slice(0, 500).map((e, i) => ({ key: `c${i}`, label: `${'\u2003'.repeat(Math.min(4, e.depth))}${e.label}`, hint: e.hint, run: () => onGo(e) }))} />`}`;
}

// ---- Converted documents (e-books, Word, OpenDocument, RTF, sheets, slides) ----

function HtmlDocument({ doc, compact, bar, view, nav, start }) {
  const page = useRef(null);
  const scroller = useRef(null);
  // The place opened at (the bookmark), kept while pictures load and the page grows, until the reader scrolls.
  const anchor = useRef(null);
  const startNow = useRef(start);
  startNow.current = start;
  useHandScroll(scroller, () => (anchor.current = null));

  const blocks = () => [...(page.current?.querySelectorAll(BOOKMARK_BLOCKS) ?? [])];
  const here = () => {
    const root = scroller.current;
    const list = blocks();
    if (!root || !list.length) return null;
    const base = root.getBoundingClientRect().top - root.scrollTop;
    const tops = [];
    const bottoms = [];
    for (const b of list) {
      const r = b.getBoundingClientRect();
      tops.push(r.top - base);
      bottoms.push(r.bottom - base);
    }
    const place = placeAt(tops, bottoms, root.scrollTop);
    // Its chapter: the last entry of the contents before it, else the heading above it.
    const block = list[place.block];
    let heading = '';
    for (const e of doc.toc ?? []) {
      const at = e.target && page.current.querySelector(`#${CSS.escape(e.target)}`);
      if (at && (at.contains(block) || at.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)) heading = e.label;
    }
    for (let i = place.block; i >= 0 && !heading; i--) if (/^H[1-3]$/.test(list[i].tagName)) heading = list[i].textContent;
    heading = heading.trim().slice(0, 80);
    const room = root.scrollHeight - root.clientHeight;
    return { ...place, heading, percent: room > 0 ? Math.round((root.scrollTop / room) * 1000) / 1000 : 0 };
  };
  const goTo = (place) => {
    const root = scroller.current;
    const b = place && blocks()[place.block];
    if (!root || !b) return false;
    const r = b.getBoundingClientRect();
    root.scrollTop = topOf(place, r.top - root.getBoundingClientRect().top + root.scrollTop, r.height);
    return true;
  };
  nav.current = {
    here,
    go: (place) => {
      anchor.current = null;
      goTo(place);
    },
  };
  // Pictures loading above the place push it down: it is put back while kept.
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const ro = new ResizeObserver(() => anchor.current && goTo(anchor.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    el.innerHTML = DOMPurify.sanitize(doc.html, PURIFY);
    for (const a of el.querySelectorAll('a[href]')) {
      if (!a.getAttribute('href').startsWith('#')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    }
    anchor.current = startNow.current?.block != null && goTo(startNow.current) ? startNow.current : null;
    // Kept for a while only: never fighting the reader later.
    const letGo = setTimeout(() => (anchor.current = null), 15_000);
    // Pictures from the file itself, as blob addresses (never fetched from elsewhere).
    const urls = [];
    let stale = false;
    (async () => {
      for (const img of el.querySelectorAll('img[data-doc-img]')) {
        if (stale) return;
        const got = await doc.image(img.dataset.docImg).catch(() => null);
        if (stale) return;
        if (!got) {
          img.replaceWith(Object.assign(document.createElement('span'), { className: 'doc-no-picture', textContent: img.alt ? `[${img.alt}]` : '[picture]' }));
          continue;
        }
        const url = URL.createObjectURL(new Blob([got.bytes], { type: got.type }));
        urls.push(url);
        img.src = url;
      }
    })();
    return () => {
      stale = true;
      clearTimeout(letGo);
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [doc]);
  // Links inside the document go to their place here; the others open in the browser.
  const onClick = (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('href').slice(1));
  };
  const go = (id) => {
    const target = id && page.current?.querySelector(`#${CSS.escape(id)}`);
    anchor.current = null;
    target?.scrollIntoView({ block: 'start' });
  };
  return view(html`
    ${!compact && bar(html`<${ContentsButton} entries=${doc.toc} onGo=${(e) => go(e.target)} />${doc.title && html`<span class="doc-title" title=${doc.author ? `${doc.title} · ${doc.author}` : doc.title}>${doc.title}</span>`}`)}
    <div class="doc-scroll" tabindex="0" ref=${scroller}>
      <article class="doc-html markdown ${compact ? 'compact' : ''}" ref=${page} onClick=${onClick} />
    </div>`);
}

// ---- PDFs ----

const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const clampZoom = (z) => Math.max(0.25, Math.min(5, z));
// Pages drawn around the ones on screen; those further away let their canvas go.
const KEEP_AROUND = 4;

function PdfView({ pdf, pdfjs, compact, bar, view, nav, start, onText }) {
  const scroller = useRef(null);
  // The page opened at (the bookmark), kept while the pages' sizes and the fit settle, until the reader scrolls.
  const anchor = useRef(start?.page ? start : null);
  useHandScroll(scroller, () => (anchor.current = null));
  const pagesEl = useRef(null);
  const [sizes, setSizes] = useState(null); // [{ w, h }] in points, per page
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState('fit'); // 'fit' or a scale
  const [current, setCurrent] = useState(1);
  const [outline, setOutline] = useState([]);
  const drawn = useRef(new Map()); // page number → { scale, cancel }
  const pages = useRef(new Map()); // page number → PDFPageProxy
  const n = pdf.numPages;

  // The pages' sizes: the first at once (the others are taken to be like it until read).
  useEffect(() => {
    let stale = false;
    (async () => {
      const first = await pdf.getPage(1);
      const v = first.getViewport({ scale: 1 });
      pages.current.set(1, first);
      const list = Array.from({ length: n }, () => ({ w: v.width, h: v.height }));
      if (stale) return;
      setSizes(list);
      for (let i = 2; i <= n && !stale; i++) {
        const p = await pdf.getPage(i);
        pages.current.set(i, p);
        const pv = p.getViewport({ scale: 1 });
        if (pv.width !== v.width || pv.height !== v.height) list[i - 1] = { w: pv.width, h: pv.height };
        if (i % 50 === 0 || i === n) setSizes([...list]);
      }
    })().catch(() => {});
    (async () => {
      const { pdfOutline, pdfText } = await import('../pdfDoc.js');
      const items = await pdfOutline(pdf);
      if (!stale) setOutline(items.filter((e) => e.page).map((e) => ({ ...e, hint: String(e.page) })));
      // The text, after the pages show.
      await new Promise((r) => setTimeout(r, 600));
      const text = await pdfText(pdf, { stop: () => stale });
      if (!stale && text != null) onText?.(text);
    })().catch(() => {});
    return () => {
      stale = true;
    };
  }, [pdf]);

  // The width there is, for "fit".
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const widest = sizes ? Math.max(...sizes.map((s) => s.w)) : 612;
  const fitScale = width ? Math.max(0.25, (width - (compact ? 16 : 32)) / widest) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  // For the wheel and the fingers (their listeners stay; these follow each render).
  const scaleNow = useRef(scale);
  scaleNow.current = scale;
  const zoomRef = useRef(null);

  // Drawing what is on screen (and a little around it), each page at the scale now.
  useEffect(() => {
    const root = scroller.current;
    const box = pagesEl.current;
    if (!root || !box || !sizes) return;
    const visible = new Set();
    const draw = async (num) => {
      const have = drawn.current.get(num);
      if (have && have.scale === scale) return;
      have?.cancel();
      const el = box.children[num - 1];
      if (!el) return;
      const entry = { scale, cancel: () => {} };
      drawn.current.set(num, entry);
      const page = pages.current.get(num) ?? (await pdf.getPage(num));
      pages.current.set(num, page);
      if (drawn.current.get(num) !== entry) return;
      const { drawPage } = await import('../pdfDoc.js');
      const job = drawPage(pdfjs, page, el, scale);
      entry.cancel = job.cancel;
      job.done.catch(() => drawn.current.get(num) === entry && drawn.current.delete(num));
    };
    const release = () => {
      if (!visible.size) return;
      const lo = Math.min(...visible) - KEEP_AROUND;
      const hi = Math.max(...visible) + KEEP_AROUND;
      for (const [num, entry] of drawn.current) {
        if (num >= lo && num <= hi) continue;
        entry.cancel();
        drawn.current.delete(num);
        const el = box.children[num - 1];
        el?.querySelector('.pdf-canvas')?.remove();
        el?.querySelector('.textLayer')?.remove();
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const num = Number(e.target.dataset.page);
          if (e.isIntersecting) {
            visible.add(num);
            draw(num);
          } else visible.delete(num);
        }
        release();
      },
      { root, rootMargin: '150% 0px' },
    );
    for (const el of box.children) io.observe(el);
    return () => io.disconnect();
  }, [sizes, scale, pdf]);

  // The page at the middle of the screen, for the counter.
  const onScroll = () => {
    const root = scroller.current;
    const box = pagesEl.current;
    if (!root || !box) return;
    const mid = root.scrollTop + root.clientHeight / 3;
    let lo = 0;
    let hi = box.children.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (box.children[m].offsetTop <= mid) lo = m;
      else hi = m - 1;
    }
    if (lo + 1 !== current) setCurrent(lo + 1);
  };

  const goToPage = (num, into = 0) => {
    const el = pagesEl.current?.children[Math.max(0, Math.min(n, num) - 1)];
    if (el) scroller.current.scrollTop = into ? el.offsetTop + into * el.offsetHeight : el.offsetTop - 8;
  };
  // The page at the top of the screen, and how far into it.
  const here = () => {
    const root = scroller.current;
    const box = pagesEl.current;
    if (!root || !box?.children.length) return null;
    const top = root.scrollTop;
    let i = 0;
    while (i < box.children.length - 1 && box.children[i + 1].offsetTop <= top + 8) i++;
    const el = box.children[i];
    const into = Math.max(0, Math.min(1, (top - el.offsetTop) / Math.max(1, el.offsetHeight)));
    return { page: i + 1, pages: n, into: into < 0.02 ? 0 : Math.round(into * 1000) / 1000 };
  };
  nav.current = {
    here,
    go: (place) => {
      anchor.current = null;
      if (place?.page) goToPage(place.page, place.into);
    },
  };
  // A layout effect: the place is there before the first drawing.
  useLayoutEffect(() => {
    if (anchor.current && sizes && width) goToPage(anchor.current.page, anchor.current.into);
  }, [sizes, scale, width]);
  useEffect(() => {
    const letGo = setTimeout(() => (anchor.current = null), 15_000);
    return () => clearTimeout(letGo);
  }, []);

  // Zooming keeps the point under the fingers (or the middle of the screen) in its place.
  const zoomTo = (next, focus) => {
    const root = scroller.current;
    const to = next === 'fit' ? fitScale : clampZoom(next);
    if (!root) return setZoom(next);
    const fx = focus?.x ?? root.clientWidth / 2;
    const fy = focus?.y ?? root.clientHeight / 2;
    const ratio = to / scale;
    const left = (root.scrollLeft + fx) * ratio - fx;
    const top = (root.scrollTop + fy) * ratio - fy;
    setZoom(next === 'fit' ? 'fit' : to);
    requestAnimationFrame(() => {
      root.scrollLeft = left;
      root.scrollTop = top;
    });
  };
  zoomRef.current = zoomTo;
  const step = (dir) => {
    const now = scale;
    const next = dir > 0 ? (ZOOMS.find((z) => z > now + 0.001) ?? 5) : ([...ZOOMS].reverse().find((z) => z < now - 0.001) ?? 0.25);
    zoomTo(next);
  };

  // Ctrl+wheel (a touchpad's pinch too) and two fingers.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let turned = 0;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      turned += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(turned) < 40) return;
      const r = root.getBoundingClientRect();
      zoomRef.current(clampZoom(scaleNow.current * (turned < 0 ? 1.15 : 1 / 1.15)), { x: e.clientX - r.left, y: e.clientY - r.top });
      turned = 0;
    };
    let pinch = null;
    const apart = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e) => {
      if (e.touches.length !== 2) return void (pinch = null);
      const r = root.getBoundingClientRect();
      pinch = { apart: apart(e.touches), from: scaleNow.current, ratio: 1, x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
      pagesEl.current.style.transformOrigin = `${root.scrollLeft + pinch.x}px ${root.scrollTop + pinch.y}px`;
    };
    const onMove = (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.ratio = clampZoom(pinch.from * (apart(e.touches) / pinch.apart)) / pinch.from;
      pagesEl.current.style.transform = `scale(${pinch.ratio})`;
    };
    const onEnd = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      const { from, ratio, x, y } = pinch;
      pinch = null;
      pagesEl.current.style.transform = '';
      if (Math.abs(ratio - 1) > 0.02) zoomRef.current(from * ratio, { x, y });
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, []);
  // Pages let go of their drawings with the view.
  useEffect(
    () => () => {
      for (const entry of drawn.current.values()) {
        try {
          entry.cancel();
        } catch {
          // drawn already
        }
      }
    },
    [],
  );

  const controls = html`<${ContentsButton} entries=${outline} onGo=${(e) => goToPage(e.page)} />
    <span class="doc-pages muted small" title="The page at the top of the screen">${current} / ${n}</span>
    <span class="doc-zoom">
      <button type="button" class="icon-btn sm" aria-label="Smaller" title="Smaller (Ctrl+wheel, or pinch)" onClick=${() => step(-1)}>−</button>
      <button type="button" class="btn ghost sm doc-zoom-value ${zoom === 'fit' ? 'on' : ''}" title="Fit the width" onClick=${() => zoomTo('fit')}>${zoom === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}</button>
      <button type="button" class="icon-btn sm" aria-label="Larger" title="Larger (Ctrl+wheel, or pinch)" onClick=${() => step(1)}>+</button>
    </span>`;
  return view(
    html`
    ${compact ? html`<div class="doc-bar compact">${controls}</div>` : bar(controls)}
    <div class="doc-scroll pdf-view" ref=${scroller} tabindex="0" onScroll=${onScroll}>
      <div class="pdf-pages" ref=${pagesEl}>
        ${(sizes ?? []).map(
          (s, i) => html`<div class="pdf-page" key=${i} data-page=${i + 1} style=${{ width: `${Math.floor(s.w * scale)}px`, height: `${Math.floor(s.h * scale)}px` }} aria-label=${`Page ${i + 1}`} />`,
        )}
      </div>
    </div>`,
    'pdf',
  );
}
