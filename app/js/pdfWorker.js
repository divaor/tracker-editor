// pdf.js's worker (workerSrc in pdfDoc.js), with compat.js first. Also what pdf.js imports on
// the page when a worker cannot start (its "fake worker"), so it gives the same exports.
import './compat.js';
export * from '../vendor/pdf/pdf.worker.js';
