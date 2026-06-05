// SimpleTools.tsx — The whole-document, options-only tools. Each is a thin
// Panel that funnels an existing pdf-operations writer through applyTransform.
// No canvas interaction, so they render identically on desktop (right panel)
// and mobile (bottom sheet). Structure-changing ops (n-up) drop overlay objects
// since page indices/geometry shift; content-only ops (grayscale, compress,
// flatten, repair) preserve them (still valid in fraction space).
// (Reverse moved into the Organize page-board's quick actions.)

import { useState } from "react";
import {
  compressPdf,
  flattenPdf,
  grayscalePdf,
  nupPages,
  repairPdf,
} from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";
import { Segmented, WholeDocPanel } from "./WholeDocPanel.tsx";

// Per-quality copy for Compress, so the editor explains the trade-off the same
// way the standalone tool does (render scale + JPEG quality + what it means).
const COMPRESS_INFO: Record<"low" | "medium" | "high", string> = {
  low: "Sharpest pages, modest size drop. Renders at 1× with JPEG quality 85%.",
  medium:
    "A balanced size-vs-quality trade-off that suits most documents. Renders at 1.5× with JPEG quality 70%.",
  high: "Smallest file, softest pages — text-heavy PDFs may barely shrink. Renders at 2× with JPEG quality 50%.",
};

export function GrayscalePanel() {
  const { applyTransform } = useEditorActions();
  return (
    <WholeDocPanel
      blurb="Convert every page to grayscale, removing all colour information."
      applyLabel="Convert to grayscale"
      note="Pages are re-rendered as images, so selectable text is lost."
      onApply={() =>
        void applyTransform(async (d) => ({
          bytes: await grayscalePdf(docToFile(d)),
          label: "Grayscale",
        }))
      }
    />
  );
}

export function FlattenPanel() {
  const { applyTransform } = useEditorActions();
  return (
    <WholeDocPanel
      blurb="Remove interactive form fields and annotations, baking them into the page."
      applyLabel="Flatten document"
      note="The result is no longer editable as a form."
      onApply={() =>
        void applyTransform(async (d) => ({
          bytes: await flattenPdf(docToFile(d)),
          label: "Flatten",
        }))
      }
    />
  );
}

export function RepairPanel() {
  const { applyTransform } = useEditorActions();
  return (
    <WholeDocPanel
      blurb="Rebuild the document structure to fix corrupted or malformed PDFs."
      applyLabel="Repair document"
      onApply={() =>
        void applyTransform(async (d) => ({
          bytes: await repairPdf(docToFile(d)),
          label: "Repair",
        }))
      }
    />
  );
}

export function CompressPanel() {
  const { applyTransform } = useEditorActions();
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  return (
    <WholeDocPanel
      blurb="Shrink the file by re-rendering pages as compressed images."
      applyLabel="Compress PDF"
      note="Pages become images — selectable text is lost. Higher compression = smaller file, lower quality."
      onApply={() =>
        void applyTransform(async (d) => ({
          bytes: await compressPdf(docToFile(d), quality),
          label: `Compress (${quality})`,
        }))
      }
    >
      <Segmented
        value={quality}
        onChange={setQuality}
        options={[
          { value: "low", label: "Light", sub: "Best quality" },
          { value: "medium", label: "Balanced" },
          { value: "high", label: "Max", sub: "Smallest" },
        ]}
      />
      <p className="rounded-lg bg-slate-50 dark:bg-dark-bg px-3 py-2 text-xs text-slate-500 dark:text-dark-text-muted">
        {COMPRESS_INFO[quality]}
      </p>
    </WholeDocPanel>
  );
}

type NupLayout = "2x1" | "1x2" | "2x2" | "3x3";

/** Live preview of how sheet 1 will look: the first cols×rows page thumbnails
 *  arranged in the chosen grid, using the already-rendered previews (no extra
 *  render pass). */
function NupPreview({ layout }: { layout: NupLayout }) {
  const { doc } = useEditorRead();
  const [cols, rows] = layout.split("x").map(Number);
  const perSheet = cols * rows;
  const pages = doc?.pages ?? [];
  // Each cell is one grid slot on a sheet the size of page 1, so its aspect is
  // the page aspect × (rows / cols). With object-contain on the thumbnail this
  // mirrors nupPages' real letterboxed output (page fit + centred in the cell).
  const first = pages[0];
  const pageAspect = first ? first.widthPt / first.heightPt : 0.7727;
  const cellAspect = (pageAspect * rows) / cols;
  const sheets = pages.length > 0 ? Math.ceil(pages.length / perSheet) : 0;

  return (
    <div>
      <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
        Preview — sheet 1
      </p>
      <div className="rounded-lg border border-slate-200 dark:border-dark-border bg-slate-50 dark:bg-dark-bg p-2">
        <div
          className="mx-auto grid w-full max-w-45 gap-1"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: perSheet }, (_, i) => {
            const url = pages[i]?.thumbUrl ?? null;
            return (
              <div
                key={i}
                className="overflow-hidden rounded-sm border border-slate-200 dark:border-dark-border bg-white"
                style={{ aspectRatio: String(cellAspect) }}
              >
                {url ? (
                  <img
                    src={url}
                    alt=""
                    className="h-full w-full object-contain"
                    draggable={false}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {sheets > 0 && (
        <p className="mt-1.5 text-xs text-slate-400 dark:text-dark-text-muted tabular-nums">
          {pages.length} {pages.length === 1 ? "page" : "pages"} → {sheets}{" "}
          {sheets === 1 ? "sheet" : "sheets"} ({perSheet} per sheet)
        </p>
      )}
    </div>
  );
}

export function NupPanel() {
  const { applyTransform } = useEditorActions();
  const [layout, setLayout] = useState<NupLayout>("2x2");
  return (
    <WholeDocPanel
      blurb="Arrange several pages onto each sheet for compact printing."
      applyLabel="Apply N-up layout"
      onApply={() =>
        void applyTransform(async (d) => ({
          bytes: await nupPages(docToFile(d), layout),
          label: `N-up ${layout}`,
          objects: [],
        }))
      }
    >
      <Segmented
        value={layout}
        onChange={setLayout}
        options={[
          { value: "2x1", label: "2", sub: "↔" },
          { value: "1x2", label: "2", sub: "↕" },
          { value: "2x2", label: "4" },
          { value: "3x3", label: "9" },
        ]}
      />
      <NupPreview layout={layout} />
    </WholeDocPanel>
  );
}
