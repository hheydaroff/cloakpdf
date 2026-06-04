/**
 * Annotate PDF tool.
 *
 * Draw on a page with a pen or highlighter, add shapes (line, arrow,
 * rectangle, ellipse), and drop text labels — then burn them onto the
 * PDF as vector graphics via {@link annotatePdf}. Unlike redaction this
 * is additive: the page's existing text stays selectable; annotations
 * ride on top.
 *
 * Annotations are stored in page-relative fractions (0–1) so they hold at
 * any display size, mirroring the Redact tool's overlay mechanics. Pointer
 * events drive drawing, so mouse, pen, and touch all work the same.
 */

import {
  Circle,
  Highlighter,
  Minus,
  MoveUpRight,
  PenLine,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton } from "../components/ActionButton.tsx";
import { AlertBox } from "../components/AlertBox.tsx";
import { ColorPicker, hexToRgb } from "../components/ColorPicker.tsx";
import { FileDropZone } from "../components/FileDropZone.tsx";
import { FileInfoBar } from "../components/FileInfoBar.tsx";
import { LoadingSpinner } from "../components/LoadingSpinner.tsx";
import { PagePreviewNav } from "../components/PagePreviewNav.tsx";
import { categoryAccent, categoryGlow } from "../config/theme.ts";
import { useAsyncProcess } from "../hooks/useAsyncProcess.ts";
import { usePdfFile } from "../hooks/usePdfFile.ts";
import { useToolOutput } from "../hooks/useToolOutput.ts";
import { type Annotation, type AnnotationColor, annotatePdf } from "../utils/pdf-operations.ts";
import { PREVIEW_SCALE, renderAllThumbnails, revokeThumbnails } from "../utils/pdf-renderer.ts";

type Tool = "pen" | "highlighter" | "line" | "arrow" | "rect" | "ellipse" | "text";

const TOOLS: { id: Tool; label: string; icon: typeof PenLine }[] = [
  { id: "pen", label: "Pen", icon: PenLine },
  { id: "highlighter", label: "Highlighter", icon: Highlighter },
  { id: "line", label: "Line", icon: Minus },
  { id: "arrow", label: "Arrow", icon: MoveUpRight },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "text", label: "Text", icon: Type },
];

// Tool weights, all as fractions of the page so the preview matches output.
const PEN = { thicknessFrac: 0.005, opacity: 1 };
const HIGHLIGHTER = { thicknessFrac: 0.03, opacity: 0.35 };
const SHAPE_THICKNESS = 0.005;
const TEXT_SIZE_FRAC = 0.03;

const BLACK_HEX = "#1e293b"; // matches the ColorPicker "Black" preset
const YELLOW_HEX = "#facc15";

const css = (c: AnnotationColor) => `rgb(${c.r}, ${c.g}, ${c.b})`;

/** Paint one annotation onto the overlay canvas (pixel space, y-down). */
function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, cw: number, ch: number) {
  ctx.save();
  ctx.strokeStyle = css(a.color);
  ctx.fillStyle = css(a.color);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (a.kind === "stroke") {
    ctx.globalAlpha = a.opacity;
    ctx.lineWidth = Math.max(1, a.thicknessFrac * cw);
    ctx.beginPath();
    a.points.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x * cw, p.y * ch) : ctx.lineTo(p.x * cw, p.y * ch),
    );
    ctx.stroke();
  } else if (a.kind === "rect" || a.kind === "ellipse") {
    ctx.lineWidth = Math.max(1, a.thicknessFrac * cw);
    if (a.kind === "rect") {
      ctx.strokeRect(a.x * cw, a.y * ch, a.w * cw, a.h * ch);
    } else {
      ctx.beginPath();
      ctx.ellipse(
        (a.x + a.w / 2) * cw,
        (a.y + a.h / 2) * ch,
        (a.w / 2) * cw,
        (a.h / 2) * ch,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  } else if (a.kind === "line" || a.kind === "arrow") {
    const lw = Math.max(1, a.thicknessFrac * cw);
    ctx.lineWidth = lw;
    const x1 = a.x1 * cw;
    const y1 = a.y1 * ch;
    const x2 = a.x2 * cw;
    const y2 = a.y2 * ch;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (a.kind === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(6, lw * 3.5);
      for (const spread of [Math.PI - 0.45, Math.PI + 0.45]) {
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 + head * Math.cos(angle + spread), y2 + head * Math.sin(angle + spread));
      }
    }
    ctx.stroke();
  } else if (a.kind === "text") {
    ctx.textBaseline = "top";
    ctx.font = `${Math.max(8, a.sizeFrac * ch)}px Helvetica, Arial, sans-serif`;
    ctx.fillText(a.text, a.x * cw, a.y * ch);
  }
  ctx.restore();
}

export default function AnnotatePdf() {
  const [selectedPage, setSelectedPage] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [undoHistory, setUndoHistory] = useState<Annotation[][]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [colorHex, setColorHex] = useState(BLACK_HEX);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  // Live preview pixel size, so the text-entry box matches the final glyph size.
  const [previewH, setPreviewH] = useState(0);

  const color = useMemo<AnnotationColor>(() => hexToRgb(colorHex), [colorHex]);

  const pdf = usePdfFile<string[]>({
    load: (file) => renderAllThumbnails(file, PREVIEW_SCALE),
    onReset: (thumbs) => {
      revokeThumbnails(thumbs ?? []);
      setSelectedPage(0);
      setAnnotations([]);
      setUndoHistory([]);
      setTextDraft(null);
    },
  });
  const task = useAsyncProcess();
  const output = useToolOutput();

  const thumbnails = pdf.data ?? [];
  const pageCount = thumbnails.length;

  // Latch live state in refs so imperative pointer handlers and the
  // ResizeObserver redraw stay current without re-subscribing.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const strokeRef = useRef<{ x: number; y: number }[]>([]);
  const drawingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  const strokeParams = tool === "highlighter" ? HIGHLIGHTER : PEN;

  /** Build a shape annotation from a drag's start/end, or null if too small. */
  const buildDragShape = useCallback(
    (s: { x: number; y: number }, e: { x: number; y: number }): Annotation | null => {
      if (tool === "rect" || tool === "ellipse") {
        const x = Math.min(s.x, e.x);
        const y = Math.min(s.y, e.y);
        const w = Math.abs(e.x - s.x);
        const h = Math.abs(e.y - s.y);
        if (w < 0.01 || h < 0.01) return null;
        return {
          kind: tool,
          pageIndex: selectedPage,
          x,
          y,
          w,
          h,
          color,
          thicknessFrac: SHAPE_THICKNESS,
        };
      }
      // line | arrow — keep direction (don't normalise to a bounding box).
      if (Math.hypot(e.x - s.x, e.y - s.y) < 0.01) return null;
      return {
        kind: tool === "arrow" ? "arrow" : "line",
        pageIndex: selectedPage,
        x1: s.x,
        y1: s.y,
        x2: e.x,
        y2: e.y,
        color,
        thicknessFrac: SHAPE_THICKNESS,
      };
    },
    [tool, selectedPage, color],
  );

  /** Redraw the current page's saved annotations plus any in-progress one. */
  const redraw = useCallback(
    (live?: Annotation | null) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const { width: cw, height: ch } = canvas;
      ctx.clearRect(0, 0, cw, ch);
      for (const a of annotationsRef.current) {
        if (a.pageIndex === selectedPage) drawAnnotation(ctx, a, cw, ch);
      }
      if (live) drawAnnotation(ctx, live, cw, ch);
    },
    [selectedPage],
  );

  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  // Re-render the overlay when saved annotations or the page change.
  useEffect(() => {
    redraw();
  }, [redraw, annotations]);

  const getPos = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
      y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1),
    };
  }, []);

  const pushAnnotation = useCallback((a: Annotation) => {
    setUndoHistory((h) => [...h, annotationsRef.current]);
    setAnnotations((prev) => [...prev, a]);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (textDraft || tool === "text") return; // text places on click (pointer up)
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const pos = getPos(e);
      if (tool === "pen" || tool === "highlighter") {
        drawingRef.current = true;
        strokeRef.current = [pos];
      } else {
        dragStartRef.current = pos;
      }
    },
    [tool, textDraft, getPos],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (drawingRef.current) {
        e.preventDefault();
        strokeRef.current.push(getPos(e));
        redraw({
          kind: "stroke",
          pageIndex: selectedPage,
          points: strokeRef.current,
          color,
          thicknessFrac: strokeParams.thicknessFrac,
          opacity: strokeParams.opacity,
        });
      } else if (dragStartRef.current) {
        e.preventDefault();
        redraw(buildDragShape(dragStartRef.current, getPos(e)));
      }
    },
    [getPos, redraw, selectedPage, color, strokeParams, buildDragShape],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const pos = getPos(e);
      if (tool === "text") {
        setTextDraft({ x: pos.x, y: pos.y, value: "" });
        return;
      }
      if (drawingRef.current) {
        drawingRef.current = false;
        const points = strokeRef.current;
        strokeRef.current = [];
        if (points.length > 1) {
          pushAnnotation({
            kind: "stroke",
            pageIndex: selectedPage,
            points,
            color,
            thicknessFrac: strokeParams.thicknessFrac,
            opacity: strokeParams.opacity,
          });
        } else {
          redraw();
        }
      } else if (dragStartRef.current) {
        const shape = buildDragShape(dragStartRef.current, pos);
        dragStartRef.current = null;
        if (shape) pushAnnotation(shape);
        else redraw();
      }
    },
    [tool, color, selectedPage, getPos, pushAnnotation, redraw, strokeParams, buildDragShape],
  );

  const cancelDraw = useCallback(() => {
    if (drawingRef.current || dragStartRef.current) {
      drawingRef.current = false;
      dragStartRef.current = null;
      strokeRef.current = [];
      redraw();
    }
  }, [redraw]);

  const commitText = useCallback(() => {
    setTextDraft((draft) => {
      if (draft && draft.value.trim()) {
        pushAnnotation({
          kind: "text",
          pageIndex: selectedPage,
          x: draft.x,
          y: draft.y,
          text: draft.value.trim(),
          sizeFrac: TEXT_SIZE_FRAC,
          color,
        });
      }
      return null;
    });
  }, [selectedPage, color, pushAnnotation]);

  const selectTool = useCallback(
    (t: Tool) => {
      setTool(t);
      // A black highlighter reads as muddy grey — nudge to yellow on switch.
      if (t === "highlighter" && colorHex.toLowerCase() === BLACK_HEX) setColorHex(YELLOW_HEX);
    },
    [colorHex],
  );

  const undo = useCallback(() => {
    setUndoHistory((prev) => {
      if (prev.length === 0) return prev;
      setAnnotations(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }, []);

  const clearPage = useCallback(() => {
    setUndoHistory((h) => [...h, annotationsRef.current]);
    setAnnotations((prev) => prev.filter((a) => a.pageIndex !== selectedPage));
  }, [selectedPage]);

  const clearAll = useCallback(() => {
    setUndoHistory((h) => [...h, annotationsRef.current]);
    setAnnotations([]);
  }, []);

  const handleApply = useCallback(async () => {
    if (!pdf.file || annotations.length === 0) return;
    const file = pdf.file;
    await task.run(async () => {
      const result = await annotatePdf(file, annotations);
      output.deliver(result, "_annotated", file);
    }, "Failed to apply annotations. Please try again.");
  }, [pdf.file, annotations, task, output]);

  // Keep the overlay canvas pixel-sized to the page image as it loads/resizes.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const sync = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      canvas.width = width;
      canvas.height = height;
      setPreviewH(height);
      redrawRef.current();
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(container);
    return () => ro.disconnect();
  }, [pdf.loading]);

  const total = annotations.length;
  const pageTotal = annotations.filter((a) => a.pageIndex === selectedPage).length;

  if (!pdf.file) {
    return (
      <div className="space-y-6">
        <FileDropZone
          glowColor={categoryGlow.annotate}
          iconColor={categoryAccent.annotate}
          accept=".pdf,application/pdf"
          onFiles={pdf.onFiles}
          encryptedFile={pdf.encryptedFile}
          onClearEncrypted={pdf.reset}
          label="Drop a PDF file here"
          hint="Draw, highlight, add shapes & text — then flatten onto the page"
        />
        {pdf.loadError && <AlertBox message={pdf.loadError} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <FileInfoBar
        fileName={pdf.file.name}
        details={`${pageCount} page${pageCount === 1 ? "" : "s"}`}
        onChangeFile={pdf.reset}
        extra={
          total > 0 ? (
            <span className="text-primary-600 dark:text-primary-400 ml-2">
              ({total} annotation{total > 1 ? "s" : ""})
            </span>
          ) : undefined
        }
      />

      {pdf.loading ? (
        <LoadingSpinner />
      ) : (
        <>
          {/* Toolbar: tools + colour + undo/clear */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {TOOLS.map((t) => {
                const active = tool === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTool(t.id)}
                    aria-pressed={active}
                    title={t.label}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg ${
                      active
                        ? "bg-primary-600 text-white border-primary-600"
                        : "bg-white dark:bg-dark-surface text-slate-600 dark:text-dark-text-muted border-slate-200 dark:border-dark-border hover:border-primary-300 dark:hover:border-primary-600"
                    }`}
                  >
                    <t.icon className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t.label}</span>
                  </button>
                );
              })}
            </div>

            <ColorPicker value={colorHex} onChange={setColorHex} />

            {total > 0 && (
              <div className="flex items-center gap-3 ml-auto">
                <button
                  type="button"
                  onClick={undo}
                  disabled={undoHistory.length === 0}
                  className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 dark:text-dark-text-muted dark:hover:text-dark-text disabled:opacity-40 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                >
                  <Undo2 className="w-4 h-4" />
                  Undo
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="inline-flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                >
                  <Trash2 className="w-4 h-4" />
                  Clear all
                </button>
              </div>
            )}
          </div>

          {/* Page preview + drawing surface */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-700 dark:text-dark-text">
                Page {selectedPage + 1}
                {pageTotal > 0 && (
                  <span className="text-slate-500 dark:text-dark-text-muted font-normal">
                    {" "}
                    · {pageTotal} mark{pageTotal > 1 ? "s" : ""}
                  </span>
                )}
              </p>
              {pageTotal > 0 && (
                <button
                  type="button"
                  onClick={clearPage}
                  className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-dark-bg"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear page
                </button>
              )}
            </div>

            <div
              ref={containerRef}
              className="relative rounded-xl overflow-hidden border border-slate-200 dark:border-dark-border select-none w-full"
              style={{ cursor: tool === "text" ? "text" : "crosshair" }}
            >
              <img
                src={thumbnails[selectedPage]}
                alt={`Page ${selectedPage + 1}`}
                className="w-full h-auto block pointer-events-none"
                draggable={false}
              />
              <canvas
                ref={canvasRef}
                role="application"
                aria-label={`Annotation surface for page ${selectedPage + 1} — draw with a pointer`}
                className="absolute inset-0 w-full h-full touch-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={cancelDraw}
                onPointerLeave={cancelDraw}
              />
              {textDraft && (
                <input
                  autoFocus
                  value={textDraft.value}
                  onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitText();
                    if (e.key === "Escape") setTextDraft(null);
                  }}
                  onBlur={commitText}
                  placeholder="Type, then Enter"
                  className="absolute z-10 bg-transparent border-0 p-0 leading-none outline-none placeholder:text-slate-400/70"
                  style={{
                    left: `${textDraft.x * 100}%`,
                    top: `${textDraft.y * 100}%`,
                    maxWidth: `${(1 - textDraft.x) * 100}%`,
                    fontSize: `${Math.max(10, TEXT_SIZE_FRAC * previewH)}px`,
                    fontFamily: "Helvetica, Arial, sans-serif",
                    color: colorHex,
                  }}
                />
              )}
            </div>

            {/* Prominent page stepper */}
            {pageCount > 1 && (
              <div className="flex justify-center pt-1">
                <PagePreviewNav
                  page={selectedPage}
                  total={pageCount}
                  onChange={(p) => {
                    setTextDraft(null);
                    setSelectedPage(p);
                  }}
                  variant="bordered"
                />
              </div>
            )}

            <p className="text-xs text-slate-500 dark:text-dark-text-muted text-center">
              {tool === "text"
                ? "Tap the page to place text."
                : tool === "pen" || tool === "highlighter"
                  ? "Draw on the page. Annotations stay vector — your page text stays selectable."
                  : "Drag on the page to draw the shape."}
            </p>
          </div>

          <ActionButton
            onClick={handleApply}
            processing={task.processing}
            disabled={total === 0}
            label={`Apply Annotations & ${output.deliveryWord}`}
            processingLabel="Applying…"
          />
        </>
      )}

      {(pdf.loadError || task.error) && <AlertBox message={pdf.loadError ?? task.error ?? ""} />}
    </div>
  );
}
