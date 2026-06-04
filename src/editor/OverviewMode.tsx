// OverviewMode.tsx — Chooses what the overview stage shows: the editable
// page-board when the Organize tool is active, otherwise the read-only browse
// grid (click a page → focus). Keeps EditorShell ignorant of the active tool.

import { useActiveTool } from "./EditorContext.tsx";
import { OverviewGrid } from "./OverviewGrid.tsx";
import { Board as OrganizeBoard, ORGANIZE_ID } from "./tools/OrganizeTool.tsx";

export function OverviewMode() {
  const activeTool = useActiveTool();
  return activeTool === ORGANIZE_ID ? <OrganizeBoard /> : <OverviewGrid />;
}
