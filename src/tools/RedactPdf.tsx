/**
 * Redact PDF tool.
 *
 * Two ways to redact, one review surface:
 *   - **Auto-detect** sweeps the document for emails, phones, IDs etc. and
 *     pre-fills redaction boxes (see {@link detectPiiRects}).
 *   - **Manual** — drag on the page preview to cover anything else.
 *
 * Boxes are stored as page-relative fractions (0–1) so they stay accurate at
 * any display size. On apply, {@link redactPdf} rasterises every page that
 * carries a box and burns the boxes into the pixels, so the underlying text is
 * permanently destroyed — not merely hidden.
 *
 * Layout mirrors the rest of the toolkit: a controls column and a live page
 * preview side-by-side on desktop, stacked on mobile.
 */

import { Loader2, ScanSearch, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { PagePreviewNav } from "../components/PagePreviewNav.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { canvas as canvasColors, categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { downloadPdf, pdfFilename } from "../utils/file-helpers.ts";
import { detectPiiRects, extractTextGeometry } from "../utils/layout-extract.ts";
import { redactPdf } from "../utils/pdf-operations.ts";
import { PREVIEW_SCALE, renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";
import { type PiiType, PII_LABELS, PII_TYPES } from "../utils/pii.ts";

interface RedactionRect {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export default function RedactPdf() {
  // Page shown in the preview (always set once a file is loaded).
  const [selectedPage, setSelectedPage] = useState(0);
  // Map of pageIndex → list of redaction rects (fraction coords).
  const [redactions, setRedactions] = useState<Map<number, RedactionRect[]>>(new Map());
  // Global undo history — each entry is the full redactions map before a change.
  const [undoHistory, setUndoHistory] = useState<Map<number, RedactionRect[]>[]>([]);

  // Smart-redaction (auto-detect PII) state.
  const [detecting, setDetecting] = useState(false);
  const [detectSummary, setDetectSummary] = useState<string | null>(null);
  // Determinate progress for the (potentially minutes-long) PII scan on a big
  // PDF: "read" while pulling text geometry, "ocr" while OCR'ing scanned pages.
  const [scanProgress, setScanProgress] = useState<{
    current: number;
    total: number;
    phase: "read" | "ocr";
  } | null>(null);
  // Determinate progress while rasterising redacted pages on apply.
  const [applyProgress, setApplyProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  // Determinate progress while rendering page thumbnails after upload — the one
  // blocking step before the editor appears, slow on a big PDF.
  const [thumbProgress, setThumbProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  // Date is off by default — it's the noisiest category on real documents.
  const [piiTypes, setPiiTypes] = useState<Set<PiiType>>(
    () => new Set(PII_TYPES.filter((t) => t !== "date")),
  );

  const pdf = usePdfFile<string[]>({
    load: (file) =>
      renderAllThumbnails(file, PREVIEW_SCALE, (rendered, total) =>
        setThumbProgress({ current: rendered, total }),
      ),
    onReset: (thumbs) => {
      revokeThumbnails(thumbs ?? []);
      setRedactions(new Map());
      setUndoHistory([]);
      setSelectedPage(0);
      setDetectSummary(null);
      setScanProgress(null);
      setApplyProgress(null);
      setThumbProgress(null);
    },
  });
  const task = useAsyncProcess();

  // Latch the live file + redaction map in refs so async handlers can detect a
  // mid-run file swap and merge against the freshest state (closures captured
  // at call time go stale across an await).
  const fileRef = useRef(pdf.file);
  fileRef.current = pdf.file;
  const redactionsRef = useRef(redactions);
  redactionsRef.current = redactions;

  const thumbnails = pdf.data ?? [];
  const pageCount = thumbnails.length;
  const pageRects = redactions.get(selectedPage) ?? [];
  const totalRedactions = [...redactions.values()].reduce((sum, r) => sum + r.length, 0);

  // Canvas drawing state.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  /** Redraw all saved rects + optional in-progress rect onto the canvas. */
  const redrawCanvas = useCallback(
    (inProgress?: RedactionRect) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const draw = (r: RedactionRect) => {
        const x = r.xPct * canvas.width;
        const y = r.yPct * canvas.height;
        const w = r.wPct * canvas.width;
        const h = r.hPct * canvas.height;
        ctx.fillStyle = canvasColors.redactFill;
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = canvasColors.redactStroke;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
      };

      for (const r of redactions.get(selectedPage) ?? []) draw(r);
      if (inProgress) draw(inProgress);
    },
    [selectedPage, redactions],
  );

  // Latch the latest redraw closure so the ResizeObserver effect below doesn't
  // have to depend on its identity (which changes on every box add / page nav).
  const redrawCanvasRef = useRef(redrawCanvas);
  redrawCanvasRef.current = redrawCanvas;

  // Re-render canvas whenever saved rects or the selected page changes.
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  /** Convert a pointer event to canvas-relative fractional coords (0–1). */
  const getRelativePos = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragStart(getRelativePos(e));
    },
    [getRelativePos],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStart) return;
      e.preventDefault();
      const pos = getRelativePos(e);
      redrawCanvas({
        xPct: Math.min(dragStart.x, pos.x),
        yPct: Math.min(dragStart.y, pos.y),
        wPct: Math.abs(pos.x - dragStart.x),
        hPct: Math.abs(pos.y - dragStart.y),
      });
    },
    [dragStart, getRelativePos, redrawCanvas],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStart) return;
      e.preventDefault();
      const pos = getRelativePos(e);
      const r: RedactionRect = {
        xPct: Math.min(dragStart.x, pos.x),
        yPct: Math.min(dragStart.y, pos.y),
        wPct: Math.abs(pos.x - dragStart.x),
        hPct: Math.abs(pos.y - dragStart.y),
      };

      // Only save rects that are at least 1% of the page in each dimension.
      if (r.wPct > 0.01 && r.hPct > 0.01) {
        setUndoHistory((h) => [...h, redactions]);
        const next = new Map(redactions);
        next.set(selectedPage, [...(next.get(selectedPage) ?? []), r]);
        setRedactions(next);
      }
      setDragStart(null);
    },
    [dragStart, getRelativePos, redactions, selectedPage],
  );

  const cancelDrag = useCallback(() => {
    if (dragStart) {
      setDragStart(null);
      redrawCanvas();
    }
  }, [dragStart, redrawCanvas]);

  const globalUndo = useCallback(() => {
    setUndoHistory((prev) => {
      if (prev.length === 0) return prev;
      setRedactions(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }, []);

  const clearAllRects = useCallback(() => {
    setUndoHistory((h) => [...h, redactions]);
    setRedactions(new Map());
  }, [redactions]);

  const clearPageRects = useCallback(() => {
    setUndoHistory((h) => [...h, redactions]);
    const next = new Map(redactions);
    next.delete(selectedPage);
    setRedactions(next);
  }, [redactions, selectedPage]);

  const togglePiiType = useCallback((t: PiiType) => {
    setPiiTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  /**
   * Auto-detect sensitive data and pre-fill redaction boxes for review.
   * Runs layout-aware extraction (digital text + geometry, OCR for scans),
   * maps each PII span to a rectangle, and merges the results into the same
   * redaction map the manual editor uses — so the user can inspect, undo, or
   * add to them before applying. Nothing is burned until they hit Apply.
   */
  const handleDetectPii = useCallback(async () => {
    if (!pdf.file || piiTypes.size === 0) return;
    const file = pdf.file;
    setDetecting(true);
    setDetectSummary(null);
    setScanProgress(null);
    task.setError(null);
    try {
      const pages = await extractTextGeometry(file, {
        ocr: true,
        onProgress: (current, total) => setScanProgress({ current, total, phase: "read" }),
        onOcrPage: (current, total) => setScanProgress({ current, total, phase: "ocr" }),
      });
      // Bail if the user swapped files mid-scan — otherwise we'd merge the old
      // file's hits into the new file's (wrong-coordinate) redaction map.
      if (fileRef.current !== file) return;
      const found = detectPiiRects(pages, [...piiTypes]);
      if (found.length === 0) {
        setDetectSummary("No matching sensitive data found — draw boxes manually if needed.");
        return;
      }

      // Merge against the freshest map (via ref) so boxes the user drew *during*
      // the async scan aren't clobbered. Computed outside setState so the
      // updater stays pure (StrictMode double-invokes updaters; the synchronous
      // ref read after the only await can't race a concurrent React update).
      const base = redactionsRef.current;
      const next = new Map(base);
      let added = 0;
      let firstPage = -1;
      const counts = new Map<PiiType, number>();
      for (const r of found) {
        const existing = next.get(r.pageIndex) ?? [];
        // Skip near-duplicates so re-running detect doesn't stack boxes.
        const dup = existing.some(
          (e) =>
            Math.abs(e.xPct - r.xPct) < 0.01 &&
            Math.abs(e.yPct - r.yPct) < 0.01 &&
            Math.abs(e.wPct - r.wPct) < 0.02,
        );
        if (dup) continue;
        next.set(r.pageIndex, [
          ...existing,
          { xPct: r.xPct, yPct: r.yPct, wPct: r.wPct, hPct: r.hPct },
        ]);
        added++;
        if (firstPage === -1) firstPage = r.pageIndex;
        counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
      }

      if (added === 0) {
        setDetectSummary("Already covered — detected data is already in the boxes.");
      } else {
        setUndoHistory((h) => [...h, base]);
        setRedactions(next);
        if (firstPage >= 0) setSelectedPage(firstPage); // jump to the first hit
        const parts = [...counts].map(
          ([t, n]) => `${n} ${PII_LABELS[t].toLowerCase()}${n > 1 ? "s" : ""}`,
        );
        setDetectSummary(`Added ${added} box${added > 1 ? "es" : ""}: ${parts.join(", ")}.`);
      }
    } catch (e) {
      task.setError(e instanceof Error ? e.message : "Failed to scan for sensitive data.");
    } finally {
      setDetecting(false);
      setScanProgress(null);
    }
  }, [pdf.file, piiTypes, task]);

  const handleApply = useCallback(async () => {
    if (!pdf.file || totalRedactions === 0) return;
    const file = pdf.file;
    setApplyProgress(null);
    await task.run(async () => {
      const flat: { pageIndex: number; xPct: number; yPct: number; wPct: number; hPct: number }[] =
        [];
      for (const [pageIndex, rects] of redactions) {
        for (const r of rects) flat.push({ pageIndex, ...r });
      }
      const result = await redactPdf(file, flat, (current, total) =>
        setApplyProgress({ current, total }),
      );
      downloadPdf(result, pdfFilename(file, "_redacted"));
    }, "Failed to apply redactions. Please try again.");
    setApplyProgress(null);
  }, [pdf.file, redactions, totalRedactions, task]);

  // Keep the drawing canvas sized to the preview image as it loads / resizes.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const sync = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      canvas.width = width;
      canvas.height = height;
      redrawCanvasRef.current();
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    return () => ro.disconnect();
  }, [pdf.loading]);

  if (!pdf.file) {
    return (
      <div className="space-y-6">
        <FileDropZone
          glowColor={categoryGlow.security}
          iconColor={categoryAccent.security}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="Auto-detect emails, links, phones & IDs — or draw boxes — then permanently remove them"
        />
        {pdf.loadError && <AlertBox message={pdf.loadError} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FileInfoBar
        fileName={pdf.file.name}
        details={`${pageCount} page${pageCount === 1 ? "" : "s"}`}
        onChangeFile={pdf.reset}
        extra={
          totalRedactions > 0 ? (
            <span className="text-red-600 dark:text-red-400 ml-2">
              ({totalRedactions} redaction{totalRedactions > 1 ? "s" : ""})
            </span>
          ) : undefined
        }
      />

      {pdf.loading ? (
        thumbProgress && thumbProgress.total > 0 ? (
          <div className="py-8">
            <ProgressBar
              current={thumbProgress.current}
              total={thumbProgress.total}
              label={`Rendering page ${thumbProgress.current} of ${thumbProgress.total}…`}
            />
          </div>
        ) : (
          <LoadingSpinner />
        )
      ) : (
        <>
          <div className="grid md:grid-cols-2 gap-6">
            {/* ── Left column: controls ── */}
            <div className="space-y-4">
              {/* Auto-detect */}
              <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <ScanSearch className="w-5 h-5 text-primary-600 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-700 dark:text-dark-text">
                      Auto-detect sensitive info
                    </p>
                    <p className="text-xs text-slate-500 dark:text-dark-text-muted">
                      Scans the document and adds boxes for the selected data types. Names aren’t
                      auto-detected — box those by hand.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {PII_TYPES.map((t) => {
                    const on = piiTypes.has(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => togglePiiType(t)}
                        disabled={detecting}
                        aria-pressed={on}
                        className={`px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-surface ${
                          on
                            ? "bg-primary-600 text-white"
                            : "bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted border border-slate-200 dark:border-dark-border hover:bg-slate-200 dark:hover:bg-dark-border"
                        }`}
                      >
                        {PII_LABELS[t]}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={handleDetectPii}
                  disabled={detecting || piiTypes.size === 0}
                  className="inline-flex w-full sm:w-auto items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-surface"
                >
                  {detecting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Scanning…
                    </>
                  ) : (
                    <>
                      <ScanSearch className="w-4 h-4" />
                      Detect &amp; add boxes
                    </>
                  )}
                </button>
                {detecting && scanProgress && scanProgress.total > 0 && (
                  <ProgressBar
                    current={scanProgress.current}
                    total={scanProgress.total}
                    label={
                      scanProgress.phase === "ocr"
                        ? `OCR’ing scanned page ${scanProgress.current} of ${scanProgress.total}…`
                        : `Reading page ${scanProgress.current} of ${scanProgress.total}…`
                    }
                  />
                )}
                {detectSummary && (
                  <p
                    role="status"
                    aria-live="polite"
                    className="text-xs text-slate-600 dark:text-dark-text-muted"
                  >
                    {detectSummary}
                  </p>
                )}
              </div>

              {/* Manual + global actions */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-700 dark:text-dark-text">
                    Draw boxes by hand
                  </p>
                  {totalRedactions > 0 && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={globalUndo}
                        disabled={undoHistory.length === 0}
                        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 dark:text-dark-text-muted dark:hover:text-dark-text disabled:opacity-40 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                      >
                        <Undo2 className="w-4 h-4" />
                        Undo
                      </button>
                      <button
                        type="button"
                        onClick={clearAllRects}
                        className="inline-flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                      >
                        <Trash2 className="w-4 h-4" />
                        Clear all
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-dark-text-muted">
                  Drag on the page preview to cover anything the scan missed — names, signatures, or
                  logos. Boxes snap to where you draw.
                </p>
              </div>
            </div>

            {/* ── Right column: page preview ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700 dark:text-dark-text">
                  Page {selectedPage + 1}
                  {pageRects.length > 0 && (
                    <span className="text-red-600 dark:text-red-400 font-normal">
                      {" "}
                      · {pageRects.length} box{pageRects.length > 1 ? "es" : ""}
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  {pageRects.length > 0 && (
                    <button
                      type="button"
                      onClick={clearPageRects}
                      className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear page
                    </button>
                  )}
                  <PagePreviewNav
                    page={selectedPage}
                    total={pageCount}
                    onChange={setSelectedPage}
                    size="touch"
                  />
                </div>
              </div>

              <div
                ref={containerRef}
                className="relative rounded-xl overflow-hidden border border-slate-200 dark:border-dark-border select-none w-full"
                style={{ cursor: "crosshair" }}
              >
                <img
                  src={thumbnails[selectedPage]}
                  alt={`Page ${selectedPage + 1}`}
                  className="w-full h-auto block pointer-events-none"
                  draggable={false}
                />
                <canvas
                  ref={canvasRef}
                  role="application"
                  tabIndex={0}
                  aria-label={`Redaction drawing surface for page ${selectedPage + 1} — drag with a pointer to cover sensitive content, or press Delete to clear this page's boxes`}
                  aria-describedby="redact-canvas-hint"
                  className="absolute inset-0 w-full h-full touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-inset"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={cancelDrag}
                  onPointerLeave={cancelDrag}
                  onKeyDown={(e) => {
                    // Keyboard users can't draw boxes (pointer-only), but they can
                    // remove them: Delete/Backspace clears the focused page's boxes,
                    // matching the "Clear page" button.
                    if ((e.key === "Delete" || e.key === "Backspace") && pageRects.length > 0) {
                      e.preventDefault();
                      clearPageRects();
                    }
                  }}
                />
              </div>
              <p
                id="redact-canvas-hint"
                className="text-xs text-slate-500 dark:text-dark-text-muted text-center"
              >
                Drag on the page to draw a redaction box. Manual drawing requires a pointer; use
                Auto-detect to add boxes for sensitive data with the keyboard, and press Delete
                while the page is focused to clear its boxes.
              </p>
            </div>
          </div>

          {/* Apply — below the grid, full-width primary action */}
          {totalRedactions > 0 && (
            <div className="space-y-2">
              {task.processing && applyProgress && applyProgress.total > 0 && (
                <ProgressBar
                  current={applyProgress.current}
                  total={applyProgress.total}
                  label={`Rasterising page ${applyProgress.current} of ${applyProgress.total}…`}
                  color="bg-red-600"
                />
              )}
              <p className="text-xs text-slate-500 dark:text-dark-text-muted text-center">
                Redacted pages are flattened to images so the hidden text is permanently removed —
                those pages become non-selectable and the file may grow. Other pages are left
                untouched.
              </p>
              <ActionButton
                onClick={handleApply}
                processing={task.processing}
                label={`Apply ${totalRedactions} Redaction${totalRedactions > 1 ? "s" : ""} & Download`}
                processingLabel="Applying Redactions…"
                color="bg-red-600 hover:bg-red-700"
              />
            </div>
          )}
        </>
      )}

      {(pdf.loadError || task.error) && <AlertBox message={pdf.loadError ?? task.error ?? ""} />}
    </div>
  );
}
