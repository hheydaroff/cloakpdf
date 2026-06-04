// MobileEditorSurface.tsx — One in-flow bottom surface, three states
// (collapsed → picker → tool), modeled on CloakIMG's MobileEditorSurface but
// trimmed for M0 (no drag-physics yet; CSS height transition). Because it's an
// in-flow shrink-0 sibling below the stage — not fixed/absolute — the page
// above reflows and stays fully visible while a panel is open: the
// canvas-dominance trick. Tool selection mirrors the desktop rail; the body
// reuses the same ToolPanelBody the right panel renders.

import { Check, Grid2x2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useActiveTool, useEditorActions } from "./EditorContext.tsx";
import { ToolControls } from "./ToolControls.tsx";
import { EDITOR_TOOLS, findEditorTool } from "./tools.ts";

type Mode = "collapsed" | "picker";

export function MobileEditorSurface() {
  const activeTool = useActiveTool();
  const { setActiveTool, setViewMode, cancelCurrentTool } = useEditorActions();
  const [mode, setMode] = useState<Mode>("collapsed");

  const tool = findEditorTool(activeTool);
  const expanded = mode === "picker" || tool !== null;

  const pick = useCallback(
    (id: string) => {
      setActiveTool(id);
      const picked = findEditorTool(id);
      if (picked?.mode === "focus") setViewMode("focus");
      else if (picked?.mode === "overview") setViewMode("overview");
      setMode("collapsed"); // tool mode is driven by activeTool, not local mode
    },
    [setActiveTool, setViewMode],
  );

  const done = useCallback(() => {
    setActiveTool(null);
    setMode("collapsed");
  }, [setActiveTool]);

  const cancel = useCallback(() => {
    void cancelCurrentTool();
    setMode("collapsed");
  }, [cancelCurrentTool]);

  if (!expanded) {
    return (
      <div className="flex shrink-0 items-center justify-center pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
        <button
          type="button"
          onClick={() => setMode("picker")}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-slate-700 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          aria-label="Open tools"
        >
          <Grid2x2 className="h-[18px] w-[18px]" />
          <span className="text-[13px] font-semibold">Tools</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden rounded-t-2xl border-t border-slate-200/70 dark:border-dark-border bg-white dark:bg-dark-surface"
      style={{ maxHeight: "50vh" }}
      role="dialog"
      aria-modal="true"
      aria-label={tool ? "Tool controls" : "Tools"}
    >
      <div className="flex items-center justify-between border-b border-slate-200/70 dark:border-dark-border px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-800 dark:text-dark-text">
          {tool ? tool.name : "Tools"}
        </span>
        {tool ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={cancel}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={done}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-600 text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
              aria-label="Done"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setMode("collapsed")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-dark-surface-alt"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {tool ? (
          <ToolControls />
        ) : (
          <div className="grid grid-cols-4 gap-x-1 gap-y-3">
            {EDITOR_TOOLS.map((t) => {
              const Icon = t.icon;
              const on = t.id === activeTool;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pick(t.id)}
                  aria-label={t.name}
                  aria-pressed={on}
                  className={`flex flex-col items-center gap-1.5 rounded-xl border px-1 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                    on
                      ? "border-primary-200 bg-primary-50 text-primary-600 dark:border-primary-900/40 dark:bg-primary-900/30 dark:text-primary-300"
                      : "border-transparent text-slate-700 hover:bg-slate-50 dark:text-dark-text dark:hover:bg-dark-surface-alt"
                  }`}
                >
                  <Icon className="h-6 w-6" />
                  <span className="text-tag font-medium leading-tight">{t.name.split(" ")[0]}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
