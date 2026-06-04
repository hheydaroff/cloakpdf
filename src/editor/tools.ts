// tools.ts — Rail metadata for the canvas editor's single-PDF tools.
//
// This is metadata only (id / label / icon / group / which view mode it drives
// / build status). The actual Tool behaviour (canvas interaction) and Panel
// (right-side options) are bound per id in the dispatchers, mirroring CloakIMG.
// The roster is the 20 workflow-eligible single-PDF tools plus redact + ocr —
// see REDESIGN.md for the disposition of every CloakPDF tool. Multi-file /
// terminal / security-cert / AI tools are NOT here; they live outside the editor.

import {
  AlignCenter,
  Archive,
  BookMarked,
  ClipboardList,
  Contrast,
  Crop,
  Eraser,
  EyeOff,
  FileOutput,
  FileText,
  FileX,
  Grid2x2,
  Hash,
  Highlighter,
  Layers,
  LayoutGrid,
  Paperclip,
  PenTool,
  Repeat2,
  Scale,
  ScanText,
  Stamp,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

export type EditorToolGroup = "security" | "annotate" | "pages" | "transform" | "document";

/** Which stage the tool operates in. `overview` tools act on the page grid;
 *  `focus` tools draw on / configure a single page; `either` work in both. */
export type EditorToolMode = "focus" | "overview" | "either";

/** Build status — lets the rail render the full target roster now while tools
 *  land milestone by milestone. `soon` tools show a placeholder panel. */
export type EditorToolStatus = "ready" | "soon";

export interface EditorTool {
  id: string;
  name: string;
  icon: ComponentType<{ className?: string }>;
  group: EditorToolGroup;
  mode: EditorToolMode;
  status: EditorToolStatus;
}

export const EDITOR_GROUP_LABELS: Record<EditorToolGroup, string> = {
  security: "Privacy & Security",
  annotate: "Annotate & Sign",
  pages: "Pages",
  transform: "Transform",
  document: "Document",
};

// Rail order: privacy first (brand-defining, à la CloakIMG's Redact placement),
// then annotate, pages, transform, document. Within a group, most-used first.
export const EDITOR_TOOLS: EditorTool[] = [
  // Privacy & Security
  {
    id: "redact-pdf",
    name: "Redact",
    icon: EyeOff,
    group: "security",
    mode: "focus",
    status: "soon",
  },
  {
    id: "pdf-scrub",
    name: "Scrub",
    icon: Eraser,
    group: "security",
    mode: "either",
    status: "soon",
  },
  {
    id: "metadata",
    name: "Metadata",
    icon: FileText,
    group: "security",
    mode: "either",
    status: "soon",
  },

  // Annotate & Sign
  {
    id: "annotate-pdf",
    name: "Annotate",
    icon: Highlighter,
    group: "annotate",
    mode: "focus",
    status: "soon",
  },
  {
    id: "signature",
    name: "Signature",
    icon: PenTool,
    group: "annotate",
    mode: "focus",
    status: "soon",
  },
  { id: "stamp-pdf", name: "Stamp", icon: Stamp, group: "annotate", mode: "focus", status: "soon" },
  {
    id: "add-page-numbers",
    name: "Page numbers",
    icon: Hash,
    group: "annotate",
    mode: "either",
    status: "soon",
  },
  {
    id: "header-footer",
    name: "Header & footer",
    icon: AlignCenter,
    group: "annotate",
    mode: "either",
    status: "soon",
  },
  {
    id: "bates-numbering",
    name: "Bates",
    icon: Scale,
    group: "annotate",
    mode: "either",
    status: "soon",
  },
  {
    id: "fill-pdf-form",
    name: "Fill form",
    icon: ClipboardList,
    group: "annotate",
    mode: "focus",
    status: "soon",
  },

  // Pages
  {
    id: "organize-pages",
    name: "Organize",
    icon: Grid2x2,
    group: "pages",
    mode: "overview",
    status: "soon",
  },
  {
    id: "extract-pages",
    name: "Extract",
    icon: FileOutput,
    group: "pages",
    mode: "overview",
    status: "soon",
  },
  {
    id: "reverse-pages",
    name: "Reverse",
    icon: Repeat2,
    group: "pages",
    mode: "overview",
    status: "soon",
  },
  {
    id: "remove-blank-pages",
    name: "Remove blank",
    icon: FileX,
    group: "pages",
    mode: "overview",
    status: "soon",
  },
  {
    id: "nup-pages",
    name: "N-up",
    icon: LayoutGrid,
    group: "pages",
    mode: "either",
    status: "soon",
  },

  // Transform
  { id: "crop-pages", name: "Crop", icon: Crop, group: "transform", mode: "focus", status: "soon" },
  {
    id: "compress",
    name: "Compress",
    icon: Archive,
    group: "transform",
    mode: "either",
    status: "soon",
  },
  {
    id: "grayscale",
    name: "Grayscale",
    icon: Contrast,
    group: "transform",
    mode: "either",
    status: "soon",
  },
  {
    id: "flatten",
    name: "Flatten",
    icon: Layers,
    group: "transform",
    mode: "either",
    status: "soon",
  },
  {
    id: "repair-pdf",
    name: "Repair",
    icon: Wrench,
    group: "transform",
    mode: "either",
    status: "soon",
  },
  { id: "ocr", name: "OCR", icon: ScanText, group: "transform", mode: "either", status: "soon" },

  // Document
  {
    id: "add-bookmarks",
    name: "Bookmarks",
    icon: BookMarked,
    group: "document",
    mode: "either",
    status: "soon",
  },
  {
    id: "file-attachment",
    name: "Attachments",
    icon: Paperclip,
    group: "document",
    mode: "either",
    status: "soon",
  },
];

export function findEditorTool(id: string | null): EditorTool | null {
  if (!id) return null;
  return EDITOR_TOOLS.find((t) => t.id === id) ?? null;
}

/** Rail groups in display order, each with its tools. */
export function editorToolGroups(): {
  group: EditorToolGroup;
  label: string;
  tools: EditorTool[];
}[] {
  const order: EditorToolGroup[] = ["security", "annotate", "pages", "transform", "document"];
  return order.map((group) => ({
    group,
    label: EDITOR_GROUP_LABELS[group],
    tools: EDITOR_TOOLS.filter((t) => t.group === group),
  }));
}
