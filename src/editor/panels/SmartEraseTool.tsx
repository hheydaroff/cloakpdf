// SmartEraseTool.tsx — Drag boxes over blemishes, logos, stains, or faces and
// make them vanish: Fill samples the surrounding colour and patches the box
// (best on solid backgrounds), Pixelate mosaics it (de-identify a face / plate).
// Like Redact it is destructive — erasePdf rasterises the touched pages and
// burns the patch into the pixels, so the covered content is physically gone,
// not just hidden behind a vector shape. Regions live in the tool slice (like
// Crop's `keep`); the Stage drags them, the Panel applies + clears.

import { Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { type EraseRegion, erasePdf } from "../../utils/pdf-operations.ts";
import { docToFile, nextId } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";
import { useStageProps } from "../stage.tsx";
import type { FractionRect } from "../types.ts";
import { Labeled } from "./controls.tsx";
import { Segmented, WholeDocPanel } from "./WholeDocPanel.tsx";

const TOOL_ID = "smart-erase";

type Mode = "fill" | "pixelate";
type Coarseness = "subtle" | "medium" | "strong";

const BLOCK_FRAC: Record<Coarseness, number> = { subtle: 0.06, medium: 0.12, strong: 0.22 };

interface Region {
  id: string;
  pageIndex: number;
  rect: FractionRect;
}

interface EraseSlice {
  regions: Region[];
  mode: Mode;
  coarseness: Coarseness;
}

function readSlice(slice: Record<string, unknown>): EraseSlice {
  return {
    regions: (slice.regions as Region[]) ?? [],
    mode: (slice.mode as Mode) ?? "fill",
    coarseness: (slice.coarseness as Coarseness) ?? "medium",
  };
}

function drawBox(ctx: CanvasRenderingContext2D, r: FractionRect, w: number, h: number) {
  const x = r.xPct * w;
  const y = r.yPct * h;
  const bw = r.wPct * w;
  const bh = r.hPct * h;
  ctx.save();
  ctx.fillStyle = "rgba(100, 116, 139, 0.30)";
  ctx.fillRect(x, y, bw, bh);
  ctx.strokeStyle = "rgba(71, 85, 105, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x, y, bw, bh);
  ctx.restore();
}

export function Stage() {
  const slice = useToolSlice(TOOL_ID);
  const { regions } = readSlice(slice);
  const { selectedPage } = useEditorRead();
  const { patchToolState } = useEditorActions();
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<FractionRect | null>(null);

  const paintOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pageIndex: number) => {
      for (const r of regions) if (r.pageIndex === pageIndex) drawBox(ctx, r.rect, w, h);
      if (box) drawBox(ctx, box, w, h);
    },
    [regions, box],
  );

  useStageProps({
    cursor: "crosshair",
    paintOverlay,
    onPointerDown: (p) => {
      startRef.current = { x: p.xPct, y: p.yPct };
    },
    onPointerMove: (p) => {
      const s = startRef.current;
      if (!s) return;
      setBox({
        xPct: Math.min(s.x, p.xPct),
        yPct: Math.min(s.y, p.yPct),
        wPct: Math.abs(p.xPct - s.x),
        hPct: Math.abs(p.yPct - s.y),
      });
    },
    onPointerUp: (p) => {
      const s = startRef.current;
      startRef.current = null;
      setBox(null);
      if (!s) return;
      const rect: FractionRect = {
        xPct: Math.min(s.x, p.xPct),
        yPct: Math.min(s.y, p.yPct),
        wPct: Math.abs(p.xPct - s.x),
        hPct: Math.abs(p.yPct - s.y),
      };
      if (rect.wPct > 0.01 && rect.hPct > 0.01) {
        const { regions: cur } = readSlice(slice);
        patchToolState(TOOL_ID, {
          regions: [...cur, { id: nextId("erase"), pageIndex: selectedPage, rect }],
        });
      }
    },
    onPointerCancel: () => {
      startRef.current = null;
      setBox(null);
    },
  });

  return null;
}

export function Panel() {
  const { applyTransform, patchToolState, setSelectedPage, setViewMode } = useEditorActions();
  const slice = readSlice(useToolSlice(TOOL_ID));
  const { regions, mode, coarseness } = slice;

  const remove = (id: string) =>
    patchToolState(TOOL_ID, { regions: regions.filter((r) => r.id !== id) });
  const clearAll = () => patchToolState(TOOL_ID, { regions: [] });

  const apply = useCallback(() => {
    if (regions.length === 0) return;
    const eraseRegions: EraseRegion[] = regions.map((r) => ({
      pageIndex: r.pageIndex,
      xPct: r.rect.xPct,
      yPct: r.rect.yPct,
      wPct: r.rect.wPct,
      hPct: r.rect.hPct,
      mode,
      blockFrac: BLOCK_FRAC[coarseness],
    }));
    void applyTransform(async (d) => ({
      bytes: await erasePdf(docToFile(d), eraseRegions),
      label: `Erase ${eraseRegions.length} area${eraseRegions.length === 1 ? "" : "s"}`,
      objects: d.objects,
    })).then(() => patchToolState(TOOL_ID, { regions: [] }));
  }, [regions, mode, coarseness, applyTransform, patchToolState]);

  return (
    <WholeDocPanel
      blurb="Drag a box over anything you want gone — a stain, a logo, a face — then erase."
      applyLabel={`Erase ${regions.length} area${regions.length === 1 ? "" : "s"}`}
      danger
      disabled={regions.length === 0}
      onApply={apply}
      note="Erased pages are flattened to images, so the covered content is permanently removed."
    >
      <Labeled label="Method">
        <Segmented
          value={mode}
          onChange={(m: Mode) => patchToolState(TOOL_ID, { mode: m })}
          options={[
            { value: "fill", label: "Fill", sub: "solid bg" },
            { value: "pixelate", label: "Pixelate", sub: "faces" },
          ]}
        />
      </Labeled>

      {mode === "pixelate" && (
        <Labeled label="Coarseness">
          <Segmented
            value={coarseness}
            onChange={(c: Coarseness) => patchToolState(TOOL_ID, { coarseness: c })}
            options={[
              { value: "subtle", label: "Subtle" },
              { value: "medium", label: "Medium" },
              { value: "strong", label: "Strong" },
            ]}
          />
        </Labeled>
      )}

      {regions.length === 0 ? (
        <div className="rounded-lg bg-slate-50 dark:bg-dark-bg px-3 py-2 text-xs text-slate-500 dark:text-dark-text-muted">
          Drag on the page to mark an area to erase.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
              {regions.length} area{regions.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-primary-600 hover:underline"
            >
              Clear all
            </button>
          </div>
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 dark:border-dark-border divide-y divide-slate-100 dark:divide-dark-border">
            {regions.map((r, i) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-1 px-2.5 py-1.5 text-xs"
              >
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPage(r.pageIndex);
                    setViewMode("focus");
                  }}
                  className="min-w-0 flex-1 truncate rounded text-left text-slate-600 dark:text-dark-text-muted hover:text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  Area {i + 1} · page {r.pageIndex + 1}
                </button>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  aria-label={`Remove area ${i + 1}`}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-slate-400 dark:text-dark-text-muted">
        Fill matches a solid surrounding colour; for textured areas or faces, use Pixelate.
      </p>
    </WholeDocPanel>
  );
}
