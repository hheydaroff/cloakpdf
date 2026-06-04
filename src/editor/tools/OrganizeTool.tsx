// OrganizeTool.tsx — The unified page-board tool (overview mode). The Board
// renders an editable grid of every page: drag to reorder, rotate, or mark for
// deletion. The Panel summarises the pending plan, offers quick actions, and
// applies it via `assemblePdf` (one pass, all ops). Because every page op
// reduces to a mutation of `order` + `deleted` + `rotations`, this tool absorbs
// what used to be four separate tools:
//   • Reverse      → reverse the `order` array
//   • Remove-blank → auto-detect near-blank pages, mark them deleted
//   • Extract      → "Delete all", then restore the few pages to keep
//   • (rotate/reorder/delete are the board's native gestures)
// N-up stays separate — it composites pages onto new sheets, not a reorder.
// All working state lives in the namespaced tool slice so the Board (center)
// and Panel (right) share it and it survives re-selection. See REDESIGN.md.

import { FileX, Repeat2, RotateCw, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { assemblePdf, type AssembleOp } from "../../utils/pdf-operations.ts";
import { renderThumbnailsAndScores, revokeThumbnails } from "../../utils/pdf-renderer.ts";
import { type CanvasObject, docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";

export const ORGANIZE_ID = "organize-pages";

// Fraction of near-white pixels above which a page is treated as blank. High so
// a faint header/footer isn't swept up. (Absorbed from the old Remove-blank.)
const BLANK_THRESHOLD = 0.995;

interface OrganizeState {
  /** Original page indices, in display (output) order. */
  order: number[];
  /** Original page index → extra clockwise rotation in degrees. */
  rotations: Record<number, number>;
  /** Original page indices marked for deletion. */
  deleted: number[];
  /** Page count the state was initialised against (drives auto-reset). */
  baseCount: number;
}

function readState(slice: Record<string, unknown>, pageCount: number): OrganizeState {
  const order = (slice.order as number[] | undefined) ?? null;
  if (!order || (slice.baseCount as number | undefined) !== pageCount) {
    return {
      order: Array.from({ length: pageCount }, (_, i) => i),
      rotations: {},
      deleted: [],
      baseCount: pageCount,
    };
  }
  return {
    order,
    rotations: (slice.rotations as Record<number, number>) ?? {},
    deleted: (slice.deleted as number[]) ?? [],
    baseCount: pageCount,
  };
}

// ── Board (center, overview mode) ────────────────────────────────────

export function Board() {
  const { doc, view } = useEditorRead();
  const { patchToolState } = useEditorActions();
  const slice = useToolSlice(ORGANIZE_ID);
  const dragFrom = useRef<number | null>(null);

  const pageCount = doc?.pageCount ?? 0;
  const state = readState(slice, pageCount);

  // Auto-initialise / reset whenever the page count changes (first open, or
  // after an Apply rebuilds the doc).
  useEffect(() => {
    if (!doc) return;
    if ((slice.baseCount as number | undefined) !== doc.pageCount) {
      patchToolState(ORGANIZE_ID, {
        order: Array.from({ length: doc.pageCount }, (_, i) => i),
        rotations: {},
        deleted: [],
        baseCount: doc.pageCount,
      });
    }
  }, [doc, slice.baseCount, patchToolState]);

  if (!doc) return null;

  const rotate = (origIdx: number) => {
    const next = { ...state.rotations, [origIdx]: ((state.rotations[origIdx] ?? 0) + 90) % 360 };
    patchToolState(ORGANIZE_ID, { rotations: next });
  };
  const toggleDelete = (origIdx: number) => {
    const next = state.deleted.includes(origIdx)
      ? state.deleted.filter((i) => i !== origIdx)
      : [...state.deleted, origIdx];
    patchToolState(ORGANIZE_ID, { deleted: next });
  };
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const order = [...state.order];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    patchToolState(ORGANIZE_ID, { order });
  };

  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto bg-slate-100 dark:bg-dark-bg p-4 sm:p-6">
      <div
        className="mx-auto grid max-w-5xl gap-3"
        style={{ gridTemplateColumns: `repeat(${view.gridCols}, minmax(0, 1fr))` }}
      >
        {state.order.map((origIdx, pos) => {
          const page = doc.pages[origIdx];
          if (!page) return null;
          const rot = state.rotations[origIdx] ?? 0;
          const del = state.deleted.includes(origIdx);
          return (
            <div
              key={origIdx}
              draggable
              onDragStart={() => {
                dragFrom.current = pos;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null) reorder(dragFrom.current, pos);
                dragFrom.current = null;
              }}
              className={`group relative flex flex-col items-center gap-1.5 rounded-xl border bg-white dark:bg-dark-surface p-2 transition-opacity ${
                del ? "opacity-40" : ""
              } border-slate-200 dark:border-dark-border`}
            >
              <div
                className="flex w-full items-center justify-center overflow-hidden rounded-md ring-1 ring-slate-200/70 dark:ring-dark-border"
                style={{ aspectRatio: `${page.widthPt} / ${page.heightPt}` }}
              >
                {page.thumbUrl ? (
                  <img
                    src={page.thumbUrl}
                    alt={`Page ${origIdx + 1}`}
                    className="h-full w-full object-contain bg-white transition-transform"
                    style={{ transform: `rotate(${rot}deg)` }}
                    draggable={false}
                    loading="lazy"
                  />
                ) : (
                  <div className="h-full w-full bg-white" />
                )}
              </div>
              <div className="flex w-full items-center justify-between px-0.5">
                <span className="text-xs font-medium tabular-nums text-slate-500 dark:text-dark-text-muted">
                  {origIdx + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => rotate(origIdx)}
                    aria-label={`Rotate page ${origIdx + 1}`}
                    className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleDelete(origIdx)}
                    aria-label={`${del ? "Restore" : "Delete"} page ${origIdx + 1}`}
                    aria-pressed={del}
                    className={`flex h-6 w-6 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                      del
                        ? "text-primary-600"
                        : "text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-dark-surface-alt"
                    }`}
                  >
                    {del ? <Undo2 className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Panel (right) ────────────────────────────────────────────────────

/** A compact secondary action button, on-system (slate border, primary focus). */
function QuickAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Repeat2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-2 text-xs font-medium text-slate-600 dark:text-dark-text-muted hover:border-primary-300 hover:text-primary-700 disabled:opacity-40 disabled:hover:border-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

export function Panel() {
  const { doc } = useEditorRead();
  const { patchToolState, applyTransform } = useEditorActions();
  const slice = useToolSlice(ORGANIZE_ID);
  const pageCount = doc?.pageCount ?? 0;
  const state = readState(slice, pageCount);

  const [blanks, setBlanks] = useState<number[] | null>(null);
  const [scanning, setScanning] = useState(false);

  // Drop stale blank-scan results whenever the page set changes (after Apply).
  useEffect(() => {
    setBlanks(null);
  }, [pageCount]);

  const kept = state.order.filter((i) => !state.deleted.includes(i));
  const rotatedCount = Object.values(state.rotations).filter((d) => d % 360 !== 0).length;
  const reordered = state.order.some((v, i) => v !== i);
  const dirty = state.deleted.length > 0 || rotatedCount > 0 || reordered;
  const allDeleted = kept.length === 0;

  // ── Absorbed page-ops: reverse / extract / remove-blank ──────────────
  const reverse = () => patchToolState(ORGANIZE_ID, { order: [...state.order].reverse() });
  const deleteAll = () => patchToolState(ORGANIZE_ID, { deleted: [...state.order] });
  const restoreAll = () => patchToolState(ORGANIZE_ID, { deleted: [] });

  const findBlanks = () => {
    if (!doc) return;
    setScanning(true);
    void renderThumbnailsAndScores(docToFile(doc)).then(
      ({ thumbnails, scores }) => {
        revokeThumbnails(thumbnails);
        setBlanks(scores.map((s, i) => (s >= BLANK_THRESHOLD ? i : -1)).filter((i) => i >= 0));
        setScanning(false);
      },
      () => {
        setBlanks([]);
        setScanning(false);
      },
    );
  };

  const markBlanks = () => {
    if (!blanks || blanks.length === 0) return;
    patchToolState(ORGANIZE_ID, { deleted: [...new Set([...state.deleted, ...blanks])] });
  };

  const reset = useCallback(() => {
    patchToolState(ORGANIZE_ID, {
      order: Array.from({ length: pageCount }, (_, i) => i),
      rotations: {},
      deleted: [],
      baseCount: pageCount,
    });
  }, [patchToolState, pageCount]);

  const apply = useCallback(() => {
    void applyTransform(async (d) => {
      const order = (slice.order as number[] | undefined) ?? d.pages.map((p) => p.index);
      const deleted = (slice.deleted as number[] | undefined) ?? [];
      const rotations = (slice.rotations as Record<number, number> | undefined) ?? {};
      const survivors = order.filter((i) => !deleted.includes(i));
      const ops: AssembleOp[] = survivors.map((i) => ({
        kind: "page",
        sourceIndex: 0,
        pageIndex: i,
        rotation: rotations[i] ?? 0,
      }));
      const bytes = await assemblePdf([d.bytes], ops);
      // Remap surviving overlay objects to their new page index; drop objects on
      // deleted or rotated pages (rotation invalidates their fraction coords).
      const newIndex = new Map<number, number>();
      survivors.forEach((origIdx, pos) => newIndex.set(origIdx, pos));
      const objects: CanvasObject[] = d.objects
        .filter((o) => newIndex.has(o.pageIndex) && !(rotations[o.pageIndex] % 360))
        .map((o) => ({ ...o, pageIndex: newIndex.get(o.pageIndex)! }));
      return { bytes, label: "Organize pages", objects };
    });
  }, [applyTransform, slice]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-500 dark:text-dark-text-muted">
        Drag pages to reorder, rotate, or mark for deletion. Changes preview live and apply all at
        once.
      </p>

      <div className="rounded-xl border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface p-3 text-sm text-slate-600 dark:text-dark-text-muted">
        <div className="flex justify-between">
          <span>Output pages</span>
          <span className="font-medium tabular-nums text-slate-800 dark:text-dark-text">
            {kept.length} / {pageCount}
          </span>
        </div>
        {rotatedCount > 0 && (
          <div className="mt-1 flex justify-between">
            <span>Rotated</span>
            <span className="tabular-nums">{rotatedCount}</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
          Quick actions
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <QuickAction icon={Repeat2} label="Reverse order" onClick={reverse} />
          {allDeleted ? (
            <QuickAction icon={Undo2} label="Restore all" onClick={restoreAll} />
          ) : (
            <QuickAction icon={Trash2} label="Delete all" onClick={deleteAll} />
          )}
        </div>
        {blanks === null ? (
          <QuickAction
            icon={FileX}
            label={scanning ? "Scanning…" : "Find blank pages"}
            onClick={findBlanks}
            disabled={scanning}
          />
        ) : blanks.length === 0 ? (
          <p className="rounded-lg bg-slate-50 dark:bg-dark-bg px-2.5 py-2 text-xs text-slate-500 dark:text-dark-text-muted">
            No blank pages found.
          </p>
        ) : (
          <QuickAction
            icon={FileX}
            label={`Delete ${blanks.length} blank page${blanks.length === 1 ? "" : "s"}`}
            onClick={markBlanks}
          />
        )}
        <p className="text-tag text-slate-400 dark:text-dark-text-muted">
          To keep only a few pages, “Delete all” then restore the ones you want.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={!dirty || kept.length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          Apply changes
        </button>
        {dirty && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-slate-500 hover:text-slate-700 dark:text-dark-text-muted dark:hover:text-dark-text"
          >
            Reset pending changes
          </button>
        )}
      </div>
    </div>
  );
}
