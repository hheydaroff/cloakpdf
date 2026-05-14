/**
 * Summarize PDF — generates an abstractive summary of the PDF text
 * by prompting the same Qwen chat model the other AI tools use. The
 * model is downloaded on first use behind the consent dialog and
 * cached for offline runs.
 *
 * Long documents are summarised in two passes: first each chunk is
 * summarised independently, then those summaries are re-summarised
 * into a single overall summary. Only the final overall summary is
 * shown to the user — the per-chunk summaries are an internal step.
 */
import { ScanSearch, Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { ActiveModelBar } from "../components/ActiveModelBar.tsx";
import { AiConsentDialog } from "../components/AiConsentDialog.tsx";
import { AiModelGate } from "../components/AiModelGate.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { useChatTier } from "../hooks/useChatTier.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { runSummarize, type SummarizeLength } from "../utils/ai-tasks.ts";
import { downloadBlob, formatFileSize } from "../utils/file-helpers.ts";
import { chunkPages, extractTextFromPdf, looksLikeScannedPdf } from "../utils/pdf-text.ts";

interface ChunkSummary {
  /** 1-based page where the source chunk lives. */
  pageNumber: number;
  /** The summary returned by the model. */
  summary: string;
}

export default function SummarizePdf() {
  const [length, setLength] = useState<SummarizeLength>("medium");
  const [overall, setOverall] = useState<string | null>(null);
  const [scannedHint, setScannedHint] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [copiedOverall, setCopiedOverall] = useState(false);

  // Shared chat-tier lifecycle. Single tier registered today means
  // the hook auto-selects it — no picker is rendered.
  const { ai } = useChatTier();

  const pdf = usePdfFile({
    onReset: () => {
      setOverall(null);
      setScannedHint(false);
      setProgress(null);
      setStatusText(null);
    },
  });
  const task = useAsyncProcess();

  const dialogOpen =
    ai.status === "awaiting-consent" || ai.status === "downloading" || ai.status === "error";

  const handleSummarize = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    setOverall(null);
    setScannedHint(false);

    await task.run(async () => {
      setStatusText("Loading model…");
      let pipe: Awaited<ReturnType<typeof ai.ensureReady>>;
      try {
        pipe = await ai.ensureReady();
      } catch (e) {
        if (e instanceof Error && e.message === "cancelled") return;
        throw e;
      }

      setStatusText("Reading PDF text…");
      const pages = await extractTextFromPdf(file);
      if (looksLikeScannedPdf(pages)) {
        setScannedHint(true);
        setStatusText(null);
        return;
      }

      // 1500 chars (~375 tokens) per chunk keeps Qwen 0.5B q8 well
      // inside its comfortable context window. The previous 2000-char
      // window pushed the small tier into byte-fallback gibberish on
      // dense pages — see the runSummarize comment for the full story.
      const chunks = chunkPages(pages, 1500, 0);
      if (chunks.length === 0) {
        setStatusText(null);
        throw new Error("The PDF text layer is empty — nothing to summarize.");
      }
      setProgress({ current: 0, total: chunks.length + (chunks.length > 1 ? 1 : 0) });

      const chunkSummaries: ChunkSummary[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        setStatusText(`Summarising page ${c.pageNumber} (${i + 1} of ${chunks.length})…`);
        setProgress({ current: i, total: chunks.length + (chunks.length > 1 ? 1 : 0) });
        const summary = await runSummarize(pipe, c.text, length);
        chunkSummaries.push({ pageNumber: c.pageNumber, summary });
      }

      // For multi-chunk docs, do a final "summary of summaries" pass so
      // the user gets one coherent overview rather than N disconnected
      // ones. Skip when there's only one chunk — the chunk summary IS
      // the overall summary.
      if (chunkSummaries.length === 1) {
        setOverall(chunkSummaries[0].summary);
      } else {
        setStatusText("Combining summaries…");
        setProgress({ current: chunks.length, total: chunks.length + 1 });
        const joined = chunkSummaries.map((c) => c.summary).join(" ");
        // Cap the second-pass input — Qwen 2.5 handles long context but
        // the smaller tier slows down sharply past ~4K characters.
        const trimmed = joined.length > 6000 ? joined.slice(0, 6000) : joined;
        const overall = await runSummarize(pipe, trimmed, length);
        setOverall(overall || joined);
        setProgress({ current: chunks.length + 1, total: chunks.length + 1 });
      }

      setStatusText(null);
      setProgress(null);
    }, "Failed to summarise PDF. Please try again.");
  }, [pdf.file, length, ai, task]);

  const handleCopy = useCallback(async () => {
    if (!overall) return;
    try {
      await navigator.clipboard.writeText(overall);
      setCopiedOverall(true);
      setTimeout(() => setCopiedOverall(false), 2000);
    } catch {
      task.setError("Failed to copy to clipboard.");
    }
  }, [overall, task]);

  const handleDownload = useCallback(() => {
    if (!overall || !pdf.file) return;
    const body = [`Summary of ${pdf.file.name}`, "", overall].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const base = pdf.file.name.replace(/\.pdf$/i, "");
    downloadBlob(blob, `${base}_summary.txt`);
  }, [overall, pdf.file]);

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.transform}
          iconColor={categoryAccent.transform}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          label="Drop a PDF file here"
          hint="Generate an abstractive summary using a local AI model"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {!overall && !scannedHint && (
            <div className="space-y-4">
              <AiModelGate
                ai={ai}
                title="Download AI model to summarise"
                blurb="Long documents are summarised in chunks and then re-summarised into one overview. The model runs entirely in your browser."
              >
                <InfoCallout icon={Sparkles} title="On-device summarisation">
                  Pick a length below and run a summary. Long documents are processed in chunks.
                </InfoCallout>

                {/* Length picker */}
                <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border shadow-sm p-4">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-dark-text-muted mb-3">
                    Summary length
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["short", "medium", "long"] as SummarizeLength[]).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setLength(opt)}
                        disabled={task.processing}
                        className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-[transform,opacity,color,background-color,border-color,box-shadow] ${
                          length === opt
                            ? "bg-primary-600 text-white shadow-sm"
                            : "bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted border border-slate-200 dark:border-dark-border hover:bg-slate-200 dark:hover:bg-dark-border"
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        {opt[0].toUpperCase() + opt.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {task.processing && progress && progress.total > 0 && (
                  <ProgressBar
                    current={progress.current}
                    total={progress.total}
                    label={statusText ?? "Working…"}
                  />
                )}
                {task.processing && (!progress || progress.total === 0) && (
                  <div className="flex items-center gap-3 py-2">
                    <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
                    <span className="text-sm text-slate-600 dark:text-dark-text-muted">
                      {statusText ?? "Working…"}
                    </span>
                  </div>
                )}

                <ActionButton
                  onClick={handleSummarize}
                  processing={task.processing}
                  label="Summarise PDF"
                  processingLabel="Summarising…"
                />
              </AiModelGate>

              <ActiveModelBar info={ai.info} ready={ai.status === "ready"} />
            </div>
          )}

          {scannedHint && (
            <InfoCallout icon={ScanSearch} title="No text layer detected" accent="warning">
              This PDF looks like a scanned image. Run <span className="font-medium">OCR PDF</span>{" "}
              first to add a text layer, then come back here.
            </InfoCallout>
          )}

          {overall && (
            <div className="space-y-4">
              <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-dark-text-muted mb-2">
                  Summary
                </p>
                <p className="text-sm text-slate-800 dark:text-dark-text leading-relaxed">
                  {overall}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-700 dark:text-dark-text py-3 px-4 rounded-xl font-medium hover:bg-slate-50 dark:hover:bg-dark-border transition-colors text-sm"
                >
                  {copiedOverall ? "Copied!" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOverall(null);
                  }}
                  className="bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-700 dark:text-dark-text py-3 px-4 rounded-xl font-medium hover:bg-slate-50 dark:hover:bg-dark-border transition-colors text-sm"
                >
                  Run again
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="bg-primary-600 text-white py-3 px-4 rounded-xl font-medium hover:bg-primary-700 transition-colors text-sm"
                >
                  Download
                </button>
              </div>
            </div>
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
