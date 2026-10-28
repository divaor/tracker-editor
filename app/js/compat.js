// What older WebViews (Android System WebView before Chrome 124) lack that the vendored
// libraries use without bringing it themselves: pdf.js's legacy build calls
// ArrayBuffer#transferToFixedLength (Chrome 114), Promise.withResolvers (Chrome 119) and reads
// streams with `for await` (Chrome 124). Imported before them, on the page and in pdf.js's
// worker (pdfWorker.js); checked in Chrome 113 and by the Android check.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof ReadableStream === 'function' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype.values = function values({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const step = await reader.read();
          if (step.done) reader.releaseLock();
          return step;
        } catch (err) {
          reader.releaseLock();
          throw err;
        }
      },
      // Leaving the loop early cancels the stream (unless `preventCancel`), as the standard does.
      async return(value) {
        const cancelled = preventCancel ? null : reader.cancel(value);
        reader.releaseLock();
        await cancelled;
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}

// A copy where the browser cannot move the memory (the old buffer stays usable: only memory differs).
for (const name of ['transfer', 'transferToFixedLength']) {
  if (typeof ArrayBuffer.prototype[name] !== 'function') {
    Object.defineProperty(ArrayBuffer.prototype, name, {
      configurable: true,
      writable: true,
      value(length = this.byteLength) {
        const copy = new ArrayBuffer(length);
        new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
        return copy;
      },
    });
  }
}
