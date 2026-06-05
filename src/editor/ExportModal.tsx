// ExportModal.tsx — The editor's "Export" control: a button that opens a modal
// of output options, each driven off the LIVE document bytes. Replaces the old
// dropdown menu AND absorbs the whole-document "convert then download" tools
// (compress / grayscale / flatten / repair) that used to live on the tool rail
// — they're terminal outputs, not edit steps, so they belong with Export.
//
//   Save as:           PDF · Images (.zip) · Contact sheet · Split (.zip)
//   Convert & export:  Compress (quality) · Grayscale · Flatten · Repair
//
// Long-running ops run under the editor's busy overlay via `runTask` (no history
// commit — exports never mutate the working doc). The modal mirrors the app's
// dialog idiom (ChatModelPickerModal): portal, scroll-lock, Escape / backdrop
// dismiss, bottom-sheet on mobile / centered card on desktop.

import {
  Archive,
  ChevronDown,
  Contrast,
  FileText,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  type LucideIcon,
  Scissors,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { downloadBlob, downloadPdf, pdfFilename } from "../utils/file-helpers.ts";
import {
  compressPdf,
  flattenPdf,
  grayscalePdf,
  nupPages,
  repairPdf,
  splitPdfIntoParts,
} from "../utils/pdf-operations.ts";
import { renderPagesToBlobs } from "../utils/pdf-renderer.ts";
import { docToFile } from "./doc.ts";
import { useEditorActions, useEditorRead } from "./EditorContext.tsx";
import { Segmented } from "./panels/WholeDocPanel.tsx";

const IMAGE_DPI = 150;

type Quality = "low" | "medium" | "high";

const COMPRESS_INFO: Record<Quality, string> = {
  low: "Sharpest pages, modest size drop (1× render, JPEG 85%).",
  medium: "Balanced size vs quality — suits most documents (1.5× render, JPEG 70%).",
  high: "Smallest file, softest pages (2× render, JPEG 50%).",
};

/** One export option: an icon chip + label + hint, full-width clickable row. */
function ExportRow({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex w-full items-center gap-3 rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-3 py-2.5 text-left transition-colors hover:border-primary-300 hover:bg-slate-50 dark:hover:border-primary-700 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
          {label}
        </span>
        <span className="block text-xs text-slate-500 dark:text-dark-text-muted">{hint}</span>
      </span>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-0.5 text-xxs font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
      {children}
    </p>
  );
}

export function ExportButton() {
  const { doc, busyLabel } = useEditorRead();
  const { runTask } = useEditorActions();
  const [open, setOpen] = useState(false);
  const [quality, setQuality] = useState<Quality>("medium");
  const busy = busyLabel !== null;
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Scroll-lock + Escape while open. Mirrors the app's modal idiom.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const baseName = doc ? doc.fileName.replace(/\.pdf$/i, "") : "document";

  // Run an op then close the modal. Each op reads the LIVE bytes and downloads;
  // none mutate the working doc (exports are terminal).
  const run = useCallback((fn: () => void | Promise<void>) => {
    setOpen(false);
    void fn();
  }, []);

  const exportPdf = useCallback(() => {
    if (!doc) return;
    downloadPdf(doc.bytes, pdfFilename(doc.fileName, "_edited"));
  }, [doc]);

  const exportImages = useCallback(() => {
    if (!doc) return;
    void runTask("Rendering images…", async () => {
      const file = docToFile(doc);
      const indices = Array.from({ length: doc.pageCount }, (_, i) => i);
      const rendered = await renderPagesToBlobs(file, indices, IMAGE_DPI, "image/png");
      if (rendered.length === 1) {
        downloadBlob(rendered[0].blob, `${baseName}.png`);
        return;
      }
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const { pageIndex, blob } of rendered) {
        zip.file(`${baseName}_p${String(pageIndex + 1).padStart(3, "0")}.png`, blob);
      }
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName}_images.zip`);
    });
  }, [doc, baseName, runTask]);

  const exportContactSheet = useCallback(() => {
    if (!doc) return;
    void runTask("Building contact sheet…", async () => {
      const bytes = await nupPages(docToFile(doc), "3x3");
      downloadPdf(bytes, pdfFilename(doc.fileName, "_contact-sheet"));
    });
  }, [doc, runTask]);

  const exportSplit = useCallback(() => {
    if (!doc) return;
    void runTask("Splitting pages…", async () => {
      const parts = Array.from({ length: doc.pageCount }, (_, i) => [i]);
      const pdfs = await splitPdfIntoParts(docToFile(doc), parts);
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      pdfs.forEach((bytes, i) => {
        zip.file(`${baseName}_p${String(i + 1).padStart(3, "0")}.pdf`, bytes);
      });
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName}_pages.zip`);
    });
  }, [doc, baseName, runTask]);

  const exportCompressed = useCallback(() => {
    if (!doc) return;
    void runTask("Compressing…", async () => {
      const bytes = await compressPdf(docToFile(doc), quality);
      downloadPdf(bytes, pdfFilename(doc.fileName, "_compressed"));
    });
  }, [doc, quality, runTask]);

  const exportGrayscale = useCallback(() => {
    if (!doc) return;
    void runTask("Converting to grayscale…", async () => {
      const bytes = await grayscalePdf(docToFile(doc));
      downloadPdf(bytes, pdfFilename(doc.fileName, "_grayscale"));
    });
  }, [doc, runTask]);

  const exportFlattened = useCallback(() => {
    if (!doc) return;
    void runTask("Flattening…", async () => {
      const bytes = await flattenPdf(docToFile(doc));
      downloadPdf(bytes, pdfFilename(doc.fileName, "_flattened"));
    });
  }, [doc, runTask]);

  const exportRepaired = useCallback(() => {
    if (!doc) return;
    void runTask("Repairing…", async () => {
      const bytes = await repairPdf(docToFile(doc));
      downloadPdf(bytes, pdfFilename(doc.fileName, "_repaired"));
    });
  }, [doc, runTask]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!doc || busy}
        aria-haspopup="dialog"
        className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        <span className="hidden sm:inline">Export</span>
        <ChevronDown className="h-4 w-4" />
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-200 flex items-end justify-center sm:items-center sm:px-3 md:px-6"
            role="dialog"
            aria-modal="true"
            aria-label="Export document"
          >
            <button
              type="button"
              aria-label="Close export"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="absolute inset-0 cursor-default border-none bg-slate-900/30 backdrop-blur-sm"
            />
            <div className="relative flex max-h-[88svh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200/80 bg-white/90 shadow-2xl backdrop-blur-xl animate-slide-up-in overscroll-contain sm:max-h-[min(640px,calc(100svh-64px))] sm:w-[min(480px,100%)] sm:rounded-2xl dark:border-dark-border dark:bg-dark-surface/90">
              {/* Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-slate-200/70 px-4 py-3 dark:border-dark-border">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-dark-text">
                    Export
                  </h2>
                  {doc && (
                    <p className="truncate text-xs text-slate-400 dark:text-dark-text-muted">
                      {doc.fileName} · {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
                    </p>
                  )}
                </div>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-dark-surface-alt dark:hover:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Body */}
              <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
                <div className="flex flex-col gap-2">
                  <SectionLabel>Save as</SectionLabel>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ExportRow
                      icon={FileText}
                      label="PDF"
                      hint="The edited document"
                      onClick={() => run(exportPdf)}
                    />
                    <ExportRow
                      icon={ImageIcon}
                      label="Images (.zip)"
                      hint="Each page as PNG"
                      onClick={() => run(exportImages)}
                    />
                    <ExportRow
                      icon={LayoutGrid}
                      label="Contact sheet"
                      hint="3×3 overview PDF"
                      onClick={() => run(exportContactSheet)}
                    />
                    <ExportRow
                      icon={Scissors}
                      label="Split pages (.zip)"
                      hint="One PDF per page"
                      onClick={() => run(exportSplit)}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <SectionLabel>Convert &amp; export</SectionLabel>

                  {/* Compress carries a quality choice, so it's a small block. */}
                  <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface p-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400">
                        <Archive className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
                          Compress
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-dark-text-muted">
                          Shrink by re-rendering pages as images
                        </span>
                      </span>
                    </div>
                    <div className="mt-3">
                      <Segmented
                        value={quality}
                        onChange={setQuality}
                        options={[
                          { value: "low", label: "Light", sub: "Sharp" },
                          { value: "medium", label: "Balanced" },
                          { value: "high", label: "Max", sub: "Smallest" },
                        ]}
                      />
                    </div>
                    <p className="mt-2 text-xs text-slate-500 dark:text-dark-text-muted">
                      {COMPRESS_INFO[quality]}
                    </p>
                    <button
                      type="button"
                      onClick={() => run(exportCompressed)}
                      className="mt-3 inline-flex w-full items-center justify-center rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                    >
                      Compress &amp; download
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ExportRow
                      icon={Contrast}
                      label="Grayscale"
                      hint="Remove all colour"
                      onClick={() => run(exportGrayscale)}
                    />
                    <ExportRow
                      icon={Layers}
                      label="Flatten"
                      hint="Bake in forms & annotations"
                      onClick={() => run(exportFlattened)}
                    />
                    <ExportRow
                      icon={Wrench}
                      label="Repair"
                      hint="Rebuild the file structure"
                      onClick={() => run(exportRepaired)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
