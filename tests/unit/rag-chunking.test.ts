/**
 * Unit tests for the page-aware chunker.
 *
 * The chunker is a thin wrapper around LangChain's
 * `RecursiveCharacterTextSplitter` — we test the bits we own: that page
 * metadata flows through every chunk, that chunks never cross a page
 * boundary, and that ordinals are dense and sequential.
 */
import { Document } from "@langchain/core/documents";
import { describe, expect, it } from "vitest";
import { chunkDocuments } from "../../src/rag/chunking.ts";

function page(pageNumber: number, content: string): Document {
  return new Document({
    pageContent: content,
    metadata: { pageNumber, ocrUsed: false },
  });
}

describe("chunkDocuments", () => {
  it("attaches page metadata + a stable chunkId to every chunk", async () => {
    const pages = [page(1, "short page one"), page(2, "short page two")];
    const chunks = await chunkDocuments(pages, { chunkSize: 200, chunkOverlap: 20 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].metadata).toMatchObject({ pageNumber: 1, ordinal: 0 });
    expect(chunks[0].metadata.chunkId).toMatch(/^p1-/);
    expect(chunks[1].metadata).toMatchObject({ pageNumber: 2, ordinal: 1 });
    expect(chunks[1].metadata.chunkId).toMatch(/^p2-/);
  });

  it("never crosses a page boundary in a single chunk", async () => {
    const pages = [
      page(1, "Apple banana cherry. Page one ends here."),
      page(2, "Page two starts. Pear plum quince."),
    ];
    const chunks = await chunkDocuments(pages, { chunkSize: 200, chunkOverlap: 20 });
    for (const c of chunks) {
      if (c.metadata.pageNumber === 1) {
        expect(c.pageContent).not.toMatch(/pear plum quince/i);
        expect(c.pageContent).not.toMatch(/page two starts/i);
      } else {
        expect(c.pageContent).not.toMatch(/apple banana/i);
        expect(c.pageContent).not.toMatch(/page one ends/i);
      }
    }
  });

  it("emits dense sequential ordinals across the whole document", async () => {
    const long = (n: number, txt: string) => page(n, txt.repeat(40));
    const pages = [long(1, "alpha "), long(2, "beta "), long(3, "gamma ")];
    const chunks = await chunkDocuments(pages, { chunkSize: 100, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.metadata.ordinal)).toEqual(chunks.map((_, idx) => idx));
  });

  it("drops empty pages without breaking ordinals", async () => {
    const pages = [page(1, "first content"), page(2, ""), page(3, "third content")];
    const chunks = await chunkDocuments(pages, { chunkSize: 200, chunkOverlap: 20 });
    expect(chunks.map((c) => c.metadata.pageNumber)).toEqual([1, 3]);
    expect(chunks.map((c) => c.metadata.ordinal)).toEqual([0, 1]);
  });

  it("returns no chunks when every page is empty", async () => {
    const chunks = await chunkDocuments([page(1, ""), page(2, "   ")], {
      chunkSize: 200,
      chunkOverlap: 20,
    });
    expect(chunks).toEqual([]);
  });
});
