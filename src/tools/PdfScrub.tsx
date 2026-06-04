/**
 * PDF Scrub tool — privacy sanitiser.
 *
 * Scans a PDF for hidden / non-visible data that leaks identity or poses
 * a security risk — document metadata, the XMP packet, embedded
 * JavaScript & auto-launch actions, embedded files, and annotations —
 * reports what it finds, then permanently removes it by rebuilding the
 * document from its visible page content only.
 *
 * Sits alongside Edit Metadata (which only edits the standard Info
 * fields) and Redact (which only removes *visible* pixels): Scrub is the
 * one-click sweep for everything you can't see in the viewer.
 */

import {
  CheckCircle2,
  Code2,
  Eraser,
  Fingerprint,
  type LucideIcon,
  MapPin,
  Paperclip,
  ShieldCheck,
  StickyNote,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { CheckboxField } from "../components/CheckboxField.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { InfoCallout } from "../components/InfoCallout.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { formatFileSize } from "../utils/file-helpers.ts";
import {
  type ScrubAnalysis,
  type ScrubCategory,
  SCRUB_CATEGORIES,
  analyzePdfHiddenData,
  scrubPdf,
} from "../utils/pdf-operations.ts";

/** Display copy + icon for each hidden-data category in the report. */
const CATEGORY_META: Record<
  ScrubCategory,
  { label: string; description: string; icon: LucideIcon; unit: (n: number) => string }
> = {
  metadata: {
    label: "Document metadata",
    description: "Author, software fingerprints, and timestamps in the Info dictionary",
    icon: Fingerprint,
    unit: (n) => `${n} field${n === 1 ? "" : "s"}`,
  },
  xmp: {
    label: "XMP metadata packet",
    description: "Extended metadata that can carry GPS tags and edit history",
    icon: MapPin,
    unit: () => "present",
  },
  javascript: {
    label: "Scripts & auto-actions",
    description: "Embedded JavaScript and actions that run when the file opens",
    icon: Code2,
    unit: (n) => `${n} action${n === 1 ? "" : "s"}`,
  },
  attachments: {
    label: "Embedded files",
    description: "Files hidden inside the PDF via the attachments name tree",
    icon: Paperclip,
    unit: (n) => `${n} file${n === 1 ? "" : "s"}`,
  },
  annotations: {
    label: "Annotations & comments",
    description: "Sticky notes, highlights, and markup that carry author names",
    icon: StickyNote,
    unit: (n) => `${n} item${n === 1 ? "" : "s"}`,
  },
};

export default function PdfScrub() {
  const [removeAnnotations, setRemoveAnnotations] = useState(false);
  const [done, setDone] = useState(false);

  const pdf = usePdfFile<ScrubAnalysis>({
    load: analyzePdfHiddenData,
    onReset: () => {
      setRemoveAnnotations(false);
      setDone(false);
    },
    loadErrorMessage: "Failed to scan the PDF for hidden data.",
  });
  const task = useAsyncProcess();
  const output = useToolOutput();

  const analysis = pdf.data;
  const counts = analysis?.counts;

  const totalFound = useMemo(
    () => (counts ? SCRUB_CATEGORIES.reduce((sum, key) => sum + counts[key], 0) : 0),
    [counts],
  );
  const categoriesFound = useMemo(
    () => (counts ? SCRUB_CATEGORIES.filter((key) => counts[key] > 0).length : 0),
    [counts],
  );

  const handleScrub = useCallback(async () => {
    if (!pdf.file) return;
    const file = pdf.file;
    const ok = await task.run(async () => {
      const data = await scrubPdf(file, removeAnnotations);
      output.deliver(data, "_scrubbed", file);
    }, "Failed to scrub the PDF.");
    if (ok) setDone(true);
  }, [pdf.file, removeAnnotations, task, output]);

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.security}
          iconColor={categoryAccent.security}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="Find and permanently remove hidden metadata, scripts, and embedded data"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={formatFileSize(pdf.file.size)}
            onChangeFile={pdf.reset}
          />

          {pdf.loading ? (
            <div className="flex items-center justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : counts ? (
            <div className="space-y-4">
              {/* Summary banner */}
              {totalFound > 0 ? (
                <InfoCallout icon={ShieldCheck}>
                  Found <span className="font-semibold tabular-nums">{totalFound}</span>{" "}
                  {totalFound === 1 ? "item" : "items"} of hidden data across{" "}
                  <span className="font-semibold tabular-nums">{categoriesFound}</span>{" "}
                  {categoriesFound === 1 ? "category" : "categories"}. Scrub rebuilds the document
                  from its visible pages — physically removing this data, not just hiding it.
                </InfoCallout>
              ) : (
                <InfoCallout icon={CheckCircle2}>
                  No hidden data detected — this PDF is already clean.
                </InfoCallout>
              )}

              {/* Findings report */}
              <div className="bg-white dark:bg-dark-surface rounded-xl border border-slate-200 dark:border-dark-border divide-y divide-slate-100 dark:divide-dark-border">
                <div className="px-4 py-2.5 bg-slate-50 dark:bg-dark-surface-alt rounded-t-xl flex items-center gap-1.5">
                  <Eraser className="w-3.5 h-3.5 text-primary-500 dark:text-primary-400" />
                  <p className="text-xs font-semibold text-slate-500 dark:text-dark-text-muted uppercase tracking-wide">
                    What we found
                  </p>
                </div>
                {SCRUB_CATEGORIES.map((key) => {
                  const meta = CATEGORY_META[key];
                  const count = counts[key];
                  const found = count > 0;
                  return (
                    <div key={key} className="flex items-start sm:items-center gap-3 px-4 py-3">
                      <meta.icon
                        className={`w-4 h-4 mt-0.5 sm:mt-0 shrink-0 ${found ? "text-primary-500 dark:text-primary-400" : "text-slate-400 dark:text-slate-600"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-700 dark:text-dark-text leading-snug">
                          {meta.label}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-dark-text-muted leading-snug">
                          {meta.description}
                        </p>
                      </div>
                      <span className="shrink-0 self-center">
                        {found ? (
                          <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-dark-surface-alt px-2.5 py-0.5 text-xs font-medium text-slate-600 dark:text-dark-text-muted tabular-nums">
                            {meta.unit(count)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-slate-600">
                            <CheckCircle2
                              className="w-3.5 h-3.5 text-emerald-500"
                              aria-hidden="true"
                            />
                            None
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Annotation opt-in */}
              {counts.annotations > 0 && (
                <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface p-4">
                  <CheckboxField
                    label="Also remove annotations & comments"
                    description="Strips sticky notes, highlights, and markup. Off by default so visible annotations are kept."
                    checked={removeAnnotations}
                    onChange={(c) => {
                      setRemoveAnnotations(c);
                      setDone(false);
                    }}
                  />
                </div>
              )}

              <ActionButton
                onClick={handleScrub}
                processing={task.processing}
                disabled={totalFound === 0}
                label={`Scrub PDF & ${output.deliveryWord}`}
                processingLabel="Scrubbing…"
              />

              <p className="text-xs text-slate-500 dark:text-dark-text-muted text-center">
                Rebuilding from visible pages also drops the document outline (bookmarks) and any
                interactive form fields.
              </p>

              {done && (
                <InfoCallout icon={CheckCircle2}>
                  {output.inWorkflow && !output.isLastStep
                    ? "Hidden data removed and PDF passed to the next step."
                    : "Hidden data removed and a clean PDF downloaded successfully."}
                </InfoCallout>
              )}
            </div>
          ) : null}
        </>
      )}

      {(pdf.loadError || task.error) && <AlertBox message={pdf.loadError ?? task.error ?? ""} />}
    </div>
  );
}
