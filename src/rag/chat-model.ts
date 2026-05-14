/**
 * LangChain `SimpleChatModel` adapter wrapping a Transformers.js
 * `text-generation` pipeline.
 *
 * Why this adapter exists: LangGraph nodes, prompt templates, and any
 * future chains/agents speak in LangChain's `BaseMessage` / `ChatResult`
 * vocabulary. This class bridges that abstraction to our on-device
 * inference. Sampling defaults match the values that stop small-model
 * loop pathologies — see `runChat` for the full story.
 *
 * Streaming is implemented via `_streamResponseChunks` so consumers
 * can pipe tokens straight into the UI (typewriter chat) without
 * waiting for the full response.
 */
import {
  SimpleChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { AiPipeline } from "../utils/ai-runtime.ts";
import { type ChatMessage, runChat } from "../utils/ai-tasks.ts";

export interface TransformersJsChatModelOptions extends BaseChatModelParams {
  /** Resolved Transformers.js `text-generation` pipeline. */
  pipeline: AiPipeline;
  /** Per-call cap on tokens emitted. Default 512. */
  maxNewTokens?: number;
  /** Sampling temperature. Default 0.6. */
  temperature?: number;
  /** Nucleus sampling cutoff. Default 0.9. */
  topP?: number;
  /** Repetition penalty. Default 1.1. */
  repetitionPenalty?: number;
}

export class TransformersJsChatModel extends SimpleChatModel {
  private pipeline: AiPipeline;
  private maxNewTokens: number;
  private temperature: number;
  private topP: number;
  private repetitionPenalty: number;

  constructor(options: TransformersJsChatModelOptions) {
    super(options);
    this.pipeline = options.pipeline;
    this.maxNewTokens = options.maxNewTokens ?? 512;
    this.temperature = options.temperature ?? 0.6;
    this.topP = options.topP ?? 0.9;
    this.repetitionPenalty = options.repetitionPenalty ?? 1.1;
  }

  _llmType(): string {
    return "transformers-js";
  }

  /**
   * Non-streaming generation. Required by `SimpleChatModel`; the
   * streaming hook below is what the UI actually drives.
   */
  async _call(messages: BaseMessage[]): Promise<string> {
    const chatMessages = toChatMessages(messages);
    return runChat(this.pipeline, chatMessages, {
      maxNewTokens: this.maxNewTokens,
      temperature: this.temperature,
      topP: this.topP,
      repetitionPenalty: this.repetitionPenalty,
    });
  }

  /**
   * Streaming generation. Yields one `ChatGenerationChunk` per decoded
   * fragment — matches what `RunnableSequence.stream()` expects so the
   * graph can stream end-to-end without intermediate buffering.
   */
  async *_streamResponseChunks(messages: BaseMessage[]): AsyncGenerator<ChatGenerationChunk> {
    const chatMessages = toChatMessages(messages);

    // Adapt the imperative `onToken` callback into an async generator
    // using a small in-flight queue. Each token resolves a pending
    // promise; when generation completes we close the queue.
    type Deferred = {
      resolve: (chunk: string | null) => void;
      reject: (err: unknown) => void;
    };
    const waiters: Deferred[] = [];
    const buffer: string[] = [];
    let done = false;
    let error: unknown = null;

    const push = (chunk: string | null) => {
      const w = waiters.shift();
      if (w) {
        if (chunk === null) w.resolve(null);
        else w.resolve(chunk);
      } else if (chunk !== null) {
        buffer.push(chunk);
      }
    };

    const next = () =>
      new Promise<string | null>((resolve, reject) => {
        if (buffer.length > 0) {
          resolve(buffer.shift() as string);
        } else if (done) {
          resolve(null);
        } else if (error) {
          reject(error);
        } else {
          waiters.push({ resolve, reject });
        }
      });

    // Kick off generation. We don't await here so we can yield tokens
    // through the async generator as they arrive.
    const generationPromise = runChat(this.pipeline, chatMessages, {
      maxNewTokens: this.maxNewTokens,
      temperature: this.temperature,
      topP: this.topP,
      repetitionPenalty: this.repetitionPenalty,
      onToken: (delta) => push(delta),
    })
      .then(() => {
        done = true;
        push(null);
      })
      .catch((e) => {
        error = e;
        // Reject any pending waiters so the consumer sees the failure.
        while (waiters.length) {
          const w = waiters.shift();
          w?.reject(e);
        }
      });

    while (true) {
      const token = await next();
      if (token === null) break;
      yield new ChatGenerationChunk({
        text: token,
        message: new AIMessageChunk({ content: token }),
      });
    }

    // Surface any error that fired after the queue drained.
    await generationPromise;
  }
}

/**
 * Translate LangChain `BaseMessage[]` into the simple
 * `{role, content}[]` shape `runChat` expects. Anything that isn't a
 * system / human / AI message is coerced to a user turn — fine for
 * our tool's single-prompt-per-call usage.
 */
function toChatMessages(messages: BaseMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    const content = flattenContent(m.content);
    if (m instanceof SystemMessage) return { role: "system", content };
    if (m instanceof HumanMessage) return { role: "user", content };
    if (m.getType() === "ai") return { role: "assistant", content };
    return { role: "user", content };
  });
}

/**
 * Reduce LangChain's `MessageContent` (string OR array of complex
 * parts, e.g. `[{ type: "text", text: "..." }, { type: "image_url", ... }]`)
 * down to a plain string our text-generation pipeline understands.
 * Image / non-text parts are skipped — Transformers.js text-generation
 * pipelines don't accept them anyway.
 */
function flattenContent(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object" && "type" in part && part.type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}
