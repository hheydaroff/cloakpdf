// PdfStage.tsx — The single persistent focus-mode canvas. Mounted once in
// EditorShell and never torn down on tool switch (the StageProps seam swaps the
// active tool's overlay instead). Shows the selected page's preview with an
// overlay canvas on top; pointer events are normalised to page-fraction space
// and forwarded to the active tool, or used to pan when no tool is active.
//
// Generalized from RedactPdf's proven surface: <img> page preview +
// absolutely-positioned <canvas> overlay synced by a ResizeObserver, fraction
// coordinates via getBoundingClientRect.

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";
import { useEditorActions, useEditorRead } from "./EditorContext.tsx";
import { type StagePoint, useActiveStageProps } from "./stage.tsx";

export function PdfStage() {
  const { doc, selectedPage, view } = useEditorRead();
  const { setView } = useEditorActions();
  const stageProps = useActiveStageProps();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const page = doc?.pages[selectedPage] ?? null;

  // Keep the overlay canvas's backing store synced to the displayed image size,
  // then let the active tool paint into it.
  const repaint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const { width, height } = wrap.getBoundingClientRect();
    if (!width || !height) return;
    if (canvas.width !== Math.round(width) || canvas.height !== Math.round(height)) {
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stageProps.paintOverlay?.(ctx, canvas.width, canvas.height, selectedPage);
  }, [stageProps, selectedPage]);

  useEffect(() => {
    repaint();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(repaint);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [repaint]);

  const toPoint = useCallback(
    (e: ReactPointerEvent<HTMLElement>): StagePoint => {
      const wrap = wrapRef.current;
      const rect = wrap?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) {
        return { xPct: 0, yPct: 0, pageIndex: selectedPage };
      }
      return {
        xPct: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
        yPct: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
        pageIndex: selectedPage,
      };
    },
    [selectedPage],
  );

  const hasToolPointer = Boolean(stageProps.onPointerDown);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (hasToolPointer) {
        e.currentTarget.setPointerCapture(e.pointerId);
        stageProps.onPointerDown?.(toPoint(e), e);
        return;
      }
      // No active tool → drag to pan.
      e.currentTarget.setPointerCapture(e.pointerId);
      panStart.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
    },
    [hasToolPointer, stageProps, toPoint, view.panX, view.panY],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (hasToolPointer) {
        stageProps.onPointerMove?.(toPoint(e), e);
        return;
      }
      const p = panStart.current;
      if (!p) return;
      setView((prev) => ({
        ...prev,
        panX: p.panX + (e.clientX - p.x),
        panY: p.panY + (e.clientY - p.y),
      }));
    },
    [hasToolPointer, stageProps, toPoint, setView],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (hasToolPointer) {
        stageProps.onPointerUp?.(toPoint(e), e);
        return;
      }
      panStart.current = null;
    },
    [hasToolPointer, stageProps, toPoint],
  );

  // Ctrl/Cmd + wheel zooms; clamped to a sane range.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((prev) => ({ ...prev, zoom: Math.min(8, Math.max(0.2, prev.zoom * factor)) }));
    },
    [setView],
  );

  if (!page) return <div className="flex min-h-0 flex-1" />;

  const cursor = hasToolPointer
    ? (stageProps.cursor ?? "crosshair")
    : view.zoom > 1
      ? "grab"
      : "default";

  return (
    <div
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-slate-100 dark:bg-dark-bg p-4 sm:p-8"
      onWheel={onWheel}
    >
      <div
        ref={wrapRef}
        className="relative shadow-sm ring-1 ring-slate-200/70 dark:ring-dark-border touch-none select-none"
        style={{
          transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          transformOrigin: "center center",
          // Fit-contain within the stage while preserving the page aspect ratio:
          // width:100% + aspect-ratio sets a preferred height; max-height:100%
          // clamps it and the ratio re-derives width. Works in both orientations.
          aspectRatio: `${page.widthPt} / ${page.heightPt}`,
          width: "100%",
          height: "auto",
          maxWidth: "100%",
          maxHeight: "100%",
          cursor,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {page.thumbUrl ? (
          <img
            src={page.thumbUrl}
            alt={`Page ${selectedPage + 1}`}
            className="block h-full w-full pointer-events-none bg-white"
            draggable={false}
          />
        ) : (
          <div className="h-full w-full bg-white" />
        )}
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>
    </div>
  );
}
