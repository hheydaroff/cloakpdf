/**
 * Wiring tests for `runNer` and `runSummarize`. These don't load a
 * real model — they substitute a tiny fake pipeline that records what
 * was asked and returns canned replies. Goal: assert the prompts go
 * out in the right shape and the answers come back parsed correctly.
 *
 * The fake mimics the @huggingface/transformers TextGenerationPipeline
 * shape: a callable with an attached `tokenizer` property. Test code
 * controls the reply by assigning to `fake.nextReply`.
 */
import { describe, expect, it } from "vitest";
import type { AiPipeline } from "../../src/utils/ai-runtime.ts";
import type { ChatMessage } from "../../src/utils/ai-tasks.ts";
import { runNer, runSummarize } from "../../src/utils/ai-tasks.ts";

/**
 * Build a fake pipeline that records the latest call args on
 * `lastMessages` / `lastOptions` and returns whatever `nextReply`
 * is set to. The returned object is shaped to match what `runChat`
 * casts the pipeline to — callable plus `tokenizer`.
 */
function makeFakePipeline(): {
  pipe: AiPipeline;
  setReply: (text: string) => void;
  lastMessages: () => ChatMessage[] | null;
  lastOptions: () => Record<string, unknown> | null;
} {
  let nextReply = "";
  let lastMessages: ChatMessage[] | null = null;
  let lastOptions: Record<string, unknown> | null = null;

  // `runChat` calls the pipeline as a function and reads `.tokenizer`.
  // We attach the tokenizer property to the callable. The TextStreamer
  // path isn't exercised here because we don't pass `onToken`.
  const callable = (messages: ChatMessage[], options: Record<string, unknown>) => {
    lastMessages = messages;
    lastOptions = options;
    return Promise.resolve([
      {
        // Match the array-of-messages shape `runChat` expects when the
        // pipeline applied its chat template. Last entry = assistant reply.
        generated_text: [...messages, { role: "assistant", content: nextReply }],
      },
    ]);
  };
  (callable as unknown as { tokenizer: unknown }).tokenizer = {};

  return {
    pipe: callable as unknown as AiPipeline,
    setReply: (t) => {
      nextReply = t;
    },
    lastMessages: () => lastMessages,
    lastOptions: () => lastOptions,
  };
}

// ── runNer ────────────────────────────────────────────────────────

describe("runNer", () => {
  it("sends the user text as the user-role message", async () => {
    const fake = makeFakePipeline();
    fake.setReply("[]");
    await runNer(fake.pipe, "John Smith works at Acme Corp.");
    const messages = fake.lastMessages();
    expect(messages?.[0].role).toBe("system");
    expect(messages?.[1]).toEqual({ role: "user", content: "John Smith works at Acme Corp." });
  });

  it("instructs the model in the system prompt to emit JSON only", async () => {
    const fake = makeFakePipeline();
    fake.setReply("[]");
    await runNer(fake.pipe, "anything");
    const system = fake.lastMessages()?.[0].content ?? "";
    expect(system).toContain("JSON array");
    expect(system.toLowerCase()).toContain("only");
  });

  it("uses greedy decoding for structured output", async () => {
    // We pin this in the test because sampling makes JSON output
    // unstable — if someone flips do_sample back to true the NER tool
    // will return parseable but inconsistent results across runs.
    const fake = makeFakePipeline();
    fake.setReply("[]");
    await runNer(fake.pipe, "x");
    expect(fake.lastOptions()?.do_sample).toBe(false);
  });

  it("returns parsed entities for a clean JSON reply", async () => {
    const fake = makeFakePipeline();
    fake.setReply('[{"text":"Berlin","type":"LOC"},{"text":"Sumit","type":"PER"}]');
    const result = await runNer(fake.pipe, "Sumit lives in Berlin.");
    expect(result).toEqual([
      { text: "Berlin", type: "LOC" },
      { text: "Sumit", type: "PER" },
    ]);
  });

  it("returns [] when the model emits prose instead of JSON", async () => {
    // Failure mode we hit during early prompting iterations — model
    // ignores the format instruction and writes a sentence. We must
    // not throw; we just lose detections from that chunk.
    const fake = makeFakePipeline();
    fake.setReply("I'm sorry, I cannot help with that.");
    const result = await runNer(fake.pipe, "x");
    expect(result).toEqual([]);
  });
});

// ── runSummarize ──────────────────────────────────────────────────

describe("runSummarize", () => {
  it("returns the model's reply trimmed of surrounding whitespace", async () => {
    const fake = makeFakePipeline();
    fake.setReply("  This is the summary.\n\n");
    const result = await runSummarize(fake.pipe, "Long document text.", "medium");
    expect(result).toBe("This is the summary.");
  });

  it("varies the length guidance in the user-message prompt for each tier", async () => {
    const fake = makeFakePipeline();
    fake.setReply("ok");

    await runSummarize(fake.pipe, "doc", "short");
    const shortUser = fake.lastMessages()?.[1].content ?? "";

    await runSummarize(fake.pipe, "doc", "long");
    const longUser = fake.lastMessages()?.[1].content ?? "";

    expect(shortUser).not.toBe(longUser);
    // Spot-check that each prompt asks for a different length.
    expect(shortUser).toContain("1 to 2 sentences");
    expect(longUser).toContain("paragraph");
  });

  it("caps max_new_tokens proportionally to the requested length", async () => {
    const fake = makeFakePipeline();
    fake.setReply("ok");

    await runSummarize(fake.pipe, "doc", "short");
    const shortCap = fake.lastOptions()?.max_new_tokens as number;

    await runSummarize(fake.pipe, "doc", "long");
    const longCap = fake.lastOptions()?.max_new_tokens as number;

    // Long should generate more tokens than short — otherwise the
    // "long" setting would get truncated mid-sentence on real models.
    expect(longCap).toBeGreaterThan(shortCap);
  });

  it("uses greedy decoding to avoid byte-level token gibberish on small tiers", async () => {
    // Failure mode this pins: under sampling, Qwen 0.5B q8 can drift
    // into byte-fallback tokens that decode as digits/punctuation.
    // Greedy locks output to the highest-probability path.
    const fake = makeFakePipeline();
    fake.setReply("ok");
    await runSummarize(fake.pipe, "doc", "medium");
    expect(fake.lastOptions()?.do_sample).toBe(false);
  });

  it("uses a stronger repetition penalty than the chat default", async () => {
    // Summarization revisits the same phrases more than open Q&A,
    // so it needs a slightly stronger push to keep moving forward.
    const fake = makeFakePipeline();
    fake.setReply("ok");
    await runSummarize(fake.pipe, "doc", "medium");
    expect(fake.lastOptions()?.repetition_penalty).toBeGreaterThan(1.1);
  });

  it("places the source text and instruction in the user-role message", async () => {
    // Layout matters for small models: the text comes first so the
    // model has read the content before being asked to summarise.
    const fake = makeFakePipeline();
    fake.setReply("ok");
    await runSummarize(fake.pipe, "The quick brown fox.", "medium");
    const userContent = fake.lastMessages()?.[1].content ?? "";
    expect(userContent).toContain("The quick brown fox.");
    expect(userContent.toLowerCase()).toContain("summari");
  });
});
