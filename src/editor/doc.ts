// doc.ts — The canvas editor's document model.
//
// `CanvasDoc` is the single source of truth every tool, the canvas, and (later)
// the headless workflow runner mutate through `applyTransform`. It is
// deliberately NON-DESTRUCTIVE: `bytes` is the canonical pdf-lib-writable
// source, and overlay edits live as `objects` (fraction-rect tagged shapes)
// that are burned into bytes only at export. See REDESIGN.md for the rationale
// (history snapshots cheap bytes-by-ref + object deltas, never page rasters).

import { PDFDocument } from "@pdfme/pdf-lib";
import { PREVIEW_SCALE, renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";
import type { FractionRect } from "./types.ts";

/** Per-page geometry + cached preview. Dimensions are in PDF points (the space
 *  pdf-lib writes in) and taken from the CropBox — the visible box PDF.js
 *  renders — so the focus canvas aspect ratio always matches the thumbnail,
 *  even for cropped pages or inputs that ship a CropBox. `rotation` is the
 *  page's own /Rotate angle. */
export interface PageMeta {
  index: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  /** PDF.js blob: URL preview, or null before it renders. Revoke on replace. */
  thumbUrl: string | null;
}

/** Tagged overlay kinds the editor can place on a page. The roster grows as
 *  overlay tools land (M1+); the union is the contract the layers list and the
 *  per-tool dispatch read. */
export type CanvasObjectKind =
  | "redaction"
  | "annotation"
  | "signature"
  | "stamp"
  | "text"
  | "watermark"
  | "pageNumber";

/** A non-destructive overlay placed on one page. `rect` carries simple
 *  box-shaped marks (redaction, stamp); freeform marks (pen strokes) keep
 *  their geometry in `payload` instead, so `rect` is optional. */
export interface CanvasObject {
  id: string;
  kind: CanvasObjectKind;
  pageIndex: number;
  rect?: FractionRect;
  /** Tool-specific data (the Annotation shape, colour, text, …). Typed per tool. */
  payload?: unknown;
}

/** The in-memory editor document. */
export interface CanvasDoc {
  id: string;
  fileName: string;
  /** Canonical, pdf-lib-writable source of truth. */
  bytes: Uint8Array;
  pageCount: number;
  pages: PageMeta[];
  /** Non-destructive overlay objects across all pages. */
  objects: CanvasObject[];
}

let docSeq = 0;
/** Cheap monotonic id — app-side only (workflow scripts forbid Math.random,
 *  app code does not). Sequence keeps ids stable within a session. */
export function nextId(prefix = "obj"): string {
  docSeq += 1;
  return `${prefix}-${docSeq.toString(36)}`;
}

/**
 * Build a {@link CanvasDoc} from an uploaded PDF file.
 *
 * Reads the bytes once for pdf-lib (page dimensions / rotation) and renders
 * every page to a preview thumbnail via PDF.js. `pdf-lib` gets a private copy
 * of the bytes (`slice(0)`) because PDF.js detaches the File's ArrayBuffer to
 * its worker on render — the two readers must not share one buffer.
 *
 * @param file - the dropped PDF.
 * @param onProgress - optional `(rendered, total)` for a determinate bar.
 */
export async function createDocFromFile(
  file: File,
  onProgress?: (rendered: number, total: number) => void,
): Promise<CanvasDoc> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  // pdf-lib gets its own copy so PDF.js's worker-side detach can't strand it.
  const pdf = await PDFDocument.load(bytes.slice(0));
  const pages: PageMeta[] = pdf.getPages().map((p, index) => {
    // CropBox (defaults to MediaBox when absent) — the box PDF.js renders, so
    // the canvas aspect ratio matches the preview for cropped pages too.
    const { width, height } = p.getCropBox();
    return {
      index,
      widthPt: width,
      heightPt: height,
      rotation: p.getRotation().angle,
      thumbUrl: null,
    };
  });

  // One render pass at preview scale — crisp enough for the focus canvas, and
  // CSS-downscaled for the strip / overview grid. Matches RedactPdf's approach.
  const thumbs = await renderAllThumbnails(file, PREVIEW_SCALE, onProgress);
  for (let i = 0; i < pages.length; i++) pages[i].thumbUrl = thumbs[i] ?? null;

  return {
    id: nextId("doc"),
    fileName: file.name,
    bytes,
    pageCount: pages.length,
    pages,
    objects: [],
  };
}

/**
 * Build a {@link CanvasDoc} from raw bytes (e.g. the output of a `DocTransform`
 * or a multi-file "doc constructor" like Merge). Wraps the bytes in a File and
 * reuses {@link createDocFromFile}, so the returned doc owns a private copy of
 * the bytes.
 */
export async function createDocFromBytes(
  bytes: Uint8Array,
  fileName: string,
  onProgress?: (rendered: number, total: number) => void,
): Promise<CanvasDoc> {
  const file = new File([bytes.slice(0)], fileName, { type: "application/pdf" });
  return createDocFromFile(file, onProgress);
}

/** Revoke every page thumbnail blob URL the doc holds. Call on doc replace /
 *  editor unmount so previews don't leak across sessions. */
export function revokeDocThumbnails(doc: CanvasDoc | null): void {
  if (!doc) return;
  revokeThumbnails(doc.pages.map((p) => p.thumbUrl ?? "").filter(Boolean));
}

/**
 * Remap overlay objects after a transform that changes the page set (extract,
 * remove-blank, reorder). `survivors` lists the surviving original page indices
 * in their new output order; objects on dropped pages are removed and the rest
 * are re-pointed to their new index.
 */
export function remapObjects(objects: CanvasObject[], survivors: number[]): CanvasObject[] {
  const newIndex = new Map<number, number>();
  survivors.forEach((origIdx, pos) => newIndex.set(origIdx, pos));
  return objects
    .filter((o) => newIndex.has(o.pageIndex))
    .map((o) => ({ ...o, pageIndex: newIndex.get(o.pageIndex)! }));
}

/** Wrap the doc's current bytes as a File so the existing `pdf-operations`
 *  writers (which take a File) can run against the live document. */
export function docToFile(doc: CanvasDoc): File {
  // Copy into a fresh buffer so callers that detach it (PDF.js) can't corrupt
  // the doc's canonical bytes.
  const copy = doc.bytes.slice(0);
  return new File([copy], doc.fileName, { type: "application/pdf" });
}
