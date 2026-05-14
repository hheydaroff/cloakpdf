/**
 * LangChain `Embeddings` adapter that delegates to a Transformers.js
 * `feature-extraction` pipeline.
 *
 * Why this adapter exists: every retriever / vector store in LangChain
 * accepts the abstract `Embeddings` shape. Pointing them at our local
 * Transformers.js pipeline through this thin wrapper means BM25,
 * MemoryVectorStore, the ensemble retriever, and the LangGraph nodes
 * don't have to know our model came from on-device inference.
 *
 * Vectors are L2-normalised by Transformers.js (`normalize: true`) so
 * downstream cosine similarity collapses to a dot product.
 */
import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { runEmbed } from "../utils/ai-tasks.ts";
import type { AiPipeline } from "../utils/ai-runtime.ts";

export interface TransformersJsEmbeddingsOptions extends EmbeddingsParams {
  /** Resolved Transformers.js `feature-extraction` pipeline. */
  pipeline: AiPipeline;
  /**
   * Batch size for `embedDocuments`. 32 is a good middle ground for
   * MiniLM in WASM — bigger batches don't gain much throughput once
   * the WASM threads saturate, and small batches hurt latency.
   */
  batchSize?: number;
}

export class TransformersJsEmbeddings extends Embeddings {
  private pipeline: AiPipeline;
  private batchSize: number;

  constructor(options: TransformersJsEmbeddingsOptions) {
    super(options);
    this.pipeline = options.pipeline;
    this.batchSize = options.batchSize ?? 32;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await runEmbed(this.pipeline, batch);
      for (const v of vectors) out.push(Array.from(v));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await runEmbed(this.pipeline, [text]);
    return Array.from(vec);
  }
}
