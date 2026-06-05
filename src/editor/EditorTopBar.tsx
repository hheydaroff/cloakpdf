// EditorTopBar.tsx — The editor's top chrome, laid out as three grid zones so
// the centre never drifts:
//   • left   — back, logo, file pill (desktop), and (desktop) the page stepper
//              hugging the right edge so it sits just left of centre.
//   • centre — desktop: the page-density toggle, pinned to the true middle
//              (grid-cols-[1fr_auto_1fr]) so it no longer shifts when the zoom
//              group shows/hides. mobile: the page stepper (centred).
//   • right  — undo/redo/(reset desktop), zoom (desktop focus), Export.
// On mobile the file pill, logo, density toggle and zoom buttons collapse (no
// room); view mode is driven by the tool you pick, and zoom is pinch-to-zoom.

import {
  ChevronLeft,
  Grid2x2,
  Grid3x3,
  Maximize2,
  Redo2,
  RotateCcw,
  Square,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { PagePreviewNav } from "../components/PagePreviewNav.tsx";
import { useEditorActions, useEditorRead } from "./EditorContext.tsx";
import { ExportMenu } from "./ExportMenu.tsx";
import { DEFAULT_VIEW } from "./types.ts";

// Page-density options for the view control: single page (focus, editable) vs
// a 2- or 3-column browse grid. The active icon reflects the current density.
const DENSITIES = [
  { cols: 1, icon: Square, label: "Single page" },
  { cols: 2, icon: Grid2x2, label: "2-column grid" },
  { cols: 3, icon: Grid3x3, label: "3-column grid" },
] as const;

const ICON_BTN =
  "flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-dark-text-muted dark:hover:bg-dark-surface-alt dark:hover:text-dark-text disabled:opacity-30 disabled:pointer-events-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500";

export function EditorTopBar() {
  const { doc, viewMode, view, selectedPage, canUndo, canRedo, canReset, layout } = useEditorRead();
  const { exit, setViewMode, setView, setSelectedPage, undo, redo, reset } = useEditorActions();
  const isMobile = layout === "mobile";

  const zoomPct = Math.round(view.zoom * 100);

  // Density: 1 column === focus (single editable page); >1 === overview grid.
  const activeCols = viewMode === "focus" ? 1 : view.gridCols;
  const setDensity = (cols: number) => {
    if (cols === 1) {
      setViewMode("focus");
    } else {
      setView((v) => ({ ...v, gridCols: cols }));
      setViewMode("overview");
    }
  };

  // Page prev/next — focus mode only (in overview you page by tapping a thumb).
  // Returns null for single-page docs. One stepper, shown left-of-centre on
  // desktop and dead-centre on mobile (see zones below).
  const pageStepper =
    doc && viewMode === "focus" ? (
      <PagePreviewNav
        page={selectedPage}
        total={doc.pageCount}
        onChange={setSelectedPage}
        size={isMobile ? "touch" : "sm"}
      />
    ) : null;

  const densityToggle =
    doc && doc.pageCount > 1 ? (
      <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface p-0.5">
        {DENSITIES.map(({ cols, icon: Icon, label }) => {
          const on = activeCols === cols;
          return (
            <button
              key={cols}
              type="button"
              onClick={() => setDensity(cols)}
              aria-label={label}
              aria-pressed={on}
              title={label}
              className={`flex h-7 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                on
                  ? "bg-primary-600 text-white"
                  : "text-slate-500 hover:text-slate-800 dark:text-dark-text-muted dark:hover:text-dark-text"
              }`}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <header
      className={`grid h-16 shrink-0 items-center overflow-x-clip border-b border-slate-200/70 dark:border-dark-border bg-slate-50/90 dark:bg-dark-surface/90 px-3 ${
        isMobile ? "grid-cols-[auto_1fr_auto]" : "grid-cols-[1fr_auto_1fr]"
      }`}
    >
      {/* LEFT zone */}
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" onClick={exit} className={ICON_BTN} aria-label="Back to home">
          <ChevronLeft className="h-5 w-5" />
        </button>

        {!isMobile && (
          <img
            src="/icons/favicon.svg"
            alt=""
            width="28"
            height="28"
            className="h-7 w-7 drop-shadow-sm"
          />
        )}

        {doc && !isMobile && (
          <div className="ml-1 flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface px-3 py-1.5">
            <span className="max-w-50 truncate text-sm font-medium text-slate-700 dark:text-dark-text">
              {doc.fileName}
            </span>
            <span className="text-xs tabular-nums text-slate-400 dark:text-dark-text-muted">
              · {doc.pageCount} {doc.pageCount === 1 ? "page" : "pages"}
            </span>
          </div>
        )}

        {/* Desktop: the page stepper hugs the right edge of the left zone, so it
            sits just left of the dead-centre density toggle and its show/hide
            (focus↔overview) never nudges the toggle. */}
        {!isMobile && pageStepper && <div className="ml-auto pl-2">{pageStepper}</div>}
      </div>

      {/* CENTRE zone — desktop: density toggle (true middle); mobile: page stepper. */}
      <div className="flex items-center justify-center gap-2">
        {isMobile ? pageStepper : densityToggle}
      </div>

      {/* RIGHT zone */}
      <div className="flex items-center justify-self-end">
        <div className="flex items-center">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className={ICON_BTN}
            aria-label="Undo"
          >
            <Undo2 className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className={ICON_BTN}
            aria-label="Redo"
          >
            <Redo2 className="h-5 w-5" />
          </button>
          {!isMobile && (
            <button
              type="button"
              onClick={reset}
              disabled={!canReset}
              className={ICON_BTN}
              aria-label="Reset to original"
            >
              <RotateCcw className="h-5 w-5" />
            </button>
          )}
        </div>

        {viewMode === "focus" && !isMobile && (
          <div className="ml-1 flex items-center gap-1 rounded-lg border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface px-1">
            <button
              type="button"
              onClick={() => setView((v) => ({ ...v, zoom: Math.max(0.2, v.zoom / 1.2) }))}
              className={ICON_BTN}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-11 text-center text-xs font-medium tabular-nums text-slate-600 dark:text-dark-text-muted">
              {zoomPct}%
            </span>
            <button
              type="button"
              onClick={() => setView((v) => ({ ...v, zoom: Math.min(8, v.zoom * 1.2) }))}
              className={ICON_BTN}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setView((v) => ({ ...DEFAULT_VIEW, gridCols: v.gridCols }))}
              className={ICON_BTN}
              aria-label="Fit to screen"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        )}

        <ExportMenu />
      </div>
    </header>
  );
}
