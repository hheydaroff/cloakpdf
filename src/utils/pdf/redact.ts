/**
 * Destructive redaction — rasterise box-carrying pages and burn the boxes in.
 */

import { PDFDocument } from "@pdfme/pdf-lib";
import { PDFJS_WASM_URL } from "../pdfjs-config.ts";
import { getPdfJs, canvasToImageBytes } from "./raster.ts";

/**
 * Permanently redact regions of a PDF — destructively.
 *
 * A black rectangle drawn on top of a page is NOT a redaction: the text and
 * images underneath survive in the byte stream and are trivially recovered by
 * copy/paste or text extraction. So instead, any page that carries a redaction
 * is **rasterised, has the black boxes burned into the pixels, and is rebuilt
 * as an image-only page** — the original text/vectors under (and around) the
 * boxes no longer exist in the output. Pages without redactions are copied
 * through untouched, so they keep their crisp vector text and small size.
 *
 * Trade-off (surfaced in the UI): redacted pages become flattened images —
 * their remaining text is no longer selectable and the file grows. That is the
 * standard, defensible cost of true redaction.
 *
 * Coordinates are fractions (0-1) of page width/height from the top-left.
 *
 * @param file - The source PDF file.
 * @param redactions - Array of redaction regions per page.
 * @returns A new PDF with the redacted areas permanently destroyed.
 */
export async function redactPdf(
  file: File,
  redactions: Array<{ pageIndex: number; xPct: number; yPct: number; wPct: number; hPct: number }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const arrayBuffer = await file.arrayBuffer();
  const src = await PDFDocument.load(arrayBuffer);
  const pageCount = src.getPageCount();

  // Group redaction rects by page.
  const byPage = new Map<number, typeof redactions>();
  for (const r of redactions) {
    if (r.pageIndex < 0 || r.pageIndex >= pageCount) continue;
    const list = byPage.get(r.pageIndex) ?? [];
    list.push(r);
    byPage.set(r.pageIndex, list);
  }
  if (byPage.size === 0) return src.save();

  const pdfjsLib = await getPdfJs();
  // PDF.js may detach the backing buffer — hand it its own copy so `src`
  // (used for copying untouched pages) stays valid.
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0), wasmUrl: PDFJS_WASM_URL });
  const pdfjsDoc = await loadingTask.promise;
  const REDACT_DPI = 150;
  const scale = REDACT_DPI / 72;

  // Only the box-carrying pages do real (slow) rasterisation work — report
  // progress over those, since the copy-through pages are near-instant.
  const total = byPage.size;
  let done = 0;

  const out = await PDFDocument.create();
  try {
    for (let i = 0; i < pageCount; i++) {
      const rects = byPage.get(i);
      if (!rects) {
        const [copied] = await out.copyPages(src, [i]);
        out.addPage(copied);
        continue;
      }

      const page = await pdfjsDoc.getPage(i + 1);
      try {
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Failed to acquire 2D canvas context");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        // Burn the redaction boxes into the pixels.
        ctx.fillStyle = "#000000";
        for (const r of rects) {
          ctx.fillRect(
            r.xPct * canvas.width,
            r.yPct * canvas.height,
            r.wPct * canvas.width,
            r.hPct * canvas.height,
          );
        }

        const jpeg = await canvasToImageBytes(canvas, "image/jpeg", 0.92);
        const img = await out.embedJpg(jpeg);
        const ptW = viewport.width / scale;
        const ptH = viewport.height / scale;
        const outPage = out.addPage([ptW, ptH]);
        outPage.drawImage(img, { x: 0, y: 0, width: ptW, height: ptH });

        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
      onProgress?.(++done, total);
    }
    return out.save();
  } finally {
    void loadingTask.destroy();
  }
}
