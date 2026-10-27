// What the phone's Node.js (nodejs-mobile 18, built without ICU) lacks next to the desktop's,
// filled in before electron/main.cjs loads:
//   - Intl: none at all. Folders sort names with an Intl.Collator (numeric, case-insensitive).
//   - TextDecoder: no `fatal` option without ICU, which the desktop uses to tell UTF-8 files
//     from Latin-1 ones; buffer.isUtf8 does that check here.
//   - os.userInfo(): throws for an app's user (no passwd entry).
//   - fs.watch: no `recursive` on Linux before Node 20; the folder itself is watched instead.
const fs = require('node:fs');
const os = require('node:os');

/** A stand-in for Intl.Collator: numeric runs compare as numbers; 'base' / 'accent' ignore case. */
class Collator {
  constructor(_locales, options = {}) {
    this.numeric = Boolean(options.numeric);
    this.sensitivity = options.sensitivity ?? 'variant';
    this.compare = this.compare.bind(this);
  }

  resolvedOptions() {
    return { locale: 'und', numeric: this.numeric, sensitivity: this.sensitivity, usage: 'sort' };
  }

  compare(a, b) {
    const fold = (s) => (this.sensitivity === 'base' || this.sensitivity === 'accent' ? String(s).toLowerCase() : String(s));
    const x = fold(a);
    const y = fold(b);
    if (!this.numeric) return x < y ? -1 : x > y ? 1 : 0;
    const xs = x.match(/\d+|\D+/g) ?? [];
    const ys = y.match(/\d+|\D+/g) ?? [];
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      const p = xs[i];
      const q = ys[i];
      if (p === q) continue;
      if (/^\d/.test(p) && /^\d/.test(q)) {
        const d = Number(p) - Number(q);
        if (d) return d < 0 ? -1 : 1;
        if (p.length !== q.length) return p.length < q.length ? -1 : 1;
        continue;
      }
      return p < q ? -1 : 1;
    }
    return xs.length - ys.length < 0 ? -1 : xs.length > ys.length ? 1 : 0;
  }
}

/** TextDecoder with `fatal` for UTF-8 when the built-in one refuses it (no ICU). */
function strictUtf8Decoder(Native, isUtf8) {
  return class TextDecoder extends Native {
    constructor(label = 'utf-8', options = {}) {
      super(label, { ...options, fatal: false });
      this.strict = Boolean(options.fatal) && /^(utf-?8|unicode-1-1-utf-8)$/i.test(String(label).trim());
    }

    decode(input, options) {
      if (this.strict && input && !isUtf8(input)) throw new TypeError('The encoded data was not valid for encoding utf-8');
      return super.decode(input, options);
    }
  };
}

/** os.userInfo() for an app's user, which has no passwd entry. */
function userInfoFallback(userInfo) {
  return (options) => {
    try {
      return userInfo(options);
    } catch {
      const uid = process.getuid?.() ?? -1;
      return { uid, gid: process.getgid?.() ?? -1, username: process.env.USER || `u${uid}`, homedir: os.homedir(), shell: process.env.SHELL ?? null };
    }
  };
}

/** fs.watch that watches the folder itself when `recursive` is not available. */
function watchFallback(watch) {
  return function (file, options, listener) {
    try {
      return watch.call(this, file, options, listener);
    } catch (err) {
      if (err?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || !options?.recursive) throw err;
      return watch.call(this, file, { ...options, recursive: false }, listener);
    }
  };
}

function fillIn() {
  const filled = [];
  if (typeof globalThis.Intl === 'undefined') {
    globalThis.Intl = { Collator };
    filled.push('Intl.Collator');
  }
  try {
    new TextDecoder('utf-8', { fatal: true });
  } catch {
    const Decoder = strictUtf8Decoder(globalThis.TextDecoder, require('node:buffer').isUtf8);
    globalThis.TextDecoder = Decoder;
    require('node:util').TextDecoder = Decoder;
    filled.push('TextDecoder fatal');
  }
  os.userInfo = userInfoFallback(os.userInfo);
  fs.watch = watchFallback(fs.watch);
  return filled;
}

module.exports = { fillIn, Collator, strictUtf8Decoder, userInfoFallback, watchFallback };
