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
 * The chat slot ships **two tiers** (see {@link CHAT_VARIANT_IDS}),
 * both from Liquid AI's LFM family:
 *
 *   - `lfm2.5-1.2b` — Compact: ~1.2 GB / ~2 GB peak. Liquid AI's
 *     latest 1.2B hybrid (LFM2.5 = LFM2 base + extended pretraining
 *     + RL post-training). The static default for fresh visitors.
 *   - `lfm2-2.6b` — Quality: ~1.5 GB / ~3.5 GB peak. Liquid AI's
 *     larger hybrid; purpose-built for on-device structured extraction
 *     and RAG. Liquid hasn't shipped a 2.6 B variant of LFM2.5 yet, so
 *     this tier stays on the LFM2 build. Recommended on ≥ 8 GB free RAM.
 *
 * **Why no SmolLM2 tier any more.** SmolLM2-1.7B was the historical
 * default and shipped briefly as a "Balanced" middle tier alongside
 * the two LFM tiers. The cross-tier e2e comparison (résumé fixture,
 * same prompts) showed it was the slowest of the three on real
 * model-inference questions *and* the most prone to embellishing
 * answers with items that weren't in the document — losing on both
 * speed and grounding. The fast-paths in `src/rag/fast-paths.ts`
 * still carry SmolLM2-specific defensive guards in their comments
 * (don't mistake those for "SmolLM2 is still wired in" — the guards
 * help the LFM models too, since the failure modes generalise).
 *
 * The Ask PDF tool is gated to non-mobile devices (see
 * `tool.desktopOnly` in `tool-registry.ts`), so this registry only
 * carries the desktop-tier models — no mobile-fallback variants.
 * Call sites should go through {@link getModelInfo} rather than read
 * `AI_MODELS` directly.
 */
import type { PipelineType } from "@huggingface/transformers";

/**
 * Stable id used in code to reference a model. Chat ids carry the
 * variant suffix so the pipeline cache (in ai-runtime.ts) keys
 * correctly when the user switches tiers — without the suffix two
 * variants would share one cache slot and clobber each other.
 */
export type AiModelId = "chat:lfm2.5-1.2b" | "chat:lfm2-2.6b" | "embed";

/**
 * Just the chat-variant slugs — used by the picker UI which doesn't
 * need to know about the `chat:` prefix.
 */
export type ChatVariantId = "lfm2.5-1.2b" | "lfm2-2.6b";

/** Convert a chat variant slug to its full {@link AiModelId}. */
export function getChatModelId(variant: ChatVariantId): AiModelId {
  return `chat:${variant}`;
}

/**
 * Sampling defaults for the chat pipeline. Co-located with the model
 * entry so each tier's params travel with it — the chat-model adapter
 * reads these straight off `AiModelInfo` rather than carrying its own
 * per-model conditional. Add a new tier → fill these in once → done.
 *
 * Only `min_p` *or* `top_p` should be set per variant: they're both
 * sampling-cutoff filters and stacking them tends to over-constrain
 * the distribution. `no_repeat_ngram_size` is the lexical-loop
 * crutch — `0` / `undefined` disables it.
 */
export interface ChatGenerationParams {
  /** Per-call cap on tokens emitted. */
  maxNewTokens: number;
  /** Sampling temperature. Lower = more deterministic / extractive. */
  temperature: number;
  /** Nucleus sampling cutoff. Mutually exclusive with `minP`. */
  topP?: number;
  /** Min-p sampling cutoff (Liquid AI's default sampler). */
  minP?: number;
  /** Repetition penalty. 1.0 disables. */
  repetitionPenalty: number;
  /**
   * Bans repeated n-grams of this size. Catches lexically-varied loops
   * the repetition penalty misses. 0 / undefined disables.
   */
  noRepeatNgramSize?: number;
}

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
  /**
   * Generation defaults for chat models (omitted on the embedder).
   * The chat-model adapter reads these on construction; UI overrides
   * (e.g. a "creative" toggle, were we to add one) would layer on top.
   */
  generationParams?: ChatGenerationParams;
}

// ── Chat-variant entries ────────────────────────────────────────────
//
// **History of swaps in the chat slot** (so future-us doesn't repeat
// them). Each candidate was tested against the same résumé fixture
// and prompt set in `tests/e2e/ai-tools.e2e.ts`:
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
//   - SmolLM3-3B (q4f16)     → hybrid-reasoning model emits
//                              unclosed `<think>` tags + catastrophic
//                              repetition loops on open-ended questions
//   - SmolLM2-1.7B           → kept briefly as the Balanced tier;
//                              dropped after the LFM2-vs-LFM2.5 e2e
//                              comparison showed it was the slowest
//                              of three tested *and* most prone to
//                              embellishment (mentioning Zed/Affinity
//                              etc. that aren't in the source). The
//                              fast-paths in `src/rag/fast-paths.ts`
//                              still carry SmolLM2-shaped guards
//                              because the failure modes generalise.
//   - LFM2-1.2B (q4f16)      → first LFM family entry in this slot;
//                              superseded by LFM2.5-1.2B-Instruct
//                              once the .5 release shipped its ONNX.
//
// The pattern across all the failed swaps: small instruct models
// from Google / Meta / Alibaba optimise for conversational fluency
// and confidently fill "plausible" answers from world knowledge.
// Liquid AI's LFM family is the only one we've found in this size
// class that consistently stays anchored to the supplied excerpts.

const CHAT_LFM2_5_1_2B: AiModelInfo = {
  id: "chat:lfm2.5-1.2b",
  displayName: "LFM2.5 (1.2B, instruct, Liquid AI)",
  repo: "LiquidAI/LFM2.5-1.2B-Instruct-ONNX",
  task: "text-generation",
  // ~1.2 GB on disk at q4, ~2 GB peak RAM (Liquid AI's published
  // q4 size; q4f16 isn't shipped for this repo so we use plain q4
  // which is their documented WebGPU-recommended quant). Same
  // hybrid architecture as LFM2-1.2B (10-conv + 6-attention) but
  // newer training recipe (extended pretraining + RL post-training)
  // — Liquid markets LFM2.5 as the latest of the family.
  //
  // **Why this slot is LFM2.5-1.2B-Instruct and not LFM2-1.2B**:
  // straight version-superset. Same parameter count, same family,
  // newer training. The q4-vs-q4f16 swap is forced by Liquid's
  // ONNX export (they don't ship q4f16 for LFM2.5-1.2B) — q4 with
  // fp32 activations is slightly heavier on disk but works on the
  // same WebGPU path. Validated against the résumé probe before
  // shipping; passes phone/email/address extraction the same way
  // the LFM2-1.2B q4f16 build did.
  //
  // **Why not LFM2.5-350M**: tried it on paper but the chat slot
  // has burned every model at ≤ 500M params (SmolLM2-360M, Qwen
  // 0.5B). Smaller models in this size class consistently fail
  // verbatim extraction — they confabulate plausible-looking
  // digits/emails instead of copying from the retrieved chunk.
  // Sticking to 1.2B keeps the discipline guarantee.
  approxSizeBytes: Math.round(1.2 * 1024 * 1024 * 1024),
  approxPeakRamBytes: Math.round(2 * 1024 * 1024 * 1024),
  description:
    "Liquid AI's latest 1.2B hybrid (extended pretraining + RL post-training over the LFM2 base). Designed for on-device structured extraction and RAG. The smaller of the two LFM2-family tiers we ship.",
  bestFor:
    "Devices with 3-4 GB free RAM, or when you want fast first-token latency on a fresh chat.",
  license: "LFM Open License v1.0",
  modelUrl: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct",
  pipelineOptions: { dtype: "q4" },
  // Liquid AI's recommended sampler for the LFM2 family — see
  // their model card. min_p (not top_p) is the documented
  // sampling strategy; repetition_penalty stays low because their
  // training recipe already discourages tight loops. We start
  // without `no_repeat_ngram_size` (a SmolLM2 crutch) and add it
  // back only if the probe surfaces an LFM2-specific loop
  // pathology. LFM2.5 inherits the same recommended defaults.
  generationParams: {
    maxNewTokens: 256,
    temperature: 0.3,
    minP: 0.15,
    repetitionPenalty: 1.05,
  },
};

const CHAT_LFM2_2_6B: AiModelInfo = {
  id: "chat:lfm2-2.6b",
  displayName: "LFM2 (2.6B, Liquid AI)",
  repo: "onnx-community/LFM2-2.6B-ONNX",
  task: "text-generation",
  // ~1.5 GB on disk at q4f16, ~3.5 GB peak RAM. The largest of the
  // three tiers — recommended on ≥ 8 GB free RAM. Same hybrid
  // architecture and training discipline as LFM2-1.2B but with the
  // extra capacity that lets it handle longer, more nuanced
  // extraction questions.
  approxSizeBytes: Math.round(1.5 * 1024 * 1024 * 1024),
  approxPeakRamBytes: Math.round(3.5 * 1024 * 1024 * 1024),
  description:
    "Liquid AI's larger hybrid model. Same on-device extraction discipline as LFM2-1.2B with more capacity for longer answers and harder questions.",
  bestFor: "Devices with ≥ 8 GB free RAM where you want the best extraction quality.",
  license: "LFM Open License v1.0",
  modelUrl: "https://huggingface.co/LiquidAI/LFM2-2.6B",
  pipelineOptions: { dtype: "q4f16" },
  generationParams: {
    maxNewTokens: 256,
    temperature: 0.3,
    minP: 0.15,
    repetitionPenalty: 1.05,
  },
};

const EMBED: AiModelInfo = {
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
  //     bound; the chat model gets exclusive use of WebGPU where
  //     it actually matters.
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
};

/**
 * Desktop-tier registry. Read these via {@link getModelInfo} so the
 * chat-variant selection layer can be added without touching every
 * call site.
 */
export const AI_MODELS: Record<AiModelId, AiModelInfo> = {
  "chat:lfm2.5-1.2b": CHAT_LFM2_5_1_2B,
  "chat:lfm2-2.6b": CHAT_LFM2_2_6B,
  embed: EMBED,
};

// ── Chat-variant picker helpers ─────────────────────────────────────

/**
 * Ordered list of chat variants — drives the picker UI. Order is
 * Compact → Balanced → Quality, matching the segmented-control flow
 * left-to-right (smallest to biggest footprint).
 */
export const CHAT_VARIANT_IDS: readonly ChatVariantId[] = ["lfm2.5-1.2b", "lfm2-2.6b"] as const;

/** Short tier label shown in the picker — never the full model name. */
export const CHAT_VARIANT_TIER_LABEL: Record<ChatVariantId, string> = {
  "lfm2.5-1.2b": "Compact",
  "lfm2-2.6b": "Quality",
};

/**
 * localStorage key holding the user's chosen chat variant. Absent /
 * invalid → fall back to {@link getDefaultChatVariant}.
 */
const CHAT_VARIANT_STORAGE_KEY = "cloakpdf:chat-variant";

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Static default for a fresh visitor who hasn't picked a tier yet.
 *
 * **Why this isn't RAM-aware.** `navigator.deviceMemory` is a noisy
 * signal — Chrome caps it at 8 GB for privacy, so a 16 GB or 32 GB
 * desktop reads identical to an 8 GB laptop. Firefox and Safari
 * don't expose the API at all (returns `null`). A "recommendation"
 * built on that signal would mis-classify the majority of desktops
 * either way, so we don't try.
 *
 * Instead we ship the smallest tier as the default — Compact /
 * LFM2.5-1.2B-Instruct fits any device we'd let near this tool,
 * downloads in a few minutes on broadband, and is purpose-built by
 * Liquid AI for on-device extraction (so the answer quality is
 * reasonable out of the box). Users who want more can pick Balanced
 * or Quality from the picker; the choice persists across reloads.
 */
export function getDefaultChatVariant(): ChatVariantId {
  return "lfm2.5-1.2b";
}

/**
 * The user's currently-selected chat variant. Reads localStorage
 * first; falls back to {@link getDefaultChatVariant} when nothing
 * is stored (fresh visitor) or the stored value is invalid (schema
 * drift, manual tampering). Pure — no side effects.
 */
export function getActiveChatVariant(): ChatVariantId {
  const storage = safeLocalStorage();
  const stored = storage?.getItem(CHAT_VARIANT_STORAGE_KEY);
  if (stored && (CHAT_VARIANT_IDS as readonly string[]).includes(stored)) {
    return stored as ChatVariantId;
  }
  return getDefaultChatVariant();
}

/**
 * Persist the user's choice. Best-effort — failures (private mode,
 * quota exceeded) are swallowed; subsequent reads simply fall back
 * to the static default.
 */
export function setActiveChatVariant(variant: ChatVariantId): void {
  const storage = safeLocalStorage();
  try {
    storage?.setItem(CHAT_VARIANT_STORAGE_KEY, variant);
  } catch {
    // ignore
  }
}

/** Convenience: full {@link AiModelId} for the currently-active chat tier. */
export function getActiveChatModelId(): AiModelId {
  return getChatModelId(getActiveChatVariant());
}

/**
 * Cleanup-only migration for the pre-tier
 * `cloakpdf:ai-model-ready:chat` flag (and the SmolLM2-specific
 * variant-suffixed flag we briefly used while SmolLM2 was the
 * Balanced tier). Both removed because SmolLM2 isn't in the registry
 * any more — the flags would just be orphan localStorage entries.
 *
 * Returning users who downloaded SmolLM2 still have the model bytes
 * sitting in CacheStorage (~1 GB). Those are wasted but unavoidable
 * — there's no programmatic way to evict a CacheStorage entry from
 * here without knowing the exact request URLs. They get reclaimed
 * the next time the user clicks "Free model memory" in the active-
 * model bar (which calls `disposeAllModels` + lets the browser GC
 * the underlying entries) or when CacheStorage hits its quota and
 * evicts LRU.
 *
 * Idempotent. Call once at app startup; safe to re-run.
 */
export function migrateLegacyChatReadyFlag(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem("cloakpdf:ai-model-ready:chat");
    storage.removeItem("cloakpdf:ai-model-ready:chat:smollm2-1.7b");
    // If a returning user's variant pref points at the dropped tier,
    // clear it so `getActiveChatVariant` falls back to the current
    // default rather than returning a slug that's not in CHAT_VARIANT_IDS.
    if (storage.getItem(CHAT_VARIANT_STORAGE_KEY) === "smollm2-1.7b") {
      storage.removeItem(CHAT_VARIANT_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

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
