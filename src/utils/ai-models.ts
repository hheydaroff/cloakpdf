/**
 * Registry of AI models used by Ask PDF.
 *
 * Two models load together: a small instruction-tuned chat LLM and a
 * tiny sentence-embedding model. The chat model answers questions; the
 * embedder powers the RAG retriever that picks which chunks of the PDF
 * to feed the chat model. Both run locally in the browser via
 * Transformers.js; weights are fetched from huggingface.co on first
 * use and cached in the browser's CacheStorage so repeat visits work
 * offline.
 *
 * The Ask PDF tool is gated to non-mobile devices (see
 * `tool.desktopOnly` in `tool-registry.ts`), so this registry only
 * carries the desktop-tier models — no mobile-fallback variants.
 * Call sites should go through {@link getModelInfo} rather than read
 * `AI_MODELS` directly in case we add per-feature variants later.
 */
import type { PipelineType } from "@huggingface/transformers";

/** Stable id used in code to reference a model. */
export type AiModelId = "chat" | "embed";

export interface AiModelInfo {
  /** Stable id referenced by tools. */
  id: AiModelId;
  /** Short, user-facing name (shown in the consent dialog title). */
  displayName: string;
  /**
   * Hugging Face repository id passed to `pipeline(...)`.
   * Format: `<author>/<model>`.
   */
  repo: string;
  /** Transformers.js pipeline task. */
  task: PipelineType;
  /**
   * Approximate total download size in bytes — used to render a friendly
   * "~28 MB" hint before the download starts.
   */
  approxSizeBytes: number;
  /**
   * Approximate **peak RAM** the model occupies during inference, in
   * bytes. Used by `assessMemoryFit()` to gauge whether the user's
   * device can run the model without crashing the tab.
   */
  approxPeakRamBytes: number;
  /** One-liner shown under the model name in the consent dialog. */
  description: string;
  /** Short, concrete description of what this model handles well. */
  bestFor?: string;
  /** License string shown verbatim in the consent dialog. */
  license: string;
  /** Hugging Face model page URL. */
  modelUrl: string;
  /**
   * Pipeline options merged into the `pipeline(task, repo, {...})` call.
   * Use this to pin `dtype` (e.g. "q4f16") so we deterministically pull
   * the quantized weights instead of the full-precision ones.
   */
  pipelineOptions?: Record<string, unknown>;
}

/**
 * Desktop-tier defaults. Read these via {@link getModelInfo}; on a
 * memory-constrained device the matching entry in
 * {@link MOBILE_OVERRIDES} takes precedence.
 */
export const AI_MODELS: Record<AiModelId, AiModelInfo> = {
  chat: {
    id: "chat",
    displayName: "SmolLM2 (1.7B, instruct)",
    repo: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
    task: "text-generation",
    // q4f16 weights are ~1.0 GB on disk. Peak RAM during inference
    // sits around 2.5 GB once the KV cache, embedding table, and ONNX
    // runtime overhead are accounted for. Runs well on desktops,
    // laptops, and tablets with ≥ 4 GB free; marginal on phones with
    // 6 GB total RAM.
    //
    // **History of swaps in this slot** (so future-us doesn't repeat
    // them). Same résumé fixture and prompt in each test:
    //
    //   - Qwen 2.5 0.5B / 1.5B   → broken ONNX (pure token noise)
    //   - Llama 3.2 1B           → severe extraction hallucinations
    //                              ("Gemini developed by Facebook" etc.)
    //   - Gemma 4 E2B            → same failure mode as Llama 1B —
    //                              lists generic AI categories
    //                              (Anthropic Claude, OpenAI GPT,
    //                              Docker, Kubernetes) none of which
    //                              appear in the chunks
    //   - SmolLM2-360M           → fabricated identifiers under load
    //   - SmolLM3-3B (q4f16)     → tried as "same family, bigger" but
    //                              regressed badly. Two distinct
    //                              failures: (1) hybrid-reasoning
    //                              model emits unclosed `<think>`
    //                              tags our streaming pipe doesn't
    //                              strip; (2) catastrophic repetition
    //                              loops on open-ended questions
    //                              ("tactical X, tactical Y, ..."
    //                              for 50+ tokens, or "Wally, Wally,
    //                              Wally..." on address extraction).
    //                              Failure reproduced on both cold
    //                              and warm cache paths.
    //   - SmolLM2-1.7B           → near-verbatim extraction (winner)
    //
    // The pattern that emerged across these tests: small instruct
    // models from Google / Meta optimise for conversational fluency
    // and fill in "plausible" answers from world knowledge. SmolLM2
    // alone in the small-model space stays close to the supplied
    // excerpts. Scaling within the SmolLM family also doesn't help —
    // SmolLM3 changes the training recipe (reasoning mode) and breaks
    // the verbatim-extraction discipline. Until that changes we hold
    // the line at 1.7B and improve quality via the retrieval /
    // prompt path instead.
    approxSizeBytes: 1024 * 1024 * 1024,
    approxPeakRamBytes: Math.round(2.5 * 1024 * 1024 * 1024),
    description:
      "Hugging Face's most capable sub-2 B chat model. Tuned to read the supplied document excerpts and answer from them, instead of guessing from general knowledge.",
    bestFor:
      "Answering questions about a PDF on desktops, laptops, and tablets with ≥ 4 GB free RAM.",
    license: "Apache 2.0",
    modelUrl: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
    pipelineOptions: { dtype: "q4f16" },
  },
  embed: {
    id: "embed",
    displayName: "EmbeddingGemma (300M)",
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    task: "feature-extraction",
    // ~309 MB on disk (int8 quantized weights), ~400 MB peak RAM.
    // 2× the prior bge-base-en-v1.5 (~140 MB) on disk but the
    // retrieval quality jump from EmbeddingGemma's asymmetric
    // task-prefix training is meaningful, and runtime RAM is
    // comparable thanks to int8 weights vs bge's fp16. 308M params
    // vs bge-base's 109M.
    //
    // **Why we swapped from bge-base**:
    //   - EmbeddingGemma is trained for asymmetric retrieval with
    //     task-specific prompt prefixes ("title: none | text: ..."
    //     for docs vs "task: search result | query: ..." for
    //     queries). bge-base used the same prefix on both sides.
    //   - Stronger on MTEB retrieval at this size class, and
    //     multilingual out of the box (100+ langs) — covers non-
    //     English PDFs without a model swap.
    //   - Still 768-dim output (with Matryoshka truncation to 512 /
    //     256 / 128 available; we currently use the full 768).
    //
    // **Why `dtype: "q8"` + `device: "wasm"`** (and not q4f16 +
    // webgpu like the chat model, nor q4):
    //
    //   - q4f16: ships LayerNorm in fp16. onnxruntime-web's WebGPU
    //     shader for that op fails to compile (`Invalid ShaderModule
    //     "LayerNorm"`). Verified failing on Chrome / macOS.
    //   - q4 (197 MB): uses `GatherBlockQuantized` for the embedding
    //     table. onnxruntime-web's WASM backend doesn't implement
    //     that op — pipeline init throws (`Could not find an
    //     implementation for GatherBlockQuantized(1) … Gather_Q4`).
    //     The `model_no_gather_q4` variant in the repo exists to
    //     work around this but Transformers.js' `dtype` option
    //     doesn't expose it; we'd have to override `model_file_name`
    //     directly. Not worth the extra plumbing for 112 MB.
    //   - q8 (this): int8-quantized weights with fp32 activations.
    //     The most universally supported variant in onnxruntime-web
    //     — works on both WebGPU and WASM with no exotic ops. Pays
    //     ~112 MB in download size relative to q4.
    //   - Pinning to WASM sidesteps any future GPU-shader risk on
    //     the smaller of the two models. Embedding a few hundred
    //     chunks per PDF + one query per turn isn't throughput-
    //     bound; the chat model (SmolLM2-1.7B) gets exclusive use
    //     of WebGPU where it actually matters.
    //
    // Prefix handling lives in `src/rag/embeddings.ts` — swapping
    // back to a symmetric embedder (e.g. bge) means dropping that
    // prefix layer.
    approxSizeBytes: 309 * 1024 * 1024,
    approxPeakRamBytes: 400 * 1024 * 1024,
    description:
      "Google's on-device embedding model from the Gemma family. Trained for asymmetric retrieval — applies task-specific prompts to PDF chunks vs your question, then matches them in a 768-dim vector space so the chat model gets the right pages. Multilingual (100+ langs).",
    bestFor: "Semantic retrieval over PDFs in any of 100+ languages.",
    license: "Gemma Terms of Use",
    modelUrl: "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX",
    pipelineOptions: { dtype: "q8", device: "wasm" },
  },
};

/**
 * Look up a model's metadata by id. Thin wrapper over {@link AI_MODELS}
 * — kept as a function so future per-feature variant logic (e.g.
 * device-specific dtype selection) has one place to land without
 * touching every call site.
 */
export function getModelInfo(id: AiModelId): AiModelInfo {
  return AI_MODELS[id];
}

/** Format a byte count as e.g. "≈ 28 MB" for the consent dialog. */
export function formatApproxSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `≈ ${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `≈ ${Math.round(bytes / (1024 * 1024))} MB`;
}
