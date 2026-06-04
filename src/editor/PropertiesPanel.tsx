// PropertiesPanel.tsx — The right options panel. Header (active tool name +
// group caption + Cancel when the tool has rollback-able work) over a
// per-tool body. In M0 the tool bodies are placeholders; each tool's real
// options panel is bound here as the tool lands (M1+). When no tool is
// selected, the panel shows a short document summary + hint.

import { X } from "lucide-react";
import { useActiveTool, useEditorActions, useEditorRead } from "./EditorContext.tsx";
import { ToolControls } from "./ToolControls.tsx";
import { EDITOR_GROUP_LABELS, findEditorTool } from "./tools.ts";

export function PropertiesPanel({ collapsed = false }: { collapsed?: boolean }) {
  const activeTool = useActiveTool();
  const { doc, canCancelCurrentTool } = useEditorRead();
  const { cancelCurrentTool } = useEditorActions();
  const tool = findEditorTool(activeTool);

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-slate-200/70 dark:border-dark-border bg-white/60 dark:bg-dark-surface/60 ${
        collapsed ? "w-72" : "w-82"
      }`}
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-200/70 dark:border-dark-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800 dark:text-dark-text">
            {tool ? tool.name : "Document"}
          </p>
          <p className="text-tag font-medium uppercase tracking-[0.12em] text-slate-400 dark:text-dark-text-muted">
            {tool ? EDITOR_GROUP_LABELS[tool.group] : doc ? `${doc.pageCount} pages` : ""}
          </p>
        </div>
        {tool && canCancelCurrentTool && (
          <button
            type="button"
            onClick={() => void cancelCurrentTool()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-dark-surface-alt transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            aria-label="Cancel current tool"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {tool ? (
          <ToolControls />
        ) : (
          <div className="text-sm text-slate-500 dark:text-dark-text-muted">
            <p>Pick a tool from the left to edit this PDF.</p>
            <p className="mt-2 text-xs text-slate-400 dark:text-dark-text-muted">
              Switch to <span className="font-medium">Overview</span> to browse and rearrange pages.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
