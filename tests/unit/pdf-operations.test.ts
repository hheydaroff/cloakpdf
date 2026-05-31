/**
 * Unit tests for byte-level PDF operations that carry a correctness-of-claim
 * promise the UI makes to the user.
 *
 * `flattenPdf` advertises "removes form fields and annotations". The AcroForm
 * flatten is exercised by the e2e suite in a real browser; here we pin the
 * annotation-stripping half — a privacy promise that's easy to silently
 * regress, since `getForm().flatten()` alone leaves non-widget annotations
 * (comments, highlights, links) on the page.
 */
import { PDFDocument, PDFName } from "@pdfme/pdf-lib";
import { describe, expect, it } from "vitest";
import { flattenPdf } from "../../src/utils/pdf-operations.ts";

/** A one-page PDF whose page carries a single non-widget annotation. */
async function makeAnnotatedPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  // Low-level annotation dict (a square markup) added straight to /Annots —
  // pdf-lib has no high-level API for non-widget annotations.
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [50, 700, 120, 760],
  });
  const annotRef = doc.context.register(annot);
  page.node.set(PDFName.of("Annots"), doc.context.obj([annotRef]));
  return doc.save();
}

describe("flattenPdf", () => {
  it("strips non-widget annotations from every page", async () => {
    const bytes = await makeAnnotatedPdfBytes();

    // Sanity-check the fixture actually has an annotation before flattening.
    const src = await PDFDocument.load(bytes);
    expect(src.getPages()[0].node.get(PDFName.of("Annots"))).toBeDefined();

    const file = new File([bytes as BlobPart], "annotated.pdf", { type: "application/pdf" });
    const flattened = await flattenPdf(file);

    const out = await PDFDocument.load(flattened);
    expect(out.getPages()[0].node.get(PDFName.of("Annots"))).toBeUndefined();
  });

  it("round-trips a clean multi-page PDF without dropping pages", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const bytes = await doc.save();
    const file = new File([bytes as BlobPart], "blank.pdf", { type: "application/pdf" });

    const flattened = await flattenPdf(file);
    const out = await PDFDocument.load(flattened);
    expect(out.getPageCount()).toBe(2);
  });
});
