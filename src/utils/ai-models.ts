/**
 * Registry of AI models used by CloakPDF's optional AI features.
 *
 * Every entry describes a model in user-facing terms — its name, a short
 * blurb, an approximate download size, a license, and the canonical
 * Hugging Face page so the consent dialog can link out to it. The
 * `task` and `repo` fields are what `ai-runtime.ts` actually feeds to
 * Transformers.js when loading the pipeline.
 *
 * All models run **locally** in the browser via Transformers.js. Files
 * are fetched from huggingface.co on first use and cached in the
 * browser's CacheStorage so subsequent runs work offline.
 */
import type { PipelineType } from "@huggingface/transformers";

/**
 * Stable id used in code to reference a model.
 *
 * Only one chat tier remains — `chat-small` (Qwen 2.5 0.5B) was
 * removed after the ONNX export's LM head proved unusable in
 * Transformers.js: it collapses into single-token loops ("!!!!!!")
 * regardless of decoding strategy. The type alias is kept as a union
 * so a future second tier — once we find a small model whose ONNX
 * build is actually reliable — can be slotted back in without
 * rewiring callers.
 */
export type AiModelId = "chat-large";

/**
 * Subset of model ids that the chat tier represents. Currently
 * single-valued; `useChatTier` auto-selects it so no picker UI is
 * shown. Re-introduce a `"chat-small"` (or `"chat-fast"`) member here
 * to bring the picker back.
 */
export type ChatModelId = Extract<AiModelId, "chat-large">;

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
   * "~28 MB" hint before the download starts. The runtime reports the
   * actual size during the download via the progress callback.
   */
  approxSizeBytes: number;
  /** One-liner shown under the model name in the consent dialog. */
  description: string;
  /**
   * Short, concrete description of what this model handles well vs.
   * poorly. Rendered as a "Best suited for" row in the consent dialog
   * so users can set realistic expectations before paying the download
   * cost. Keep to one sentence.
   */
  bestFor?: string;
  /** License string shown verbatim in the consent dialog (e.g. "MIT", "Apache 2.0"). */
  license: string;
  /** Hugging Face model page URL (linked from the consent dialog). */
  modelUrl: string;
  /**
   * Pipeline options merged into the `pipeline(task, repo, {...})` call.
   * Use this to pin `dtype` (e.g. "q8") so we deterministically pull the
   * quantized weights instead of the full-precision ones.
   */
  pipelineOptions?: Record<string, unknown>;
}

export const AI_MODELS: Record<AiModelId, AiModelInfo> = {
  "chat-large": {
    id: "chat-large",
    displayName: "Qwen 2.5 (1.5B, instruct)",
    repo: "onnx-community/Qwen2.5-1.5B-Instruct",
    task: "text-generation",
    approxSizeBytes: 1100 * 1024 * 1024,
    description:
      "Alibaba's instruction-tuned 1.5B chat model. Significantly better at citing pages, following instructions, and reasoning over longer context — at the cost of a larger download.",
    bestFor: "Citing pages, multi-step reasoning, and longer-form answers over the whole document.",
    license: "Apache 2.0",
    modelUrl: "https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct",
    pipelineOptions: { dtype: "q4f16" },
  },
};

/** Format a byte count as e.g. "≈ 28 MB" for the consent dialog. */
export function formatApproxSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `≈ ${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  return `≈ ${Math.round(bytes / (1024 * 1024))} MB`;
}
