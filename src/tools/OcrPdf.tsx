/**
 * OCR PDF tool.
 *
 * Extracts text from scanned or image-based PDFs. Digital pages are read from
 * the text layer (layout-aware, via liteparse); scanned pages fall back to
 * Tesseract.js OCR. The result is shown side-by-side with the rendered source
 * page so the extraction is easy to verify:
 *
 * - **Layout / Plain text** toggle — keep liteparse's spatial spacing or read
 *   clean reading order.
 * - Per-page navigation with the source page rendered alongside the text.
 * - Copy per page / Copy all / Download .txt / Download Searchable PDF.
 */

import { Check, ChevronLeft, ChevronRight, Copy, Download, FileText, ScanLine } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { downloadBlob, formatFileSize, pdfFilename } from "../utils/file-helpers.ts";
import {
  extractLayout,
  type LayoutPage,
  layoutToReadingOrderText,
} from "../utils/layout-extract.ts";
import { classifyPdfPages } from "../utils/ocr-text.ts";
import {
  createSearchablePdf,
  createSearchablePdfFromLayout,
  extractTextOcr,
} from "../utils/pdf-operations.ts";
import { PREVIEW_SCALE, renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";

/** Data derived once per uploaded file: page previews + digital/scanned split. */
interface LoadedPdf {
  thumbnails: string[];
  /** Total page count. */
  totalPages: number;
  /** 1-based pages with no text layer (need Tesseract OCR). */
  scannedPages: number[];
}

/**
 * Render previews and classify pages (digital vs scanned) in one load pass.
 * The classification drives the upfront detection banner and lets us hide the
 * Tesseract engine/language download UI entirely for fully-digital PDFs —
 * liteparse reads those with no model download.
 */
async function loadPdf(file: File): Promise<LoadedPdf> {
  const [thumbnails, classification] = await Promise.all([
    renderAllThumbnails(file, PREVIEW_SCALE),
    classifyPdfPages(file),
  ]);
  return {
    thumbnails,
    totalPages: classification.total,
    scannedPages: classification.scannedPages,
  };
}

/** Language options displayed as pill buttons. "auto" uses Tesseract OSD. */
const LANGUAGES = [
  { code: "auto", label: "🌐 Auto Detect" },
  { code: "ara", label: "🇸🇦 Arabic" },
  { code: "chi_sim", label: "🇨🇳 Chinese" },
  { code: "nld", label: "🇳🇱 Dutch" },
  { code: "eng", label: "🇬🇧 English" },
  { code: "fra", label: "🇫🇷 French" },
  { code: "deu", label: "🇩🇪 German" },
  { code: "hin", label: "🇮🇳 Hindi" },
  { code: "ita", label: "🇮🇹 Italian" },
  { code: "jpn", label: "🇯🇵 Japanese" },
  { code: "kor", label: "🇰🇷 Korean" },
  { code: "por", label: "🇵🇹 Portuguese" },
  { code: "rus", label: "🇷🇺 Russian" },
  { code: "spa", label: "🇪🇸 Spanish" },
] as const;

export default function OcrPdf() {
  const [language, setLanguage] = useState("auto");
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  // Layout-aware extraction result (liteparse). Drives the positioned
  // searchable-PDF layer. `null` when we fell back to the Tesseract-only path.
  const [layout, setLayout] = useState<LayoutPage[] | null>(null);
  // Text preview mode: "layout" keeps liteparse's spatial spacing (columns
  // line up); "text" is clean reading order. Only meaningful on the liteparse
  // path — the Tesseract fallback is text-only.
  const [viewMode, setViewMode] = useState<"layout" | "text">("layout");
  const [selectedPage, setSelectedPage] = useState(0);
  const [copiedPage, setCopiedPage] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);
  const [creatingPdf, setCreatingPdf] = useState(false);
  // Determinate progress while building the searchable PDF on big documents.
  const [savingProgress, setSavingProgress] = useState<{ current: number; total: number } | null>(
    null,
  );

  // Monotonic id so a mid-run file swap can't let a stale extraction clobber the
  // new file's state (which would then export a mismatched searchable PDF).
  const extractIdRef = useRef(0);

  // Render page thumbnails up-front so the source-page preview is ready as soon
  // as extraction finishes.
  const pdf = usePdfFile<LoadedPdf>({
    load: loadPdf,
    onReset: (data) => {
      revokeThumbnails(data?.thumbnails ?? []);
      extractIdRef.current++;
      setPages([]);
      setLayout(null);
      setViewMode("layout");
      setSelectedPage(0);
      setProgress(null);
      setProgressStatus(null);
      setSavingProgress(null);
    },
  });
  const task = useAsyncProcess();
  const processing = task.processing;
  const error = task.error;

  const thumbnails = pdf.data?.thumbnails ?? [];
  const pageCount = pages.length;

  // Digital/scanned split from the load-time probe. Drives the upfront
  // detection banner and whether the OCR engine/language download UI shows.
  const scannedPages = pdf.data?.scannedPages ?? [];
  const totalPages = pdf.data?.totalPages ?? 0;
  const scannedCount = scannedPages.length;
  const needsOcr = scannedCount > 0;
  const analyzed = !!pdf.data;

  /**
   * Extract text with layout-aware parsing (liteparse): digital pages are read
   * from the text layer directly; scanned pages are OCR'd via Tesseract through
   * liteparse's callback, yielding per-item geometry we use for a correctly
   * positioned searchable PDF. On any failure we fall back to the proven
   * Tesseract-only path (full language auto-detect + per-page progress).
   */
  const handleExtract = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    const reqId = ++extractIdRef.current;
    setPages([]);
    setLayout(null);
    setSelectedPage(0);
    setProgress({ current: 0, total: 0 });
    setProgressStatus("Analyzing layout…");
    const ok = await task.run(async () => {
      try {
        // liteparse OCR takes a fixed language; "auto" defaults to English here
        // (digital pages don't OCR, so language is irrelevant for them). The
        // fallback path below retains full Tesseract OSD auto-detection.
        const layoutPages = await extractLayout(file, {
          language: language === "auto" ? "eng" : language,
          onOcrPage: (done, total) => {
            if (extractIdRef.current !== reqId) return;
            setProgress({ current: done, total });
            setProgressStatus("Running OCR on scanned pages…");
          },
        });
        const layoutTexts = layoutPages.map((p) => layoutToReadingOrderText(p));
        // liteparse can resolve with no usable text (e.g. an image-only page it
        // didn't flag as scanned). Treat "succeeded but empty" like a failure so
        // the proven Tesseract-only path (every page, OSD auto-detect) still runs
        // instead of leaving the user with blank output.
        if (layoutTexts.join("").replace(/\s+/g, "").length === 0) {
          throw new Error("empty-layout-result");
        }
        if (extractIdRef.current !== reqId) return;
        setLayout(layoutPages);
        setPages(layoutTexts);
      } catch {
        if (extractIdRef.current !== reqId) return;
        setProgressStatus("Extracting text…");
        const pageTexts = await extractTextOcr(file, language, (current, total, status) => {
          if (extractIdRef.current !== reqId) return;
          setProgress({ current, total });
          if (status) setProgressStatus(status);
        });
        if (extractIdRef.current !== reqId) return;
        setLayout(null);
        setPages(pageTexts);
      }
    }, "Failed to extract text. Please try again.");
    void ok;
    if (extractIdRef.current === reqId) {
      setProgress(null);
      setProgressStatus(null);
    }
  }, [pdf.file, language, task]);

  // Whether a layout-preserving view is available (liteparse path succeeded).
  const hasLayout = !!layout && layout.length > 0;
  const effectiveMode: "layout" | "text" = hasLayout ? viewMode : "text";
  // Per-page text for the active view: liteparse's layout-preserved spacing or
  // clean reading order. Copy/Download follow whatever the user is viewing.
  // Memoised so a big document isn't re-joined on every unrelated re-render.
  const displayPages = useMemo(
    () =>
      pages.map((text, i) => (effectiveMode === "layout" && layout?.[i] ? layout[i].text : text)),
    [pages, layout, effectiveMode],
  );
  const fullText = useMemo(
    () => displayPages.map((t, i) => `--- Page ${i + 1} ---\n\n${t}`).join("\n\n"),
    [displayPages],
  );
  const currentText = displayPages[selectedPage] ?? "";

  const handleCopyAll = useCallback(async () => {
    if (!fullText) return;
    try {
      await navigator.clipboard.writeText(fullText);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      task.setError("Failed to copy to clipboard.");
    }
  }, [fullText, task]);

  const handleCopyPage = useCallback(async () => {
    if (!currentText) return;
    try {
      await navigator.clipboard.writeText(currentText);
      setCopiedPage(true);
      setTimeout(() => setCopiedPage(false), 2000);
    } catch {
      task.setError("Failed to copy to clipboard.");
    }
  }, [currentText, task]);

  const handleDownload = useCallback(() => {
    if (!fullText || !pdf.file) return;
    const baseName = pdf.file.name.replace(/\.pdf$/i, "");
    const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, `${baseName}_ocr.txt`);
  }, [fullText, pdf.file]);

  /** Overlay invisible OCR text on the original PDF so it becomes searchable. */
  const handleDownloadSearchablePdf = useCallback(async () => {
    if (!pdf.file || pages.length === 0) return;
    const file = pdf.file;
    setCreatingPdf(true);
    setSavingProgress(null);
    task.setError(null);
    try {
      const onProg = (current: number, total: number) => setSavingProgress({ current, total });
      // Prefer the layout-positioned text layer (aligned with the page); fall
      // back to the line-stacked layer when we only have plain text.
      const pdfBytes = layout
        ? await createSearchablePdfFromLayout(file, layout, onProg)
        : await createSearchablePdf(file, pages, onProg);
      const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
      downloadBlob(blob, pdfFilename(file, "_searchable"));
    } catch (e) {
      task.setError(e instanceof Error ? e.message : "Failed to create searchable PDF.");
    } finally {
      setCreatingPdf(false);
      setSavingProgress(null);
    }
  }, [pdf.file, pages, layout, task]);

  const totalWords = useMemo(
    () =>
      pages.reduce((sum, text) => sum + text.split(/\s+/).filter((w) => w.length > 0).length, 0),
    [pages],
  );
  const totalChars = useMemo(() => pages.reduce((sum, text) => sum + text.length, 0), [pages]);
  const pageWords = currentText.split(/\s+/).filter((w) => w.length > 0).length;

  if (!pdf.file) {
    return (
      <div className="space-y-6">
        <FileDropZone
          glowColor={categoryGlow.transform}
          iconColor={categoryAccent.transform}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="Extract text from scanned or image-based PDFs using OCR"
        />
        {pdf.loadError && <AlertBox message={pdf.loadError} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FileInfoBar
        fileName={pdf.file.name}
        details={formatFileSize(pdf.file.size)}
        onChangeFile={pdf.reset}
      />

      {pages.length === 0 ? (
        <div className="space-y-4">
          {/* Upfront detection: tell the user what they uploaded, and only
              surface the Tesseract engine/language download UI when pages
              actually need OCR. A fully digital PDF is read by liteparse with
              no model download at all. */}
          {!analyzed ? (
            <div className="flex items-center gap-3 py-4">
              <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
              <span className="text-sm text-slate-600 dark:text-dark-text-muted">
                Analyzing document…
              </span>
            </div>
          ) : !needsOcr ? (
            <InfoCallout icon={FileText} title="Digital PDF — no OCR needed" accent="transform">
              All {totalPages} page{totalPages !== 1 ? "s" : ""} have a text layer, so text is read
              directly and extracts instantly — no OCR engine or language download.
            </InfoCallout>
          ) : scannedCount === totalPages ? (
            <InfoCallout icon={ScanLine} title="Scanned PDF — OCR required" accent="transform">
              No text layer found, so all {totalPages} page{totalPages !== 1 ? "s" : ""} are read
              with OCR. The engine (<span className="font-medium">~2 MB</span>) and the selected
              language data (<span className="font-medium">~10–15 MB</span>) download once, then
              cache offline.
            </InfoCallout>
          ) : (
            <InfoCallout icon={ScanLine} title="Mixed PDF — partial OCR" accent="transform">
              {scannedCount} of {totalPages} page{totalPages !== 1 ? "s" : ""} are scanned and need
              OCR; the rest have a text layer. Only the scanned pages use the OCR engine (
              <span className="font-medium">~2 MB</span> +{" "}
              <span className="font-medium">~10–15 MB</span> language data, downloaded once).
            </InfoCallout>
          )}

          {/* Language pill selector — only meaningful when pages need OCR. */}
          {needsOcr && (
            <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border shadow-sm p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-dark-text-muted mb-3">
                OCR Language
              </p>
              <div className="flex flex-wrap gap-2">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    onClick={() => setLanguage(lang.code)}
                    disabled={processing}
                    className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-[transform,opacity,color,background-color,border-color,box-shadow] ${
                      language === lang.code
                        ? "bg-primary-600 text-white shadow-sm"
                        : "bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted border border-slate-200 dark:border-dark-border hover:bg-slate-200 dark:hover:bg-dark-border"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Progress section */}
          {processing && progress && progress.total > 0 && (
            <ProgressBar
              current={progress.current}
              total={progress.total}
              label={progressStatus || `Processing page ${progress.current} of ${progress.total}`}
            />
          )}

          {/* Initializing spinner */}
          {processing && (!progress || progress.total === 0) && (
            <div className="flex items-center gap-3 py-4">
              <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
              <span className="text-sm text-slate-600 dark:text-dark-text-muted">
                {progressStatus || "Initializing OCR engine…"}
              </span>
            </div>
          )}

          <ActionButton
            onClick={handleExtract}
            processing={processing}
            disabled={processing || !analyzed}
            label={needsOcr ? "Extract Text (OCR)" : "Extract Text"}
            processingLabel="Extracting Text…"
          />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Stats bar */}
          <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-sm text-slate-500 dark:text-dark-text-muted">Pages</p>
                <p className="text-xl font-bold text-slate-800 dark:text-dark-text">{pageCount}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500 dark:text-dark-text-muted">Words</p>
                <p className="text-xl font-bold text-slate-800 dark:text-dark-text">
                  {totalWords.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-500 dark:text-dark-text-muted">Characters</p>
                <p className="text-xl font-bold text-slate-800 dark:text-dark-text">
                  {totalChars.toLocaleString()}
                </p>
              </div>
            </div>
          </div>

          {/* Controls: layout/plain toggle + page navigation */}
          <div className="flex items-center justify-between gap-3">
            {hasLayout ? (
              <div
                role="group"
                aria-label="Text view"
                className="inline-flex rounded-lg border border-slate-200 dark:border-dark-border p-0.5 bg-slate-50 dark:bg-dark-bg"
              >
                {(
                  [
                    ["layout", "Layout"],
                    ["text", "Plain text"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    aria-pressed={viewMode === mode}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      viewMode === mode
                        ? "bg-white dark:bg-dark-surface text-primary-700 dark:text-primary-300 shadow-sm"
                        : "text-slate-500 dark:text-dark-text-muted hover:text-slate-700 dark:hover:text-dark-text"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <span />
            )}
            {pageCount > 1 && (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={selectedPage === 0}
                  onClick={() => setSelectedPage((p) => Math.max(0, p - 1))}
                  className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-dark-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-slate-500 dark:text-dark-text-muted tabular-nums px-1">
                  Page {selectedPage + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={selectedPage === pageCount - 1}
                  onClick={() => setSelectedPage((p) => Math.min(pageCount - 1, p + 1))}
                  className="p-1 rounded text-slate-400 hover:text-slate-600 dark:hover:text-dark-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>

          {/* Side-by-side: extracted text | source page */}
          <div className="grid md:grid-cols-2 gap-6">
            {/* Left: extracted text. min-w-0 lets the layout-mode <pre> scroll
                inside its own box instead of forcing the grid track (and the
                whole page) wider than the viewport on mobile. */}
            <div className="space-y-2 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700 dark:text-dark-text">
                  Extracted text
                  <span className="text-slate-400 dark:text-dark-text-muted font-normal">
                    {" "}
                    · {pageWords} words
                  </span>
                </p>
                <button
                  type="button"
                  onClick={handleCopyPage}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full bg-slate-100 dark:bg-dark-border text-slate-600 dark:text-dark-text-muted hover:bg-primary-100 hover:text-primary-700 dark:hover:bg-primary-900/40 dark:hover:text-primary-300 transition-colors"
                >
                  {copiedPage ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy page
                    </>
                  )}
                </button>
              </div>
              <pre
                className={`text-slate-700 dark:text-dark-text font-mono leading-relaxed bg-slate-50 dark:bg-dark-bg rounded-xl border border-slate-200 dark:border-dark-border p-3 aspect-3/4 overflow-y-auto thin-scrollbar ${
                  effectiveMode === "layout"
                    ? "whitespace-pre overflow-x-auto text-xs"
                    : "whitespace-pre-wrap text-sm"
                }`}
              >
                {currentText || "(No text detected on this page)"}
              </pre>
              {effectiveMode === "layout" && (
                <p className="text-xs text-slate-400 dark:text-dark-text-muted">
                  Spacing preserves the page layout — scroll a row sideways if it’s wide.
                </p>
              )}
            </div>

            {/* Right: source page preview */}
            <div className="space-y-2 min-w-0">
              <p className="text-sm font-medium text-slate-700 dark:text-dark-text">Source page</p>
              <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-bg overflow-hidden aspect-3/4 flex items-center justify-center">
                {thumbnails[selectedPage] ? (
                  <img
                    src={thumbnails[selectedPage]}
                    alt={`Page ${selectedPage + 1}`}
                    className="max-w-full max-h-full w-auto h-auto object-contain"
                    draggable={false}
                  />
                ) : (
                  <LoadingSpinner />
                )}
              </div>
            </div>
          </div>

          {/* Secondary text exports */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handleCopyAll}
              className="inline-flex items-center justify-center gap-2 bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-700 dark:text-dark-text py-2.5 px-4 rounded-xl font-medium hover:bg-slate-50 dark:hover:bg-dark-border transition-colors text-sm"
            >
              {copiedAll ? (
                <>
                  <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy all text
                </>
              )}
            </button>
            <button
              onClick={handleDownload}
              className="inline-flex items-center justify-center gap-2 bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-700 dark:text-dark-text py-2.5 px-4 rounded-xl font-medium hover:bg-slate-50 dark:hover:bg-dark-border transition-colors text-sm"
            >
              <Download className="w-4 h-4" />
              Download .txt
            </button>
          </div>

          {/* Primary action — produce a searchable PDF */}
          {creatingPdf && savingProgress && savingProgress.total > 0 && (
            <ProgressBar
              current={savingProgress.current}
              total={savingProgress.total}
              label={`Adding text layer to page ${savingProgress.current} of ${savingProgress.total}…`}
            />
          )}
          <ActionButton
            onClick={handleDownloadSearchablePdf}
            processing={creatingPdf}
            label="Download Searchable PDF"
            processingLabel="Creating Searchable PDF…"
          />
        </div>
      )}

      {error && <AlertBox message={error} />}
    </div>
  );
}
