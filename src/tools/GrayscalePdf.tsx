/**
 * Grayscale PDF tool.
 *
 * Converts every page of a PDF to grayscale by rasterising each page,
 * applying the standard luminance formula, and re-embedding it as PNG.
 * Useful for reducing ink costs when printing or producing print-ready
 * black-and-white documents.
 */

import { useCallback, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { PagePreviewNav } from "../components/PagePreviewNav.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import { grayscalePdf } from "../utils/pdf-operations.ts";
import { PREVIEW_SCALE, renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";

export default function GrayscalePdf() {
  const [result, setResult] = useState<Uint8Array | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  // Preview-only cursor. Grayscaling converts every page unconditionally,
  // so paging never affects the output — the "After" column is just a CSS
  // filter on the rendered thumbnail.
  const [selectedPage, setSelectedPage] = useState(0);

  // Pre-render every page once so paging the preview is a cheap array
  // index — the same thumbnail source every other preview tool uses.
  const pdf = usePdfFile<string[]>({
    load: (file) => renderAllThumbnails(file, PREVIEW_SCALE),
    onReset: (data) => {
      revokeThumbnails(data ?? []);
      setResult(null);
      setSelectedPage(0);
    },
  });
  const task = useAsyncProcess();
  const output = useToolOutput();

  const thumbnails = pdf.data ?? [];
  const pageCount = thumbnails.length;

  const handleConvert = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    const ok = await task.run(async () => {
      const data = await grayscalePdf(file, (current, total) => setProgress({ current, total }));
      if (output.inWorkflow) {
        output.deliver(data, "_grayscale", file);
      } else {
        setResult(data);
      }
    }, "Failed to convert PDF. Please try again.");
    void ok;
    setProgress(null);
  }, [pdf.file, task, output]);

  const handleDownload = useCallback(() => {
    if (!result || !pdf.file) return;
    output.deliver(result, "_grayscale", pdf.file);
  }, [result, pdf.file, output]);

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.transform}
          iconColor={categoryAccent.transform}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="All pages will be converted to grayscale — colour information is permanently removed"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={pdf.loading ? "loading…" : formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {/* Before / After preview */}
          {pdf.loading ? (
            <div className="grid grid-cols-2 gap-4">
              {(["Before", "After"] as const).map((label) => (
                <div
                  key={label}
                  className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border overflow-hidden"
                >
                  <div className="px-3 py-2 border-b border-slate-100 dark:border-dark-border">
                    <p className="text-xs font-semibold text-slate-500 dark:text-dark-text-muted uppercase tracking-widest">
                      {label}
                    </p>
                  </div>
                  <div className="p-2 flex items-center justify-center bg-slate-50 dark:bg-dark-surface-alt h-56">
                    <LoadingSpinner />
                  </div>
                </div>
              ))}
            </div>
          ) : pageCount > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-slate-700 dark:text-dark-text">
                  Preview — Page {selectedPage + 1}
                </p>
                <PagePreviewNav page={selectedPage} total={pageCount} onChange={setSelectedPage} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                {(["Before", "After"] as const).map((label) => (
                  <div
                    key={label}
                    className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border overflow-hidden"
                  >
                    <div className="px-3 py-2 border-b border-slate-100 dark:border-dark-border">
                      <p className="text-xs font-semibold text-slate-500 dark:text-dark-text-muted uppercase tracking-widest">
                        {label}
                      </p>
                    </div>
                    <div className="p-2 flex items-center justify-center bg-slate-50 dark:bg-dark-surface-alt">
                      <img
                        src={thumbnails[selectedPage]}
                        alt={`${label} — page ${selectedPage + 1}`}
                        className={`max-h-52 w-auto rounded-lg${label === "After" ? " grayscale" : ""}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {!result ? (
            <div className="space-y-4">
              {task.processing && progress && (
                <ProgressBar
                  current={progress.current}
                  total={progress.total}
                  label="Processing pages…"
                />
              )}

              <ActionButton
                onClick={handleConvert}
                processing={task.processing}
                label={`Convert to Grayscale & ${output.deliveryWord}`}
                processingLabel="Converting… (this may take a moment)"
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-6 text-center">
                <p className="text-sm text-slate-500 dark:text-dark-text-muted">Output size</p>
                <p className="text-2xl font-semibold tabular-nums text-slate-800 dark:text-dark-text mt-1">
                  {formatFileSize(result.length)}
                </p>
                <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-2">
                  All colour has been removed — the PDF is ready to download
                </p>
              </div>

              <ActionButton
                onClick={handleDownload}
                processing={false}
                label="Download Grayscale PDF"
                processingLabel=""
              />
            </div>
          )}
        </>
      )}

      {(pdf.loadError || task.error) && <AlertBox message={pdf.loadError ?? task.error ?? ""} />}
    </div>
  );
}
