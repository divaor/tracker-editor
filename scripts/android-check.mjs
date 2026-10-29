// The Android check (.github/workflows/android-check.yml): installs a debug APK (built with
// WebView debugging on) on the emulator that is running, opens the app and checks, inside its
// real WebView over Chrome's DevTools protocol, what a desktop browser cannot stand in for:
// text from an image (tesseract's worker, core and models as the APK holds them), text to speech
// (Android's, through the app: spoken, and made into audio ahead for the page to play), a speech
// server on the computer next to the phone (KOKORO=its /v1 address, as the emulator reaches it),
// a PDF (pdf.js and its worker), converted documents, a shell on the phone (its Node.js and
// pty addon, directly and through the terminal panel) and turning the app sideways. Writes
// android-check/report.json, screenshots, the WebView's console lines and Node's from logcat;
// exits 1 when a check fails.
//   [KOKORO=http://10.0.2.2:8880/v1] node scripts/android-check.mjs path/to/app-debug.apk
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _android as android } from 'playwright-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG = 'com.divaor.trackereditor';
const OUT = path.join(ROOT, 'android-check');
const apk = process.argv[2];
if (!apk) throw new Error('Usage: node scripts/android-check.mjs app-debug.apk');
fs.mkdirSync(OUT, { recursive: true });

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 180_000 });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600) : ''}`);
};
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test/fixtures/documents', name)).toString('base64');
// Taps the text a native dialog shows (uiautomator's dump of the screen); false when it never shows.
const tapText = async (text, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/window.xml');
      const xml = adb('shell', 'cat', '/sdcard/window.xml');
      const m = new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
      if (m) {
        adb('shell', 'input', 'tap', String((Number(m[1]) + Number(m[3])) >> 1), String((Number(m[2]) + Number(m[4])) >> 1));
        return true;
      }
    } catch {
      // the screen was busy (an animation): look again
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
};
const screencap = (name) => fs.writeFileSync(path.join(OUT, name), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
// One part failing does not stop the others.
const part = async (name, run) => {
  try {
    await run();
  } catch (err) {
    check(name, false, err.stack ?? String(err));
  }
};

let device;
try {
  console.log(adb('shell', 'getprop', 'ro.product.cpu.abilist').trim(), '| WebView', adb('shell', 'dumpsys', 'package', 'com.google.android.webview').match(/versionName=(\S+)/)?.[1] ?? '?');
  adb('install', '-r', '-g', apk);
  // All files access (a special permission install -g does not give), for folders in the phone's storage.
  adb('shell', 'appops', 'set', '--uid', PKG, 'MANAGE_EXTERNAL_STORAGE', 'allow');
  // The screen on and unlocked (an emulator started from a snapshot may have it off).
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'wm', 'dismiss-keyguard');
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-W', '-n', `${PKG}/.MainActivity`);
  [device] = await android.devices({ omitDriverInstall: true });
  const webview = await device.webView({ pkg: PKG }, { timeout: 120_000 });
  const page = await webview.page();
  page.setDefaultTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.topbar', { state: 'attached' });
  check('the app’s page loads', true, await page.evaluate(() => `${location.href} · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]}`));

  // Text from an image: a picture drawn here, read in English and in Spanish.
  for (const langs of ['eng', 'spa']) await part(`text from an image (${langs})`, async () => {
    const ocr = await page.evaluate(async (langs) => {
      const { recognize } = await import('/js/ocrEngine.js');
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 220;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      g.font = '56px sans-serif';
      g.fillText('Hello Tracker 2026', 40, 130);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const steps = [];
      const t = Date.now();
      try {
        const r = await recognize(blob, { langs, onProgress: (m) => steps.includes(m.status) || steps.push(m.status) });
        return { text: r.text, confidence: r.confidence, steps, ms: Date.now() - t };
      } catch (err) {
        return { error: err?.message ?? String(err), steps, ms: Date.now() - t };
      }
    }, langs);
    check(`text from an image (${langs})`, /Hello Tracker 2026/.test(ocr.text ?? ''), ocr);
  });

  // Read aloud: Android's text to speech through the app (the WebView has no speechSynthesis).
  await part('text to speech', async () => {
    const tts = await page.evaluate(async () => {
      const t = window.desktop?.android?.tts;
      if (!t) return { error: 'no tts bridge' };
      const out = { web: typeof window.speechSynthesis };
      try {
        // An engine just started may list none yet: the app asks again, and so does the check.
        let voices = await t.loadVoices();
        for (let i = 0; i < 8 && !voices.length; i++) voices = await new Promise((r) => setTimeout(r, 2000)).then(() => t.loadVoices());
        out.voices = voices.length;
        out.sample = voices.slice(0, 3).map((v) => `${v.name} (${v.lang})`);
      } catch (err) {
        return { ...out, error: err.message };
      }
      if (!out.voices) return out;
      const started = Date.now();
      out.spoken = await Promise.race([
        t.speak({ text: 'Hello from the check.', lang: 'en-US' }).then(() => 'done', (err) => `error: ${err.message}`),
        new Promise((r) => setTimeout(() => r('no answer in 20 s'), 20_000)),
      ]);
      out.ms = Date.now() - started;
      return out;
    });
    // An emulator image without a speech engine says so; that is not the app's fault.
    if (/no text-to-speech engine/.test(tts.error ?? '')) return check('text to speech (no engine on this emulator)', true, tts);
    check('text to speech: the phone’s voices', !tts.error && tts.voices > 0, tts);
    if (tts.voices) check('…and one speaks', tts.spoken === 'done', tts);
  });

  // A PDF: opened by pdf.js, its first page drawn, its worker a real one.
  // Reading a few sentences to the end with the reader (reader.js), in the engine the settings name:
  // how many passages there were, how many audios started, the error if any.
  const readThrough = (tts) =>
    page.evaluate(async (tts) => {
      const { startReading, getReaderState, onReaderState, stopReading } = await import('/js/reader.js');
      const { saveSettings } = await import('/js/settings.js');
      saveSettings({ tts });
      const played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        played.push(Math.round(performance.now()));
        return play.call(this);
      };
      const t0 = performance.now();
      const end = new Promise((resolve) => {
        const off = onReaderState((s) => s.status === 'idle' && (off(), resolve(s)));
      });
      try {
        // Over 240 characters, so the phone's voices read it sentence by sentence.
        startReading({ key: 'check', name: 'Check', lang: 'en', text: 'This is the first sentence the phone reads aloud here, and it goes on for a little while longer. Then a second one follows it, made into audio while the first one was still playing. And a third one closes the check, so that there is more than one passage to read through.' });
        const total = getReaderState().total;
        const state = await Promise.race([end, new Promise((r) => setTimeout(() => r({ error: 'no end in 90 s' }), 90_000))]);
        return { total, played: played.length, starts: played.map((t) => t - Math.round(t0)), ms: Math.round(performance.now() - t0), error: state.error ?? '' };
      } catch (err) {
        return { error: err?.message ?? String(err) };
      } finally {
        stopReading();
        HTMLMediaElement.prototype.play = play;
        saveSettings({ tts: { engine: 'device' } });
      }
    }, tts);

  await part('the phone’s voices made ahead', async () => {
    const made = await page.evaluate(async () => {
      const t = window.desktop.android.tts;
      try {
        const blob = await t.synthesize({ text: 'Made into audio, not spoken.', lang: 'en-US' });
        const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        return { size: blob.size, type: blob.type, riff: String.fromCharCode(...head), engines: t.engines() };
      } catch (err) {
        return { error: err?.message ?? String(err), code: err?.code, engines: t.engines() };
      }
    });
    if (/no text-to-speech engine/.test(made.error ?? '')) return check('the phone’s voices made ahead (no engine on this emulator)', true, made);
    check('the phone’s voices: a passage made into audio, not spoken', made.size > 1000 && made.riff === 'RIFF', made);
    check('…the phone’s engines listed', made.engines?.engines?.some((e) => e.name === made.engines.engine), made.engines);
    const run = await readThrough({ engine: 'device', voice: '' });
    check('…a reading played through, each passage made ahead', !run.error && run.total >= 2 && run.played === run.total, run);
  });

  if (process.env.KOKORO) await part('Kokoro on the computer', async () => {
    const base = process.env.KOKORO;
    const got = await page.evaluate(async (base) => {
      const { localFetch } = await import('/js/localFetch.js');
      try {
        const res = await localFetch(`${base}/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'kokoro', voice: 'af_heart', input: 'Hello from Kokoro on the computer.', response_format: 'mp3' }) });
        const blob = await res.blob();
        return { status: res.status, type: res.headers.get('content-type'), size: blob.size };
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    }, base);
    check('Kokoro on the computer answers the phone app (plain http on its network)', got.status === 200 && got.size > 1000, got);
    const run = await readThrough({ engine: 'server', server: { baseUrl: base, model: 'kokoro', voice: 'af_heart' } });
    check('…and reads a text through to the end', !run.error && run.total >= 1 && run.played === run.total, run);
  });

  await part('a PDF is drawn', async () => {
    const pdf = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const { openPdf, pdfLib, drawPage, pdfText } = await import('/js/pdfDoc.js');
      const doc = await openPdf(bytes);
      const box = document.createElement('div');
      box.className = 'pdf-page';
      box.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:800px;z-index:99';
      document.body.append(box);
      const job = drawPage(await pdfLib(), await doc.getPage(1), box, 1);
      await job.done;
      const canvas = box.querySelector('canvas');
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 16) if (data[i] < 128) dark++;
      const text = await pdfText(doc);
      const realWorker = doc.loadingTask._worker?.port instanceof Worker;
      box.remove();
      await doc.loadingTask.destroy();
      return { pages: doc.numPages, dark, realWorker, text: text.slice(0, 60) };
    }, fixture('libreoffice.pdf'));
    check('a PDF is drawn', pdf.dark > 100 && /Part one/.test(pdf.text), pdf);
    check('…by pdf.js’s own worker', pdf.realWorker, pdf);
  });

  // Documents converted on the page (zip, XML, DecompressionStream).
  for (const [name, kind, words] of [['pandoc.docx', 'docx', 'Nested one'], ['pandoc.epub', 'epub', 'Second chapter'], ['openpyxl.xlsx', 'xlsx', 'Merged note']]) await part(`${name} is converted`, async () => {
    const doc = await page.evaluate(async ({ b64, kind }) => {
      const { convertDocument } = await import('/js/documents.js');
      const d = await convertDocument(kind, Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
      return { text: d.text.slice(0, 2000) };
    }, { b64: fixture(name), kind });
    check(`${name} is converted`, doc.text.includes(words), doc.text.slice(0, 80));
  });
  // A shell on the phone (the app's Node.js, its pty addon): opens in a folder of the phone's
  // storage, shows its prompt and runs a command. Its output may come before the answer to open.
  await part('a terminal on the phone', async () => {
    const run = await page.evaluate(async (cwd) => {
      const t = window.desktop.terminal;
      const out = { events: [] };
      window.__checkTerm = out;
      out.off = [t.onData(({ id, data }) => out.events.push({ id, data, at: Date.now() })), t.onExit(({ id, code }) => out.events.push({ id, exit: code ?? 0, at: Date.now() }))];
      const t0 = Date.now();
      try {
        const opened = await Promise.race([t.open('local', { cols: 80, rows: 24, cwd }), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 20 s')), 20_000))]);
        out.id = opened.id;
        out.openMs = Date.now() - t0;
        out.answered = Date.now();
      } catch (err) {
        return { error: err.message };
      }
      const mine = () => out.events.filter((e) => e.id === out.id);
      await new Promise((r) => setTimeout(r, 2000));
      const prompt = mine().map((e) => e.data ?? '').join('');
      t.input(out.id, 'echo hi-$((40+2))\r');
      await new Promise((r) => setTimeout(r, 2500));
      return { id: out.id, openMs: out.openMs, prompt, data: mine().map((e) => e.data ?? '').join(''), exit: mine().find((e) => 'exit' in e)?.exit, beforeAnswer: mine().filter((e) => e.at < out.answered).length };
    }, '/storage/emulated/0/Download');
    // What the system says about it: the app's processes and SELinux denials.
    let system = '';
    try {
      const ps = adb('shell', 'ps', '-A', '-o', 'PID,PPID,NAME').split('\n').filter((l) => /trackereditor|\bsh\b/.test(l));
      const denied = adb('shell', "logcat -d | grep 'avc: *denied' | grep untrusted_app | tail -n 8").split('\n').filter(Boolean);
      system = { ps, denied };
    } catch (err) {
      system = String(err.message).slice(0, 300);
    }
    await page.evaluate(() => {
      const out = window.__checkTerm;
      if (out?.id) window.desktop.terminal.close(out.id);
      out?.off?.forEach((off) => off?.());
    });
    check('a terminal on the phone opens', !run.error && run.id, run);
    check('…in the phone’s Download folder, with its prompt', /Download/.test(run.prompt ?? ''), { prompt: run.prompt?.slice(0, 200), beforeAnswer: run.beforeAnswer, system });
    check('…and runs a command', /hi-42/.test(run.data ?? ''), { data: run.data?.slice(0, 300), exit: run.exit });
  });

  // The same through the app: Ctrl+` opens the panel with a shell, its prompt on the screen,
  // and what is typed into it runs.
  await part('the terminal panel', async () => {
    await page.keyboard.press('Control+Backquote');
    const screen = () => page.evaluate(() => document.querySelector('.terminal-screen:not([hidden]) .xterm-rows')?.innerText ?? null);
    let shown = null;
    for (let i = 0; i < 20 && !/\$\s*$/.test((shown = await screen()) ?? ''); i++) await page.waitForTimeout(500);
    check('the terminal panel shows the shell’s prompt', /\$/.test(shown ?? ''), (shown ?? 'no terminal screen').trim().slice(0, 300));
    await page.focus('.terminal-screen:not([hidden]) .xterm-helper-textarea');
    await page.keyboard.type('echo ui-$((6*7))');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 10 && !/ui-42/.test((shown = await screen()) ?? ''); i++) await page.waitForTimeout(500);
    check('…and runs what is typed', /ui-42/.test(shown ?? ''), (shown ?? '').trim().slice(-300));
  });

  // Turning sideways (a folder comparison or two panes on a phone held upright): the app asks
  // Android for landscape, and lets it turn back. Rotation by hand, upright, so back is portrait.
  await part('turning sideways', async () => {
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    const look = () => page.evaluate(() => ({ type: screen.orientation?.type, w: innerWidth, h: innerHeight }));
    const turned = async (way) => {
      let now;
      for (let i = 0; i < 20 && !(now = await look()).type?.startsWith(way); i++) await page.waitForTimeout(500);
      return now;
    };
    const before = await look();
    await page.evaluate(() => window.desktop.android.sideways(true));
    const side = await turned('landscape');
    check('Sideways turns the app to landscape', side.type?.startsWith('landscape') && side.w > side.h, { before, side });
    await page.evaluate(() => window.desktop.android.sideways(false));
    const back = await turned('portrait');
    check('…and Upright lets it turn back', back.type?.startsWith('portrait') && back.h > back.w, back);
  });

  // Two folders compared on the phone: Download picked in the app's own chooser (tapped there),
  // two folders in it compared through the bridge and in a tab (one tree upright, two columns
  // sideways, with the bar's Sideways and Upright), then as two panes (one at a time).
  await part('a folder comparison on the phone', async () => {
    const base = '/storage/emulated/0/Download';
    const [A, B] = [`${base}/cmp-a`, `${base}/cmp-b`];
    adb('shell', `rm -rf ${A} ${B}; mkdir -p ${A} ${B} && echo one > ${A}/same.txt && echo one > ${B}/same.txt && echo left > ${A}/only-left.md && echo a > ${A}/changed.txt && echo bbb > ${B}/changed.txt`);
    await page.evaluate(() => {
      window.__picked = window.desktop.folders.pick().catch((err) => ({ error: err.message }));
    });
    const tapped = await tapText('Download');
    const picked = await page.evaluate(() => window.__picked);
    check('the folder chooser picks Download', tapped && picked === base, { tapped, picked });
    const scan = await page.evaluate(([a, b]) => window.desktop.compare.scan(a, b).catch((err) => ({ error: err.message })), [A, B]);
    const names = (side) => (scan?.[side]?.entries ?? scan?.[side] ?? []).map?.((e) => e.rel ?? e.name).sort?.() ?? [];
    check('the comparison lists both folders', !scan?.error && JSON.stringify(scan).includes('only-left.md') && JSON.stringify(scan).includes('changed.txt'), scan?.error ?? { left: names('left'), right: names('right') });
    const looks = () => page.evaluate(() => ({ one: document.querySelectorAll('.fcmp-row.one').length, two: document.querySelectorAll('.fcmp-cell.left').length, btn: document.querySelector('.sideways-btn')?.textContent?.trim() ?? null, type: screen.orientation?.type, w: innerWidth, h: innerHeight }));
    const until = async (test, ms = 15_000) => {
      let now;
      for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(400)) if (test((now = await looks()))) break;
      return now;
    };
    const key = await page.evaluate(async ([a, b]) => {
      const { store } = await import('/js/store.js');
      store.openCompare({ mode: 'folders', left: { path: a }, right: { path: b }, show: 'diff' });
      return store.session.active;
    }, [A, B]);
    const upright = await until((l) => l.one >= 2);
    check('upright: one tree, with Sideways in the bar', upright.one >= 2 && upright.two === 0 && upright.btn === 'Sideways', upright);
    screencap('compare-upright.png');
    await page.click('.sideways-btn');
    const side = await until((l) => l.type?.startsWith('landscape') && l.two >= 2);
    check('Sideways: the app turns, the two folders side by side', side.type?.startsWith('landscape') && side.w > side.h && side.two >= 2 && side.one === 0 && side.btn === 'Upright', side);
    screencap('compare-sideways.png');
    await page.click('.sideways-btn');
    const again = await until((l) => l.type?.startsWith('portrait') && l.one >= 2);
    check('Upright: back to one tree', again.type?.startsWith('portrait') && again.one >= 2, again);
    const copied = await page.evaluate(([a, b]) => window.desktop.compare.copy(a, b, ['only-left.md']).then(() => true, (err) => err.message), [A, B]);
    check('copying across writes the other folder', copied === true && adb('shell', `cat ${B}/only-left.md`).trim() === 'left', copied);
    // Two panes: one at a time, a switch between them.
    const panes = await page.evaluate(async ([a, b, k]) => {
      const { store } = await import('/js/store.js');
      store.close(k);
      store.openCompare({ mode: 'panes', left: { path: a }, right: { path: b } });
      for (let i = 0; i < 40 && !document.querySelector('.panes.one .pane-row'); i++) await new Promise((r) => setTimeout(r, 300));
      const shown = [...document.querySelectorAll('.pane')].filter((p) => p.offsetWidth > 0).length;
      const out = { one: Boolean(document.querySelector('.panes.one')), shown, tabs: document.querySelector('.panes-switch')?.textContent ?? null };
      store.close(store.session.active);
      return out;
    }, [A, B, key]);
    check('two panes: one at a time, with the switch', panes.one && panes.shown === 1 && /cmp-a/.test(panes.tabs ?? '') && /cmp-b/.test(panes.tabs ?? ''), panes);
  });

  // The screen as Android shows it (a page screenshot fails on some older WebViews).
  screencap('app.png');
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('ran', false, err.stack ?? String(err));
} finally {
  try {
    // The WebView's console only (never the app's own log, which may name files).
    fs.writeFileSync(path.join(OUT, 'webview-console.txt'), adb('logcat', '-d', '-s', 'chromium:*', 'Capacitor/Console:*'));
    // Node's own lines (its version, errors; it logs no tokens): the emulator holds only the check's files.
    fs.writeFileSync(path.join(OUT, 'node.txt'), adb('logcat', '-d', '-s', 'TrackerNode:*'));
  } catch {
    // no log
  }
  await device?.close().catch(() => {});
}
fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
