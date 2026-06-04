// registry.tsx — Binds editor tool ids to their implementation: an optional
// Stage (canvas interaction, registers via useStageProps; focus tools only)
// and a Panel (right-side options). This is the id → {Stage, Panel} map the
// two dispatchers (EditorToolStage / ToolControls) read, mirroring CloakIMG's
// Tool/Panel split. Tools land here milestone by milestone; ids absent from the
// map render a placeholder panel and no canvas behaviour.

import type { ComponentType } from "react";
import * as Annotate from "./tools/AnnotateTool.tsx";
import * as Crop from "./tools/CropTool.tsx";
import * as Extract from "./tools/ExtractTool.tsx";
import * as Metadata from "./tools/MetadataTool.tsx";
import * as Organize from "./tools/OrganizeTool.tsx";
import * as Redact from "./tools/RedactTool.tsx";
import * as RemoveBlank from "./tools/RemoveBlankTool.tsx";
import * as Scrub from "./tools/ScrubTool.tsx";
import * as Signature from "./tools/SignatureTool.tsx";
import {
  BatesPanel,
  HeaderFooterPanel,
  PageNumbersPanel,
  WatermarkPanel,
} from "./tools/StampTools.tsx";
import {
  CompressPanel,
  FlattenPanel,
  GrayscalePanel,
  NupPanel,
  RepairPanel,
  ReversePanel,
} from "./tools/SimpleTools.tsx";

export interface ToolImpl {
  /** Registers canvas interaction for focus tools; absent for overview/options tools. */
  Stage?: ComponentType;
  /** The right-panel options body. */
  Panel: ComponentType;
}

export const TOOL_IMPL: Record<string, ToolImpl> = {
  "redact-pdf": { Stage: Redact.Stage, Panel: Redact.Panel },
  "annotate-pdf": { Stage: Annotate.Stage, Panel: Annotate.Panel },
  // Canvas-placement tools: a Stage to place/drag on the page + a Panel.
  signature: { Stage: Signature.Stage, Panel: Signature.Panel },
  "crop-pages": { Stage: Crop.Stage, Panel: Crop.Panel },
  // Overview tools: their Board lives in OverviewMode (center), so no focus
  // Stage here — only the Panel.
  "organize-pages": { Panel: Organize.Panel },
  "extract-pages": { Panel: Extract.Panel },
  "remove-blank-pages": { Panel: RemoveBlank.Panel },
  // Whole-document, options-only tools (no canvas interaction).
  "reverse-pages": { Panel: ReversePanel },
  grayscale: { Panel: GrayscalePanel },
  flatten: { Panel: FlattenPanel },
  "repair-pdf": { Panel: RepairPanel },
  compress: { Panel: CompressPanel },
  "nup-pages": { Panel: NupPanel },
  // Security panels: load an async report on open, then apply.
  metadata: { Panel: Metadata.Panel },
  "pdf-scrub": { Panel: Scrub.Panel },
  // Content-additive stamp-family option tools.
  "add-page-numbers": { Panel: PageNumbersPanel },
  "header-footer": { Panel: HeaderFooterPanel },
  "bates-numbering": { Panel: BatesPanel },
  "stamp-pdf": { Panel: WatermarkPanel },
};

export function toolImpl(id: string | null): ToolImpl | null {
  return id ? (TOOL_IMPL[id] ?? null) : null;
}
