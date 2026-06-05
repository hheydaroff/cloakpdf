/**
 * Core PDF manipulation operations — barrel.
 *
 * Every function here runs entirely in the browser using pdf-lib for
 * structural manipulation and PDF.js for raster-based operations
 * (compression). No files are uploaded to any server.
 *
 * This file is a thin re-export barrel over the cohesive modules in
 * `./pdf/*`. The public surface is identical to the pre-split module — the
 * shared private helpers in `./pdf/raster.ts` (getPdfJs, renderPageToCanvas,
 * preprocessCanvasForOcr, canvasToImageBytes, decodeImageToPngBytes) and
 * `./pdf/forms.ts` (clonePageFormFields) are intentionally NOT re-exported so
 * that importing `../utils/pdf-operations.ts` exposes exactly the same names as
 * before.
 */

export type { AssembleOp } from "./pdf/pages.ts";
export {
  mergePdfs,
  splitPdf,
  splitPdfIntoParts,
  rotatePages,
  deletePages,
  reorderPages,
  reversePages,
  extractPages,
  addBlankPage,
  addBlankPages,
  duplicatePage,
  duplicatePages,
  assemblePdf,
} from "./pdf/pages.ts";

export { getFieldPageIndices, fillPdfForm, flattenPdf } from "./pdf/forms.ts";

export {
  compressPdf,
  grayscalePdf,
  imagesToPdf,
  nupPages,
  cropPages,
  cropPagesIndividual,
  uncropPages,
} from "./pdf/transform.ts";

export {
  addWatermark,
  addSealStamp,
  addSignature,
  addRectangleStamp,
  addPageNumbers,
  addHeaderFooter,
  addBatesNumbers,
} from "./pdf/stamps.ts";

export type { PdfInfo } from "./pdf/metadata.ts";
export { getPdfMetadata, setPdfMetadata, getPdfInfo, repairPdf } from "./pdf/metadata.ts";

export { extractTextOcr, createSearchablePdf, createSearchablePdfFromLayout } from "./pdf/ocr.ts";

export { redactPdf } from "./pdf/redact.ts";

export type { ScrubCategory, ScrubAnalysis } from "./pdf/scrub.ts";
export { SCRUB_CATEGORIES, analyzePdfHiddenData, scrubPdf } from "./pdf/scrub.ts";

export type { AnnotationColor, Annotation } from "./pdf/annotate.ts";
export { annotatePdf } from "./pdf/annotate.ts";

export { addPdfBookmarks } from "./pdf/bookmarks.ts";

export type { PdfAttachment } from "./pdf/attachments.ts";
export {
  listPdfAttachments,
  attachFilesToPdf,
  removeAttachmentsFromPdf,
} from "./pdf/attachments.ts";
