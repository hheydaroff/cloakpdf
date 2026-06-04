/**
 * Organize Pages tool — the unified visual page manager.
 *
 * One thumbnail canvas that folds together what used to take five
 * separate tools: drag to reorder, rotate / duplicate / delete each
 * page in place, insert blank pages, and splice in pages from other
 * PDFs. The working state is a flat list of "slots" (one per output
 * page); pressing Apply turns that list into an `assemblePdf` plan.
 *
 * Per-card actions are always visible (not hover-only) so the tool works
 * the same under touch and mouse. Pointer drag reorders from anywhere on
 * a card; the grip handle carries the keyboard-reorder path.
 */

import { Copy, File, FileInput, FilePlus, GripHorizontal, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { ResetButton } from "../components/ResetButton.tsx";
import { SortableGrid } from "../components/SortableGrid.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useSortableDrag } from "../hooks/useSortableDrag.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { type AssembleOp, assemblePdf } from "../utils/pdf-operations.ts";
import { renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";

/** A loaded source PDF whose pages can be drawn into the canvas. */
interface Source {
  file: File;
  /** Per-page thumbnail blob URLs. */
  thumbs: string[];
  /** Short tag (A, B, C…) shown on spliced-in pages. */
  tag: string;
}

/** One output page in the working canvas. */
type Slot =
  | { uid: string; kind: "page"; srcIndex: number; page: number; rot: number }
  | { uid: string; kind: "blank"; rot: number; width: number; height: number };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export default function OrganizePages() {
  const [sources, setSources] = useState<Source[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const uidRef = useRef(0);
  const nextUid = useCallback(() => `slot-${uidRef.current++}`, []);

  // Mirror sources in a ref so onReset can revoke every thumbnail —
  // including spliced-in PDFs — without being recreated each render.
  const sourcesRef = useRef<Source[]>([]);
  sourcesRef.current = sources;

  const pdf = usePdfFile<true>({
    load: async (file) => {
      const thumbs = await renderAllThumbnails(file);
      setSources([{ file, thumbs, tag: LETTERS[0] }]);
      setSlots(
        thumbs.map((_, i) => ({ uid: nextUid(), kind: "page", srcIndex: 0, page: i, rot: 0 })),
      );
      return true;
    },
    onReset: () => {
      for (const s of sourcesRef.current) revokeThumbnails(s.thumbs);
      setSources([]);
      setSlots([]);
    },
  });
  const task = useAsyncProcess();
  const addTask = useAsyncProcess();
  const output = useToolOutput();
  const addInputRef = useRef<HTMLInputElement>(null);

  // ── Slot mutations ──────────────────────────────────────────────
  const handleMove = useCallback((fromIndex: number, toSlot: number) => {
    setSlots((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      const adjusted = fromIndex < toSlot ? toSlot - 1 : toSlot;
      next.splice(adjusted, 0, moved);
      return next;
    });
  }, []);

  const drag = useSortableDrag(handleMove);

  const rotateSlot = useCallback((uid: string) => {
    setSlots((prev) => prev.map((s) => (s.uid === uid ? { ...s, rot: (s.rot + 90) % 360 } : s)));
  }, []);

  const duplicateSlot = useCallback(
    (uid: string) => {
      setSlots((prev) => {
        const i = prev.findIndex((s) => s.uid === uid);
        if (i === -1) return prev;
        const copy = { ...prev[i], uid: nextUid() };
        const next = [...prev];
        next.splice(i + 1, 0, copy);
        return next;
      });
    },
    [nextUid],
  );

  const deleteSlot = useCallback((uid: string) => {
    setSlots((prev) => prev.filter((s) => s.uid !== uid));
  }, []);

  const addBlank = useCallback(() => {
    setSlots((prev) => [
      ...prev,
      { uid: nextUid(), kind: "blank", rot: 0, width: 612, height: 792 },
    ]);
  }, [nextUid]);

  const handleAddPdf = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      void addTask.run(async () => {
        const thumbs = await renderAllThumbnails(file);
        const idx = sourcesRef.current.length;
        const tag = LETTERS[idx] ?? "?";
        setSources((prev) => [...prev, { file, thumbs, tag }]);
        setSlots((prev) => [
          ...prev,
          ...thumbs.map((_, i) => ({
            uid: nextUid(),
            kind: "page" as const,
            srcIndex: idx,
            page: i,
            rot: 0,
          })),
        ]);
      }, "Couldn't add that PDF — it may be password-protected or damaged.");
    },
    [addTask, nextUid],
  );

  const handleReset = useCallback(() => {
    const all = sourcesRef.current;
    for (let i = 1; i < all.length; i++) revokeThumbnails(all[i].thumbs);
    const main = all[0];
    setSources(main ? [main] : []);
    setSlots(
      main
        ? main.thumbs.map((_, i) => ({
            uid: nextUid(),
            kind: "page",
            srcIndex: 0,
            page: i,
            rot: 0,
          }))
        : [],
    );
    drag.setDragIndex(null);
    drag.setDragOverSlot(null);
  }, [drag, nextUid]);

  const handleApply = useCallback(async () => {
    if (!sources[0] || slots.length === 0) return;
    await task.run(async () => {
      const srcBytes = await Promise.all(
        sources.map(async (s) => new Uint8Array(await s.file.arrayBuffer())),
      );
      const ops: AssembleOp[] = slots.map((s) =>
        s.kind === "blank"
          ? { kind: "blank", rotation: s.rot, width: s.width, height: s.height }
          : { kind: "page", sourceIndex: s.srcIndex, pageIndex: s.page, rotation: s.rot },
      );
      const result = await assemblePdf(srcBytes, ops);
      output.deliver(result, "_organized", sources[0].file);
    }, "Failed to assemble the PDF.");
  }, [sources, slots, task, output]);

  // The canvas differs from the original when pages were added/removed/
  // reordered/rotated, or another PDF was spliced in.
  const original = sources.length === 1 ? sources[0] : null;
  const isModified =
    sources.length > 1 ||
    !original ||
    slots.length !== original.thumbs.length ||
    slots.some((s, i) => s.kind !== "page" || s.srcIndex !== 0 || s.page !== i || s.rot !== 0);

  const renderThumb = (slot: Slot, faded: boolean) => {
    if (slot.kind === "blank") {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 border-2 border-dashed border-slate-300 dark:border-dark-border text-slate-400 dark:text-slate-600">
          <File className="w-5 h-5" aria-hidden="true" />
          <span className="text-xxs font-medium">Blank</span>
        </div>
      );
    }
    const src = sources[slot.srcIndex];
    return (
      <img
        src={src?.thumbs[slot.page]}
        className={`w-full h-full object-contain transition-transform duration-200 ${faded ? "" : ""}`}
        style={{
          transform: `rotate(${slot.rot}deg)${slot.rot % 180 === 90 ? " scale(0.75)" : ""}`,
        }}
        alt={`Page ${slot.page + 1}`}
        draggable={false}
      />
    );
  };

  return (
    <div className="space-y-6">
      {!pdf.file ? (
        <FileDropZone
          glowColor={categoryGlow.organise}
          iconColor={categoryAccent.organise}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="Reorder, rotate, duplicate, delete, and splice pages — all in one view"
        />
      ) : (
        <>
          <FileInfoBar
            fileName={pdf.file.name}
            details={`${slots.length} ${slots.length === 1 ? "page" : "pages"}`}
            onChangeFile={pdf.reset}
          />

          {pdf.loading ? (
            <LoadingSpinner />
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={addBlank}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-dark-border text-slate-600 dark:text-dark-text-muted bg-white dark:bg-dark-surface hover:border-primary-300 dark:hover:border-primary-600 hover:text-slate-700 dark:hover:text-dark-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                >
                  <FilePlus className="w-3.5 h-3.5" />
                  Add blank page
                </button>
                <button
                  type="button"
                  onClick={() => addInputRef.current?.click()}
                  disabled={addTask.processing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-dark-border text-slate-600 dark:text-dark-text-muted bg-white dark:bg-dark-surface hover:border-primary-300 dark:hover:border-primary-600 hover:text-slate-700 dark:hover:text-dark-text transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                >
                  <FileInput className="w-3.5 h-3.5" />
                  {addTask.processing ? "Adding…" : "Add pages from PDF"}
                </button>
                <input
                  ref={addInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    handleAddPdf(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                {isModified && <ResetButton onClick={handleReset} label="Reset" />}
              </div>

              <p className="text-sm font-medium text-slate-700 dark:text-dark-text">
                {drag.dragIndex !== null
                  ? "Drop the page at its new position"
                  : "Drag to reorder. Use the controls under each page to rotate, duplicate, or delete."}
              </p>

              <SortableGrid
                itemCount={slots.length}
                drag={drag}
                onMove={handleMove}
                renderItem={(pos, isSource) => {
                  const slot = slots[pos];
                  if (!slot) return null;
                  const tag = slot.kind === "page" ? sources[slot.srcIndex]?.tag : null;
                  const showTag = slot.kind === "page" && slot.srcIndex > 0;
                  const label =
                    slot.kind === "blank"
                      ? "Blank page"
                      : `Page ${slot.page + 1}${showTag ? ` from ${tag}` : ""}`;
                  return (
                    <div
                      key={slot.uid}
                      {...drag.getItemProps(pos)}
                      className={`shrink-0 p-1 flex flex-col items-center gap-1 select-none transition-[transform,opacity] duration-200 ${
                        isSource ? "scale-95 opacity-30" : "scale-100 opacity-100"
                      }`}
                    >
                      {/* Drag / keyboard-reorder grip */}
                      <button
                        type="button"
                        {...drag.getKeyboardProps(pos, slots.length, label)}
                        className="w-20 sm:w-24 flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-primary-400 cursor-grab active:cursor-grabbing rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      >
                        <GripHorizontal className="w-4 h-4" aria-hidden="true" />
                      </button>

                      <div className="relative">
                        <div className="w-20 sm:w-24 aspect-3/4 bg-white dark:bg-dark-surface rounded-lg overflow-hidden border-2 border-slate-200 dark:border-dark-border">
                          {renderThumb(slot, isSource)}
                        </div>
                        <div className="absolute top-1 right-1 text-white text-xs font-bold tabular-nums w-6 h-6 rounded-full flex items-center justify-center z-10 bg-primary-600 ring-2 ring-white dark:ring-dark-surface shadow-sm">
                          {pos + 1}
                        </div>
                        {showTag && (
                          <div className="absolute top-1 left-1 text-white text-xxs font-bold w-5 h-5 rounded-full flex items-center justify-center z-10 bg-slate-600 dark:bg-slate-500 ring-2 ring-white dark:ring-dark-surface shadow-sm">
                            {tag}
                          </div>
                        )}
                      </div>

                      {/* Per-page actions — always visible for touch parity */}
                      <div
                        className="flex items-center gap-0.5"
                        onDragStart={(e) => e.preventDefault()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <PageAction
                          icon={RotateCw}
                          label={`Rotate ${label}`}
                          onClick={() => rotateSlot(slot.uid)}
                        />
                        <PageAction
                          icon={Copy}
                          label={`Duplicate ${label}`}
                          onClick={() => duplicateSlot(slot.uid)}
                        />
                        <PageAction
                          icon={Trash2}
                          label={`Delete ${label}`}
                          onClick={() => deleteSlot(slot.uid)}
                          danger
                        />
                      </div>
                    </div>
                  );
                }}
                renderOverlay={(idx) => {
                  const slot = slots[idx];
                  if (!slot) return null;
                  return (
                    <div className="relative pt-2 pr-2">
                      <div className="w-20 sm:w-24 aspect-3/4 bg-white dark:bg-dark-surface rounded-lg overflow-hidden border-2 border-slate-200 dark:border-dark-border shadow-sm">
                        {renderThumb(slot, false)}
                      </div>
                      <div className="absolute top-0 right-0 text-white text-xs font-bold tabular-nums w-6 h-6 rounded-full flex items-center justify-center shadow-md bg-primary-600">
                        {idx + 1}
                      </div>
                    </div>
                  );
                }}
              />

              <div aria-live="polite" className="sr-only">
                {drag.liveMessage}
              </div>

              {slots.length === 0 && (
                <p className="text-sm text-slate-500 dark:text-dark-text-muted text-center py-6">
                  No pages left. Add a blank page or pages from another PDF, or reset.
                </p>
              )}

              <ActionButton
                onClick={handleApply}
                processing={task.processing}
                disabled={slots.length === 0}
                label={`Save & ${output.deliveryWord}`}
                processingLabel="Assembling…"
              />
            </>
          )}
        </>
      )}

      {(pdf.loadError || task.error || addTask.error) && (
        <AlertBox message={pdf.loadError ?? task.error ?? addTask.error ?? ""} />
      )}
    </div>
  );
}

/** A small icon button in a page card's action row. */
function PageAction({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof RotateCw;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`p-1.5 rounded-md text-slate-500 dark:text-dark-text-muted hover:bg-slate-100 dark:hover:bg-dark-surface-alt transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
        danger
          ? "hover:text-red-600 dark:hover:text-red-400"
          : "hover:text-primary-600 dark:hover:text-primary-400"
      }`}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  );
}
