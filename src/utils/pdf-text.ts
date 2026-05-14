/**
 * Plain-text extraction from structured PDFs (i.e. PDFs whose pages
 * already carry a text layer).
 *
 * This is the non-OCR cousin of {@link extractTextOcr} in
 * `pdf-operations.ts`. It's much faster — there's no canvas rendering
 * and no model — but it only works when the PDF actually has selectable
 * text. Scanned/image PDFs return empty strings; the caller should
 * detect that case and fall back to OCR.
 *
 * Returns one string per page so that the AI tools can:
 *   - render per-page results without re-aligning offsets,
 *   - chunk per page to keep inputs within model context windows,
 *   - cite the page a finding came from.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

let _pdfjsLib: typeof import("pdfjs-dist") | null = null;
async function getPdfJs(): Promise<typeof import("pdfjs-dist")> {
  if (!_pdfjsLib) {
    const { default: workerSrc } = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker&url");
    _pdfjsLib = await import("pdfjs-dist");
    _pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return _pdfjsLib;
}

/**
 * Extract the text layer of every page in a PDF, preserving the page
 * grouping.
 *
 * Reconstruction is line-aware: PDF text items don't carry explicit
 * newlines, so we sort items into rows by their `transform[5]` (the y
 * coordinate of the baseline) and emit a newline whenever the row
 * changes. Within a row, items are joined with a space when the
 * preceding item didn't already end in whitespace.
 *
 * @param file - The source PDF.
 * @param onProgress - Optional `(current, total)` callback fired once
 *   per processed page so the UI can show a determinate progress bar.
 * @returns Array of length `pageCount` — each entry is the page's text
 *   (empty string when the page has no extractable text).
 */
export async function extractTextFromPdf(
  file: File,
  onProgress?: (current: number, total: number) => void,
): Promise<string[]> {
  const pdfjsLib = await getPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf: PDFDocumentProxy = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;
  const pages: string[] = [];

  try {
    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      pages.push(reconstructPageText(textContent.items));
      onProgress?.(i, totalPages);
      page.cleanup();
    }
  } finally {
    void pdf.destroy();
  }

  return pages;
}

/**
 * PDF.js TextItem-ish shape we depend on. The runtime object also has
 * `dir`, `width`, `height`, etc. but we only need these three fields.
 */
interface PdfTextItemLike {
  str: string;
  transform?: number[];
  /** PDF.js sets this to `true` on items that already terminate a line. */
  hasEOL?: boolean;
}

/**
 * Reassemble page text from PDF.js TextItem objects.
 *
 * PDF text items are positioned glyphs, not strings. To get readable
 * output we:
 *
 *   1. Group items by their y-baseline (rounded to 2 px so anti-aliased
 *      coordinates don't split a single line into two).
 *   2. Sort rows top-to-bottom (PDF y origin is bottom-left, so larger
 *      y means higher on the page).
 *   3. Within a row, items are already in reading order; we join them
 *      with a space when the preceding item didn't end in whitespace.
 *
 * `hasEOL` items are treated as forced line breaks even when the y
 * coordinate suggests they're on the same row — PDF.js sets this flag
 * when the underlying content stream uses an explicit `'` (next line)
 * operator.
 */
function reconstructPageText(items: unknown[]): string {
  // Cast once for ergonomics; we tolerate items that don't have transforms.
  const typed = items as PdfTextItemLike[];

  type Row = { y: number; parts: string[] };
  const rowsByY = new Map<number, Row>();
  let lastY: number | null = null;

  for (const item of typed) {
    const y: number = item.transform ? Math.round(item.transform[5] * 2) / 2 : (lastY ?? 0);
    lastY = y;
    let row = rowsByY.get(y);
    if (!row) {
      row = { y, parts: [] };
      rowsByY.set(y, row);
    }
    row.parts.push(item.str);
    if (item.hasEOL) {
      // Sentinel forces a line break even if more items share this y.
      row.parts.push("\n");
    }
  }

  const sorted = [...rowsByY.values()].sort((a, b) => b.y - a.y);
  const lines: string[] = [];
  for (const row of sorted) {
    let line = "";
    for (const part of row.parts) {
      if (part === "\n") {
        // Push the in-progress line and continue a fresh one inside the row.
        if (line.trim()) lines.push(line);
        line = "";
        continue;
      }
      if (line && !/\s$/.test(line) && !/^\s/.test(part)) line += " ";
      line += part;
    }
    if (line.trim()) lines.push(line);
  }
  return lines.join("\n").trim();
}

/**
 * Split a long text into overlapping chunks that fit within an AI
 * model's context window. Most extractive QA / summarization models
 * top out around 384–512 tokens; we chunk by characters which is a
 * conservative proxy (roughly 4 chars per token for English).
 *
 * Each chunk preserves the index of its source page so the UI can
 * surface "Page 3 of 12 says …" alongside the model's output.
 *
 * @param pages - Per-page text from {@link extractTextFromPdf}.
 * @param maxChars - Maximum characters per chunk. Default 1500 — fits
 *   inside the ~512-token windows used by DistilBERT / DistilBART.
 * @param overlap - Number of characters of overlap between adjacent
 *   chunks. Helps QA find answers that straddle a chunk boundary.
 */
export interface TextChunk {
  /** 1-based page number (matches what the user sees in any PDF viewer). */
  pageNumber: number;
  /** The chunk text. */
  text: string;
  /** Character offset (0-based) of this chunk within its page. */
  pageOffset: number;
}

export function chunkPages(pages: string[], maxChars = 1500, overlap = 200): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i];
    if (!text) continue;
    if (text.length <= maxChars) {
      chunks.push({ pageNumber: i + 1, text, pageOffset: 0 });
      continue;
    }
    let offset = 0;
    while (offset < text.length) {
      const end = Math.min(text.length, offset + maxChars);
      // Try to break on a sentence boundary near the end so we don't slice
      // mid-sentence — only matters for the last 20% of the window.
      let cut = end;
      if (end < text.length) {
        const tail = text.slice(end - Math.floor(maxChars * 0.2), end);
        const lastStop = Math.max(tail.lastIndexOf("."), tail.lastIndexOf("\n"));
        if (lastStop > 0) {
          cut = end - Math.floor(maxChars * 0.2) + lastStop + 1;
        }
      }
      chunks.push({
        pageNumber: i + 1,
        text: text.slice(offset, cut),
        pageOffset: offset,
      });
      if (cut >= text.length) break;
      offset = Math.max(cut - overlap, offset + 1);
    }
  }
  return chunks;
}

// ── Retrieval ─────────────────────────────────────────────────────

/**
 * English stopwords stripped out before scoring chunks against a query.
 * Kept tight on purpose — over-aggressive stopword lists drop useful
 * domain terms ("about", "what") that genuinely narrow the answer.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Rank chunks by how well they match a query, top-scoring first. Used
 * to build a small context window for chat-style document QA without
 * shipping an embedding model.
 *
 * Scoring is TF-IDF over the chunked document corpus. For each unique
 * query term:
 *
 *   - `tf` = number of times that term appears in the chunk
 *   - `idf` = log((N + 1) / df), where df is the number of chunks
 *     containing the term and N is the total chunk count
 *
 * The chunk score is the sum of `tf * idf` across query terms. This
 * matters in practice because it rewards rare, discriminating words
 * (the ones that actually narrow down the answer) and downweights
 * filler terms that appear on every page. The previous pure-coverage
 * scorer treated "the report mentions" and "neural network" as having
 * equal pull on chunk selection, which led the LLM to the wrong page.
 *
 * Chunks with zero matching terms are *not* dropped — they're returned
 * at the tail of the list so callers can still fall back to "any chunk"
 * when the query has no useful keywords (e.g. "summarise this").
 *
 * @param chunks - Source chunks (typically from {@link chunkPages}).
 * @param query - User's question or search phrase.
 * @param topK - Maximum chunks to return. Default 4 — fits comfortably
 *   in a small-LLM context window after the question is prepended.
 */
export function rankChunksByQuery(chunks: TextChunk[], query: string, topK = 4): TextChunk[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return chunks.slice(0, topK);

  // Precompute tokens-per-chunk once — both df and tf walk the same
  // bag of tokens, so re-tokenising would be the most expensive part
  // of this routine on a large document.
  const chunkTokens = chunks.map((c) => tokenize(c.text));

  // Document frequency for each query term across the corpus.
  const df = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokens of chunkTokens) {
      if (tokens.includes(term)) count++;
    }
    df.set(term, count);
  }

  const N = chunks.length;

  const scored = chunks.map((chunk, i) => {
    const tf = new Map<string, number>();
    for (const token of chunkTokens[i]) {
      if (df.get(token) === undefined) continue;
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    let score = 0;
    for (const term of queryTerms) {
      const t = tf.get(term) ?? 0;
      if (t === 0) continue;
      const d = df.get(term) ?? 1;
      // +1 smoothing so a term appearing in every chunk still has a
      // non-zero idf (otherwise log(N/N) = 0 and shared terms vanish).
      const idf = Math.log((N + 1) / d);
      score += t * idf;
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.chunk);
}

/**
 * `true` when the per-page extraction looks empty enough that the PDF
 * is likely a scanned image rather than a structured document.
 *
 * Heuristic: at least 80 % of pages have fewer than 20 non-whitespace
 * characters. Conservative on purpose — the message a tool shows on
 * this signal should *suggest* OCR, not assert it's the only option.
 */
export function looksLikeScannedPdf(pages: string[]): boolean {
  if (pages.length === 0) return false;
  const sparse = pages.filter((p) => p.replace(/\s/g, "").length < 20).length;
  return sparse / pages.length >= 0.8;
}
