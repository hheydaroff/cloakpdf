// ExportModal.tsx — The editor's "Export" control: a button that opens a modal
// of output options, each driven off the LIVE document bytes. Replaces the old
// dropdown menu AND absorbs the whole-document "convert then download" tools
// (compress / grayscale / flatten / repair) that used to live on the tool rail
// — they're terminal outputs, not edit steps, so they belong with Export.
//
// One decision, then one button:
//   Format (pick one):  PDF · Images (.zip) · Contact sheet · Split (.zip)
//   Options (PDF only):  Compress (quality) · Grayscale · Flatten · Repair
//                        — independent switches, applied in a fixed, sensible
//                        order (flatten → grayscale → compress → repair) when
//                        you hit Download.
//
// Long-running ops run under the editor's busy overlay via `runTask` (no history
// commit — exports never mutate the working doc). The modal mirrors the app's
// dialog idiom (ChatModelPickerModal): portal, scroll-lock, Escape / backdrop
// dismiss, bottom-sheet on mobile / centered card on desktop.

import {
  Archive,
  Check,
  Contrast,
  Download,
  FileText,
  Image as ImageIcon,
  Layers,
  type LucideIcon,
  LayoutGrid,
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
type Format = "pdf" | "images" | "contact" | "split";

const COMPRESS_INFO: Record<Quality, string> = {
  low: "Sharpest pages, modest size drop (1× render, JPEG 85%).",
  medium: "Balanced size vs quality — suits most documents (1.5× render, JPEG 70%).",
  high: "Smallest file, softest pages (2× render, JPEG 50%).",
};

const FORMATS: { value: Format; icon: LucideIcon; label: string; hint: string }[] = [
  { value: "pdf", icon: FileText, label: "PDF", hint: "The edited document" },
  { value: "images", icon: ImageIcon, label: "Images (.zip)", hint: "Each page as PNG" },
  { value: "contact", icon: LayoutGrid, label: "Contact sheet", hint: "3×3 overview PDF" },
  { value: "split", icon: Scissors, label: "Split pages (.zip)", hint: "One PDF per page" },
];

/** Selectable output-format card (single choice — radio semantics). */
function FormatCard({
  icon: Icon,
  label,
  hint,
  selected,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
        selected
          ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500 dark:border-primary-500 dark:bg-primary-900/20"
          : "border-slate-200 bg-white hover:border-primary-300 hover:bg-slate-50 dark:border-dark-border dark:bg-dark-surface dark:hover:border-primary-700 dark:hover:bg-dark-surface-alt"
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          selected
            ? "bg-primary-600 text-white"
            : "bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400"
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
          {label}
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-dark-text-muted">
          {hint}
        </span>
      </span>
      {selected && <Check className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />}
    </button>
  );
}

/** Accessible on/off switch. */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
        checked ? "bg-primary-600" : "bg-slate-300 dark:bg-dark-border"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/** A toggleable convert option: icon + label + hint + switch, with optional
 *  detail (e.g. compress quality) revealed below when the switch is on. */
function OptionRow({
  icon: Icon,
  label,
  hint,
  checked,
  onChange,
  children,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border transition-colors ${
        checked
          ? "border-primary-300 bg-primary-50/40 dark:border-primary-700 dark:bg-primary-900/10"
          : "border-slate-200 bg-white dark:border-dark-border dark:bg-dark-surface"
      }`}
    >
      <div className="flex items-center gap-3 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
            {label}
          </span>
          <span className="block text-xs text-slate-500 dark:text-dark-text-muted">{hint}</span>
        </span>
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
      {checked && children && (
        <div className="border-t border-slate-200/70 px-3 py-3 dark:border-dark-border">
          {children}
        </div>
      )}
    </div>
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

  // Output selection + modifiers. Modifiers only apply to a PDF output.
  const [format, setFormat] = useState<Format>("pdf");
  const [compress, setCompress] = useState(false);
  const [quality, setQuality] = useState<Quality>("medium");
  const [grayscale, setGrayscale] = useState(false);
  const [flatten, setFlatten] = useState(false);
  const [repair, setRepair] = useState(false);

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

  // Build the final PDF by applying the enabled modifiers in a fixed order:
  // flatten (bake vectors) → grayscale → compress (rasterise) → repair (clean up).
  // Each op takes a File and returns bytes, so we re-wrap between steps.
  const buildPdf = useCallback(async (): Promise<{ bytes: Uint8Array; suffix: string }> => {
    if (!doc) throw new Error("No document");
    const tags: string[] = [];
    let file = docToFile(doc);
    let bytes = doc.bytes;
    const next = (b: Uint8Array) => {
      bytes = b;
      file = new File([b as Uint8Array<ArrayBuffer>], doc.fileName, { type: "application/pdf" });
    };
    if (flatten) {
      next(await flattenPdf(file));
      tags.push("flattened");
    }
    if (grayscale) {
      next(await grayscalePdf(file));
      tags.push("grayscale");
    }
    if (compress) {
      next(await compressPdf(file, quality));
      tags.push("compressed");
    }
    if (repair) {
      next(await repairPdf(file));
      tags.push("repaired");
    }
    return { bytes, suffix: tags.length ? `_${tags.join("-")}` : "_edited" };
  }, [doc, flatten, grayscale, compress, repair, quality]);

  const handleDownload = useCallback(() => {
    if (!doc) return;
    setOpen(false);

    if (format === "images") {
      void runTask("Rendering images…", async () => {
        const indices = Array.from({ length: doc.pageCount }, (_, i) => i);
        const rendered = await renderPagesToBlobs(docToFile(doc), indices, IMAGE_DPI, "image/png");
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
      return;
    }

    if (format === "contact") {
      void runTask("Building contact sheet…", async () => {
        const bytes = await nupPages(docToFile(doc), "3x3");
        downloadPdf(bytes, pdfFilename(doc.fileName, "_contact-sheet"));
      });
      return;
    }

    if (format === "split") {
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
      return;
    }

    // PDF — fast path when no modifiers are on (no overlay flash).
    if (!(compress || grayscale || flatten || repair)) {
      downloadPdf(doc.bytes, pdfFilename(doc.fileName, "_edited"));
      return;
    }
    void runTask("Exporting…", async () => {
      const { bytes, suffix } = await buildPdf();
      downloadPdf(bytes, pdfFilename(doc.fileName, suffix));
    });
  }, [doc, format, compress, grayscale, flatten, repair, baseName, runTask, buildPdf]);

  const isPdf = format === "pdf";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!doc || busy}
        aria-haspopup="dialog"
        className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        <Download className="h-4 w-4" />
        <span className="hidden sm:inline">Export</span>
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
              <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
                <div className="flex flex-col gap-2">
                  <SectionLabel>Format</SectionLabel>
                  <div
                    role="radiogroup"
                    aria-label="Export format"
                    className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                  >
                    {FORMATS.map((f) => (
                      <FormatCard
                        key={f.value}
                        icon={f.icon}
                        label={f.label}
                        hint={f.hint}
                        selected={format === f.value}
                        onSelect={() => setFormat(f.value)}
                      />
                    ))}
                  </div>
                </div>

                {isPdf && (
                  <div className="flex flex-col gap-2">
                    <SectionLabel>Options</SectionLabel>
                    <OptionRow
                      icon={Archive}
                      label="Compress"
                      hint="Shrink by re-rendering pages as images"
                      checked={compress}
                      onChange={setCompress}
                    >
                      <Segmented
                        value={quality}
                        onChange={setQuality}
                        options={[
                          { value: "low", label: "Light", sub: "Sharp" },
                          { value: "medium", label: "Balanced" },
                          { value: "high", label: "Max", sub: "Smallest" },
                        ]}
                      />
                      <p className="mt-2 text-xs text-slate-500 dark:text-dark-text-muted">
                        {COMPRESS_INFO[quality]}
                      </p>
                    </OptionRow>
                    <OptionRow
                      icon={Contrast}
                      label="Grayscale"
                      hint="Remove all colour"
                      checked={grayscale}
                      onChange={setGrayscale}
                    />
                    <OptionRow
                      icon={Layers}
                      label="Flatten"
                      hint="Bake in forms & annotations"
                      checked={flatten}
                      onChange={setFlatten}
                    />
                    <OptionRow
                      icon={Wrench}
                      label="Repair"
                      hint="Rebuild the file structure"
                      checked={repair}
                      onChange={setRepair}
                    />
                  </div>
                )}
              </div>

              {/* Footer — the single action. */}
              <div className="shrink-0 border-t border-slate-200/70 px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] dark:border-dark-border">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={!doc || busy}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
