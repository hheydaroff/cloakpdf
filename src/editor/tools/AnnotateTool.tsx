// AnnotateTool.tsx — Overlay-object tool. The Stage draws vector marks (pen,
// highlighter, box) as `annotation` overlay objects in fraction space; the
// Panel picks the mark + colour and applies. On Apply, `annotatePdf` burns the
// marks as real vector graphics (selectable text underneath is untouched), then
// the annotation objects are dropped (now in the bytes). A focused subset of
// the standalone AnnotatePdf tool — enough to prove the overlay-burn loop. See
// REDESIGN.md (overlay-object class).

import { Highlighter, Pen, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Annotation } from "../../utils/pdf-operations.ts";
import { annotatePdf } from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";
import { useStageProps } from "../stage.tsx";

const TOOL_ID = "annotate-pdf";

type Mode = "pen" | "highlight" | "box";

const COLORS = [
  { name: "Black", rgb: { r: 30, g: 41, b: 59 } },
  { name: "Red", rgb: { r: 220, g: 38, b: 38 } },
  { name: "Blue", rgb: { r: 29, g: 78, b: 216 } },
  { name: "Green", rgb: { r: 22, g: 163, b: 74 } },
  { name: "Yellow", rgb: { r: 234, g: 179, b: 8 } },
] as const;

const PEN_THICK = 0.0035;
const HIGHLIGHT_THICK = 0.022;

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, w: number, h: number) {
  const col = `rgb(${a.color.r}, ${a.color.g}, ${a.color.b})`;
  if (a.kind === "stroke") {
    if (a.points.length < 1) return;
    ctx.save();
    ctx.globalAlpha = a.opacity;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, a.thicknessFrac * w);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    a.points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
    ctx.stroke();
    ctx.restore();
  } else if (a.kind === "rect") {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, a.thicknessFrac * w);
    ctx.strokeRect(a.x * w, a.y * h, a.w * w, a.h * h);
    ctx.restore();
  }
}

export function Stage() {
  const { doc, selectedPage } = useEditorRead();
  const { addObject } = useEditorActions();
  const slice = useToolSlice(TOOL_ID);
  const mode = (slice.mode as Mode) ?? "pen";
  const color = COLORS[(slice.colorIndex as number) ?? 0].rgb;

  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[] | null>(null);
  const [draftBox, setDraftBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );

  const strokeOpacity = mode === "highlight" ? 0.4 : 1;
  const strokeThick = mode === "highlight" ? HIGHLIGHT_THICK : PEN_THICK;

  const paintOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pageIndex: number) => {
      for (const o of doc?.objects ?? []) {
        if (o.kind === "annotation" && o.pageIndex === pageIndex && o.payload) {
          drawAnnotation(ctx, o.payload as Annotation, w, h);
        }
      }
      if (draftPoints) {
        drawAnnotation(
          ctx,
          {
            kind: "stroke",
            pageIndex,
            points: draftPoints,
            color,
            thicknessFrac: strokeThick,
            opacity: strokeOpacity,
          },
          w,
          h,
        );
      }
      if (draftBox) {
        drawAnnotation(
          ctx,
          {
            kind: "rect",
            pageIndex,
            x: draftBox.x,
            y: draftBox.y,
            w: draftBox.w,
            h: draftBox.h,
            color,
            thicknessFrac: 0.004,
          },
          w,
          h,
        );
      }
    },
    [doc, draftPoints, draftBox, color, strokeThick, strokeOpacity],
  );

  useStageProps({
    cursor: "crosshair",
    paintOverlay,
    onPointerDown: (p) => {
      startRef.current = { x: p.xPct, y: p.yPct };
      if (mode === "box") setDraftBox({ x: p.xPct, y: p.yPct, w: 0, h: 0 });
      else setDraftPoints([{ x: p.xPct, y: p.yPct }]);
    },
    onPointerMove: (p) => {
      const s = startRef.current;
      if (!s) return;
      if (mode === "box") {
        setDraftBox({
          x: Math.min(s.x, p.xPct),
          y: Math.min(s.y, p.yPct),
          w: Math.abs(p.xPct - s.x),
          h: Math.abs(p.yPct - s.y),
        });
      } else {
        setDraftPoints((prev) => [...(prev ?? []), { x: p.xPct, y: p.yPct }]);
      }
    },
    onPointerUp: (p) => {
      const s = startRef.current;
      startRef.current = null;
      if (!s) return;
      if (mode === "box") {
        const box = {
          x: Math.min(s.x, p.xPct),
          y: Math.min(s.y, p.yPct),
          w: Math.abs(p.xPct - s.x),
          h: Math.abs(p.yPct - s.y),
        };
        setDraftBox(null);
        if (box.w > 0.01 && box.h > 0.01) {
          addObject({
            kind: "annotation",
            pageIndex: selectedPage,
            payload: { kind: "rect", pageIndex: selectedPage, ...box, color, thicknessFrac: 0.004 },
          });
        }
      } else {
        const points = draftPoints ?? [];
        setDraftPoints(null);
        if (points.length >= 2) {
          addObject({
            kind: "annotation",
            pageIndex: selectedPage,
            payload: {
              kind: "stroke",
              pageIndex: selectedPage,
              points,
              color,
              thicknessFrac: strokeThick,
              opacity: strokeOpacity,
            },
          });
        }
      }
    },
  });

  return null;
}

export function Panel() {
  const { doc } = useEditorRead();
  const { patchToolState, applyTransform, undo } = useEditorActions();
  const slice = useToolSlice(TOOL_ID);
  const mode = (slice.mode as Mode) ?? "pen";
  const colorIndex = (slice.colorIndex as number) ?? 0;

  const count = (doc?.objects ?? []).filter((o) => o.kind === "annotation").length;

  const apply = useCallback(() => {
    void applyTransform(async (d) => {
      const anns = d.objects
        .filter((o) => o.kind === "annotation" && o.payload)
        .map((o) => o.payload as Annotation);
      const bytes = await annotatePdf(docToFile(d), anns);
      return {
        bytes,
        label: `Annotate ${anns.length}`,
        objects: d.objects.filter((o) => o.kind !== "annotation"),
      };
    });
  }, [applyTransform]);

  const modes: { id: Mode; label: string; icon: typeof Pen }[] = [
    { id: "pen", label: "Pen", icon: Pen },
    { id: "highlight", label: "Highlight", icon: Highlighter },
    { id: "box", label: "Box", icon: Square },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-dark-text-muted">
          Tool
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {modes.map((m) => {
            const Icon = m.icon;
            const on = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => patchToolState(TOOL_ID, { mode: m.id })}
                aria-pressed={on}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  on
                    ? "border-primary-400 bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300"
                    : "border-slate-200 dark:border-dark-border text-slate-600 dark:text-dark-text-muted hover:bg-slate-50 dark:hover:bg-dark-surface-alt"
                }`}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-dark-text-muted">
          Color
        </p>
        <div className="flex gap-2">
          {COLORS.map((c, i) => (
            <button
              key={c.name}
              type="button"
              onClick={() => patchToolState(TOOL_ID, { colorIndex: i })}
              aria-label={c.name}
              aria-pressed={colorIndex === i}
              className={`h-7 w-7 rounded-full border-2 transition-transform ${
                colorIndex === i
                  ? "scale-110 border-slate-800 dark:border-white"
                  : "border-transparent"
              }`}
              style={{ backgroundColor: `rgb(${c.rgb.r}, ${c.rgb.g}, ${c.rgb.b})` }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-600 dark:text-dark-text-muted">
          {count} mark{count === 1 ? "" : "s"}
        </span>
        {count > 0 && (
          <button
            type="button"
            onClick={undo}
            className="text-xs text-slate-500 hover:text-slate-700 dark:text-dark-text-muted dark:hover:text-dark-text"
          >
            Undo last
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={apply}
        disabled={count === 0}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40"
      >
        Apply annotations
      </button>
      <p className="text-xs text-slate-400 dark:text-dark-text-muted">
        Marks are drawn as vectors — the page text underneath stays selectable.
      </p>
    </div>
  );
}
