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
import { useEditorActions } from "../EditorContext.tsx";
import { Segmented, WholeDocPanel } from "./WholeDocPanel.tsx";

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
    </WholeDocPanel>
  );
}

export function NupPanel() {
  const { applyTransform } = useEditorActions();
  const [layout, setLayout] = useState<"2x1" | "1x2" | "2x2" | "3x3">("2x2");
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
    </WholeDocPanel>
  );
}
