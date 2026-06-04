// OverviewGrid.tsx — Overview mode: a responsive grid of every page for
// browsing. Clicking a page selects it and drops into focus mode. Page-board
// editing (reorder / rotate / delete / extract) lands in M2 with the
// organize-pages tool; M0 ships read-only browse + jump-to-focus.

import { useEditorActions, useEditorRead } from "./EditorContext.tsx";

export function OverviewGrid() {
  const { doc, selectedPage } = useEditorRead();
  const { setSelectedPage, setViewMode } = useEditorActions();

  if (!doc) return null;

  const open = (index: number) => {
    setSelectedPage(index);
    setViewMode("focus");
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 dark:bg-dark-bg p-4 sm:p-6">
      <div className="mx-auto grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {doc.pages.map((page) => {
          const active = page.index === selectedPage;
          return (
            <button
              key={page.index}
              type="button"
              onClick={() => open(page.index)}
              aria-label={`Open page ${page.index + 1}`}
              aria-current={active}
              className={`group relative flex flex-col items-center gap-1.5 rounded-xl border bg-white dark:bg-dark-surface p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                active
                  ? "border-primary-400 ring-1 ring-primary-300"
                  : "border-slate-200 dark:border-dark-border hover:border-primary-300"
              }`}
            >
              <div
                className="w-full overflow-hidden rounded-md ring-1 ring-slate-200/70 dark:ring-dark-border"
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
