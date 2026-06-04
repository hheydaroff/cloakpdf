// ExtractTool.tsx — Keep only the selected pages (overview mode). The Board is a
// multi-select page grid; the Panel applies the selection via extractPages,
// reducing the working document to those pages (undoable). Selection lives in
// the namespaced tool slice so Board (center) and Panel (right) share it.

import { Check } from "lucide-react";
import { useCallback, useEffect } from "react";
import { extractPages } from "../../utils/pdf-operations.ts";
import { docToFile, remapObjects } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";

export const EXTRACT_ID = "extract-pages";

function readSelected(slice: Record<string, unknown>, pageCount: number): number[] {
  if ((slice.baseCount as number | undefined) !== pageCount) return [];
  return (slice.selected as number[] | undefined) ?? [];
}

export function Board() {
  const { doc } = useEditorRead();
  const { patchToolState } = useEditorActions();
  const slice = useToolSlice(EXTRACT_ID);
  const pageCount = doc?.pageCount ?? 0;
  const selected = readSelected(slice, pageCount);

  // Reset the selection when the page set changes (first open / after Apply).
  useEffect(() => {
    if (!doc) return;
    if ((slice.baseCount as number | undefined) !== doc.pageCount) {
      patchToolState(EXTRACT_ID, { selected: [], baseCount: doc.pageCount });
    }
  }, [doc, slice.baseCount, patchToolState]);

  if (!doc) return null;

  const toggle = (i: number) => {
    const next = selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i];
    patchToolState(EXTRACT_ID, { selected: next, baseCount: pageCount });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 dark:bg-dark-bg p-4 sm:p-6">
      <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {doc.pages.map((page) => {
          const on = selected.includes(page.index);
          return (
            <button
              key={page.index}
              type="button"
              onClick={() => toggle(page.index)}
              aria-pressed={on}
              aria-label={`${on ? "Deselect" : "Select"} page ${page.index + 1}`}
              className={`group relative flex flex-col items-center gap-1.5 rounded-xl border bg-white dark:bg-dark-surface p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                on
                  ? "border-primary-400 ring-1 ring-primary-300"
                  : "border-slate-200 dark:border-dark-border hover:border-primary-300"
              }`}
            >
              {on && (
                <span className="absolute right-3 top-3 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white">
                  <Check className="h-3 w-3" />
                </span>
              )}
              <div
                className={`w-full overflow-hidden rounded-md ring-1 ring-slate-200/70 dark:ring-dark-border ${on ? "" : "opacity-80"}`}
                style={{ aspectRatio: `${page.widthPt} / ${page.heightPt}` }}
              >
                {page.thumbUrl ? (
                  <img
                    src={page.thumbUrl}
                    alt={`Page ${page.index + 1}`}
                    className="h-full w-full object-contain bg-white"
                    draggable={false}
                    loading="lazy"
                  />
                ) : (
                  <div className="h-full w-full bg-white" />
                )}
              </div>
              <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-dark-text-muted">
                {page.index + 1}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Panel() {
  const { doc, busyLabel } = useEditorRead();
  const { patchToolState, applyTransform } = useEditorActions();
  const slice = useToolSlice(EXTRACT_ID);
  const pageCount = doc?.pageCount ?? 0;
  const selected = readSelected(slice, pageCount);
  const busy = busyLabel !== null;

  const apply = useCallback(() => {
    const survivors = [...selected].sort((a, b) => a - b);
    if (survivors.length === 0) return;
    void applyTransform(async (d) => ({
      bytes: await extractPages(docToFile(d), survivors),
      label: `Extract ${survivors.length} pages`,
      objects: remapObjects(d.objects, survivors),
    })).then(() => patchToolState(EXTRACT_ID, { selected: [], baseCount: undefined }));
  }, [selected, applyTransform, patchToolState]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Tap pages to select, then keep only those — the rest are removed (undoable).
      </p>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700 dark:text-dark-text">
          {selected.length} selected
        </span>
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            onClick={() =>
              patchToolState(EXTRACT_ID, {
                selected: Array.from({ length: pageCount }, (_, i) => i),
                baseCount: pageCount,
              })
            }
            className="text-slate-500 hover:text-slate-700 dark:text-dark-text-muted"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => patchToolState(EXTRACT_ID, { selected: [], baseCount: pageCount })}
            className="text-slate-500 hover:text-slate-700 dark:text-dark-text-muted"
          >
            Clear
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={apply}
        disabled={busy || selected.length === 0}
        className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        {busy ? "Working…" : `Keep ${selected.length} page${selected.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
