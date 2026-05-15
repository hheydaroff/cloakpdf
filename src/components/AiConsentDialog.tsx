/**
 * Consent + progress dialog shown before any AI model is downloaded.
 *
 * The dialog cycles through three visual states driven by the `status`
 * prop from `useAiModel`:
 *
 *   - `awaiting-consent` — full model card(s) with size, licence, and
 *     Hugging Face link plus a primary "Download model" CTA. User must
 *     explicitly opt in before any bytes are fetched.
 *   - `downloading` — determinate progress bar, current file name,
 *     loaded/total byte counts. The dialog refuses to close on backdrop
 *     click while in this state so the user can't accidentally lose
 *     visibility of the download (Cancel button is the explicit exit).
 *   - `error` — error message with Retry / Cancel buttons.
 *
 * **Multi-model support.** Pass `secondaryInfo` (e.g. the embedder in a
 * RAG tool) to render a second card in the consent body and a combined
 * size estimate in the download body. The model cards themselves come
 * from the shared {@link ModelCard} component used by
 * {@link AiModelDetailsDialog}, so the two dialogs read as one system.
 *
 * **Visual pattern.** Mirrors `ToolPickerModal`'s translucent layout —
 * one painting layer for backdrop + close-button, sheet rises in via
 * `animate-slide-up-in`, `bg-white/85` for the see-through feel.
 * Bottom-sheet on mobile / centered card on desktop.
 */
import { AlertCircle, Cpu, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { AiModelStatus } from "../hooks/useAiModel.ts";
import { type AiModelInfo, formatApproxSize } from "../utils/ai-models.ts";
import type { AiProgress } from "../utils/ai-runtime.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import { ModelCard } from "./ModelCard.tsx";

interface AiConsentDialogProps {
  /** When `false` the dialog is unmounted entirely. */
  open: boolean;
  /** Primary model — drives the headline when only one model is shown. */
  info: AiModelInfo;
  /**
   * Optional second model. When provided the consent body renders both
   * as separate cards and the headline / copy adapt to the plural case.
   */
  secondaryInfo?: AiModelInfo;
  /**
   * Optional role labels matching `[info, secondaryInfo]`, e.g.
   * `["chat", "retrieval"]`. Surface a small pill in each card so users
   * know which model handles which job.
   */
  roles?: [string, string];
  status: AiModelStatus;
  progress: AiProgress | null;
  error: string | null;
  /** "Download model" — only fires from the `awaiting-consent` state. */
  onConfirm: () => void;
  /** "Retry" — only fires from the `error` state. */
  onRetry: () => void;
  /** "Cancel" — closes the dialog. Always available. */
  onCancel: () => void;
}

export function AiConsentDialog({
  open,
  info,
  secondaryInfo,
  roles,
  status,
  progress,
  error,
  onConfirm,
  onRetry,
  onCancel,
}: AiConsentDialogProps) {
  // Lock body scroll + wire Escape while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // Allow Escape to cancel from any state — the underlying download
      // continues in the background but the dialog dismisses. Reopening
      // re-shows the same state machine progress.
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  // Backdrop click closes the dialog *unless* a download or warm-load
  // is mid-flight — an accidental click is a poor way to lose
  // visibility of either kind of progress.
  const dismissOnBackdrop = status !== "downloading" && status !== "loading";
  const disableClose = !dismissOnBackdrop;

  const models = secondaryInfo ? [info, secondaryInfo] : [info];
  const totalBytes = models.reduce((sum, m) => sum + m.approxSizeBytes, 0);

  return createPortal(
    <div
      className="fixed inset-0 z-200 flex items-end sm:items-center justify-center sm:px-3 md:px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-consent-title"
      style={{
        // One painting layer for dim + blur — same pattern as
        // ToolPickerModal so iOS Safari's hit-testing stays simple.
        background: "color-mix(in oklab, rgb(15 23 42) 30%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <button
        type="button"
        onClick={dismissOnBackdrop ? onCancel : undefined}
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0"
        style={{ background: "transparent" }}
      />

      <div className="relative flex flex-col w-full sm:w-[min(560px,100%)] max-h-[88svh] sm:max-h-[min(720px,calc(100svh-64px))] overflow-hidden rounded-t-2xl sm:rounded-2xl border border-slate-200/80 dark:border-dark-border bg-white/85 dark:bg-dark-surface/85 backdrop-blur-xl shadow-2xl animate-slide-up-in overscroll-contain">
        {/* Mobile drag handle — purely visual, no drag-to-dismiss
            since the download flow has its own explicit Cancel CTA. */}
        <div aria-hidden="true" className="grid place-items-center pt-2.5 pb-1 sm:hidden">
          <span className="w-11 h-1 rounded-full bg-slate-300 dark:bg-dark-border" />
        </div>

        <DialogHeader
          primary={info}
          models={models}
          status={status}
          onCancel={onCancel}
          disableClose={disableClose}
        />

        <div className="overflow-y-auto px-4 md:px-7 py-4 md:py-5 thin-scrollbar">
          {status === "awaiting-consent" || status === "idle" ? (
            <ConsentBody models={models} roles={roles} />
          ) : status === "downloading" || status === "loading" ? (
            <DownloadBody
              primary={info}
              models={models}
              totalBytes={totalBytes}
              progress={progress}
              warm={status === "loading"}
            />
          ) : status === "error" ? (
            <ErrorBody models={models} message={error} />
          ) : null}
        </div>

        <DialogFooter status={status} onConfirm={onConfirm} onRetry={onRetry} onCancel={onCancel} />
      </div>
    </div>,
    document.body,
  );
}

// ── Sub-components ────────────────────────────────────────────────

function DialogHeader({
  primary,
  models,
  status,
  onCancel,
  disableClose,
}: {
  primary: AiModelInfo;
  models: AiModelInfo[];
  status: AiModelStatus;
  onCancel: () => void;
  disableClose: boolean;
}) {
  const multi = models.length > 1;
  const headline =
    status === "loading"
      ? multi
        ? "Loading models"
        : "Loading model"
      : status === "downloading"
        ? multi
          ? "Downloading models"
          : "Downloading model"
        : status === "error"
          ? "Download failed"
          : multi
            ? "Use these AI models?"
            : `Use ${primary.displayName}?`;

  // Description: generic line when multi-model (each model has its
  // own detailed description further down in its card); the model's
  // own description when single.
  const description = multi
    ? "Two small models load together — one to chat with the document, one to find the right pages. Both run entirely on your device; your PDFs are never uploaded."
    : primary.description;

  return (
    <div className="flex items-start gap-4 px-4 md:px-7 pt-2 sm:pt-5 pb-3.5 border-b border-slate-200/70 dark:border-dark-border/70">
      <span className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400">
        {status === "downloading" || status === "loading" ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : status === "error" ? (
          <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
        ) : (
          <Cpu className="w-5 h-5" />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <h2
          id="ai-consent-title"
          className="text-card-title sm:text-base font-semibold tracking-[-0.01em] text-slate-800 dark:text-dark-text"
        >
          {headline}
        </h2>
        <p className="text-card-desc text-slate-500 dark:text-dark-text-muted mt-0.5 leading-relaxed">
          {description}
        </p>
      </div>
      <button
        type="button"
        onClick={disableClose ? undefined : onCancel}
        disabled={disableClose}
        aria-label="Close"
        className="w-9 h-9 rounded-lg grid place-items-center text-slate-400 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-surface-alt hover:text-slate-700 dark:hover:text-dark-text transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function ConsentBody({ models, roles }: { models: AiModelInfo[]; roles?: [string, string] }) {
  return (
    <div className="space-y-3">
      {models.map((info, i) => (
        <ModelCard key={info.id} info={info} role={roles?.[i]} />
      ))}

      {/* Privacy reassurance — repeated here intentionally; users may
          jump straight to this block without reading the header. */}
      <div className="flex items-start gap-2.5 text-xs text-slate-600 dark:text-dark-text-muted leading-relaxed pt-1">
        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-primary-600 dark:text-primary-400" />
        <p>
          Files are downloaded once from Hugging Face's CDN and cached in your browser. After that
          everything runs entirely on your device — your PDFs are never uploaded.
        </p>
      </div>
    </div>
  );
}

function DownloadBody({
  primary,
  models,
  totalBytes,
  progress,
  warm,
}: {
  primary: AiModelInfo;
  models: AiModelInfo[];
  /** Sum of `approxSizeBytes` across all models — used as the total fallback. */
  totalBytes: number;
  progress: AiProgress | null;
  /**
   * `true` when the bytes are already in CacheStorage and we're only
   * constructing the pipeline from disk. Suppresses the byte counter
   * and the "download will resume" line — neither applies — and
   * shows a friendlier "Loading model" label instead.
   */
  warm: boolean;
}) {
  const multi = models.length > 1;

  if (warm) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-dark-text">
          <span
            aria-hidden="true"
            className="w-4 h-4 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin"
          />
          <span className="font-medium">
            {progress?.status ?? (multi ? "Loading models" : "Loading model")}
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-relaxed">
          {multi
            ? "Both models are already cached in your browser — initialising the runtimes now. This usually takes a few seconds."
            : `${primary.displayName} is already cached in your browser — initialising the runtime now. This usually takes a few seconds.`}
        </p>
      </div>
    );
  }

  const loaded = progress?.loaded ?? 0;
  // Fall back to the registry's combined hint if Transformers.js hasn't
  // yet reported a total — this keeps the bar non-empty during the brief
  // window between "initiate" and the first "progress" event.
  const total = Math.max(progress?.total ?? 0, totalBytes);
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const fileName = progress?.file ? progress.file.split("/").pop() || progress.file : "preparing…";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-700 dark:text-dark-text font-medium">
          {progress?.status ?? "Downloading"}
        </span>
        <span className="font-medium text-primary-600 dark:text-primary-400 tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="w-full bg-slate-200 dark:bg-dark-border rounded-full h-2 overflow-hidden">
        <div
          className="bg-primary-600 h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs text-slate-500 dark:text-dark-text-muted">
        <span className="font-mono wrap-anywhere">{fileName}</span>
        <span className="tabular-nums shrink-0">
          {formatFileSize(loaded)} / {formatFileSize(total)}
        </span>
      </div>
      <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-relaxed pt-1">
        If your connection drops, the download will resume next time — files already saved to your
        browser cache won't be redownloaded.
      </p>
      {multi && (
        <p className="text-xs text-slate-400 dark:text-dark-text-muted tabular-nums pt-0.5">
          {models.length} models · ≈ {formatApproxSize(totalBytes)} total
        </p>
      )}
    </div>
  );
}

function ErrorBody({ models, message }: { models: AiModelInfo[]; message: string | null }) {
  const subject = models.length > 1 ? "the AI models" : `${models[0].displayName}`;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300">
        {message ?? "The download could not be completed."}
      </div>
      <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-relaxed">
        Files already saved to your browser cache are kept — retrying picks up where the last
        attempt left off rather than starting {subject} from scratch.
      </p>
    </div>
  );
}

function DialogFooter({
  status,
  onConfirm,
  onRetry,
  onCancel,
}: {
  status: AiModelStatus;
  onConfirm: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="px-4 md:px-7 py-4 bg-slate-50/55 dark:bg-dark-surface-alt/55 border-t border-slate-200/70 dark:border-dark-border/70 flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 rounded-lg text-sm font-medium text-slate-700 dark:text-dark-text bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border hover:border-slate-300 dark:hover:border-dark-text-muted hover:bg-slate-50 dark:hover:bg-dark-surface-alt transition-colors"
      >
        Cancel
      </button>
      {status === "error" ? (
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-primary-600 hover:bg-primary-700 text-white shadow-sm shadow-primary-500/30"
        >
          Retry download
        </button>
      ) : status === "downloading" ? null : (
        <button
          type="button"
          onClick={onConfirm}
          className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors bg-primary-600 hover:bg-primary-700 text-white shadow-sm shadow-primary-500/30"
        >
          Download model
        </button>
      )}
    </div>
  );
}
