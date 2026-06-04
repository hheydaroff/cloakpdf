// BookmarksTool.tsx — Build a PDF outline (the viewer's bookmarks panel). The
// user adds {title → target page} rows — "Add current page" pre-fills the page
// you're looking at — and Apply embeds them via addPdfBookmarks, which also
// flips the document to open its bookmarks panel by default. Panel-only (no
// canvas interaction); identical on desktop + mobile. A focused subset of the
// standalone Add Bookmarks tool (manual entry; no heading auto-detect).

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { addPdfBookmarks } from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";

interface Row {
  id: number;
  title: string;
  page: string;
}

let rowSeq = 0;
const newRow = (page: number): Row => ({ id: rowSeq++, title: "", page: String(page) });

export function Panel() {
  const { doc, selectedPage, busyLabel } = useEditorRead();
  const { applyTransform } = useEditorActions();
  const pageCount = doc?.pageCount ?? 1;
  const [rows, setRows] = useState<Row[]>(() => [newRow(1)]);

  const busy = busyLabel !== null;
  const validCount = rows.filter((r) => r.title.trim()).length;

  const update = (id: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: number) => setRows((prev) => prev.filter((r) => r.id !== id));

  const apply = () => {
    const entries = rows
      .filter((r) => r.title.trim())
      .map((r) => ({
        title: r.title.trim(),
        pageIndex: Math.max(0, Math.min((parseInt(r.page, 10) || 1) - 1, pageCount - 1)),
      }));
    if (entries.length === 0) return;
    void applyTransform(async (d) => ({
      bytes: await addPdfBookmarks(docToFile(d), entries),
      label: `Add ${entries.length} bookmark${entries.length === 1 ? "" : "s"}`,
    }));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Add named bookmarks that jump to a page. They show in the viewer's outline panel.
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-1.5">
            <input
              type="text"
              value={r.title}
              placeholder="Bookmark title"
              onChange={(e) => update(r.id, { title: e.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-1.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            />
            <input
              type="number"
              min={1}
              max={pageCount}
              value={r.page}
              aria-label="Target page"
              onChange={(e) => update(r.id, { page: e.target.value })}
              className="w-14 rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2 py-1.5 text-sm tabular-nums text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            />
            <button
              type="button"
              onClick={() => remove(r.id)}
              aria-label="Remove bookmark"
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setRows((prev) => [...prev, newRow(selectedPage + 1)])}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 dark:border-dark-border px-3 py-2 text-sm text-slate-500 dark:text-dark-text-muted hover:border-primary-400 hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      >
        <Plus className="h-4 w-4" />
        Add current page (page {selectedPage + 1})
      </button>

      <button
        type="button"
        onClick={apply}
        disabled={busy || validCount === 0}
        className="inline-flex items-center justify-center rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        {busy ? "Working…" : `Add ${validCount} bookmark${validCount === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
