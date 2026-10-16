/**
 * pdf.js, set up once, from its "legacy" build.
 *
 * The default build of pdf.js 6 is written for the newest browsers only: its
 * code uses syntax and built-ins (`Map.getOrInsertComputed`,
 * `Uint8Array.toBase64`, `Math.sumPrecise`, `Promise.withResolvers`) that a
 * phone a year or two old does not have. Importing it there failed outright,
 * and because the submit screen loads pdf.js the moment it opens, that screen
 * fell over with "Something went wrong" before showing anything. The legacy
 * build is the same library compiled for older browsers, which is what a
 * workplace full of personal phones needs.
 *
 * Every screen imports pdf.js from here, so the worker is configured in one
 * place and nothing can quietly go back to the modern build.
 */
// First, so it is in place before pdf.js runs: see the file.
import './promiseWithResolvers'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export { pdfjs }
