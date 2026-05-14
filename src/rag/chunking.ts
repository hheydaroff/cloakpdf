/**
 * Page-aware chunking using LangChain's `RecursiveCharacterTextSplitter`.
 *
 * Two design points worth noting:
 *
 *   1. We split within each page rather than across pages so a chunk
 *      always belongs to one and only one source page — citations stay
 *      crisp. LangChain's `splitDocuments` would happily merge / split
 *      across documents otherwise.
 *   2. We attach a stable `chunkId` and `ordinal` to every chunk so the
 *      vector store, BM25 retriever, and the persistence layer can
 *      identify the same chunk across passes without resorting to
 *      content hashing on the hot path.
 */
import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { PdfDocumentMetadata } from "./pdf-loader.ts";

export interface ChunkMetadata extends PdfDocumentMetadata {
  /** Zero-based ordinal across the whole document. */
  ordinal: number;
  /** Stable id (page + ordinal) used as the cache + dedup key. */
  chunkId: string;
}

export interface ChunkOptions {
  /** Soft cap on chunk size in characters. Default 700. */
  chunkSize?: number;
  /** Overlap between adjacent chunks (helps boundary retrieval). Default 100. */
  chunkOverlap?: number;
}

/**
 * Split per-page `Document`s from {@link loadPdf} into smaller
 * retriever-friendly chunks. Returns a flat array in document order;
 * page metadata is preserved on every chunk.
 */
export async function chunkDocuments(
  pages: Document[],
  options: ChunkOptions = {},
): Promise<Document<ChunkMetadata>[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: options.chunkSize ?? 700,
    chunkOverlap: options.chunkOverlap ?? 100,
    // LangChain's defaults already prefer paragraph → sentence → word
    // boundaries, which is what we want for prose. We let it pick.
  });

  const out: Document<ChunkMetadata>[] = [];
  let ordinal = 0;
  for (const page of pages) {
    const pieces = await splitter.splitText(page.pageContent);
    const meta = page.metadata as PdfDocumentMetadata;
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const chunkId = `p${meta.pageNumber}-${ordinal}`;
      out.push(
        new Document<ChunkMetadata>({
          pageContent: trimmed,
          metadata: {
            ...meta,
            ordinal,
            chunkId,
          },
        }),
      );
      ordinal++;
    }
  }
  return out;
}
