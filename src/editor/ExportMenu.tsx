// ExportMenu.tsx — The editor's primary "Export" control. Replaces the single
// "_edited.pdf" download with a small menu of output formats, each driven off
// the LIVE document bytes:
//   • PDF            — the edited document (downloadPdf).
//   • Images (.zip)  — every page rasterised to PNG, zipped (renderPagesToBlobs).
//   • Contact sheet  — a 3×3 n-up overview PDF (nupPages).
//   • Split (.zip)   — one single-page PDF per page, zipped (splitPdfIntoParts).
// Long-running formats run under the editor's busy overlay via `runTask` (no
// history commit — exports never mutate the doc). The popover mirrors the app's
// ColorPicker dismissal idiom (click-outside / Escape).

import { ChevronDown, FileText, Image as ImageIcon, LayoutGrid, Scissors } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadBlob, downloadPdf, pdfFilename } from "../utils/file-helpers.ts";
import { nupPages, splitPdfIntoParts } from "../utils/pdf-operations.ts";
import { renderPagesToBlobs } from "../utils/pdf-renderer.ts";
import { docToFile } from "./doc.ts";
import { useEditorActions, useEditorRead } from "./EditorContext.tsx";

const IMAGE_DPI = 150;

export function ExportMenu() {
  const { doc, busyLabel } = useEditorRead();
  const { runTask } = useEditorActions();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const busy = busyLabel !== null;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const baseName = doc ? doc.fileName.replace(/\.pdf$/i, "") : "document";

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
      const file = docToFile(doc);
      const bytes = await nupPages(file, "3x3");
      downloadPdf(bytes, pdfFilename(doc.fileName, "_contact-sheet"));
    });
  }, [doc, runTask]);

  const exportSplit = useCallback(() => {
    if (!doc) return;
    void runTask("Splitting pages…", async () => {
      const file = docToFile(doc);
      const parts = Array.from({ length: doc.pageCount }, (_, i) => [i]);
      const pdfs = await splitPdfIntoParts(file, parts);
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      pdfs.forEach((bytes, i) => {
        zip.file(`${baseName}_p${String(i + 1).padStart(3, "0")}.pdf`, bytes);
      });
      downloadBlob(await zip.generateAsync({ type: "blob" }), `${baseName}_pages.zip`);
    });
  }, [doc, baseName, runTask]);

  const ITEMS = [
    { icon: FileText, label: "PDF", hint: "The edited document", onClick: exportPdf },
    { icon: ImageIcon, label: "Images (.zip)", hint: "Each page as PNG", onClick: exportImages },
    {
      icon: LayoutGrid,
      label: "Contact sheet",
      hint: "3×3 overview PDF",
      onClick: exportContactSheet,
    },
    { icon: Scissors, label: "Split pages (.zip)", hint: "One PDF per page", onClick: exportSplit },
  ] as const;

  return (
    <div className="relative ml-1" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!doc || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        <span className="hidden sm:inline">Export</span>
        <ChevronDown className="h-4 w-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-60 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface shadow-xl"
        >
          <p className="px-3 pt-2.5 pb-1 text-xxs font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
            Export as
          </p>
          {ITEMS.map(({ icon: Icon, label, hint, onClick }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              aria-label={label}
              onClick={() => {
                setOpen(false);
                onClick();
              }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:bg-slate-50 dark:focus-visible:bg-dark-surface-alt"
            >
              <Icon className="h-4 w-4 shrink-0 text-slate-400 dark:text-dark-text-muted" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-700 dark:text-dark-text">
                  {label}
                </span>
                <span className="block text-tag text-slate-400 dark:text-dark-text-muted">
                  {hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
