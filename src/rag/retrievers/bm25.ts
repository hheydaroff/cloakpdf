/**
 * BM25 sparse retriever built on the LangChain community
 * `BM25Retriever`.
 *
 * BM25 catches the queries dense embeddings miss: exact phrases, rare
 * proper nouns, IDs, dates, and any keyword the embedder under-weighs.
 * Paired with the dense retriever via the hybrid (RRF) layer, this
 * gives noticeably better recall than either alone on real-world PDFs.
 *
 * Implementation is delegated entirely to `@langchain/community` — we
 * just wire it up to the same `Document[]` the dense store uses so
 * both retrievers index the same corpus.
 */
import type { Document } from "@langchain/core/documents";
import type { BaseRetriever } from "@langchain/core/retrievers";
import { BM25Retriever } from "@langchain/community/retrievers/bm25";

export interface Bm25RetrieverOptions {
  /** Chunk documents (page metadata preserved). */
  documents: Document[];
  /** Top-k for retrieval. Default 20 — the hybrid layer trims further. */
  k?: number;
}

export function buildBm25Retriever(options: Bm25RetrieverOptions): BaseRetriever {
  return BM25Retriever.fromDocuments(options.documents, { k: options.k ?? 20 });
}
