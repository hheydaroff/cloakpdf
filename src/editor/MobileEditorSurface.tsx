// MobileEditorSurface.tsx — The phone tool surface: an in-flow bottom sheet
// whose body slides open and closed. It is deliberately IN-FLOW (a `shrink-0`
// sibling below the stage, not a fixed overlay) so the canvas above reflows and
// stays fully visible AND tappable while the panel is open — the canvas-
// dominance trick that canvas-placement tools (annotate/sign/crop/redact) rely
// on. The slide is the `grid-template-rows: 0fr → 1fr` reveal: the body grows to
// its natural height and the page reflows with it, smoothly (and instantly under
// reduced motion). The body view is latched so its content keeps rendering
// through the slide-down — the active tool clears the moment Done/Cancel is
// tapped, so ToolControls is fed the just-closed tool's id explicitly. Tool
// selection mirrors the desktop rail; the body reuses the same ToolControls the
// right panel renders.

import { Check, ChevronUp, Grid2x2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useActiveTool, useEditorActions } from "./EditorContext.tsx";
import { ToolControls } from "./ToolControls.tsx";
import { EDITOR_TOOLS, findEditorTool } from "./tools.ts";

/** What the body shows. Latched (held through the slide-down) so the content
 *  doesn't blank out as the tool deactivates on close. */
type SheetView = { kind: "picker" } | { kind: "tool"; id: string };

export function MobileEditorSurface() {
  const activeTool = useActiveTool();
  const { setActiveTool, setViewMode, cancelCurrentTool } = useEditorActions();
  const [pickerOpen, setPickerOpen] = useState(false);

  const tool = findEditorTool(activeTool);
  const open = pickerOpen || tool !== null;

  // Latch the body view so its content (and height) persist through the
  // slide-down when the active tool clears on Done/Cancel. Updated only while
  // open, read while closing.
  const viewRef = useRef<SheetView>({ kind: "picker" });
  if (open) viewRef.current = tool ? { kind: "tool", id: tool.id } : { kind: "picker" };
  const view = viewRef.current;

  const pick = useCallback(
    (id: string) => {
      setActiveTool(id);
      const picked = findEditorTool(id);
      if (picked?.mode === "focus") setViewMode("focus");
      else if (picked?.mode === "overview") setViewMode("overview");
      setPickerOpen(false); // the sheet stays open via the now-active tool
    },
    [setActiveTool, setViewMode],
  );

  const done = useCallback(() => {
    setPickerOpen(false);
    setActiveTool(null);
  }, [setActiveTool]);

  const cancel = useCallback(() => {
    setPickerOpen(false);
    void cancelCurrentTool();
  }, [cancelCurrentTool]);

  return (
    <div className="shrink-0 border-t border-slate-200/70 dark:border-dark-border bg-white dark:bg-dark-surface pb-[max(env(safe-area-inset-bottom),0.5rem)]">
      {/* Header — always visible. The active tool shows its name + Cancel/Done;
          otherwise a full-width "Tools" toggle opens/closes the picker. */}
      {tool ? (
        <div className="flex items-start justify-between gap-2 px-4 py-2.5">
          <div className="min-w-0">
            <span className="block text-sm font-semibold text-slate-800 dark:text-dark-text">
              {tool.name}
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-slate-500 dark:text-dark-text-muted">
              {tool.description}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={cancel}
              className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={done}
              className="flex h-11 w-11 items-center justify-center rounded-md bg-primary-600 text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
              aria-label="Done"
            >
              <Check className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          aria-expanded={pickerOpen}
          className="flex w-full items-center justify-center gap-2 px-4 py-3 text-slate-700 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
          aria-label={pickerOpen ? "Close tools" : "Open tools"}
        >
          <Grid2x2 className="h-[18px] w-[18px]" />
          <span className="text-card-desc font-semibold">Tools</span>
          <ChevronUp
            className={`h-4 w-4 text-slate-400 transition-transform duration-300 ${
              pickerOpen ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
      )}

      {/* Body — slides open/closed by animating the grid row from 0fr to 1fr, so
          the canvas above reflows with it. */}
      <div
        className={`grid ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:transition-[grid-template-rows] motion-safe:duration-300 ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className="thin-scrollbar max-h-[50svh] overflow-y-auto px-4 pb-2 pt-1"
            aria-label={view.kind === "tool" ? "Tool controls" : "Tools"}
          >
            {view.kind === "tool" ? (
              <ToolControls toolId={view.id} />
            ) : (
              <div className="grid grid-cols-4 gap-x-1 gap-y-3 pt-1">
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
                      <span className="text-tag font-medium leading-tight">
                        {t.name.split(" ")[0]}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
