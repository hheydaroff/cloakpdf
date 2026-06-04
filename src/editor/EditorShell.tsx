// EditorShell.tsx — Arranges the editor chrome around the center stage and
// switches between the desktop/tablet three-pane layout and the mobile
// canvas-dominant layout, mirroring CloakIMG's UnifiedEditor shell. Also owns
// the empty (no-doc) dropzone, the loading state, the busy overlay, and the
// error banner. `min-h-0` / `min-w-0` on the growth axes is load-bearing.

import { AlertTriangle, History, X } from "lucide-react";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useActiveTool, useEditorActions, useEditorRead, useToolSlice } from "./EditorContext.tsx";
import { EditorToolStage } from "./EditorToolStage.tsx";
import { EditorTopBar } from "./EditorTopBar.tsx";
import { MobileEditorSurface } from "./MobileEditorSurface.tsx";
import { OverviewMode } from "./OverviewMode.tsx";
import { PdfStage } from "./PdfStage.tsx";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import { ToolRail } from "./ToolRail.tsx";
import { OCR_ID, OcrPreview, ocrHasPreview } from "./tools/OcrTool.tsx";

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <div className="h-8 w-8 animate-spin rounded-full border-3 border-primary-200 border-t-primary-600" />
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">{label}</p>
    </div>
  );
}

export function EditorShell() {
  const { doc, loading, busyLabel, error, layout, viewMode, pendingDraft, latestDraft } =
    useEditorRead();
  const { loadFile, restoreDraft, dismissDraft, restoreLatestDraft, clearError } =
    useEditorActions();
  const activeTool = useActiveTool();
  const ocrSlice = useToolSlice(OCR_ID);
  const isMobile = layout === "mobile";
  const isTablet = layout === "tablet";

  // OCR's side-by-side preview takes over the center once an extraction exists
  // for the current doc, regardless of focus/overview; otherwise the normal
  // stage / page grid. Desktop-only, mirroring the OCR Panel's mobile guard.
  const showOcrPreview = activeTool === OCR_ID && !isMobile && ocrHasPreview(ocrSlice, doc?.id);
  const center = showOcrPreview ? (
    <OcrPreview />
  ) : viewMode === "overview" ? (
    <OverviewMode />
  ) : (
    <>
      <PdfStage />
      <EditorToolStage />
    </>
  );

  return (
    <main className="fixed inset-0 z-100 flex flex-col overflow-hidden bg-slate-50 dark:bg-dark-bg font-sans text-slate-800 dark:text-dark-text">
      <EditorTopBar />

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-4 py-2 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            aria-label="Dismiss error"
            className="shrink-0 rounded-md p-1 hover:bg-red-100 dark:hover:bg-red-900/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {doc && pendingDraft && (
        <div className="flex items-center gap-3 border-b border-primary-200 dark:border-primary-900/50 bg-primary-50 dark:bg-primary-900/30 px-4 py-2 text-sm text-primary-800 dark:text-primary-200">
          <History className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Found unsaved edits for this file from a previous session.
          </span>
          <button
            type="button"
            onClick={() => void restoreDraft()}
            className="shrink-0 rounded-md bg-primary-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            Restore
          </button>
          <button
            type="button"
            onClick={dismissDraft}
            className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-primary-700 hover:bg-primary-100 dark:text-primary-300 dark:hover:bg-primary-900/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Discard
          </button>
        </div>
      )}

      {loading ? (
        <Spinner label="Opening PDF…" />
      ) : !doc ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-xl">
            <FileDropZone
              accept=".pdf,application/pdf"
              onFiles={(files) => files[0] && void loadFile(files[0])}
              glowColor={categoryGlow.organise}
              iconColor={categoryAccent.organise}
              label="Drop a PDF to start editing"
              hint="Everything runs in your browser — nothing is uploaded."
            />
            {latestDraft && (
              <button
                type="button"
                onClick={() => void restoreLatestDraft()}
                aria-label="Restore last session"
                className="mt-4 flex w-full items-center gap-3 rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-4 py-3 text-left transition-colors hover:border-primary-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <History className="h-5 w-5 shrink-0 text-primary-600 dark:text-primary-400" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
                    Restore last session
                  </span>
                  <span className="block truncate text-card-desc text-slate-500 dark:text-dark-text-muted">
                    {latestDraft.fileName}
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!isMobile && <ToolRail />}

          <div className="flex min-w-0 flex-1 flex-col">
            {center}
            {isMobile && <MobileEditorSurface />}
          </div>

          {!isMobile && <PropertiesPanel collapsed={isTablet} />}
        </div>
      )}

      {busyLabel && (
        <div
          className="absolute inset-0 z-150 flex items-center justify-center bg-slate-900/30 backdrop-blur-sm"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 dark:border-dark-border bg-white/95 dark:bg-dark-surface/95 px-5 py-4 shadow-xl">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary-200 border-t-primary-600" />
            <span className="text-card-desc font-medium text-slate-700 dark:text-dark-text">
              {busyLabel}
            </span>
          </div>
        </div>
      )}
    </main>
  );
}
