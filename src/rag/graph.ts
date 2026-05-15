/**
 * LangGraph state machine for the Ask PDF chat loop.
 *
 *                   ┌──────────────┐
 *                   │    START     │
 *                   └──────┬───────┘
 *                          │
 *                          ▼
 *                   ┌──────────────┐
 *                   │   classify   │  reads:  state.question
 *                   └──────┬───────┘  writes: state.intent
 *                          │
 *           ┌──────────────┴──────────────┐
 *  intent == chitchat               intent == question
 *  (small-talk regex)               (everything else)
 *           │                              │
 *           ▼                              ▼
 *   ┌──────────────┐               ┌──────────────┐
 *   │   chitchat   │               │   retrieve   │  reads:  state.question
 *   └──────┬───────┘               └──────┬───────┘  writes: state.docs,
 *          │                              │                 state.citedPages,
 *          │                              │                 state.offTopic
 *          │                              │
 *          │                ┌─────────────┴─────────────┐
 *          │           offTopic == true            offTopic == false
 *          │           (top cosine <                (top cosine ≥
 *          │            RELEVANCE_THRESHOLD)         RELEVANCE_THRESHOLD)
 *          │                │                              │
 *          │                ▼                              ▼
 *          │         ┌──────────────┐               ┌──────────────┐
 *          │         │    refuse    │               │   generate   │  reads:  state.docs
 *          │         └──────┬───────┘               └──────┬───────┘          state.question
 *          │                │                              │           writes: state.answer
 *          ▼                ▼                              ▼
 *                   ┌──────────────┐
 *                   │     END      │
 *                   └──────────────┘
 *
 * **Why a graph for what feels like a 3-step pipeline:**
 *
 *   - The two branch points (chitchat-vs-question, off-topic-vs-on-
 *     topic) compose cleanly as conditional edges. The alternative
 *     — `if/else` inside one giant `ask` function — buries the
 *     control flow in imperative code and makes adding a fourth
 *     branch (e.g. a future "low-confidence ⇒ ask user to clarify"
 *     node) much harder.
 *
 *   - State has a single typed schema (`RagState`). Every node
 *     reads/writes a tagged subset, so when a new node is added the
 *     surface area to think about is the state diff, not "what does
 *     this function take and return".
 *
 *   - LangGraph's compiled graph is the durable artifact other parts
 *     of LangChain (callbacks, tracing, streaming) hook into. Rolling
 *     our own state machine would re-implement that infrastructure.
 *
 * **Why two gates instead of just trusting the system prompt:**
 *
 *   1. `classify` (SMALL_TALK_RE) routes greetings to `chitchat` so
 *      we don't burn an embedder pass + retrieval round-trip on
 *      "hi" / "thanks" / "ok".
 *   2. `retrieve` runs the cosine-similarity gate (top dense match
 *      vs RELEVANCE_THRESHOLD) and tags the state as `offTopic`
 *      when no chunk is a plausible answer. The `refuse` node then
 *      returns a canned message without ever calling the chat model.
 *      Background: SmolLM2-1.7B's instruction-following caves to
 *      confident general-knowledge answers — "the capital of France
 *      is Paris (page 5 of your document)" was the literal failure
 *      mode we observed. A prompt-only "do not use general
 *      knowledge" rule wasn't enough; a deterministic gate is.
 *
 * **Why a document anchor on retrieve:**
 *
 *   Identity / overview questions ("whose résumé is this?",
 *   "what's the title?") often score poorly against the title chunk
 *   under BGE — the title says "Sumit Sahoo / Enterprise Architect",
 *   the query says "whose résumé", and the encoder doesn't bridge
 *   them strongly enough for the chunk to land in the top-K. The
 *   answer is structurally always in the title block, so we merge
 *   `anchorChunks` (the doc's first chunk) into every retrieve
 *   result, deduplicated by chunkId. Cost: at most one extra chunk
 *   in context.
 */
import type { Document } from "@langchain/core/documents";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseRetriever } from "@langchain/core/retrievers";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { TransformersJsChatModel } from "./chat-model.ts";
import type { ChunkMetadata } from "./chunking.ts";

/**
 * System prompt for the on-device chat model (currently SmolLM2-1.7B).
 *
 * Three things this phrasing is specifically engineered for:
 *
 *   1. **Structural inference.** The first version refused to say
 *      "this is a résumé" because no excerpt literally claimed so —
 *      even though the chunks contained a name, a contact block, a
 *      work experience section, a skills list, and a "Languages"
 *      block (textbook résumé layout). We explicitly grant the model
 *      permission to identify document type from those cues instead
 *      of demanding verbatim grounding for every claim.
 *
 *   2. **Format adapts to the question.** "What is this about?" wants
 *      prose; "What tools are mentioned?" wants a list. The earlier
 *      "1–3 sentences, never a list" rule (a SmolLM2-360M loop crutch)
 *      forced a single shape regardless of intent.
 *
 *   3. **Honest about gaps.** When the excerpts don't cover the
 *      question we want a one-line "the excerpts don't say", not a
 *      confident hallucination. Stays at the end so the model has
 *      already considered the rest of the rules.
 */
const SYSTEM_PROMPT = `You answer questions about a PDF. The user message contains the document header (title and contact block) followed by relevant excerpts.

How to answer:
- Read the header and excerpts. Most questions can be answered directly from them — scan for the relevant span and use it.
- For specific values (phone numbers, emails, URLs, addresses, dates, prices, IDs, names): find the value in the header or excerpts and quote it EXACTLY, every character. Lead the reply with the value itself — no preamble, no hedging.
- For "what is this document?" / "whose document is this?": identify the type from structure. A name + contact block + work experience sections = a résumé / CV. An executive summary + numbered sections = a report. Line items + total = an invoice. Name the person or entity from the header, not "the author".
- For lists (tools, technologies, skills, dates): a short comma-separated list or short bullets is fine.
- Keep answers tight: one sentence for a single fact, up to three for overviews. Cite (page N) only for facts visible on that page.

When the answer is not in the header or excerpts:
- Reply with exactly one sentence: "I couldn't find that in this document." Do not guess. Do not invent values, names, or numbers.

When the question is unrelated to the document:
- Decline in one sentence and invite a question about the PDF. Do not answer the off-topic question even partially.

Never use general knowledge. Never fabricate facts or citations. Treat the header as authoritative for identity, title, and contact information.`;

const CHITCHAT_PROMPT =
  "You are a friendly assistant who helps a user explore a PDF document. Respond briefly to the user's greeting and invite them to ask something specific about the document.";

/**
 * Canned reply for questions whose best embedding match against the
 * corpus falls below {@link RELEVANCE_THRESHOLD}. Written to be polite
 * but unambiguous about the scope — "I can only answer questions about
 * the uploaded document" is the entire contract.
 */
const OFF_TOPIC_REFUSAL =
  "I can only answer questions about the document you uploaded. Could you ask something about its contents instead?";

/**
 * Minimum cosine similarity between the query embedding and the
 * best-matching chunk for us to attempt an answer.
 *
 * **bge-base history (kept for context):**
 *
 *   - on-topic "what tools are mentioned?"  → top cosine ≈ 0.65
 *   - on-topic "what is this about?"        → top cosine ≈ 0.50
 *   - off-topic "capital of France?"        → top cosine ≈ 0.40 (!)
 *
 *   The off-topic floor sat at 0.40 because bge embedded "capital of
 *   France" weakly against the contact block ("Pune, Maharashtra,
 *   India" — a city + country combo). 0.50 was the safe threshold.
 *
 * **EmbeddingGemma (current).** The model is trained for asymmetric
 * retrieval with task prefixes, so the absolute scale is different.
 * Empirically the gap between on-topic and off-topic widens — the
 * search-result/document prefixes effectively encode "this is a
 * retrieval scenario" into both sides, so generic-knowledge queries
 * that incidentally word-overlap with chunks score lower than they
 * did under bge. We keep the threshold at **0.5** as a starting
 * point and recalibrate from the retrieval probe (see
 * `tests/retrieval-debug/*.json` — re-run `pnpm test:probe` after a
 * model swap and confirm the off-topic question still refuses).
 *
 * False rejections on legitimate obscure questions are possible at
 * this threshold — that's an accuracy/safety trade we accept because
 * the alternative (the LLM hallucinating a fake page citation —
 * literal failure mode we observed) is materially worse.
 */
const RELEVANCE_THRESHOLD = 0.5;

/** Recognises greetings / acknowledgements that don't need retrieval. */
const SMALL_TALK_RE =
  /^(hi+|hello|hey+|yo|sup|hola|howdy|good (morning|afternoon|evening)|thanks?|thank you|ok|okay|cool|nice|got it)[!.?]*$/i;

function isSmallTalk(q: string): boolean {
  const trimmed = q.trim().toLowerCase();
  if (trimmed.length <= 2) return true;
  return SMALL_TALK_RE.test(trimmed);
}

/**
 * Shared state schema for the RAG graph. `Annotation.Root` gives us a
 * typed channel-based state with default reducers (last-write-wins on
 * primitives, override on objects) — fine for a linear flow.
 */
export const RagStateAnnotation = Annotation.Root({
  question: Annotation<string>(),
  /**
   * Routing tag. `classify` sets this to `"chitchat"` or `"question"`;
   * `retrieve` may then re-tag a `"question"` as `"off-topic"` when
   * the dense-similarity gate fires. Surfaced on `AskResult` so the
   * UI can hide citation chrome on refused turns.
   */
  intent: Annotation<"chitchat" | "question" | "off-topic" | undefined>(),
  /**
   * Set by `retrieve` when the best-matching chunk scores below the
   * relevance threshold. Routes the graph to `refuse` instead of
   * `generate` so the chat model never sees obviously off-topic
   * queries.
   */
  offTopic: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  docs: Annotation<Document<ChunkMetadata>[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  citedPages: Annotation<number[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  answer: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

export type RagState = typeof RagStateAnnotation.State;

export interface BuildGraphOptions {
  /** Hybrid retriever (BM25 ⨂ dense, fused via RRF). */
  retriever: BaseRetriever;
  /** Wrapped chat model — drives both `generate` and `chitchat` nodes. */
  chatModel: TransformersJsChatModel;
  /**
   * Returns the maximum cosine similarity between the query and the
   * indexed document. When provided, the graph short-circuits to a
   * canned refusal when the score falls below
   * {@link RELEVANCE_THRESHOLD} — see the file header comment for why
   * a prompt-only guard isn't sufficient with SmolLM2-1.7B.
   */
  scoreRelevance?: (query: string) => Promise<number>;
  /**
   * "Anchor" chunks merged into every retrieve result, deduplicated
   * against the hybrid hits by `chunkId`. Typically the document's
   * first chunk — the place where titles, names, and other
   * structural identifiers live. Lets the LLM answer "whose résumé
   * is this?" / "what's the document title?" reliably without
   * relying on the embedder to bridge "whose" → a name.
   */
  anchorChunks?: Document<ChunkMetadata>[];
  /**
   * Streaming callback fired for each decoded token during the
   * `generate` and `chitchat` nodes. Lets the UI render a typewriter
   * effect without owning the model directly.
   */
  onToken?: (delta: string) => void;
}

/**
 * Build (but don't run) the LangGraph state graph. The caller invokes
 * `.compile().invoke(...)` per question.
 */
export function buildRagGraph(options: BuildGraphOptions) {
  const { retriever, chatModel, scoreRelevance, anchorChunks, onToken } = options;

  /** classify → mark the user's input as chitchat vs. real question. */
  async function classify(state: RagState): Promise<Partial<RagState>> {
    return { intent: isSmallTalk(state.question) ? "chitchat" : "question" };
  }

  /**
   * retrieve → hybrid BM25 + dense, top-K via RRF, plus a cosine-
   * similarity guard that flags off-topic queries.
   *
   * Three things happen here, in parallel where possible:
   *
   *   1. **Hybrid retrieval.** BM25 and dense each return up to
   *      CANDIDATE_K candidates; RRF fuses them to the top
   *      HYBRID_TOP_K. See `retrievers/hybrid.ts`.
   *
   *   2. **Relevance gate.** We embed the query and compute its top
   *      cosine against the corpus. When the best match falls below
   *      RELEVANCE_THRESHOLD the query is almost certainly off-topic
   *      (general-knowledge question, malformed input, etc.). We
   *      tag the state as `offTopic` so the conditional edge below
   *      routes to `refuse`. The dense pass already happened inside
   *      the hybrid retriever, so this is essentially free CPU.
   *
   *   3. **Anchor merge.** The document's title chunk gets merged
   *      into the result set if it isn't already there. See the
   *      file-header rationale.
   *
   * Errors in `scoreRelevance` (e.g. embedder crash) degrade
   * gracefully — we treat the score as 1 (very on-topic) so the
   * user still gets an attempted answer rather than a silent
   * refusal.
   */
  async function retrieve(state: RagState): Promise<Partial<RagState>> {
    const [hitsRaw, topScore] = await Promise.all([
      retriever.invoke(state.question) as Promise<Document<ChunkMetadata>[]>,
      scoreRelevance ? scoreRelevance(state.question).catch(() => 1) : Promise.resolve(1),
    ]);
    const hits = mergeAnchorChunks(hitsRaw, anchorChunks ?? []);
    const citedPages = uniqueSortedPages(hits);
    const offTopic = topScore < RELEVANCE_THRESHOLD;
    recordRetrievalDebug(state.question, hits, topScore, offTopic);
    return { docs: hits, citedPages, offTopic };
  }

  /** refuse → canned polite decline for off-topic queries. */
  async function refuse(_state: RagState): Promise<Partial<RagState>> {
    const message = OFF_TOPIC_REFUSAL;
    // Emit as a single chunk for UX consistency with the streaming
    // nodes — the assistant bubble fills in without needing to
    // special-case "non-streamed" rendering in the UI.
    onToken?.(message);
    return { answer: message, citedPages: [], intent: "off-topic" };
  }

  /**
   * generate → stream the grounded answer.
   *
   * Context layout: anchor chunks (the document header / contact block)
   * are pulled out and presented FIRST under an explicit
   * `[Document header — Page N]` label, with the rest of the
   * retrieval hits following under `[Relevant excerpts]`. Two reasons
   * to label them this way:
   *
   *   1. **Framing for overview questions.** Without the explicit
   *      label the model treats every chunk equally and can frame the
   *      document around whichever project chunk got fused in first —
   *      we observed it summarising the résumé as "a Dell finance
   *      reporting platform document" because a Dell project chunk
   *      scored highly. Labelling the header tells the model "this is
   *      what the document IS".
   *   2. **Authority for extraction questions.** When the user asks
   *      for a phone/email/address, the model should look at the
   *      contact block first. Putting it under an explicit header
   *      label makes that lookup an obvious move rather than a
   *      heuristic the model has to discover.
   */
  async function generate(state: RagState): Promise<Partial<RagState>> {
    if (state.docs.length === 0) {
      return { answer: "I could not find any relevant passages for that question." };
    }

    // ── Verbatim-extraction fast path ─────────────────────────────
    //
    // For phone / email queries we bypass the chat model entirely and
    // regex-extract the value from the anchor chunk (document header).
    // Rationale: SmolLM2-1.7B is unreliable at character-perfect copy
    // of digit strings even when they sit in the context — observed
    // failure modes include returning the person's name instead of
    // the phone number, and dropping suffix digits from emails
    // ("sumitsahoo1988@…" → "sumitsahoo@…"). A regex over the header
    // is deterministic, character-exact, and doesn't risk
    // hallucination. It also skips a multi-second WASM inference for
    // the most common contact queries.
    //
    // We fall back to the LLM whenever the question doesn't match the
    // patterns or the regex finds nothing — overview / list /
    // narrative questions all keep their existing path.
    const direct = tryVerbatimExtraction(state.question, anchorChunks ?? []);
    if (direct) {
      onToken?.(direct.value);
      return { answer: direct.value, citedPages: [direct.page] };
    }

    const anchorIds = new Set((anchorChunks ?? []).map((c) => c.metadata.chunkId));
    const headers = state.docs.filter((d) => anchorIds.has(d.metadata.chunkId));
    const others = state.docs.filter((d) => !anchorIds.has(d.metadata.chunkId));
    const orderedOthers = [...others].sort((a, b) => a.metadata.pageNumber - b.metadata.pageNumber);
    const headerBlock = headers
      .map((d) => `[Document header — Page ${d.metadata.pageNumber}]\n${d.pageContent.trim()}`)
      .join("\n\n");
    const excerptsBlock = orderedOthers
      .map((d) => `[Page ${d.metadata.pageNumber}]\n${d.pageContent.trim()}`)
      .join("\n\n");
    const contextBlock =
      headerBlock && excerptsBlock
        ? `${headerBlock}\n\n[Relevant excerpts]\n${excerptsBlock}`
        : headerBlock || excerptsBlock;
    const answer = await streamReply(
      chatModel,
      SYSTEM_PROMPT,
      contextBlock,
      state.question,
      onToken,
    );
    return { answer };
  }

  /** chitchat → friendly reply without retrieval. */
  async function chitchat(state: RagState): Promise<Partial<RagState>> {
    const answer = await streamReply(chatModel, CHITCHAT_PROMPT, null, state.question, onToken);
    return { answer, citedPages: [] };
  }

  const builder = new StateGraph(RagStateAnnotation)
    .addNode("classify", classify)
    .addNode("retrieve", retrieve)
    .addNode("generate", generate)
    .addNode("chitchat", chitchat)
    .addNode("refuse", refuse)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", (s: RagState) =>
      s.intent === "chitchat" ? "chitchat" : "retrieve",
    )
    .addConditionalEdges("retrieve", (s: RagState) => (s.offTopic ? "refuse" : "generate"))
    .addEdge("refuse", END)
    .addEdge("generate", END)
    .addEdge("chitchat", END);

  return builder.compile();
}

/**
 * Helper: stream the chat model and accumulate the full reply. We use
 * `.stream()` so the `onToken` callback can drive the typewriter UI
 * without buffering the whole response first.
 */
async function streamReply(
  model: TransformersJsChatModel,
  system: string,
  context: string | null,
  question: string,
  onToken?: (delta: string) => void,
): Promise<string> {
  const userContent = context
    ? `Document excerpts:\n${context}\n\nQuestion: ${question}`
    : question;
  const messages = [new SystemMessage(system), new HumanMessage(userContent)];
  let full = "";
  const stream = await model.stream(messages);
  for await (const chunk of stream) {
    // `chunk.content` is `string | MessageContentComplex[]`. For our
    // text-only chat model the streaming hook always emits strings; the
    // array branch only matters for multimodal models we don't ship.
    const piece = typeof chunk.content === "string" ? chunk.content : "";
    if (!piece) continue;
    full += piece;
    onToken?.(piece);
  }
  return full;
}

/**
 * Phone-number regex: matches an international `+CC-NNNN…NNN` form,
 * an `(NNN) NNN-NNNN` form, or any plain run of 7+ digits (which
 * covers local-format phone numbers without separators). Tight enough
 * that it doesn't fire on years ("1988") or 4-digit IDs but loose
 * enough to catch the variety of formats résumés / contact blocks use.
 */
const PHONE_RE =
  /\+\d{1,3}[\s\-.]?\d[\d\s\-.()]{5,}\d|\(?\d{3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{4}|\b\d{7,}\b/;

/**
 * Email regex. Standard local-part / domain shape; the negative
 * lookbehind avoids matching addresses embedded inside URLs that the
 * regex engine could otherwise greedy-walk into.
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * Deterministic fast-path for verbatim contact-info extraction.
 *
 * Reads the user's question for phone / email intent and, if the
 * intent is clear, regex-extracts the value out of the anchor chunks
 * (the document header / contact block — always included on every
 * retrieve). Returns `{ value, page }` on hit so the caller can short-
 * circuit straight to the answer instead of invoking the chat model.
 *
 * **Why this exists.** SmolLM2-1.7B reliably *finds* the right chunk
 * — the contact block sits in `[Document header]` at the top of the
 * prompt — but fails to copy digit strings character-perfectly. The
 * observed failure modes were:
 *   - Phone questions returning the person's name instead of digits.
 *   - Emails dropping trailing digits ("sumitsahoo1988@…" → "sumitsahoo@…").
 *   - Random sampling occasionally producing a hedged refusal even
 *     when the value sits in plain view.
 * A regex against the header is character-exact, deterministic, and
 * skips a multi-second WASM inference for the most common contact
 * queries.
 *
 * Returns `null` when the intent isn't clearly verbatim-extraction
 * (e.g. overview / list / narrative questions) or when no match
 * exists — both cases fall through to the LLM path.
 */
function tryVerbatimExtraction(
  question: string,
  anchorChunks: Document<ChunkMetadata>[],
): { value: string; page: number } | null {
  if (anchorChunks.length === 0) return null;
  const q = question.toLowerCase();

  // Phone: any explicit phone-y vocabulary, or a bare "number"
  // (in PDF Q&A "give me X's number" overwhelmingly means phone).
  if (/\b(phone|mobile|tel|cell|telephone|whatsapp|number)\b/.test(q)) {
    for (const chunk of anchorChunks) {
      const match = chunk.pageContent.match(PHONE_RE);
      if (match) {
        return { value: match[0].replace(/\s+/g, " ").trim(), page: chunk.metadata.pageNumber };
      }
    }
  }

  // Email: explicit "email" / "mail" / a literal "@" in the query.
  if (/\b(email|e-mail|mail)\b|@/.test(q)) {
    for (const chunk of anchorChunks) {
      const match = chunk.pageContent.match(EMAIL_RE);
      if (match) {
        return { value: match[0].trim(), page: chunk.metadata.pageNumber };
      }
    }
  }

  return null;
}

/** Unique, sorted page numbers from the retrieved chunks. */
function uniqueSortedPages(docs: Document<ChunkMetadata>[]): number[] {
  const set = new Set<number>();
  for (const d of docs) set.add(d.metadata.pageNumber);
  return [...set].sort((a, b) => a - b);
}

/**
 * Append any anchor chunk that isn't already present in `hits`,
 * deduplicating by `chunkId`. Anchors land at the *end* of the list
 * so the fused top-K stays at the front for the LLM to read first,
 * but the document header is always somewhere in scope. The
 * `generate` node sorts by `pageNumber` before composing the prompt,
 * so visual ordering ends up document-order regardless of where the
 * anchor enters this list.
 */
function mergeAnchorChunks(
  hits: Document<ChunkMetadata>[],
  anchors: Document<ChunkMetadata>[],
): Document<ChunkMetadata>[] {
  if (anchors.length === 0) return hits;
  const seen = new Set(hits.map((h) => h.metadata.chunkId));
  const merged = [...hits];
  for (const a of anchors) {
    if (!seen.has(a.metadata.chunkId)) {
      merged.push(a);
      seen.add(a.metadata.chunkId);
    }
  }
  return merged;
}

/**
 * Push the retrieved chunks onto a `window.__cloakpdfRetrievals` array
 * when `localStorage["cloakpdf:debug"]` is set. Gated so the probe
 * can read structured retrieval results back from Puppeteer; off by
 * default and not referenced anywhere else in the app.
 */
interface RetrievalDebugRecord {
  question: string;
  hits: Array<{ chunkId: string; pageNumber: number; preview: string; length: number }>;
  /** Top dense-cosine score against the corpus. Used to tune {@link RELEVANCE_THRESHOLD}. */
  relevanceScore: number;
  /** Whether the retrieve node routed this query to `refuse`. */
  offTopic: boolean;
}
function recordRetrievalDebug(
  question: string,
  hits: Document<ChunkMetadata>[],
  relevanceScore: number,
  offTopic: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    if (!window.localStorage?.getItem("cloakpdf:debug")) return;
  } catch {
    return;
  }
  const w = window as unknown as { __cloakpdfRetrievals?: RetrievalDebugRecord[] };
  if (!Array.isArray(w.__cloakpdfRetrievals)) w.__cloakpdfRetrievals = [];
  w.__cloakpdfRetrievals.push({
    question,
    hits: hits.map((d) => ({
      chunkId: d.metadata.chunkId,
      pageNumber: d.metadata.pageNumber,
      preview: d.pageContent.slice(0, 240),
      length: d.pageContent.length,
    })),
    relevanceScore,
    offTopic,
  });
}
