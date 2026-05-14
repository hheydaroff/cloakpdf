/**
 * Inline gate shown in place of an AI tool's controls until the model
 * is ready. Renders a model card + "Download model" CTA when the
 * pipeline hasn't been loaded yet; otherwise renders `children`.
 *
 * Use this to ensure the user *opts in* to a model download before the
 * tool's main UI becomes interactive — the alternative (popping the
 * consent dialog on every action click) hides the cost of the feature
 * until the user is already committed to running it.
 *
 * The gate auto-triggers `ensureReady()` for returning visitors whose
 * browser already cached the model bytes — they see a brief "Loading…"
 * state and never have to click anything.
 *
 * The progress, error, and confirmation UI continue to live in
 * {@link AiConsentDialog} (rendered by the tool) — the gate is just
 * the entry point.
 */
import { Cpu, Loader2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { UseAiModelReturn } from "../hooks/useAiModel.ts";
import { isModelMarkedReady } from "../utils/ai-runtime.ts";
import { formatFileSize } from "../utils/file-helpers.ts";

interface AiModelGateProps {
  ai: UseAiModelReturn;
  /** Headline shown on the gate card. */
  title?: string;
  /** Lead-in sentence before the model name. */
  blurb?: string;
  /** Tool controls — rendered once the model is ready. */
  children: ReactNode;
}

export function AiModelGate({
  ai,
  title = "Download AI model to continue",
  blurb = "This tool runs on-device. The model file is downloaded once and cached in your browser; your PDFs are never uploaded.",
  children,
}: AiModelGateProps) {
  // Returning-visitor auto-load. Triggers exactly once per mount when
  // the localStorage hint says the model has been downloaded before.
  // First-time visitors stay on the gate card until they click Download.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    if (ai.status !== "idle") return;
    if (!isModelMarkedReady(ai.info.id)) return;
    autoLoadedRef.current = true;
    ai.ensureReady().catch(() => {
      // Failure flows through `ai.error`; the dialog renders retry UI.
    });
  }, [ai]);

  if (ai.status === "ready") return <>{children}</>;

  // `loading` covers every transient state where the consent flow has
  // started: explicit download, cache-warm load (no network), and the
  // brief window between "consent given" and "first byte fetched".
  // The dialog handles the visible progress for downloads — here we
  // just want the gate button to read "Loading model…" so the
  // interaction is consistent across both code paths.
  const loading =
    ai.status === "downloading" || ai.status === "loading" || ai.status === "awaiting-consent";

  return (
    <div className="bg-white dark:bg-dark-surface rounded-2xl border border-slate-200 dark:border-dark-border shadow-sm p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-primary-50 dark:bg-primary-900/30 text-primary-600 dark:text-primary-400"
        >
          <Cpu className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800 dark:text-dark-text">{title}</p>
          <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-1 leading-relaxed">
            {blurb}{" "}
            <span className="font-medium text-slate-700 dark:text-dark-text">
              {ai.info.displayName}
            </span>{" "}
            (~{formatFileSize(ai.info.approxSizeBytes)}).
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          ai.ensureReady().catch(() => {
            /* dialog shows the error */
          });
        }}
        disabled={loading}
        className="mt-4 w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-semibold bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading model…
          </>
        ) : (
          <>
            <Cpu className="w-4 h-4" />
            Download model
          </>
        )}
      </button>
    </div>
  );
}
