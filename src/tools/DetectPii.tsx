/**
 * Detect PII tool — surfaces names, organisations, and locations the
 * user may want to redact. The tool is opinionated: it shows
 * suggestions with page references but never modifies the PDF — the
 * user still takes the action manually in the Redact PDF tool.
 *
 * Runs entirely in-browser by prompting the same Qwen chat model
 * other AI tools use (see `ai-models.ts`). First use triggers the
 * consent dialog; subsequent runs reuse the cached model. The LLM
 * returns a JSON list of entities — we lose the exact character
 * offsets and confidence scores the previous BERT-NER model gave us,
 * but we gain a unified single-model story across every AI tool.
 */
import { ScanSearch, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { type NerEntityType, runNer } from "../utils/ai-tasks.ts";
import { downloadBlob, formatFileSize } from "../utils/file-helpers.ts";
import { chunkPages, extractTextFromPdf, looksLikeScannedPdf } from "../utils/pdf-text.ts";

/**
 * Entity classes the LLM-based NER prompt emits. Kept as an alias of
 * the type defined in ai-tasks so the UI doesn't depend on the
 * underlying model.
 */
type EntityType = NerEntityType;

/** A grouped detection — one entry per unique entity surface form. */
interface PiiFinding {
  /** Text as it appears in the PDF (collapsed across occurrences). */
  text: string;
  /** Entity class. */
  type: EntityType;
  /** Number of times this surface form was detected. */
  count: number;
  /** Pages where the form appears (1-based, deduplicated, sorted). */
  pages: number[];
}

const TYPE_META: Record<EntityType, { label: string; description: string; color: string }> = {
  PER: {
    label: "Person",
    description: "Names of people",
    color:
      "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  },
  ORG: {
    label: "Organisation",
    description: "Companies, agencies, institutions",
    color:
      "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  },
  LOC: {
    label: "Location",
    description: "Cities, countries, places",
    color:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
  },
  MISC: {
    label: "Other",
    description: "Other named entities",
    color:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
  },
};

export default function DetectPii() {
  const [findings, setFindings] = useState<PiiFinding[] | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [scannedHint, setScannedHint] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<EntityType>>(
    new Set(["PER", "ORG", "LOC", "MISC"]),
  );

  // Shared chat-tier lifecycle. With a single tier registered today
  // the hook auto-selects it; `change` cancels any in-flight load.
  const { ai } = useChatTier();

  const pdf = usePdfFile({
    onReset: () => {
      setFindings(null);
      setProgress(null);
      setStatusText(null);
      setScannedHint(false);
    },
  });
  const task = useAsyncProcess();

  // Drive the consent dialog purely off `ai.status` — when the hook is
  // ready / idle the dialog stays unmounted.
  const dialogOpen =
    ai.status === "awaiting-consent" || ai.status === "downloading" || ai.status === "error";

  // Auto-dismiss the dialog after a successful download — useAiModel
  // resolves the pending promise so the next handler step runs.
  useEffect(() => {
    if (ai.status === "ready") {
      setStatusText(null);
    }
  }, [ai.status]);

  const handleScan = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    setFindings(null);
    setProgress(null);
    setScannedHint(false);
    setStatusText("Loading model…");

    await task.run(async () => {
      let pipe: Awaited<ReturnType<typeof ai.ensureReady>>;
      try {
        // Will surface the consent dialog if the model isn't cached yet.
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

      const chunks = chunkPages(pages, 1500, 100);
      setProgress({ current: 0, total: chunks.length });

      // Aggregate findings across chunks. Lowercased surface form keys
      // the dedup map so "John Smith" and "john smith" merge into one
      // finding. The LLM emits the original casing per occurrence; we
      // keep whichever variant we saw first.
      const grouped = new Map<string, PiiFinding>();

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setStatusText(`Scanning page ${chunk.pageNumber}…`);
        setProgress({ current: i, total: chunks.length });

        const entities = await runNer(pipe, chunk.text);

        for (const entity of entities) {
          const surface = entity.text.trim();
          if (!surface || surface.length < 2) continue;
          // The model occasionally hallucinates a surface form that
          // doesn't appear in the chunk. Drop those — the user would
          // have no way to verify or redact them, and they'd erode
          // trust in the tool. Case-insensitive contains check is
          // enough; we don't need exact word boundaries here.
          if (!chunk.text.toLowerCase().includes(surface.toLowerCase())) continue;
          const key = `${entity.type}::${surface.toLowerCase()}`;
          const prev = grouped.get(key);
          if (prev) {
            prev.count += 1;
            if (!prev.pages.includes(chunk.pageNumber)) {
              prev.pages.push(chunk.pageNumber);
              prev.pages.sort((a, b) => a - b);
            }
          } else {
            grouped.set(key, {
              text: surface,
              type: entity.type,
              count: 1,
              pages: [chunk.pageNumber],
            });
          }
        }
      }

      setProgress({ current: chunks.length, total: chunks.length });
      // Sort by count desc, then alphabetically so the user sees the
      // most-prevalent candidates first and ties are stable.
      const final = [...grouped.values()].sort((a, b) =>
        b.count - a.count !== 0 ? b.count - a.count : a.text.localeCompare(b.text),
      );
      setFindings(final);
      setStatusText(null);
      setProgress(null);
    }, "Failed to scan PDF. Please try again.");
  }, [pdf.file, ai, task]);

  const toggleFilter = useCallback((type: EntityType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleDownloadReport = useCallback(() => {
    if (!findings || !pdf.file) return;
    const lines = [
      `PII detection report for: ${pdf.file.name}`,
      `Detected ${findings.length} unique entities`,
      "",
      "Type | Count | Pages | Text",
      "-----|-------|-------|-----",
      ...findings.map(
        (f) => `${TYPE_META[f.type].label} | ${f.count} | ${f.pages.join(", ")} | ${f.text}`,
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const base = pdf.file.name.replace(/\.pdf$/i, "");
    downloadBlob(blob, `${base}_pii_report.txt`);
  }, [findings, pdf.file]);

  const visibleFindings = findings?.filter((f) => activeFilters.has(f.type)) ?? [];

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.security}
          iconColor={categoryAccent.security}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          label="Drop a PDF file here"
          hint="Scan for names, organisations, and locations that may need redaction"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {!findings && !scannedHint && (
            <div className="space-y-4">
              <AiModelGate
                ai={ai}
                title="Download AI model to detect PII"
                blurb="The model surfaces names, organisations, and locations as redaction candidates. It runs entirely in your browser; your PDFs are never uploaded."
              >
                <InfoCallout icon={ShieldAlert} title="On-device PII detection">
                  The detection is a starting point — review each finding before redacting.
                </InfoCallout>

                {task.processing && progress && progress.total > 0 && (
                  <ProgressBar
                    current={progress.current}
                    total={progress.total}
                    label={statusText ?? "Scanning…"}
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
                  onClick={handleScan}
                  processing={task.processing}
                  label="Scan for PII"
                  processingLabel="Scanning…"
                />
              </AiModelGate>

              <ActiveModelBar info={ai.info} ready={ai.status === "ready"} />
            </div>
          )}

          {scannedHint && (
            <InfoCallout icon={ScanSearch} title="No text layer detected" accent="warning">
              This PDF appears to be a scanned image — there's no extractable text for the model to
              read. Run <span className="font-medium">OCR PDF</span> first to create a searchable
              version, then come back here.
            </InfoCallout>
          )}

          {findings && (
            <div className="space-y-4">
              {/* Summary stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(Object.keys(TYPE_META) as EntityType[]).map((type) => {
                  const count = findings.filter((f) => f.type === type).length;
                  const active = activeFilters.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleFilter(type)}
                      className={`text-left rounded-xl border p-3 transition-[opacity,border-color,background-color] ${
                        active
                          ? "bg-white dark:bg-dark-surface border-slate-200 dark:border-dark-border"
                          : "bg-slate-50/60 dark:bg-dark-bg/40 border-slate-200/50 dark:border-dark-border/50 opacity-60"
                      }`}
                    >
                      <p className="text-xs uppercase tracking-widest text-slate-400 dark:text-dark-text-muted">
                        {TYPE_META[type].label}
                      </p>
                      <p className="text-2xl font-semibold text-slate-800 dark:text-dark-text mt-1 tabular-nums">
                        {count}
                      </p>
                    </button>
                  );
                })}
              </div>

              {visibleFindings.length === 0 ? (
                <InfoCallout icon={ScanSearch}>
                  {findings.length === 0
                    ? "No entities detected. The model didn't find anything worth redacting in this document."
                    : "No findings match the current filters — re-enable the categories above to see them."}
                </InfoCallout>
              ) : (
                <div className="space-y-2">
                  {visibleFindings.map((f) => {
                    const meta = TYPE_META[f.type];
                    return (
                      <div
                        key={`${f.type}-${f.text}`}
                        className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-3 flex flex-col sm:flex-row sm:items-center gap-3"
                      >
                        <span
                          className={`shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xxs font-semibold uppercase tracking-[0.12em] border ${meta.color}`}
                        >
                          {meta.label}
                        </span>
                        <p className="flex-1 min-w-0 text-sm text-slate-800 dark:text-dark-text wrap-anywhere">
                          {f.text}
                        </p>
                        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-dark-text-muted shrink-0 tabular-nums">
                          <span>×{f.count}</span>
                          <span>p. {f.pages.join(", ")}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setFindings(null);
                    setStatusText(null);
                  }}
                  className="bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-700 dark:text-dark-text py-3 px-4 rounded-xl font-medium hover:bg-slate-50 dark:hover:bg-dark-border transition-colors text-sm"
                >
                  Scan again
                </button>
                <button
                  type="button"
                  onClick={handleDownloadReport}
                  className="bg-primary-600 text-white py-3 px-4 rounded-xl font-medium hover:bg-primary-700 transition-colors text-sm"
                >
                  Download report
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
