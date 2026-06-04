// RemoveBlankTool.tsx — Auto-detect near-blank pages and remove them. Scores
// every page's whiteness when the tool opens (renderThumbnailsAndScores), lists
// the blank candidates, and deletes them via deletePages. Panel-only; the
// overview browse grid stays visible beside it so the user can eyeball the doc.

import { useEffect, useState } from "react";
import { deletePages } from "../../utils/pdf-operations.ts";
import { renderThumbnailsAndScores, revokeThumbnails } from "../../utils/pdf-renderer.ts";
import { docToFile, remapObjects } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";

// Fraction of near-white pixels above which a page is treated as blank. High so
// pages with a faint header/footer aren't swept up.
const BLANK_THRESHOLD = 0.995;

export function Panel() {
  const { doc, busyLabel } = useEditorRead();
  const { applyTransform } = useEditorActions();
  const [blanks, setBlanks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!doc) return;
    setBlanks(null);
    let live = true;
    void renderThumbnailsAndScores(docToFile(doc)).then(
      ({ thumbnails, scores }) => {
        revokeThumbnails(thumbnails);
        if (live)
          setBlanks(scores.map((s, i) => (s >= BLANK_THRESHOLD ? i : -1)).filter((i) => i >= 0));
      },
      () => live && setBlanks([]),
    );
    return () => {
      live = false;
    };
  }, [doc]);

  const busy = busyLabel !== null;
  const count = blanks?.length ?? 0;

  const apply = () => {
    if (!blanks || blanks.length === 0) return;
    const toDelete = new Set(blanks);
    void applyTransform(async (d) => {
      const survivors = d.pages.map((p) => p.index).filter((i) => !toDelete.has(i));
      return {
        bytes: await deletePages(docToFile(d), blanks),
        label: `Remove ${blanks.length} blank pages`,
        objects: remapObjects(d.objects, survivors),
      };
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Find and remove pages that are (nearly) empty.
      </p>

      {blanks === null ? (
        <p className="text-sm text-slate-400 dark:text-dark-text-muted">Scanning pages…</p>
      ) : count === 0 ? (
        <p className="text-sm text-slate-500 dark:text-dark-text-muted">No blank pages detected.</p>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface p-3 text-sm">
          <p className="font-medium text-slate-800 dark:text-dark-text">
            {count} blank page{count === 1 ? "" : "s"} found
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-dark-text-muted">
            Pages {blanks.map((i) => i + 1).join(", ")}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={apply}
        disabled={busy || count === 0}
        className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40"
      >
        {busy ? "Working…" : `Remove ${count} blank page${count === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
