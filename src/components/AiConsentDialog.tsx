/**
 * Consent + progress dialog shown before any AI model is downloaded.
 *
 * The dialog cycles through three visual states driven by the `status`
 * prop from `useAiModel`:
 *
 *   - `awaiting-consent` — full model card with size, licence, model
 *     URL and a primary "Download model" CTA. User must explicitly
 *     opt in before any bytes are fetched.
 *   - `downloading` — determinate progress bar, current file name,
 *     loaded/total byte counts. The dialog refuses to close on backdrop
 *     click while in this state so the user can't accidentally lose
 *     visibility of the download (Cancel button is the explicit exit).
 *   - `error` — error message with Retry / Cancel buttons.
 *
 * Styling mirrors `ConfirmDialog` — glass-blur backdrop, scale-in
 * card, app palette tokens.
 */
import { AlertCircle, Cpu, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { AiModelStatus } from "../hooks/useAiModel.ts";
import type { AiModelInfo } from "../utils/ai-models.ts";
import type { AiProgress } from "../utils/ai-runtime.ts";
import { formatFileSize } from "../utils/file-helpers.ts";

interface AiConsentDialogProps {
  /** When `false` the dialog is unmounted entirely. */
  open: boolean;
  info: AiModelInfo;
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

  return createPortal(
    <div
      className="fixed inset-0 z-200 flex items-center justify-center p-4 animate-fade-in overscroll-contain"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-consent-title"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-900/30 dark:bg-black/50"
        style={{
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      />
      <button
        type="button"
        onClick={dismissOnBackdrop ? onCancel : undefined}
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 bg-transparent border-0 cursor-default"
      />

      <div className="relative w-full max-w-lg rounded-2xl overflow-hidden border border-slate-200/80 dark:border-dark-border bg-white/95 dark:bg-dark-surface/95 backdrop-blur-xl shadow-2xl animate-scale-in">
        <DialogHeader
          info={info}
          status={status}
          onCancel={onCancel}
          disableClose={status === "downloading" || status === "loading"}
        />

        <div className="px-6 pb-2">
          {status === "awaiting-consent" || status === "idle" ? (
            <ConsentBody info={info} />
          ) : status === "downloading" || status === "loading" ? (
            <DownloadBody info={info} progress={progress} warm={status === "loading"} />
          ) : status === "error" ? (
            <ErrorBody info={info} message={error} />
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
  info,
  status,
  onCancel,
  disableClose,
}: {
  info: AiModelInfo;
  status: AiModelStatus;
  onCancel: () => void;
  disableClose: boolean;
}) {
  const headline =
    status === "loading"
      ? "Loading model"
      : status === "downloading"
        ? "Downloading model"
        : status === "error"
          ? "Download failed"
          : `Use ${info.displayName}?`;

  return (
    <div className="p-6 pb-4">
      <div className="flex items-start gap-4">
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
            className="text-base font-semibold tracking-[-0.01em] text-slate-800 dark:text-dark-text"
          >
            {headline}
          </h2>
          <p className="text-sm text-slate-500 dark:text-dark-text-muted mt-1 leading-relaxed">
            {info.description}
          </p>
        </div>
        <button
          type="button"
          onClick={disableClose ? undefined : onCancel}
          disabled={disableClose}
          aria-label="Close"
          className="p-1 rounded-md text-slate-400 dark:text-dark-text-muted hover:text-slate-700 dark:hover:text-dark-text hover:bg-slate-100 dark:hover:bg-dark-surface-alt transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function ConsentBody({ info }: { info: AiModelInfo }) {
  return (
    <div className="space-y-4">
      {/* Model card */}
      <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-slate-50/60 dark:bg-dark-surface-alt/60 p-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-slate-600 dark:text-dark-text-muted">
          <dt className="font-medium text-slate-500 dark:text-dark-text-muted">Model</dt>
          <dd className="text-slate-800 dark:text-dark-text font-mono text-xs wrap-anywhere">
            {info.repo}
          </dd>
          <dt className="font-medium text-slate-500 dark:text-dark-text-muted">Approx. size</dt>
          <dd className="text-slate-800 dark:text-dark-text tabular-nums">
            {formatFileSize(info.approxSizeBytes)}
          </dd>
          <dt className="font-medium text-slate-500 dark:text-dark-text-muted">Licence</dt>
          <dd className="text-slate-800 dark:text-dark-text">{info.license}</dd>
          {info.bestFor && (
            <>
              <dt className="font-medium text-slate-500 dark:text-dark-text-muted">Best for</dt>
              <dd className="text-slate-800 dark:text-dark-text leading-relaxed">{info.bestFor}</dd>
            </>
          )}
          <dt className="font-medium text-slate-500 dark:text-dark-text-muted">Source</dt>
          <dd>
            <a
              href={info.modelUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
            >
              View on Hugging Face
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </dd>
        </dl>
      </div>

      {/* Privacy reassurance */}
      <div className="flex items-start gap-2.5 text-xs text-slate-600 dark:text-dark-text-muted leading-relaxed">
        <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-primary-600 dark:text-primary-400" />
        <p>
          The model file is downloaded once from Hugging Face's CDN and cached in your browser.
          After that, it runs entirely on your device — your PDFs are never uploaded.
        </p>
      </div>
    </div>
  );
}

function DownloadBody({
  info,
  progress,
  warm,
}: {
  info: AiModelInfo;
  progress: AiProgress | null;
  /**
   * `true` when the bytes are already in CacheStorage and we're only
   * constructing the pipeline from disk. Suppresses the byte counter
   * and the "download will resume" line — neither applies — and
   * shows a friendlier "Loading model" label instead.
   */
  warm: boolean;
}) {
  if (warm) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm text-slate-700 dark:text-dark-text">
          <span
            aria-hidden="true"
            className="w-4 h-4 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin"
          />
          <span className="font-medium">{progress?.status ?? "Loading model"}</span>
        </div>
        <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-relaxed">
          {info.displayName} is already cached in your browser — initialising the runtime now. This
          usually takes a few seconds.
        </p>
      </div>
    );
  }

  const loaded = progress?.loaded ?? 0;
  // Fall back to the registry's hint if Transformers.js hasn't yet
  // reported a total — this keeps the bar non-empty during the brief
  // window between "initiate" and the first "progress" event.
  const total = Math.max(progress?.total ?? 0, info.approxSizeBytes);
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
    </div>
  );
}

function ErrorBody({ info, message }: { info: AiModelInfo; message: string | null }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-700 dark:text-red-300">
        {message ?? "The download could not be completed."}
      </div>
      <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-relaxed">
        Files already saved to your browser cache are kept — retrying picks up where the last
        attempt left off rather than starting {info.displayName} from scratch.
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
    <div className="px-6 py-4 bg-slate-50/55 dark:bg-dark-surface-alt/55 border-t border-slate-200/70 dark:border-dark-border/70 flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2">
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
