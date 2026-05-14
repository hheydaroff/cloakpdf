/**
 * Ask PDF — chat-style Q&A over the document text using a small,
 * on-device instruction-tuned LLM.
 *
 * The flow per question is:
 *
 *   1. Extract the PDF text once and chunk it.
 *   2. Rank chunks by keyword overlap with the user's question and
 *      pick the top-K (cheap, no embedding model required).
 *   3. Build a chat-template prompt: system instructions, the picked
 *      chunks as "Context", and the user's question.
 *   4. Stream the model's reply into the conversation as it generates.
 *
 * The model and pipeline shape are abstracted away by
 * {@link runChat} — to swap models, edit the registry entry in
 * {@link AI_MODELS}; this file stays put.
 */
import { Loader2, ScanSearch, Send, Sparkles, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActiveModelBar } from "../components/ActiveModelBar.tsx";
import { AiConsentDialog } from "../components/AiConsentDialog.tsx";
import { AiModelGate } from "../components/AiModelGate.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { useChatTier } from "../hooks/useChatTier.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { type ChatMessage, runChat } from "../utils/ai-tasks.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import {
  chunkPages,
  extractTextFromPdf,
  looksLikeScannedPdf,
  rankChunksByQuery,
  type TextChunk,
} from "../utils/pdf-text.ts";

interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Pages cited as context for an assistant reply. */
  citedPages?: number[];
  /** `true` while the assistant message is still being streamed. */
  streaming?: boolean;
}

const SYSTEM_PROMPT = [
  "You are a careful assistant answering questions about a PDF document.",
  "Use ONLY the information in the provided Context to answer.",
  'If the answer is not in the Context, reply exactly: "I could not find that in this document."',
  "Keep answers concise (1–3 sentences) and cite page numbers in parentheses when relevant.",
].join(" ");

export default function AskPdf() {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [scannedHint, setScannedHint] = useState(false);

  // Shared chat-tier lifecycle. Single tier in the registry today
  // means the hook auto-selects it — no picker is rendered. Destructure
  // `change` here when a second tier is reintroduced.
  const { ai } = useChatTier();

  const pdf = usePdfFile({
    onReset: () => {
      setTurns([]);
      setScannedHint(false);
      chunksRef.current = null;
    },
  });
  const task = useAsyncProcess();

  // Cache the chunked PDF text across questions — extraction is fast,
  // but skipping it on follow-ups keeps multi-question sessions snappy.
  const chunksRef = useRef<TextChunk[] | null>(null);

  // Auto-scroll the conversation to the latest message. The trigger
  // collapses "number of turns" and "current-turn length" into one
  // primitive so the effect re-runs both on new turns and as tokens
  // stream into the in-progress assistant turn.
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const scrollTrigger = turns.length * 1_000_000 + (turns.at(-1)?.content.length ?? 0);
  useEffect(() => {
    if (scrollTrigger === 0) return;
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [scrollTrigger]);

  const dialogOpen =
    ai.status === "awaiting-consent" || ai.status === "downloading" || ai.status === "error";

  const handleAsk = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    const q = question.trim();
    if (!q) return;

    // Append the user's turn immediately so the UI feels responsive,
    // and a placeholder assistant turn we'll stream into.
    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      { id: userId, role: "user", content: q },
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    setQuestion("");

    await task.run(async () => {
      let pipe: Awaited<ReturnType<typeof ai.ensureReady>>;
      try {
        pipe = await ai.ensureReady();
      } catch (e) {
        if (e instanceof Error && e.message === "cancelled") {
          // Drop the placeholders — the user backed out.
          setTurns((prev) => prev.filter((t) => t.id !== userId && t.id !== assistantId));
          return;
        }
        throw e;
      }

      // Lazy-extract once per file.
      let chunks = chunksRef.current;
      if (!chunks) {
        const pages = await extractTextFromPdf(file);
        if (looksLikeScannedPdf(pages)) {
          setScannedHint(true);
          // Drop the placeholders so the warning replaces the input area.
          setTurns((prev) => prev.filter((t) => t.id !== userId && t.id !== assistantId));
          return;
        }
        // 5 × 1200 chars ≈ 1500 tokens of context — well inside Qwen
        // 2.5's 32K window for both the 0.5B and 1.5B tiers, and leaves
        // plenty of room for the reply.
        chunks = chunkPages(pages, 1200, 150);
        chunksRef.current = chunks;
      }
      if (chunks.length === 0) {
        throw new Error("The PDF text layer is empty — nothing to query.");
      }

      // Pick the chunks most likely to contain the answer.
      const picked = rankChunksByQuery(chunks, q, 5);
      const citedPages = [...new Set(picked.map((c) => c.pageNumber))].sort((a, b) => a - b);

      const contextBlock = picked
        .map((c) => `[Page ${c.pageNumber}]\n${c.text.trim()}`)
        .join("\n\n");

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Context (from the PDF):\n${contextBlock}\n\nQuestion: ${q}`,
        },
      ];

      // Stream tokens into the assistant turn as they arrive.
      const reply = await runChat(pipe, messages, {
        maxNewTokens: 512,
        onToken: (delta) => {
          setTurns((prev) =>
            prev.map((t) => (t.id === assistantId ? { ...t, content: t.content + delta } : t)),
          );
        },
      });

      // Finalise — use the cleaned reply from the resolved promise (it
      // trims and strips the chat template's trailing newline).
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantId ? { ...t, content: reply, citedPages, streaming: false } : t,
        ),
      );
    }, "Failed to answer question. Please try again.");
  }, [pdf.file, question, ai, task]);

  // If task.run sets an error, mark the streaming assistant turn as failed.
  useEffect(() => {
    if (!task.error) return;
    setTurns((prev) =>
      prev.map((t) => (t.streaming ? { ...t, content: "", streaming: false } : t)),
    );
  }, [task.error]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleAsk();
      }
    },
    [handleAsk],
  );

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.transform}
          iconColor={categoryAccent.transform}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          label="Drop a PDF file here"
          hint="Chat with your PDF — answers are generated on-device, never uploaded"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {scannedHint ? (
            <InfoCallout icon={ScanSearch} title="No text layer detected" accent="warning">
              This PDF looks like a scanned image. Run <span className="font-medium">OCR PDF</span>{" "}
              first to add a text layer, then come back here.
            </InfoCallout>
          ) : (
            <>
              <ConversationView turns={turns} scrollAnchorRef={scrollAnchorRef} />

              <AiModelGate
                ai={ai}
                title="Download AI model to start chatting"
                blurb="The model runs entirely in your browser; your PDFs are never uploaded."
              >
                <Composer
                  value={question}
                  onChange={setQuestion}
                  onKeyDown={onKeyDown}
                  onSubmit={handleAsk}
                  disabled={task.processing}
                />
              </AiModelGate>

              <ActiveModelBar info={ai.info} ready={ai.status === "ready"} />
            </>
          )}
        </>
      )}

      {task.error && <AlertBox message={task.error} />}

      <AiConsentDialog
        open={dialogOpen}
        info={ai.info}
        status={ai.status}
        progress={ai.progress}
        error={ai.error}
        onConfirm={ai.confirm}
        onRetry={ai.retry}
        onCancel={ai.cancel}
      />
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function ConversationView({
  turns,
  scrollAnchorRef,
}: {
  turns: ChatTurn[];
  scrollAnchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (turns.length === 0) return null;
  return (
    <div className="space-y-3">
      {turns.map((turn) => (
        <Bubble key={turn.id} turn={turn} />
      ))}
      <div ref={scrollAnchorRef} />
    </div>
  );
}

function Bubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <span
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
          isUser
            ? "bg-primary-600 text-white"
            : "bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400"
        }`}
        aria-hidden="true"
      >
        {isUser ? <User className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
      </span>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-primary-600 text-white rounded-tr-md"
            : "bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-800 dark:text-dark-text rounded-tl-md"
        }`}
      >
        {turn.streaming && !turn.content ? (
          <span className="inline-flex items-center gap-2 text-slate-500 dark:text-dark-text-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Thinking…
          </span>
        ) : (
          <p className="whitespace-pre-wrap wrap-anywhere">
            {turn.content}
            {turn.streaming && (
              <span
                aria-hidden="true"
                className="inline-block w-1.5 h-4 ml-0.5 -mb-0.5 align-middle bg-current opacity-60 animate-pulse"
              />
            )}
          </p>
        )}
        {!isUser && turn.citedPages && turn.citedPages.length > 0 && !turn.streaming && (
          <p className="mt-2 pt-2 border-t border-slate-100 dark:border-dark-border/60 text-xs text-slate-400 dark:text-dark-text-muted">
            Context from {turn.citedPages.length === 1 ? "page" : "pages"}{" "}
            {turn.citedPages.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onKeyDown,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <div className="sticky bottom-2 bg-white dark:bg-dark-surface rounded-2xl border border-slate-200 dark:border-dark-border shadow-sm p-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder="Ask something about this PDF…"
        rows={2}
        className="w-full resize-none bg-transparent text-sm text-slate-800 dark:text-dark-text placeholder-slate-400 dark:placeholder-dark-text-muted focus-visible:outline-none disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-3 mt-2 pt-2 border-t border-slate-100 dark:border-dark-border/60">
        <p className="text-xs text-slate-400 dark:text-dark-text-muted hidden sm:block">
          Press{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted font-mono">
            Enter
          </kbd>{" "}
          to send,{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted font-mono">
            Shift+Enter
          </kbd>{" "}
          for a new line.
        </p>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          className="inline-flex items-center gap-1.5 ml-auto px-4 py-2 rounded-lg text-sm font-semibold bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {disabled ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Thinking…
            </>
          ) : (
            <>
              <Send className="w-4 h-4" />
              Send
            </>
          )}
        </button>
      </div>
    </div>
  );
}
