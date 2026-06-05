/**
 * PDF outline (bookmarks) authoring.
 */

import {
  PDFDocument,
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFString,
  PDFRef,
} from "@pdfme/pdf-lib";

/**
 * Add bookmarks (PDF outline) to a document.
 *
 * Each bookmark maps a title to a 0-based target page index. Any existing
 * outline is replaced. The /PageMode is set to UseOutlines so PDF viewers
 * show the bookmarks panel by default.
 *
 * @param file - The source PDF file.
 * @param bookmarks - Array of { title, pageIndex } entries (0-based).
 * @returns New PDF bytes with the outline inserted.
 */
export async function addPdfBookmarks(
  file: File,
  bookmarks: Array<{ title: string; pageIndex: number }>,
): Promise<Uint8Array> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await PDFDocument.load(arrayBuffer);

  if (bookmarks.length === 0) return pdf.save();

  const pages = pdf.getPages();

  // Build the outline root dictionary
  const outlineDict = pdf.context.obj({
    Type: PDFName.of("Outlines"),
    Count: PDFNumber.of(bookmarks.length),
  }) as PDFDict;
  const outlineRef = pdf.context.register(outlineDict);

  const itemRefs: PDFRef[] = [];

  for (const bm of bookmarks) {
    const pageIdx = Math.max(0, Math.min(bm.pageIndex, pages.length - 1));
    const pageRef = pages[pageIdx].ref;

    // Destination: go to the top of the target page fitting the full width
    const destArray = pdf.context.obj([pageRef, PDFName.of("Fit")]) as PDFArray;

    const itemDict = pdf.context.obj({
      Title: PDFString.of(bm.title),
      Parent: outlineRef,
      Dest: destArray,
    }) as PDFDict;

    itemRefs.push(pdf.context.register(itemDict));
  }

  // Link sibling items with Prev/Next pointers
  for (let i = 0; i < itemRefs.length; i++) {
    const item = pdf.context.lookup(itemRefs[i]);
    if (!(item instanceof PDFDict)) continue;
    if (i > 0) item.set(PDFName.of("Prev"), itemRefs[i - 1]);
    if (i < itemRefs.length - 1) item.set(PDFName.of("Next"), itemRefs[i + 1]);
  }

  outlineDict.set(PDFName.of("First"), itemRefs[0]);
  outlineDict.set(PDFName.of("Last"), itemRefs[itemRefs.length - 1]);

  pdf.catalog.set(PDFName.of("Outlines"), outlineRef);
  // Show the bookmarks panel in PDF viewers by default
  pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  return pdf.save();
}
