// What older WebViews (Android System WebView before Chrome 119) lack that the vendored
// libraries use without bringing it themselves: pdf.js's legacy build calls
// Promise.withResolvers. Imported before them, on the page and in pdf.js's worker (pdfWorker.js).
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
