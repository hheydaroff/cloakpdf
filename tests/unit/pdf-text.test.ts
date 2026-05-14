/**
 * Tests for the PDF text utilities consumed by every AI tool. These
 * are pure functions over strings — no PDF parsing involved — so they
 * run fast and don't need a fixture.
 *
 * What's covered:
 *
 *   - `chunkPages` slices long pages into overlapping windows, prefers
 *     sentence boundaries, and produces correct page numbers/offsets.
 *   - `rankChunksByQuery` ranks by TF-IDF and degrades gracefully when
 *     the query has no useful terms.
 *   - `looksLikeScannedPdf` triggers only when the bulk of pages have
 *     no real text — the signal that flips the UI into "run OCR first".
 */
import { describe, expect, it } from "vitest";
import {
  chunkPages,
  looksLikeScannedPdf,
  rankChunksByQuery,
  type TextChunk,
} from "../../src/utils/pdf-text.ts";

// ── chunkPages ────────────────────────────────────────────────────

describe("chunkPages", () => {
  it("returns one chunk per page when each page fits the window", () => {
    const chunks = chunkPages(["short page", "another one"], 1500, 200);
    expect(chunks).toEqual([
      { pageNumber: 1, text: "short page", pageOffset: 0 },
      { pageNumber: 2, text: "another one", pageOffset: 0 },
    ]);
  });

  it("skips empty pages entirely so the LLM never sees blank context", () => {
    const chunks = chunkPages(["content", "", "more content"], 1500, 200);
    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 3]);
  });

  it("emits multiple chunks for a page longer than maxChars", () => {
    const longPage = "a".repeat(3500);
    const chunks = chunkPages([longPage], 1000, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.pageNumber === 1)).toBe(true);
  });

  it("overlaps successive chunks so context isn't lost at boundaries", () => {
    // Build a page where each chunk's first 100 chars repeat the
    // previous chunk's last 100 chars. Without overlap a sentence
    // straddling the boundary would be invisible to the LLM.
    const page = "ABCDEFGHIJ".repeat(300); // 3000 chars
    const chunks = chunkPages([page], 1000, 100);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < chunks.length; i++) {
      // Each subsequent chunk starts before the previous chunk ends.
      const prevEnd = chunks[i - 1].pageOffset + chunks[i - 1].text.length;
      expect(chunks[i].pageOffset).toBeLessThan(prevEnd);
    }
  });

  it("prefers sentence breaks near the end of the window", () => {
    // Build a page with two sentence boundaries inside the "last
    // 20% of the window" zone. The chunker should cut at the LAST
    // period (closest to maxChars) rather than slicing mid-word.
    const lead = "x".repeat(800);
    const tail = ` sentence one. sentence two.${"y".repeat(800)}`;
    const chunks = chunkPages([`${lead}${tail}`], 1000, 100);
    expect(chunks[0].text.endsWith("sentence two.")).toBe(true);
    // And the next chunk must pick up after that boundary (no glyph lost).
    expect(chunks[1].text.startsWith("y") || chunks[1].text.includes("sentence")).toBe(true);
  });

  it("computes correct pageOffset for each chunk", () => {
    const longPage = "x".repeat(3500);
    const chunks = chunkPages([longPage], 1000, 100);
    // First chunk always starts at 0.
    expect(chunks[0].pageOffset).toBe(0);
    // Subsequent chunks start at strictly increasing offsets.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].pageOffset).toBeGreaterThan(chunks[i - 1].pageOffset);
    }
  });

  it("returns [] for an empty pages array", () => {
    expect(chunkPages([], 1000, 100)).toEqual([]);
  });
});

// ── rankChunksByQuery ─────────────────────────────────────────────

function makeChunks(texts: string[]): TextChunk[] {
  return texts.map((t, i) => ({ pageNumber: i + 1, text: t, pageOffset: 0 }));
}

describe("rankChunksByQuery", () => {
  it("ranks the chunk containing the query term first", () => {
    const chunks = makeChunks([
      "The quick brown fox jumps over the lazy dog.",
      "Neural networks are universal function approximators.",
      "Photosynthesis converts sunlight into chemical energy.",
    ]);
    const result = rankChunksByQuery(chunks, "neural networks", 1);
    expect(result[0].text).toContain("Neural networks");
  });

  it("rewards rare terms over common ones (TF-IDF, not raw coverage)", () => {
    // Both chunks contain "the". Only chunk B contains "epoch".
    // The TF-IDF-based ranker should pull chunk B to the top even
    // though chunk A repeats "the" many times.
    const chunks = makeChunks([
      "The the the the the report mentions the the the.",
      "Training the model for one epoch yielded the result.",
    ]);
    const result = rankChunksByQuery(chunks, "epoch the", 2);
    expect(result[0].text).toContain("epoch");
  });

  it("falls back to the first topK chunks when the query has no useful terms", () => {
    const chunks = makeChunks(["one", "two", "three", "four", "five"]);
    // "a the is" tokenizes to nothing (all stopwords + short words).
    const result = rankChunksByQuery(chunks, "a the is", 3);
    expect(result.map((c) => c.text)).toEqual(["one", "two", "three"]);
  });

  it("returns all chunks when topK exceeds chunk count", () => {
    const chunks = makeChunks(["alpha", "beta", "gamma"]);
    const result = rankChunksByQuery(chunks, "alpha", 10);
    expect(result).toHaveLength(3);
  });

  it("does not throw on an empty chunk list", () => {
    expect(() => rankChunksByQuery([], "anything", 4)).not.toThrow();
    expect(rankChunksByQuery([], "anything", 4)).toEqual([]);
  });

  it("is case-insensitive on the query side", () => {
    const chunks = makeChunks(["REVENUE grew quarter over quarter.", "The dog is on the mat."]);
    const result = rankChunksByQuery(chunks, "revenue", 1);
    expect(result[0].text).toContain("REVENUE");
  });
});

// ── looksLikeScannedPdf ───────────────────────────────────────────

describe("looksLikeScannedPdf", () => {
  it("returns true when 80%+ of pages have <20 non-whitespace chars", () => {
    // 4 of 5 pages are effectively empty → 80% sparse → flagged.
    const pages = ["", "  ", "    ", "      ", "Real content on page five."];
    expect(looksLikeScannedPdf(pages)).toBe(true);
  });

  it("returns false when most pages have real text", () => {
    const pages = [
      "Page one has plenty of content to read.",
      "Page two continues with more useful text here.",
      "Page three wraps up the document neatly.",
    ];
    expect(looksLikeScannedPdf(pages)).toBe(false);
  });

  it("returns false for an empty document (nothing to scan)", () => {
    // We don't want a fresh empty document to be misclassified as
    // 'scanned' — the user should see a more accurate error upstream.
    expect(looksLikeScannedPdf([])).toBe(false);
  });

  it("treats a page with a few stray glyphs as sparse (likely OCR artefact)", () => {
    // Some scanned PDFs have a page number stamped on otherwise empty
    // pages. 19 chars or fewer counts as sparse.
    const pages = ["1", "2", "3", "4", "5"];
    expect(looksLikeScannedPdf(pages)).toBe(true);
  });

  it("returns false when exactly 60% of pages are sparse (below the 80% threshold)", () => {
    const pages = ["", "", "", "real text here for page four", "real text here for page five"];
    // 3 sparse out of 5 = 60%, below the 80% bar.
    expect(looksLikeScannedPdf(pages)).toBe(false);
  });
});
