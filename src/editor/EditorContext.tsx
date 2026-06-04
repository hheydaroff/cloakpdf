// EditorContext.tsx — Single source of truth for the canvas editor: the
// document, per-tool state, view (zoom/pan/page/mode), history, and layout.
//
// Ported in spirit from CloakIMG's EditorContext but PDF-shaped: the document
// is multi-page, history is byte+object snapshots (never rasters), and per-tool
// state is namespaced (Record<toolId, slice>) rather than one flat struct.
//
// State is split across focused contexts so a slider drag in one tool doesn't
// re-render the rail / top bar / every other panel:
//   • ActionsCtx    — stable callbacks; identity never changes after mount.
//   • ToolStateCtx  — the namespaced per-tool option slices (high-frequency).
//   • ActiveToolCtx — just the active tool id (flips only on tool switch).
//   • ReadCtx       — doc, view, layout, history flags (infrequent).
// `useEditor()` merges all four for convenience.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { detectLayout } from "./breakpoints.ts";
import {
  type CanvasDoc,
  type CanvasObject,
  createDocFromBytes,
  createDocFromFile,
  nextId,
  revokeDocThumbnails,
} from "./doc.ts";
import {
  deleteDraft,
  type EditorDraft,
  getLatestDraft,
  hashDocBytes,
  loadDraft,
  saveDraft,
} from "./draft-store.ts";
import { EditorHistory } from "./history.ts";
import { DEFAULT_VIEW, type Layout, type ViewMode, type ViewState } from "./types.ts";

/** A serializable byte transform — the single funnel every byte mutation runs
 *  through (canvas Apply buttons, right-panel Apply, headless workflow runner).
 *  Receives the live doc, returns new bytes + a history label, and optionally
 *  the overlay object list to keep. Destructive/overlay-burn tools (redact,
 *  annotate) return `objects` to DROP the marks they just baked into pixels;
 *  omitting it preserves the current objects (valid in fraction space). */
export type DocTransform = (
  doc: CanvasDoc,
) => Promise<{ bytes: Uint8Array; label: string; objects?: CanvasObject[] }>;

interface ActionsValue {
  loadFile: (file: File) => Promise<void>;
  setActiveTool: (id: string | null) => void;
  patchToolState: (toolId: string, partial: Record<string, unknown>) => void;
  setView: (v: ViewState | ((prev: ViewState) => ViewState)) => void;
  setViewMode: (m: ViewMode) => void;
  setSelectedPage: (i: number) => void;
  /** Apply a byte transform under the busy spinner, re-render pages, commit. */
  applyTransform: (t: DocTransform) => Promise<void>;
  addObject: (obj: Omit<CanvasObject, "id">) => void;
  /** Add many overlay objects in a single history entry (e.g. PII auto-detect). */
  addObjects: (objs: Omit<CanvasObject, "id">[], label?: string) => void;
  updateObject: (id: string, patch: Partial<CanvasObject>) => void;
  removeObject: (id: string) => void;
  commit: (label: string) => void;
  undo: () => void;
  redo: () => void;
  jumpTo: (index: number) => void;
  reset: () => void;
  registerPendingApply: (fn: (() => void | Promise<void>) | null) => void;
  flushPendingApply: () => Promise<void>;
  cancelCurrentTool: () => Promise<void>;
  /** Run an async task under the busy spinner WITHOUT committing to history
   *  (export, contact-sheet, etc. don't mutate the doc). */
  runTask: (label: string, fn: () => Promise<void>) => Promise<void>;
  /** Restore the draft offered for the just-loaded file (the banner's action). */
  restoreDraft: () => Promise<void>;
  /** Discard the offered draft and keep the freshly-loaded original. */
  dismissDraft: () => void;
  /** Restore the most-recent draft (the empty editor's "last session" card). */
  restoreLatestDraft: () => Promise<void>;
  exit: () => void;
}

interface ReadValue {
  doc: CanvasDoc | null;
  loading: boolean;
  busyLabel: string | null;
  error: string | null;
  view: ViewState;
  viewMode: ViewMode;
  selectedPage: number;
  layout: Layout;
  canUndo: boolean;
  canRedo: boolean;
  canReset: boolean;
  canCancelCurrentTool: boolean;
  /** Bumps on every history mutation so consumers re-derive from the doc. */
  historyVersion: number;
  /** Unsaved edits recovered for the just-loaded file, pending the user's
   *  Restore / Discard choice (null when none). */
  pendingDraft: EditorDraft | null;
  /** Most-recent draft, surfaced on the empty editor as "restore last session". */
  latestDraft: EditorDraft | null;
}

interface ToolStateValue {
  toolState: Record<string, Record<string, unknown>>;
}

const ActionsCtx = createContext<ActionsValue | null>(null);
const ReadCtx = createContext<ReadValue | null>(null);
const ToolStateCtx = createContext<ToolStateValue | null>(null);
const ActiveToolCtx = createContext<string | null>(null);

interface ProviderProps {
  initialFile?: File | null;
  onExit: () => void;
  children: ReactNode;
}

export function EditorProvider({ initialFile = null, onExit, children }: ProviderProps) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [activeTool, setActiveToolState] = useState<string | null>(null);
  const [toolState, setToolState] = useState<Record<string, Record<string, unknown>>>({});
  const [view, setViewState] = useState<ViewState>(DEFAULT_VIEW);
  const [viewMode, setViewModeState] = useState<ViewMode>("focus");
  const [selectedPage, setSelectedPageState] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  // Draft autosave: pendingDraft is offered after loading a file that has saved
  // edits; latestDraft powers the empty editor's "restore last session" card.
  const [pendingDraft, setPendingDraft] = useState<EditorDraft | null>(null);
  const [latestDraft, setLatestDraft] = useState<EditorDraft | null>(null);
  // SHA-256 of the ORIGINAL loaded bytes — the draft key, stable across byte
  // transforms; null suspends autosave (no file, or hashing in flight).
  const draftKeyRef = useRef<string | null>(null);
  const pendingDraftRef = useRef<EditorDraft | null>(null);
  pendingDraftRef.current = pendingDraft;
  const latestDraftRef = useRef<EditorDraft | null>(null);
  latestDraftRef.current = latestDraft;

  const [layout, setLayout] = useState<Layout>(() =>
    typeof window === "undefined" ? "desktop" : detectLayout(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    const onResize = () => setLayout(detectLayout(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Latch the live doc so the (stable-identity) actions below always read the
  // freshest value without re-creating their closures. Mirrors CloakIMG's
  // docRef / undoRef pattern.
  const docRef = useRef<CanvasDoc | null>(null);
  docRef.current = doc;

  const historyRef = useRef(new EditorHistory());
  const pendingApplyRef = useRef<(() => void | Promise<void>) | null>(null);
  const [pendingApplyVersion, setPendingApplyVersion] = useState(0);
  const toolCheckpointRef = useRef(0);

  // Revoke thumbnails on unmount so previews never leak across sessions.
  useEffect(() => {
    return () => revokeDocThumbnails(docRef.current);
  }, []);

  const runBusy = useCallback((label: string, fn: () => void | Promise<void>): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      setBusyLabel(label);
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          try {
            await fn();
            resolve();
          } catch (e) {
            reject(e);
          } finally {
            setBusyLabel(null);
          }
        });
      });
    });
  }, []);

  /** Set a brand-new doc as the base of a fresh history timeline. */
  const installDoc = useCallback((next: CanvasDoc) => {
    revokeDocThumbnails(docRef.current);
    setDoc(next);
    setSelectedPageState(0);
    setViewState(DEFAULT_VIEW);
    setToolState({});
    historyRef.current.clear();
    historyRef.current.push({
      label: "Open",
      bytes: next.bytes,
      pages: next.pages,
      objects: next.objects,
    });
    toolCheckpointRef.current = historyRef.current.index();
    setHistoryVersion((v) => v + 1);
    // A document is live now — the "restore last session" affordance is moot.
    setLatestDraft(null);
  }, []);

  // After installing a freshly-loaded file, key the autosave to its original
  // bytes and offer back any saved edits for that same file.
  const detectDraft = useCallback(async (next: CanvasDoc) => {
    try {
      const key = await hashDocBytes(next.bytes);
      draftKeyRef.current = key;
      const existing = await loadDraft(key);
      if (existing) setPendingDraft(existing);
    } catch {
      // IndexedDB / SubtleCrypto unavailable — autosave silently disabled.
    }
  }, []);

  const loadFile = useCallback(
    async (file: File) => {
      setLoading(true);
      setError(null);
      setPendingDraft(null);
      draftKeyRef.current = null; // suspend autosave until re-keyed for this file
      try {
        const next = await createDocFromFile(file);
        installDoc(next);
        void detectDraft(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not open this PDF.");
      } finally {
        setLoading(false);
      }
    },
    [installDoc, detectDraft],
  );

  // Load the file the editor was opened with (if any), once.
  const initialLoadedRef = useRef(false);
  useEffect(() => {
    if (initialLoadedRef.current) return;
    if (!initialFile) return;
    initialLoadedRef.current = true;
    void loadFile(initialFile);
  }, [initialFile, loadFile]);

  /** Commit a new doc state to history and make it live. */
  const commitDoc = useCallback((next: CanvasDoc, label: string) => {
    setDoc(next);
    historyRef.current.push({
      label,
      bytes: next.bytes,
      pages: next.pages,
      objects: next.objects,
    });
    toolCheckpointRef.current = historyRef.current.index();
    setHistoryVersion((v) => v + 1);
  }, []);

  const commit = useCallback(
    (label: string) => {
      const cur = docRef.current;
      if (!cur) return;
      commitDoc(cur, label);
    },
    [commitDoc],
  );

  const restoreEntry = useCallback(() => {
    const entry = historyRef.current.current();
    const cur = docRef.current;
    if (!entry || !cur) return;
    setDoc({ ...cur, bytes: entry.bytes, pages: entry.pages, objects: entry.objects });
    setHistoryVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    if (!historyRef.current.undo()) return;
    restoreEntry();
  }, [restoreEntry]);

  const redo = useCallback(() => {
    if (!historyRef.current.redo()) return;
    restoreEntry();
  }, [restoreEntry]);

  const jumpTo = useCallback(
    (index: number) => {
      historyRef.current.jumpTo(index);
      restoreEntry();
    },
    [restoreEntry],
  );

  const reset = useCallback(() => {
    historyRef.current.jumpTo(0);
    restoreEntry();
  }, [restoreEntry]);

  const setActiveTool = useCallback((id: string | null) => {
    setActiveToolState(id);
    toolCheckpointRef.current = historyRef.current.index();
  }, []);

  const patchToolState = useCallback((toolId: string, partial: Record<string, unknown>) => {
    setToolState((prev) => ({ ...prev, [toolId]: { ...prev[toolId], ...partial } }));
  }, []);

  const setView = useCallback((v: ViewState | ((prev: ViewState) => ViewState)) => {
    setViewState((prev) => (typeof v === "function" ? v(prev) : v));
  }, []);
  const setViewMode = useCallback((m: ViewMode) => setViewModeState(m), []);
  const setSelectedPage = useCallback((i: number) => setSelectedPageState(i), []);

  const addObject = useCallback((obj: Omit<CanvasObject, "id">) => {
    const cur = docRef.current;
    if (!cur) return;
    const full: CanvasObject = { ...obj, id: nextId(obj.kind) };
    const next: CanvasDoc = { ...cur, objects: [...cur.objects, full] };
    setDoc(next);
    historyRef.current.push({
      label: `Add ${obj.kind}`,
      bytes: next.bytes,
      pages: next.pages,
      objects: next.objects,
    });
    setHistoryVersion((v) => v + 1);
  }, []);

  const addObjects = useCallback((objs: Omit<CanvasObject, "id">[], label?: string) => {
    const cur = docRef.current;
    if (!cur || objs.length === 0) return;
    const full = objs.map((o) => ({ ...o, id: nextId(o.kind) }));
    const next: CanvasDoc = { ...cur, objects: [...cur.objects, ...full] };
    setDoc(next);
    historyRef.current.push({
      label: label ?? `Add ${objs.length} objects`,
      bytes: next.bytes,
      pages: next.pages,
      objects: next.objects,
    });
    setHistoryVersion((v) => v + 1);
  }, []);

  const updateObject = useCallback((id: string, patch: Partial<CanvasObject>) => {
    const cur = docRef.current;
    if (!cur) return;
    setDoc({
      ...cur,
      objects: cur.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    });
  }, []);

  const removeObject = useCallback((id: string) => {
    const cur = docRef.current;
    if (!cur) return;
    const next: CanvasDoc = { ...cur, objects: cur.objects.filter((o) => o.id !== id) };
    setDoc(next);
    historyRef.current.push({
      label: "Remove object",
      bytes: next.bytes,
      pages: next.pages,
      objects: next.objects,
    });
    setHistoryVersion((v) => v + 1);
  }, []);

  const applyTransform = useCallback(
    async (t: DocTransform) => {
      const cur = docRef.current;
      if (!cur) return;
      await runBusy("Applying…", async () => {
        const { bytes, label, objects } = await t(cur);
        // Re-derive page geometry + thumbnails from the new bytes. Keep the
        // objects the transform returned (used to drop just-burned marks), or
        // preserve the current ones (still valid in fraction space).
        const rebuilt = await createDocFromBytes(bytes, cur.fileName);
        revokeDocThumbnails(cur);
        commitDoc({ ...rebuilt, id: cur.id, objects: objects ?? cur.objects }, label);
      });
    },
    [runBusy, commitDoc],
  );

  const registerPendingApply = useCallback((fn: (() => void | Promise<void>) | null) => {
    const wasNull = pendingApplyRef.current === null;
    pendingApplyRef.current = fn;
    if (wasNull !== (fn === null)) setPendingApplyVersion((v) => v + 1);
  }, []);

  const flushPendingApply = useCallback(async () => {
    const fn = pendingApplyRef.current;
    if (!fn) return;
    pendingApplyRef.current = null;
    setPendingApplyVersion((v) => v + 1);
    await fn();
  }, []);

  const cancelCurrentTool = useCallback(async () => {
    pendingApplyRef.current = null;
    setPendingApplyVersion((v) => v + 1);
    const checkpoint = toolCheckpointRef.current;
    while (historyRef.current.index() > checkpoint) {
      const before = historyRef.current.index();
      historyRef.current.undo();
      if (historyRef.current.index() === before) break;
    }
    restoreEntry();
    setActiveToolState(null);
  }, [restoreEntry]);

  const exit = useCallback(() => {
    revokeDocThumbnails(docRef.current);
    onExit();
  }, [onExit]);

  // ── Draft autosave: restore / discard ───────────────────────────────
  const applyDraft = useCallback(
    async (draft: EditorDraft) => {
      setPendingDraft(null);
      await runBusy("Restoring your edits…", async () => {
        const restored = await createDocFromBytes(draft.bytes, draft.fileName);
        restored.objects = draft.objects;
        draftKeyRef.current = draft.key; // keep the same original-bytes key
        installDoc(restored);
      });
    },
    [runBusy, installDoc],
  );

  const restoreDraft = useCallback(async () => {
    const draft = pendingDraftRef.current;
    if (draft) await applyDraft(draft);
  }, [applyDraft]);

  const restoreLatestDraft = useCallback(async () => {
    const draft = latestDraftRef.current;
    if (draft) await applyDraft(draft);
  }, [applyDraft]);

  const dismissDraft = useCallback(() => {
    const draft = pendingDraftRef.current;
    setPendingDraft(null);
    if (draft) void deleteDraft(draft.key);
  }, []);

  // Persist the live document, debounced, whenever it carries real edits — so
  // an accidental unmount / tab-close doesn't destroy unsaved overlay work.
  useEffect(() => {
    const key = draftKeyRef.current;
    if (!key || !doc) return;
    if (historyRef.current.index() <= 0) return; // pristine — nothing to save yet
    const id = setTimeout(() => {
      void saveDraft({
        key,
        fileName: doc.fileName,
        bytes: doc.bytes,
        objects: doc.objects,
        savedAt: Date.now(),
      });
    }, 800);
    return () => clearTimeout(id);
  }, [doc, historyVersion]);

  // On opening the empty editor (no initial file), surface the most-recent draft.
  useEffect(() => {
    if (initialFile) return;
    void getLatestDraft().then(setLatestDraft);
  }, [initialFile]);

  const actions = useMemo<ActionsValue>(
    () => ({
      loadFile,
      setActiveTool,
      patchToolState,
      setView,
      setViewMode,
      setSelectedPage,
      applyTransform,
      addObject,
      addObjects,
      updateObject,
      removeObject,
      commit,
      undo,
      redo,
      jumpTo,
      reset,
      registerPendingApply,
      flushPendingApply,
      cancelCurrentTool,
      runTask: runBusy,
      restoreDraft,
      dismissDraft,
      restoreLatestDraft,
      exit,
    }),
    [
      loadFile,
      setActiveTool,
      patchToolState,
      setView,
      setViewMode,
      setSelectedPage,
      applyTransform,
      addObject,
      addObjects,
      updateObject,
      removeObject,
      commit,
      undo,
      redo,
      jumpTo,
      reset,
      registerPendingApply,
      flushPendingApply,
      cancelCurrentTool,
      runBusy,
      restoreDraft,
      dismissDraft,
      restoreLatestDraft,
      exit,
    ],
  );

  const readValue = useMemo<ReadValue>(
    () => ({
      doc,
      loading,
      busyLabel,
      error,
      view,
      viewMode,
      selectedPage,
      layout,
      canUndo: historyVersion >= 0 && historyRef.current.canUndo(),
      canRedo: historyVersion >= 0 && historyRef.current.canRedo(),
      canReset: historyVersion >= 0 && historyRef.current.index() > 0,
      canCancelCurrentTool:
        activeTool !== null &&
        pendingApplyVersion >= 0 &&
        (pendingApplyRef.current !== null ||
          historyRef.current.index() > toolCheckpointRef.current),
      historyVersion,
      pendingDraft,
      latestDraft,
    }),
    [
      doc,
      loading,
      busyLabel,
      error,
      view,
      viewMode,
      selectedPage,
      layout,
      historyVersion,
      activeTool,
      pendingApplyVersion,
      pendingDraft,
      latestDraft,
    ],
  );

  const toolStateValue = useMemo<ToolStateValue>(() => ({ toolState }), [toolState]);

  return (
    <ActionsCtx.Provider value={actions}>
      <ToolStateCtx.Provider value={toolStateValue}>
        <ActiveToolCtx.Provider value={activeTool}>
          <ReadCtx.Provider value={readValue}>{children}</ReadCtx.Provider>
        </ActiveToolCtx.Provider>
      </ToolStateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export function useEditorActions(): ActionsValue {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error("useEditorActions must be used inside <EditorProvider />");
  return v;
}

export function useEditorRead(): ReadValue {
  const v = useContext(ReadCtx);
  if (!v) throw new Error("useEditorRead must be used inside <EditorProvider />");
  return v;
}

export function useActiveTool(): string | null {
  return useContext(ActiveToolCtx);
}

/** The namespaced option slice for one tool (empty object if unset). */
export function useToolSlice(toolId: string): Record<string, unknown> {
  const v = useContext(ToolStateCtx);
  if (!v) throw new Error("useToolSlice must be used inside <EditorProvider />");
  return v.toolState[toolId] ?? {};
}
