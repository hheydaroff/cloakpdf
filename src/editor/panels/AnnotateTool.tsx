// AnnotateTool.tsx — Overlay-object tool. The Stage draws vector marks (pen,
// highlighter, line, arrow, rectangle, oval) and tap-to-place text as
// `annotation` overlay objects in fraction space; the Panel picks the mark,
// colour, an optional shape fill, and — for text — font, size, and an optional
// opaque background (so a label can mask the content beneath it). On Apply,
// `annotatePdf` burns the marks as real vector graphics + text (selectable text
// underneath is untouched), then the annotation objects are dropped (now in the
// bytes). See REDESIGN.md (overlay-object class).

import { ArrowUpRight, Circle, Highlighter, Minus, Pen, Square, Type } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ColorPicker, hexToRgb } from "../../components/ColorPicker.tsx";
import type { Annotation, TextFontId } from "../../utils/pdf-operations.ts";
import { annotatePdf, TEXT_BG_HEIGHT_EM, TEXT_BG_PAD_EM } from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";
import { type StagePoint, useStageProps } from "../stage.tsx";
import { Labeled, RangeField, SelectField, TextField, Toggle } from "./controls.tsx";

const TOOL_ID = "annotate-pdf";
const DEFAULT_HEX = "#1e293b";
const DEFAULT_FILL_HEX = "#2563eb";
const DEFAULT_BG_HEX = "#ffffff";
const DEFAULT_TEXT_PT = 16;

type Mode = "pen" | "highlight" | "line" | "arrow" | "rect" | "ellipse" | "text";

const PEN_THICK = 0.0035;
const HIGHLIGHT_THICK = 0.022;
const SHAPE_THICK = 0.004;

/** Text fonts offered in the panel. `css` mirrors each standard-14 family for
 *  the on-canvas preview; `weight` carries Bold. The ids match annotate.ts's
 *  STANDARD_FONT map so the preview and the burned-in output agree. */
const TEXT_FONTS: { id: TextFontId; label: string; css: string; weight: number }[] = [
  { id: "helvetica", label: "Helvetica", css: "Helvetica, Arial, sans-serif", weight: 400 },
  {
    id: "helvetica-bold",
    label: "Helvetica Bold",
    css: "Helvetica, Arial, sans-serif",
    weight: 700,
  },
  { id: "times", label: "Times", css: '"Times New Roman", Times, serif', weight: 400 },
  { id: "times-bold", label: "Times Bold", css: '"Times New Roman", Times, serif', weight: 700 },
  { id: "courier", label: "Courier", css: '"Courier New", Courier, monospace', weight: 400 },
  {
    id: "courier-bold",
    label: "Courier Bold",
    css: '"Courier New", Courier, monospace',
    weight: 700,
  },
];
const fontById = (id: TextFontId) => TEXT_FONTS.find((f) => f.id === id) ?? TEXT_FONTS[0];

/** Closed shapes can carry an interior fill; freehand/line marks cannot. */
const isFillable = (m: Mode): boolean => m === "rect" || m === "ellipse";

function fillStyle(c: { r: number; g: number; b: number }): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function drawEllipsePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
}

function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, w: number, h: number) {
  const col = fillStyle(a.color);
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
  } else if (a.kind === "rect" || a.kind === "ellipse") {
    ctx.save();
    const x = a.x * w;
    const y = a.y * h;
    const ww = a.w * w;
    const hh = a.h * h;
    if (a.fill) {
      ctx.globalAlpha = a.fill.opacity ?? 1;
      ctx.fillStyle = fillStyle(a.fill.color);
      if (a.kind === "rect") ctx.fillRect(x, y, ww, hh);
      else {
        drawEllipsePath(ctx, x, y, ww, hh);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, a.thicknessFrac * w);
    if (a.kind === "rect") ctx.strokeRect(x, y, ww, hh);
    else {
      drawEllipsePath(ctx, x, y, ww, hh);
      ctx.stroke();
    }
    ctx.restore();
  } else if (a.kind === "line" || a.kind === "arrow") {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, a.thicknessFrac * w);
    ctx.lineCap = "round";
    const x1 = a.x1 * w;
    const y1 = a.y1 * h;
    const x2 = a.x2 * w;
    const y2 = a.y2 * h;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (a.kind === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(6, ctx.lineWidth * 3.5);
      for (const spread of [Math.PI - 0.45, Math.PI + 0.45]) {
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 + headLen * Math.cos(angle + spread),
          y2 + headLen * Math.sin(angle + spread),
        );
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (a.kind === "text") {
    if (!a.text) return;
    const size = a.sizeFrac * h;
    const f = fontById(a.font ?? "helvetica");
    ctx.save();
    ctx.font = `${f.weight} ${size}px ${f.css}`;
    ctx.textBaseline = "alphabetic";
    // Mirror annotate.ts's burn-in geometry exactly: anchor `y` is the box top,
    // baseline one size below it, background spanning down past the descenders.
    if (a.bg) {
      const padX = size * TEXT_BG_PAD_EM;
      ctx.globalAlpha = a.bg.opacity ?? 1;
      ctx.fillStyle = fillStyle(a.bg.color);
      ctx.fillRect(
        a.x * w - padX,
        a.y * h,
        ctx.measureText(a.text).width + padX * 2,
        size * TEXT_BG_HEIGHT_EM,
      );
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = col;
    ctx.fillText(a.text, a.x * w, a.y * h + size);
    ctx.restore();
  }
}

export function Stage() {
  const { doc, selectedPage } = useEditorRead();
  const { addObject } = useEditorActions();
  const slice = useToolSlice(TOOL_ID);
  const mode = (slice.mode as Mode) ?? "pen";
  const colorHex = (slice.colorHex as string) ?? DEFAULT_HEX;
  const fillEnabled = (slice.fillEnabled as boolean) ?? false;
  const fillHex = (slice.fillHex as string) ?? DEFAULT_FILL_HEX;
  const fillOpacity = (slice.fillOpacity as number) ?? 0.3;
  // Text-mode settings (read for the click-to-place handler below).
  const textValue = (slice.text as string) ?? "";
  const textFont = (slice.textFont as TextFontId) ?? "helvetica";
  const textSizePt = (slice.textSizePt as number) ?? DEFAULT_TEXT_PT;
  const bgEnabled = (slice.bgEnabled as boolean) ?? false;
  const bgHex = (slice.bgHex as string) ?? DEFAULT_BG_HEX;
  const bgOpacity = (slice.bgOpacity as number) ?? 1;
  // Memoise parsed colours so the overlay painter + pointer handlers keep a
  // stable identity across idle re-renders (hexToRgb returns a fresh object
  // each call, which would otherwise re-register the stage props every render).
  const color = useMemo(() => hexToRgb(colorHex), [colorHex]);
  const fillColor = useMemo(() => hexToRgb(fillHex), [fillHex]);
  const bgColor = useMemo(() => hexToRgb(bgHex), [bgHex]);
  const pageHeightPt = doc?.pages[selectedPage]?.heightPt ?? 0;

  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[] | null>(null);
  const [draftBox, setDraftBox] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );
  const [draftLine, setDraftLine] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  const boxMode = mode === "rect" || mode === "ellipse";
  const lineMode = mode === "line" || mode === "arrow";
  const textMode = mode === "text";

  const strokeOpacity = mode === "highlight" ? 0.4 : 1;
  const strokeThick = mode === "highlight" ? HIGHLIGHT_THICK : PEN_THICK;
  const fill = useMemo(
    () =>
      fillEnabled && isFillable(mode) ? { color: fillColor, opacity: fillOpacity } : undefined,
    [fillEnabled, mode, fillColor, fillOpacity],
  );

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
            kind: mode === "ellipse" ? "ellipse" : "rect",
            pageIndex,
            x: draftBox.x,
            y: draftBox.y,
            w: draftBox.w,
            h: draftBox.h,
            color,
            thicknessFrac: SHAPE_THICK,
            ...(fill ? { fill } : {}),
          },
          w,
          h,
        );
      }
      if (draftLine) {
        drawAnnotation(
          ctx,
          {
            kind: mode === "arrow" ? "arrow" : "line",
            pageIndex,
            ...draftLine,
            color,
            thicknessFrac: SHAPE_THICK,
          },
          w,
          h,
        );
      }
    },
    [doc, draftPoints, draftBox, draftLine, mode, color, strokeThick, strokeOpacity, fill],
  );

  const onPointerDown = useCallback(
    (p: StagePoint) => {
      startRef.current = { x: p.xPct, y: p.yPct };
      // Text is dropped on release (a tap) — no live draft to start here.
      if (textMode) return;
      if (boxMode) setDraftBox({ x: p.xPct, y: p.yPct, w: 0, h: 0 });
      else if (lineMode) setDraftLine({ x1: p.xPct, y1: p.yPct, x2: p.xPct, y2: p.yPct });
      else setDraftPoints([{ x: p.xPct, y: p.yPct }]);
    },
    [boxMode, lineMode, textMode],
  );

  const onPointerMove = useCallback(
    (p: StagePoint) => {
      const s = startRef.current;
      if (!s || textMode) return;
      if (boxMode) {
        setDraftBox({
          x: Math.min(s.x, p.xPct),
          y: Math.min(s.y, p.yPct),
          w: Math.abs(p.xPct - s.x),
          h: Math.abs(p.yPct - s.y),
        });
      } else if (lineMode) {
        setDraftLine({ x1: s.x, y1: s.y, x2: p.xPct, y2: p.yPct });
      } else {
        setDraftPoints((prev) => [...(prev ?? []), { x: p.xPct, y: p.yPct }]);
      }
    },
    [boxMode, lineMode, textMode],
  );

  const onPointerUp = useCallback(
    (p: StagePoint) => {
      const s = startRef.current;
      startRef.current = null;
      if (!s) return;
      if (textMode) {
        // Drop the typed text at the tap point (its top-left anchor). Size is in
        // points; convert to a page-height fraction so it stays proportional.
        const trimmed = textValue.trim();
        if (trimmed && pageHeightPt > 0) {
          addObject({
            kind: "annotation",
            pageIndex: selectedPage,
            payload: {
              kind: "text",
              pageIndex: selectedPage,
              x: s.x,
              y: s.y,
              text: trimmed,
              sizeFrac: textSizePt / pageHeightPt,
              color,
              font: textFont,
              ...(bgEnabled ? { bg: { color: bgColor, opacity: bgOpacity } } : {}),
            },
          });
        }
        return;
      }
      if (boxMode) {
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
            payload: {
              kind: mode === "ellipse" ? "ellipse" : "rect",
              pageIndex: selectedPage,
              ...box,
              color,
              thicknessFrac: SHAPE_THICK,
              ...(fill ? { fill } : {}),
            },
          });
        }
      } else if (lineMode) {
        const line = { x1: s.x, y1: s.y, x2: p.xPct, y2: p.yPct };
        setDraftLine(null);
        if (Math.hypot(line.x2 - line.x1, line.y2 - line.y1) > 0.01) {
          addObject({
            kind: "annotation",
            pageIndex: selectedPage,
            payload: {
              kind: mode === "arrow" ? "arrow" : "line",
              pageIndex: selectedPage,
              ...line,
              color,
              thicknessFrac: SHAPE_THICK,
            },
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
    [
      boxMode,
      lineMode,
      textMode,
      mode,
      color,
      fill,
      strokeThick,
      strokeOpacity,
      selectedPage,
      addObject,
      draftPoints,
      textValue,
      textFont,
      textSizePt,
      pageHeightPt,
      bgEnabled,
      bgColor,
      bgOpacity,
    ],
  );

  const onPointerCancel = useCallback(() => {
    startRef.current = null;
    setDraftBox(null);
    setDraftLine(null);
    setDraftPoints(null);
  }, []);

  useStageProps({
    cursor: textMode ? "text" : "crosshair",
    paintOverlay,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  });

  return null;
}

const MODES: { id: Mode; label: string; icon: typeof Pen }[] = [
  { id: "pen", label: "Pen", icon: Pen },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "line", label: "Line", icon: Minus },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Oval", icon: Circle },
  { id: "text", label: "Text", icon: Type },
];

export function Panel() {
  const { doc } = useEditorRead();
  const { patchToolState, applyTransform } = useEditorActions();
  const slice = useToolSlice(TOOL_ID);
  const mode = (slice.mode as Mode) ?? "pen";
  const colorHex = (slice.colorHex as string) ?? DEFAULT_HEX;
  const fillEnabled = (slice.fillEnabled as boolean) ?? false;
  const fillHex = (slice.fillHex as string) ?? DEFAULT_FILL_HEX;
  const fillOpacity = (slice.fillOpacity as number) ?? 0.3;
  const textValue = (slice.text as string) ?? "";
  const textFont = (slice.textFont as TextFontId) ?? "helvetica";
  const textSizePt = (slice.textSizePt as number) ?? DEFAULT_TEXT_PT;
  const bgEnabled = (slice.bgEnabled as boolean) ?? false;
  const bgHex = (slice.bgHex as string) ?? DEFAULT_BG_HEX;
  const bgOpacity = (slice.bgOpacity as number) ?? 1;

  const count = (doc?.objects ?? []).filter((o) => o.kind === "annotation").length;
  const isText = mode === "text";
  const showFill = isFillable(mode);

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

  return (
    <div className="flex flex-col gap-4">
      <Labeled label="Tool">
        <div className="grid grid-cols-3 gap-1.5">
          {MODES.map((m) => {
            const Icon = m.icon;
            const on = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => patchToolState(TOOL_ID, { mode: m.id })}
                aria-pressed={on}
                // Selected = solid primary fill, matching Segmented / PositionGrid
                // / the density toggle — one selected look across every pick-one.
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  on
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-slate-200 dark:border-dark-border text-slate-600 dark:text-dark-text-muted hover:bg-slate-50 dark:hover:bg-dark-surface-alt"
                }`}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            );
          })}
        </div>
      </Labeled>

      {isText ? (
        <>
          <TextField
            label="Text"
            value={textValue}
            placeholder="Type, then tap the page to place"
            onChange={(v) => patchToolState(TOOL_ID, { text: v })}
          />
          <SelectField
            label="Font"
            value={textFont}
            options={TEXT_FONTS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(v) => patchToolState(TOOL_ID, { textFont: v })}
          />
          <RangeField
            label="Text size"
            value={textSizePt}
            min={8}
            max={72}
            suffix=" pt"
            onChange={(v) => patchToolState(TOOL_ID, { textSizePt: v })}
          />
          <Labeled label="Text colour">
            <ColorPicker
              value={colorHex}
              onChange={(hex) => patchToolState(TOOL_ID, { colorHex: hex })}
            />
          </Labeled>
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 dark:border-dark-border p-3">
            <Toggle
              label="Background"
              checked={bgEnabled}
              onChange={(v) => patchToolState(TOOL_ID, { bgEnabled: v })}
            />
            {bgEnabled && (
              <>
                <Labeled label="Background colour">
                  <ColorPicker
                    value={bgHex}
                    onChange={(hex) => patchToolState(TOOL_ID, { bgHex: hex })}
                  />
                </Labeled>
                <RangeField
                  label="Background opacity"
                  value={Math.round(bgOpacity * 100)}
                  min={10}
                  max={100}
                  suffix="%"
                  onChange={(v) => patchToolState(TOOL_ID, { bgOpacity: v / 100 })}
                />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <Labeled label={showFill ? "Stroke" : "Colour"}>
            <ColorPicker
              value={colorHex}
              onChange={(hex) => patchToolState(TOOL_ID, { colorHex: hex })}
            />
          </Labeled>

          {showFill && (
            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 dark:border-dark-border p-3">
              <Toggle
                label="Fill shape"
                checked={fillEnabled}
                onChange={(v) => patchToolState(TOOL_ID, { fillEnabled: v })}
              />
              {fillEnabled && (
                <>
                  <Labeled label="Fill">
                    <ColorPicker
                      value={fillHex}
                      onChange={(hex) => patchToolState(TOOL_ID, { fillHex: hex })}
                    />
                  </Labeled>
                  <RangeField
                    label="Fill opacity"
                    value={Math.round(fillOpacity * 100)}
                    min={10}
                    max={100}
                    suffix="%"
                    onChange={(v) => patchToolState(TOOL_ID, { fillOpacity: v / 100 })}
                  />
                </>
              )}
            </div>
          )}
        </>
      )}

      <span className="text-sm text-slate-600 dark:text-dark-text-muted">
        {count} mark{count === 1 ? "" : "s"}
      </span>

      <button
        type="button"
        onClick={apply}
        disabled={count === 0}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        Apply annotations
      </button>
      <p className="text-xs text-slate-400 dark:text-dark-text-muted">
        {isText
          ? "Tap the page to drop the text. Add a background to cover what’s underneath."
          : "Marks are drawn as vectors — the page text underneath stays selectable."}
      </p>
    </div>
  );
}
