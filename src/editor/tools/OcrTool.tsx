// OcrTool.tsx — Make a scanned / image-only PDF searchable in place. Reads
// digital pages from the text layer (layout-aware, via liteparse) and OCRs
// scanned pages with Tesseract, then burns an invisible, correctly-positioned
// text layer over the original pages via createSearchablePdfFromLayout — so the
// page visuals are untouched but the text becomes selectable & searchable (and
// the editor's own PII auto-detect can then find it). Falls back to the proven
// Tesseract-only path if the layout parse comes back empty. Panel-only.
//
// Desktop-only: the OCR engine + page rasterisation need more memory than a
// phone provides, mirroring the standalone OCR tool's `desktopOnly` flag. The
// editor smoke only mounts this panel (asserting it's wired) — it never runs
// the engine, which would download model weights.

import { Loader2, ScanText } from "lucide-react";
import { useState } from "react";
import { extractLayout, layoutToReadingOrderText } from "../../utils/layout-extract.ts";
import {
  createSearchablePdf,
  createSearchablePdfFromLayout,
  extractTextOcr,
} from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";

const LANGUAGES = [
  { code: "auto", label: "Auto detect" },
  { code: "eng", label: "English" },
  { code: "ara", label: "Arabic" },
  { code: "chi_sim", label: "Chinese" },
  { code: "nld", label: "Dutch" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "hin", label: "Hindi" },
  { code: "ita", label: "Italian" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "por", label: "Portuguese" },
  { code: "rus", label: "Russian" },
  { code: "spa", label: "Spanish" },
] as const;

export function Panel() {
  const { busyLabel, layout } = useEditorRead();
  const { applyTransform } = useEditorActions();
  const [language, setLanguage] = useState("auto");
  const [progress, setProgress] = useState<string | null>(null);
  const busy = busyLabel !== null;

  if (layout === "mobile") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-500 dark:text-dark-text-muted">
          OCR runs a text-recognition engine on-device and needs more memory than a phone provides.
        </p>
        <p className="text-sm text-slate-500 dark:text-dark-text-muted">
          Open this PDF on a desktop to make it searchable.
        </p>
      </div>
    );
  }

  const apply = () => {
    setProgress("Analysing pages…");
    void applyTransform(async (d) => {
      const lang = language === "auto" ? "eng" : language;
      let bytes: Uint8Array;
      try {
        const layoutPages = await extractLayout(docToFile(d), {
          language: lang,
          onOcrPage: (done, total) => setProgress(`Recognising page ${done} / ${total}…`),
        });
        const dense = layoutPages
          .map((p) => layoutToReadingOrderText(p))
          .join("")
          .replace(/\s+/g, "").length;
        // liteparse can resolve empty on an image-only page it didn't flag as
        // scanned — treat that as a miss so the Tesseract-only path still runs.
        if (dense === 0) throw new Error("empty-layout");
        setProgress("Building searchable layer…");
        bytes = await createSearchablePdfFromLayout(docToFile(d), layoutPages);
      } catch {
        setProgress("Recognising text…");
        const pageTexts = await extractTextOcr(docToFile(d), language, (done, total) =>
          setProgress(`Recognising page ${done} / ${total}…`),
        );
        bytes = await createSearchablePdf(docToFile(d), pageTexts);
      }
      return { bytes, label: "OCR — searchable text" };
    }).finally(() => setProgress(null));
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Add an invisible text layer so a scanned PDF becomes selectable and searchable. The page
        visuals stay exactly as they are.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-dark-text-muted">
          Language
        </span>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          disabled={busy}
          className="w-full rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-1.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={apply}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanText className="h-4 w-4" />}
        {busy ? "Working…" : "Make searchable"}
      </button>

      {progress && (
        <p role="status" className="text-xs text-slate-500 dark:text-dark-text-muted">
          {progress}
        </p>
      )}
      <p className="text-xs text-slate-400 dark:text-dark-text-muted">
        Digital pages read instantly. Scanned pages download a one-time OCR engine (~10–15 MB), then
        recognise on-device — nothing leaves your browser.
      </p>
    </div>
  );
}
