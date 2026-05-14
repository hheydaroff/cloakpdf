/**
 * Task-typed wrappers around the opaque {@link AiPipeline} handles
 * returned by `loadPipeline()`.
 *
 * **Why this file exists.** Transformers.js exposes one concrete pipeline
 * class per task (TextGenerationPipeline, TokenClassificationPipeline,
 * etc.) with subtly different call shapes. If every tool called the
 * pipeline directly it would have to cast and hard-code those shapes —
 * swapping the underlying model would mean touching every tool.
 *
 * Instead, each task gets one helper here. Tools call the helper; the
 * helper knows the pipeline shape. To swap a model, update its entry in
 * {@link AI_MODELS} — no tool code changes.
 *
 * Currently exposed tasks:
 *
 *   - {@link runChat} — chat-style generation with optional streaming.
 *   - {@link runSummarize} — prompt-based abstractive summarization.
 *   - {@link runNer} — prompt-based named-entity recognition.
 */
import type { AiPipeline } from "./ai-runtime.ts";

/**
 * Module-level cache for the dynamically-imported `TextStreamer`
 * constructor. The first `runChat({ onToken })` call has to wait for
 * the import to resolve; subsequent calls re-use the same constructor
 * without paying the dynamic-import cost again.
 */
let _textStreamerCtor: typeof import("@huggingface/transformers").TextStreamer | null = null;
async function getTextStreamerCtor(): Promise<
  typeof import("@huggingface/transformers").TextStreamer
> {
  if (!_textStreamerCtor) {
    const mod = await import("@huggingface/transformers");
    _textStreamerCtor = mod.TextStreamer;
  }
  return _textStreamerCtor;
}

// ── Chat / text-generation ────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatGenerationOptions {
  /** Cap on tokens emitted by this call. Default 512. */
  maxNewTokens?: number;
  /**
   * `true` enables nucleus/temperature sampling. Default `true` because
   * small (≤1.5B) on-device models reliably collapse into single-token
   * loops under greedy decoding — passing `false` here is opt-in for
   * cases where strict determinism beats stability (e.g. tests).
   */
  doSample?: boolean;
  /** Sampling temperature. Ignored when `doSample` is false. */
  temperature?: number;
  /** Nucleus sampling cutoff. Ignored when `doSample` is false. */
  topP?: number;
  /**
   * Penalty applied to tokens already in the output, suppressing repeat
   * loops. Default 1.1 — Qwen's published recommendation. 1.0 disables.
   */
  repetitionPenalty?: number;
  /**
   * Fires for each decoded text fragment as the model generates. Use it
   * to stream tokens into a chat UI. The callback receives the *delta*
   * (only the newly generated piece), not the cumulative text.
   */
  onToken?: (delta: string) => void;
}

/**
 * Run a chat-template generation against a text-generation pipeline.
 *
 * Returns the assistant's final reply as a plain string. When
 * `onToken` is supplied, fragments are also streamed to the callback
 * as they're decoded — perfect for a typewriter-style chat UI.
 */
export async function runChat(
  pipe: AiPipeline,
  messages: ChatMessage[],
  options: ChatGenerationOptions = {},
): Promise<string> {
  // We treat the pipeline as a function with an attached `tokenizer`.
  // This matches the shape of TextGenerationPipeline; Transformers.js
  // doesn't export a Plain-old callable type, so we spell it inline.
  const generator = pipe as unknown as ((
    messages: ChatMessage[],
    opts: Record<string, unknown>,
  ) => Promise<Array<{ generated_text: ChatMessage[] | string }>>) & {
    tokenizer: unknown;
  };

  let streamer: unknown;
  if (options.onToken) {
    const TextStreamer = await getTextStreamerCtor();
    streamer = new TextStreamer(
      generator.tokenizer as ConstructorParameters<typeof TextStreamer>[0],
      {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: options.onToken,
      },
    );
  }

  // Defaults follow Qwen 2.5's published inference recipe — sampling
  // with mild temperature, nucleus cutoff, and a >1 repetition penalty.
  // These are the settings the model authors validated against; they
  // also happen to be the values that stop small-model loop pathologies
  // ("!!!!!!" / single-token runs) we saw with greedy decoding.
  const result = await generator(messages, {
    max_new_tokens: options.maxNewTokens ?? 512,
    do_sample: options.doSample ?? true,
    temperature: options.temperature ?? 0.6,
    top_p: options.topP ?? 0.9,
    repetition_penalty: options.repetitionPenalty ?? 1.1,
    ...(streamer ? { streamer } : {}),
  });

  const generated = result[0]?.generated_text;
  if (Array.isArray(generated)) {
    // Chat output: array of messages. The model's reply is the last
    // entry (it appends after the prompt's `system`/`user` turns).
    const last = generated[generated.length - 1];
    return last?.content?.trim() ?? "";
  }
  return (typeof generated === "string" ? generated : "").trim();
}

// ── Summarization (LLM-prompted) ──────────────────────────────────

/**
 * Three coarse summary lengths exposed to the UI. We don't expose
 * raw token counts because the chat model controls length via the
 * prompt, not via `min_length`/`max_length` parameters.
 */
export type SummarizeLength = "short" | "medium" | "long";

const SUMMARY_LENGTH_PHRASE: Record<SummarizeLength, string> = {
  short: "1 to 2 sentences",
  medium: "3 to 5 sentences",
  long: "one thorough paragraph of 6 to 10 sentences",
};

/**
 * Summarize `text` by prompting the chat pipeline. Replaces the
 * previous DistilBART-based pipeline so every AI tool runs off the
 * single Qwen model the user has downloaded.
 *
 * Decoding notes — these are the levers we tuned after seeing the
 * 0.5B tier emit byte-level gibberish under default chat settings:
 *
 *   - **Greedy decoding** (`do_sample: false`). Sampling lets a small
 *     model wander into Qwen's byte-fallback tokens, which decode as
 *     digits and punctuation — exactly the failure mode reported on
 *     real PDFs. Greedy locks the model onto the highest-probability
 *     path; the repetition penalty alone is enough to stop loops.
 *   - **Stronger repetition penalty** (1.15 vs the chat default 1.1).
 *     Summarization tends to revisit the same phrases more than open
 *     Q&A, so it needs slightly more push to keep moving forward.
 *   - **Instruction *after* the text** in the user turn. Small models
 *     produce more grounded summaries when the source content is in
 *     view *before* the task is described — matches the "read first,
 *     then answer" pattern they were fine-tuned on.
 */
export async function runSummarize(
  pipe: AiPipeline,
  text: string,
  length: SummarizeLength,
): Promise<string> {
  return runChat(
    pipe,
    [
      {
        role: "system",
        content:
          "You are a precise summariser. You produce clear, factual summaries based solely on the text the user provides. Reply with the summary only — no preamble, no quotes, no list formatting.",
      },
      {
        role: "user",
        content: `Read the following text and summarize it in ${SUMMARY_LENGTH_PHRASE[length]}.\n\nText:\n${text}\n\nSummary:`,
      },
    ],
    {
      doSample: false,
      repetitionPenalty: 1.15,
      maxNewTokens: length === "long" ? 400 : length === "medium" ? 240 : 120,
    },
  );
}

// ── Named-entity recognition (LLM-prompted) ───────────────────────

/** Entity classes the chat-based NER prompt asks the model to emit. */
export type NerEntityType = "PER" | "ORG" | "LOC" | "MISC";

export interface NerEntity {
  /** Surface form as it appears in the source text. */
  text: string;
  /** One of {@link NerEntityType}. */
  type: NerEntityType;
}

const NER_SYSTEM_PROMPT = [
  "You extract named entities from text. Return a JSON array — and ONLY a",
  'JSON array — where each item has shape {"text": string, "type":',
  '"PER"|"ORG"|"LOC"|"MISC"}. PER = a person\'s name. ORG = a company,',
  "agency, or institution. LOC = a city, country, or other place. MISC =",
  "any other proper noun. Use the exact surface form from the text. If no",
  "entities are present, return [].",
].join(" ");

/**
 * Extract named entities by prompting the chat pipeline. Replaces the
 * BERT-NER token-classification model. The chat model produces JSON
 * directly, so we lose character offsets and confidence scores but
 * gain a single shared model across every AI tool. Invalid model
 * output is tolerated — we return [] rather than throwing so a bad
 * chunk doesn't tank the whole scan.
 */
export async function runNer(pipe: AiPipeline, text: string): Promise<NerEntity[]> {
  const reply = await runChat(
    pipe,
    [
      { role: "system", content: NER_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    {
      // Greedy decoding for structured output — keeps the JSON shape
      // predictable. The repetition penalty alone is enough to stop
      // small-model loops on this task.
      doSample: false,
      maxNewTokens: 600,
    },
  );

  return parseNerJson(reply);
}

/**
 * Best-effort parser for the JSON array the NER prompt asks the model
 * to emit. Models sometimes prefix prose or wrap output in a fenced
 * code block; we scan for the first balanced JSON array in the reply
 * and feed *only* that to `JSON.parse`. Exported for tests — the
 * production caller is {@link runNer}.
 */
export function parseNerJson(reply: string): NerEntity[] {
  const first = reply.indexOf("[");
  const last = reply.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(first, last + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: NerEntity[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === "object" &&
      "text" in item &&
      "type" in item &&
      typeof (item as { text: unknown }).text === "string" &&
      typeof (item as { type: unknown }).type === "string"
    ) {
      const t = (item as { text: string }).text.trim();
      const k = (item as { type: string }).type.toUpperCase();
      if (!t) continue;
      if (k === "PER" || k === "ORG" || k === "LOC" || k === "MISC") {
        out.push({ text: t, type: k });
      }
    }
  }
  return out;
}
