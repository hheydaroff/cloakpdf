/**
 * Compress PDF tool.
 *
 * Offers three compression levels (Light / Balanced / Maximum). After
 * compression, shows a summary comparing original vs. compressed size
 * and the percentage saved. The compressed file can then be downloaded.
 */

import { Gauge, Info } from "lucide-react";
import { useCallback, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import { compressPdf } from "../utils/pdf-operations.ts";

export default function CompressPdf() {
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  const [result, setResult] = useState<{
    original: number;
    compressed: number;
    data: Uint8Array;
  } | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const pdf = usePdfFile({
    onReset: () => setResult(null),
  });
  const task = useAsyncProcess();
  const output = useToolOutput();
  const processing = task.processing;
  const error = task.error;

  /** Compress the PDF at the selected quality preset and store the result for download. */
  const handleCompress = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    const ok = await task.run(async () => {
      const data = await compressPdf(file, quality, (current, total) =>
        setProgress({ current, total }),
      );
      // Workflow mode bypasses the savings panel — the user picked a
      // quality preset, the result is the result, advance the runner.
      if (output.inWorkflow) {
        output.deliver(data, "_compressed", file);
      } else {
        setResult({ original: file.size, compressed: data.length, data });
      }
    }, "Failed to compress PDF. Please try again.");
    void ok;
    setProgress(null);
  }, [pdf.file, quality, task, output]);

  const handleDownload = useCallback(() => {
    if (!result || !pdf.file) return;
    output.deliver(result.data, "_compressed", pdf.file);
  }, [result, pdf.file, output]);

  // Clamp to 0 so we never show negative savings when the output is larger
  const savings = result
    ? Math.max(0, Math.round(((result.original - result.compressed) / result.original) * 100))
    : 0;

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
          hint="Re-renders each page as a compressed JPEG image to shrink the file"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {!result ? (
            <div className="space-y-4">
              <div>
                <p
                  id="compress-level-label"
                  className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-dark-text-muted mb-2"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  Compression Level
                </p>
                <div
                  role="radiogroup"
                  aria-labelledby="compress-level-label"
                  className="grid grid-cols-3 gap-3"
                >
                  {[
                    {
                      value: "low" as const,
                      label: "Light",
                      desc: "Sharpest pages, modest size drop",
                      detail: "Renders pages at 1×, JPEG quality 85%",
                    },
                    {
                      value: "medium" as const,
                      label: "Balanced",
                      desc: "Good balance of size & quality",
                      detail: "Renders pages at 1.5×, JPEG quality 70%",
                    },
                    {
                      value: "high" as const,
                      label: "Maximum",
                      desc: "Highest detail; may not shrink text PDFs",
                      detail: "Renders pages at 2×, JPEG quality 50%",
                    },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={quality === opt.value}
                      onClick={() => setQuality(opt.value)}
                      className={`p-3 rounded-xl border text-left transition-[transform,opacity,color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-dark-bg ${
                        quality === opt.value
                          ? "border-primary-500 bg-primary-50 dark:bg-primary-900/30 ring-1 ring-primary-300 dark:ring-primary-700"
                          : "border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface hover:border-slate-300 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-dark-surface-alt"
                      }`}
                    >
                      <p
                        className={`text-sm font-semibold ${quality === opt.value ? "text-primary-700 dark:text-primary-300" : "text-slate-700 dark:text-dark-text"}`}
                      >
                        {opt.label}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-dark-text-muted mt-0.5 leading-snug">
                        {opt.desc}
                      </p>
                      <p className="text-xxs text-slate-500 dark:text-dark-text-muted mt-1.5 leading-snug tabular-nums">
                        {opt.detail}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <InfoCallout icon={Info} accent="warning" title="Output is rasterized">
                Each page is re-rendered as a JPEG image, so text in the result is no longer
                selectable or searchable. Keep the original if you need the text layer.
              </InfoCallout>

              {processing && progress && (
                <ProgressBar
                  current={progress.current}
                  total={progress.total}
                  label="Processing pages…"
                />
              )}

              <ActionButton
                onClick={handleCompress}
                processing={processing}
                label={`Compress & ${output.deliveryWord}`}
                processingLabel="Compressing… (this may take a moment)"
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border p-6">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-sm text-slate-500 dark:text-dark-text-muted">Original</p>
                    <p className="text-xl font-semibold tabular-nums text-slate-800 dark:text-dark-text">
                      {formatFileSize(result.original)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-500 dark:text-dark-text-muted">Compressed</p>
                    <p className="text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatFileSize(result.compressed)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-slate-500 dark:text-dark-text-muted">Saved</p>
                    <p
                      className={`text-xl font-semibold tabular-nums ${savings > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-dark-text-muted"}`}
                    >
                      {savings}%
                    </p>
                  </div>
                </div>
                {savings === 0 && (
                  <p className="text-sm text-slate-500 dark:text-dark-text-muted text-center mt-4">
                    This file is already well optimized. The output is about the same size.
                  </p>
                )}
              </div>

              <ActionButton
                onClick={handleDownload}
                processing={false}
                label="Download Compressed PDF"
                processingLabel=""
              />
            </div>
          )}
        </>
      )}

      {error && <AlertBox message={error} />}
    </div>
  );
}
