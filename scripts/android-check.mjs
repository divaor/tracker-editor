// The Android check (.github/workflows/android-check.yml): installs a debug APK (built with
// WebView debugging on) on the emulator that is running, opens the app and checks, inside its
// real WebView over Chrome's DevTools protocol, what a desktop browser cannot stand in for:
// text from an image (tesseract's worker, core and models as the APK holds them), text to speech
// (Android's, through the app: spoken, and made into audio ahead for the page to play), a speech
// server on the computer next to the phone (KOKORO=its /v1 address, as the emulator reaches it),
// a PDF (pdf.js and its worker) and converted documents. Writes android-check/report.json, a
// screenshot and the WebView's console lines from logcat; exits 1 when a check fails.
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
        const voices = await t.loadVoices();
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
  // The screen as Android shows it (a page screenshot fails on some older WebViews).
  fs.writeFileSync(path.join(OUT, 'app.png'), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('ran', false, err.stack ?? String(err));
} finally {
  try {
    // The WebView's console only (never the app's own log, which may name files).
    fs.writeFileSync(path.join(OUT, 'webview-console.txt'), adb('logcat', '-d', '-s', 'chromium:*', 'Capacitor/Console:*'));
  } catch {
    // no log
  }
  await device?.close().catch(() => {});
}
fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
