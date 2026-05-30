/**
 * Layout-aware PDF extraction powered by LlamaParse Lite (liteparse-wasm).
 *
 * Where {@link ./ocr-text.ts | extractPdfText} produces a flat reading-order
 * string per page (discarding geometry), this module preserves each text
 * item's bounding box. That geometry is what makes two features possible:
 *
 *   1. Layout-aware OCR — a *correctly positioned* invisible text layer for
 *      searchable PDFs (the old layer was stacked at a synthetic line height
 *      and never aligned with the page).
 *   2. Smart redaction — mapping a detected PII span back to a draw-able
 *      rectangle on the page.
 *
 * liteparse runs 100 % client-side as a ~4 MB Rust→WASM module. It extracts
 * the native text layer of digital PDFs directly (no OCR, no model weights).
 * Its *in-browser* OCR/rasterisation path is broken on the published 2.0.4
 * wasm (it traps and hangs — see the orchestration section), so for scanned /
 * text-sparse pages we OCR ourselves with PDF.js + Tesseract.js — the same
 * engine the rest of the app already uses — and convert the word boxes back to
 * the same geometry shape. Everything stays local; no file ever leaves the
 * browser.
 *
 * Coordinate convention (verified against fixtures): liteparse emits item
 * positions in PDF *point* space with a **top-left** origin (y grows
 * downward) — identical to the fraction convention RedactPdf uses, so the
 * conversion in {@link itemFractionRect} is a plain divide with no axis flip.
 *
 * The wasm-loading + Tesseract orchestration lives in {@link extractLayout}
 * (browser-only — it resolves the `.wasm` via a Vite `?url` import). The
 * shape-normalisation and geometry maths are split into pure exported helpers
 * ({@link normalizeParseResult}, {@link itemFractionRect},
 * {@link layoutToReadingOrderText}, {@link detectPiiRects}) so they unit-test
 * without a browser.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";
import { detectPii, type PiiType } from "./pii.ts";

/** A single positioned text run. Coordinates are PDF points, top-left origin. */
export interface LayoutItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

/** One page of extracted layout. */
export interface LayoutPage {
  /** 1-based page index. */
  pageNumber: number;
  /** Page width in PDF points. */
  width: number;
  /** Page height in PDF points. */
  height: number;
  /** liteparse's layout-preserved page text (whitespace approximates layout). */
  text: string;
  /** Positioned text runs in document order. */
  items: LayoutItem[];
}

/** A rectangle expressed as fractions (0–1) of page width/height, top-left origin. */
export interface FractionRect {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface ExtractLayoutOptions {
  /** Tesseract language code for OCR of scanned pages. Defaults to `"eng"`. */
  language?: string;
  /** Set `false` to skip OCR entirely (digital text layer only). */
  ocr?: boolean;
  /** Render DPI used when OCR'ing scanned pages. Higher = sharper, slower. Defaults to 200. */
  dpi?: number;
  /** Password for an encrypted PDF. */
  password?: string;
  /**
   * Called once per page that goes through the Tesseract OCR callback, so a
   * UI can show a determinate progress bar on scanned documents. `done` is the
   * running number of OCR'd pages; `total` is how many pages need OCR.
   */
  onOcrPage?: (done: number, total: number) => void;
  /**
   * Called once per page during the primary text-geometry pass of
   * {@link extractTextGeometry}, so a UI can show a determinate "reading page
   * X of N" bar on large documents. Not fired by {@link extractLayout} — its
   * liteparse `parse()` is a single opaque call with no per-page granularity.
   */
  onProgress?: (done: number, total: number) => void;
}

// ── pure helpers (no wasm — unit-testable) ────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Raw page shape returned by liteparse's `parse()` (loose by design). */
interface RawLiteParsePage {
  pageNum?: number;
  width?: number;
  height?: number;
  text?: string;
  textItems?: Array<{
    text?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fontSize?: number;
  }>;
}

/**
 * Convert liteparse's raw `{ text, pages }` result into our typed
 * {@link LayoutPage}[]. Pure — accepts the parsed object so it can be tested
 * against a real fixture without going through the browser wasm loader.
 */
export function normalizeParseResult(result: { pages?: RawLiteParsePage[] } | null): LayoutPage[] {
  const pages = result?.pages ?? [];
  return pages.map((p, idx) => ({
    pageNumber: typeof p.pageNum === "number" ? p.pageNum : idx + 1,
    width: p.width ?? 0,
    height: p.height ?? 0,
    text: p.text ?? "",
    items: (p.textItems ?? [])
      .filter((it) => typeof it.x === "number" && typeof it.y === "number")
      .map((it) => ({
        text: it.text ?? "",
        x: it.x ?? 0,
        y: it.y ?? 0,
        width: it.width ?? 0,
        height: it.height ?? 0,
        fontSize: it.fontSize ?? 0,
      })),
  }));
}

/** Bounding box of a whole item as a page-fraction rectangle. */
export function itemFractionRect(item: LayoutItem, page: LayoutPage): FractionRect {
  const w = page.width || 1;
  const h = page.height || 1;
  return {
    xPct: clamp01(item.x / w),
    yPct: clamp01(item.y / h),
    wPct: clamp01(item.width / w),
    hPct: clamp01(item.height / h),
  };
}

/**
 * Page-fraction rectangle for a substring `[start, end)` of an item's text.
 *
 * liteparse items are line/phrase granularity (no per-glyph geometry), so for
 * PII embedded mid-line we estimate the sub-span horizontally by proportional
 * character offset and pad outward by `padChars` characters' worth of width on
 * each side. Redaction favours over-covering: the pad guarantees we never
 * leave a sliver of the matched value exposed. The rect is clamped to the
 * item's own box.
 */
export function substringFractionRect(
  item: LayoutItem,
  page: LayoutPage,
  start: number,
  end: number,
  padChars = 0.75,
): FractionRect {
  const len = item.text.length || 1;
  // Guard against a missing/bogus item width: liteparse occasionally reports 0,
  // and degenerate OCR word boxes can too. A zero charW would collapse the box
  // to zero area — silently leaving the matched PII fully visible after
  // redaction. Estimate a per-char width from the glyph height instead so a
  // detected match always produces a covering box.
  let charW = item.width / len;
  if (!Number.isFinite(charW) || charW <= 0) charW = (item.height || item.fontSize || 8) * 0.6;
  const x0 = item.x + Math.max(0, start - padChars) * charW;
  let x1 = item.x + Math.min(len, end + padChars) * charW;
  if (x1 <= x0) x1 = x0 + Math.max(1, end - start) * charW;
  const w = page.width || 1;
  const h = page.height || 1;
  // Floor the drawn box to a small visible size so a real match is never
  // reported as redacted while painting nothing.
  const minW = 8 / w;
  const itemH = item.height || item.fontSize || 8;
  const minH = 6 / h;
  return {
    xPct: clamp01(x0 / w),
    yPct: clamp01(item.y / h),
    wPct: Math.max(minW, clamp01((x1 - x0) / w)),
    hPct: Math.max(minH, clamp01(itemH / h)),
  };
}

/**
 * Reconstruct clean reading-order text from positioned items.
 *
 * liteparse's own `page.text` preserves layout by padding with whitespace
 * (multi-column gutters become long space runs). For display and downstream
 * text use we instead group items into rows by their y-baseline (within
 * `rowTolerance` points), order rows top-to-bottom and items left-to-right,
 * and join with single spaces / newlines. This keeps multi-column reading
 * order correct without the gutters.
 */
export function layoutToReadingOrderText(page: LayoutPage, rowTolerance = 3): string {
  const items = page.items.filter((i) => i.text.trim().length > 0);
  if (items.length === 0) return page.text.trim();

  const rows: LayoutItem[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= rowTolerance) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows
    .map((row) =>
      [...row]
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text.trim())
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")
    .trim();
}

/** A detected PII span resolved to a redaction rectangle on a specific page. */
export interface PiiRect extends FractionRect {
  /** 0-based page index (matches RedactPdf's `pageIndex`). */
  pageIndex: number;
  type: PiiType;
  /** The matched text — for the review summary, never drawn into the output. */
  value: string;
}

/**
 * Detect PII across extracted pages and resolve each hit to a page-fraction
 * rectangle ready for redaction.
 *
 * We run {@link detectPii} per text item (PII values — emails, phones, IDs —
 * sit within a single line/phrase item), then map the matched character span
 * to geometry with {@link substringFractionRect}. The result drops straight
 * into RedactPdf's redaction map for user review. Pure — operates on the
 * extracted {@link LayoutPage}s, no wasm.
 */
export function detectPiiRects(
  pages: LayoutPage[],
  types?: PiiType[],
  rowTolerance = 3,
): PiiRect[] {
  const rects: PiiRect[] = [];
  const opts = types ? { types } : undefined;
  for (const page of pages) {
    const withText = page.items.filter((i) => i.text.length > 0);
    if (withText.length === 0) continue;

    // Group items into visual rows by y-baseline (same grouping as
    // layoutToReadingOrderText). A PII value like a phone number can arrive as
    // several whitespace-separated word-items on one line — Tesseract OCR
    // always splits on spaces, and PDF.js can split a run too — so detecting
    // per-item would miss it. We detect over the *reconstructed line* instead.
    const rows: LayoutItem[][] = [];
    for (const item of [...withText].sort((a, b) => a.y - b.y)) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - item.y) <= rowTolerance) row.push(item);
      else rows.push([item]);
    }

    for (const row of rows) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      // Build the line text, recording each item's [start, end) char range in it.
      let line = "";
      const spans: { item: LayoutItem; start: number; end: number }[] = [];
      for (const item of sorted) {
        if (line.length > 0) line += " ";
        const start = line.length;
        line += item.text;
        spans.push({ item, start, end: line.length });
      }

      for (const match of detectPii(line, opts)) {
        // Every item the match overlaps — usually one, but several for a
        // space-separated value (phone "123 456 7890", spaced card, IBAN…).
        const touched = spans.filter((s) => s.start < match.end && s.end > match.start);
        if (touched.length === 0) continue;
        // Union the per-item sub-rects so a multi-word value gets one box that
        // covers the whole span (partial first/last item, full interior items).
        let xMin = 1;
        let yMin = 1;
        let xMax = 0;
        let yMax = 0;
        for (const { item, start } of touched) {
          const localStart = Math.max(0, match.start - start);
          const localEnd = Math.min(item.text.length, match.end - start);
          const sub = substringFractionRect(item, page, localStart, localEnd);
          xMin = Math.min(xMin, sub.xPct);
          yMin = Math.min(yMin, sub.yPct);
          xMax = Math.max(xMax, sub.xPct + sub.wPct);
          yMax = Math.max(yMax, sub.yPct + sub.hPct);
        }
        rects.push({
          pageIndex: page.pageNumber - 1,
          type: match.type,
          value: match.value,
          xPct: clamp01(xMin),
          yPct: clamp01(yMin),
          wPct: clamp01(xMax - xMin),
          hPct: clamp01(yMax - yMin),
        });
      }
    }
  }
  return rects;
}

// ── browser orchestration (wasm + Tesseract) ──────────────────────────────
//
// IMPORTANT: liteparse extracts the digital text layer + geometry perfectly
// in the browser, but its *in-browser OCR/rasterisation* path traps
// (`RuntimeError: unreachable`) on the published 2.0.4 wasm and leaves the
// parse promise hung — verified in a real browser. So we run liteparse with
// `ocrEnabled: false` (text layer only) and OCR scanned / text-sparse pages
// ourselves with PDF.js + Tesseract, capturing word boxes so geometry is
// preserved on either path. A timeout guard turns any future wasm hang into a
// recoverable rejection instead of a frozen UI.

/** Below this many non-whitespace chars a page is treated as scanned → OCR. */
const MIN_TEXT_CHARS = 16;
/** Hard ceiling on a single liteparse parse() before we treat it as hung. */
const PARSE_TIMEOUT_MS = 30_000;

let _initPromise: Promise<typeof import("@llamaindex/liteparse-wasm")> | null = null;

/**
 * Lazily load + initialise the liteparse wasm module exactly once. The `.wasm`
 * is resolved via Vite's `?url` import so the ~4 MB binary is emitted as a
 * hashed asset and fetched on demand — digital-PDF tools that never touch
 * layout extraction pay nothing.
 */
async function getLiteParse(): Promise<typeof import("@llamaindex/liteparse-wasm")> {
  if (!_initPromise) {
    _initPromise = (async () => {
      const mod = await import("@llamaindex/liteparse-wasm");
      const { default: wasmUrl } =
        await import("@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url");
      await mod.default({ module_or_path: wasmUrl });
      return mod;
    })();
  }
  return _initPromise;
}

let _pdfjsLib: typeof import("pdfjs-dist") | null = null;
async function getPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!_pdfjsLib) {
    const { default: workerSrc } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&url");
    _pdfjsLib = await import("pdfjs-dist");
    _pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return _pdfjsLib;
}

/** Reject if `promise` hasn't settled within `ms` — guards against a wasm hang. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Non-whitespace character count across a page's items. */
function pageTextLength(page: LayoutPage): number {
  let n = 0;
  for (const item of page.items) n += item.text.replace(/\s+/g, "").length;
  return n;
}

/**
 * OCR the given page numbers with Tesseract and write positioned items back
 * onto the matching {@link LayoutPage}s. We render each page with PDF.js at
 * `dpi`, recognise it, and convert Tesseract's pixel-space word boxes to PDF
 * points (`point = pixel / scale`, top-left origin — matching liteparse), so
 * a scanned page ends up with the same geometry shape as a digital one.
 */
async function ocrScannedPages(
  file: File,
  pages: LayoutPage[],
  pageNumbers: number[],
  language: string,
  dpi: number,
  onOcrPage: ((done: number, total: number) => void) | undefined,
  existingPdf?: PDFDocumentProxy,
): Promise<void> {
  const { createWorker } = await import("tesseract.js");
  // Reuse the caller's already-open PDF.js document when given one (saves a
  // second full decode + parse of the same file); otherwise open our own and
  // destroy it when done.
  let pdf: PDFDocumentProxy;
  const ownPdf = !existingPdf;
  if (existingPdf) {
    pdf = existingPdf;
  } else {
    const pdfjsLib = await getPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  }
  const scale = dpi / 72;
  const total = pageNumbers.length;
  let done = 0;
  try {
    // Create the worker *inside* the try so a createWorker rejection still
    // hits the outer finally that destroys our PDF.js document — and only
    // terminate a worker that was actually created.
    const worker = await createWorker(language);
    try {
      for (const pageNumber of pageNumbers) {
        const target = pages.find((p) => p.pageNumber === pageNumber);
        if (!target || pageNumber < 1 || pageNumber > pdf.numPages) continue;
        const page = await pdf.getPage(pageNumber);
        try {
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) continue;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          const { data } = await worker.recognize(canvas);
          canvas.width = 0;
          canvas.height = 0;

          // Page dimensions in points (liteparse may report 0 for image-only pages).
          if (!target.width || !target.height) {
            const base = page.getViewport({ scale: 1 });
            target.width = base.width;
            target.height = base.height;
          }

          const items: LayoutItem[] = [];
          for (const block of data.blocks ?? []) {
            for (const paragraph of block.paragraphs) {
              for (const line of paragraph.lines) {
                for (const word of line.words) {
                  const text = word.text?.trim();
                  if (!text) continue;
                  const { x0, y0, x1, y1 } = word.bbox;
                  items.push({
                    text,
                    x: x0 / scale,
                    y: y0 / scale,
                    width: (x1 - x0) / scale,
                    height: (y1 - y0) / scale,
                    fontSize: (y1 - y0) / scale,
                  });
                }
              }
            }
          }
          target.items = items;
          target.text = items.length ? layoutToReadingOrderText(target) : (data.text ?? "").trim();
        } finally {
          page.cleanup();
        }
        onOcrPage?.(++done, total);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } finally {
      await worker.terminate();
    }
  } finally {
    if (ownPdf) void pdf.destroy();
  }
}

/**
 * Extract layout-aware text + per-item geometry from a PDF, 100 % in-browser.
 *
 * Digital pages are read from the text layer by liteparse; scanned /
 * text-sparse pages are OCR'd with PDF.js + Tesseract (see the note above for
 * why we don't use liteparse's own OCR). Returns one {@link LayoutPage} per
 * page in document order.
 */
export async function extractLayout(
  file: File,
  options: ExtractLayoutOptions = {},
): Promise<LayoutPage[]> {
  const language = options.language ?? "eng";
  const ocrEnabled = options.ocr !== false;
  const dpi = options.dpi ?? 200;
  const mod = await getLiteParse();
  const bytes = new Uint8Array(await file.arrayBuffer());

  const config: Record<string, unknown> = {
    ocrEnabled: false, // liteparse in-browser OCR is broken; we OCR ourselves
    outputFormat: "json",
    quiet: true,
  };
  if (options.password) config.password = options.password;

  const parser = new mod.LiteParse(config);
  let pages: LayoutPage[];
  try {
    const result = await withTimeout(parser.parse(bytes), PARSE_TIMEOUT_MS, "liteparse parse");
    pages = normalizeParseResult(result);
  } finally {
    (parser as { free?: () => void }).free?.();
  }

  if (ocrEnabled) {
    const sparse = pages.filter((p) => pageTextLength(p) < MIN_TEXT_CHARS).map((p) => p.pageNumber);
    if (sparse.length > 0) {
      await ocrScannedPages(file, pages, sparse, language, dpi, options.onOcrPage);
    }
  }

  return pages;
}

/**
 * Extract per-item geometry for **redaction** using PDF.js's text layer.
 *
 * Why a second extractor instead of {@link extractLayout}? liteparse is great
 * at reading-order text, but it *merges* runs and occasionally reports an
 * unreliable item width (e.g. 29 pt for a 69-character line) — which throws a
 * sub-line PII box to the wrong place and can leave the value exposed. PDF.js
 * `getTextContent` gives each run a trustworthy width + position, which is
 * exactly what redaction needs to land the box precisely.
 *
 * Coordinates are converted to the same top-left point space the rest of this
 * module uses (PDF.js reports a bottom-left baseline). Scanned / text-sparse
 * pages fall back to Tesseract word boxes via {@link ocrScannedPages}, so the
 * output shape is identical for digital and scanned input.
 */
export async function extractTextGeometry(
  file: File,
  options: ExtractLayoutOptions = {},
): Promise<LayoutPage[]> {
  const language = options.language ?? "eng";
  const ocrEnabled = options.ocr !== false;
  const dpi = options.dpi ?? 200;
  const pdfjsLib = await getPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages: LayoutPage[] = [];
  try {
    const total = pdf.numPages;
    for (let i = 1; i <= total; i++) {
      const page = await pdf.getPage(i);
      try {
        // The default viewport applies the page's /Rotate, so its width/height
        // and convertToViewportPoint() live in the same rotated, top-left frame
        // that renderAllThumbnails (preview/manual boxes) and redactPdf (burn-in)
        // use. Mapping each run's corners through it keeps auto-detected boxes
        // correctly placed on rotated pages, not just upright ones.
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: LayoutItem[] = [];
        for (const raw of content.items) {
          const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
          const text = it.str ?? "";
          if (!text.trim() || !it.transform) continue;
          const tr = it.transform;
          const height = it.height || Math.hypot(tr[1], tr[3]) || 0;
          const width = it.width ?? 0;
          // Convert the run's baseline-left and opposite (top-right) corners from
          // PDF user space into rotated viewport space, then take the
          // axis-aligned bounding box. For an unrotated page this reduces to the
          // old `y = viewport.height - tr[5] - height` formula.
          const [ax, ay] = viewport.convertToViewportPoint(tr[4], tr[5]);
          const [bx, by] = viewport.convertToViewportPoint(tr[4] + width, tr[5] + height);
          items.push({
            text,
            x: Math.min(ax, bx),
            y: Math.min(ay, by),
            width: Math.abs(bx - ax),
            height: Math.abs(by - ay),
            fontSize: height,
          });
        }
        pages.push({
          pageNumber: i,
          width: viewport.width,
          height: viewport.height,
          text: "",
          items,
        });
      } finally {
        page.cleanup();
      }
      options.onProgress?.(i, total);
    }

    if (ocrEnabled) {
      const sparse = pages
        .filter((p) => pageTextLength(p) < MIN_TEXT_CHARS)
        .map((p) => p.pageNumber);
      if (sparse.length > 0) {
        // Hand our already-open document to the OCR pass so it doesn't decode +
        // parse the same file a second time.
        await ocrScannedPages(file, pages, sparse, language, dpi, options.onOcrPage, pdf);
      }
    }
  } finally {
    void pdf.destroy();
  }
  for (const p of pages) if (!p.text) p.text = layoutToReadingOrderText(p);
  return pages;
}
