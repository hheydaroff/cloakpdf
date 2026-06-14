// SimpleTools.tsx — The N-up page-layout tool: a thin options-only Panel that
// funnels nupPages through applyTransform. No canvas interaction, so it renders
// identically on desktop (right panel) and mobile (bottom sheet). N-up is
// structure-changing (page indices/geometry shift) so it drops overlay objects.
//
// (Compress / Grayscale / Flatten / Repair used to live here too; they moved to
// the Export modal as terminal "convert then download" outputs. Reverse moved
// into the Organize page-board's quick actions.)

import { useState } from "react";
import { nupPages } from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";
import { Segmented, WholeDocPanel } from "./WholeDocPanel.tsx";

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
        <p className="mt-1.5 text-xs text-slate-500 dark:text-dark-text-muted tabular-nums">
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
