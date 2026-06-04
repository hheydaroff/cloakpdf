// EditorView.tsx — Lazy entry point for the canvas editor. Mounts the provider
// stack (EditorProvider owns the doc/history/view; StageProvider owns the
// persistent-canvas registration seam) and renders the shell. App.tsx routes
// `{ kind: "editor" }` here, code-split so the editor's pdf-lib/PDF.js graph
// stays off the home-screen critical path.

import { EditorProvider } from "./EditorContext.tsx";
import { EditorShell } from "./EditorShell.tsx";
import { StageProvider } from "./stage.tsx";

interface EditorViewProps {
  /** PDF to open immediately, or null to show the editor's own dropzone. */
  initialFile: File | null;
  /** Return to the home launcher. */
  onExit: () => void;
}

export default function EditorView({ initialFile, onExit }: EditorViewProps) {
  return (
    <EditorProvider initialFile={initialFile} onExit={onExit}>
      <StageProvider>
        <EditorShell />
      </StageProvider>
    </EditorProvider>
  );
}
