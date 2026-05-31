/**
 * Shared PDF.js configuration.
 *
 * Intentionally imports nothing from `pdfjs-dist` so the lazy-loading modules
 * (ocr-text, layout-extract, pdf-operations) can read these constants without
 * pulling PDF.js into their initial chunk.
 */

/**
 * Directory URL where pdfjs-dist's WASM image decoders are served.
 *
 * PDF.js v6 fetches `jbig2.wasm` / `openjpeg.wasm` / `qcms_bg.wasm` (plus their
 * JS fallbacks and the quickjs scripting runtime) from this directory to decode
 * CCITT-fax, JBIG2, JPEG2000 and ICC-colour images — without it, such images
 * (common in scanned documents) render as black boxes. Passed as the `wasmUrl`
 * option to every `getDocument()` call.
 *
 * The files are served by the `pdfjs-wasm-assets` plugin in vite.config.ts.
 * Must end with a trailing slash — PDF.js appends the filename and throws on a
 * URL without one.
 */
export const PDFJS_WASM_URL = `${import.meta.env.BASE_URL}pdfjs-wasm/`;
