# CloakPDF Canvas Redesign

> Working spec for the `feature/redesign` branch. Goal: turn CloakPDF from a grid of
> 34 isolated tools into a **canvas-centric, Photoshop-like PDF editor** — left tool
> rail, center PDF in full focus, right per-tool options panel — modeled on the sibling
> app **CloakIMG** (`/Users/sumit.sahoo/Developer/Personal/cloakimg`, `src/editor/`).
>
> This is a big-bang effort: all work lands on `feature/redesign` (branched from `dev`)
> and merges only when the whole experience is ready. No production feature flag.

## Locked decisions

1. **Editor-first immediately.** The home screen becomes a thin launcher. Dropping a
   single PDF goes straight into the canvas editor. The categorized tool grid is
   demoted to a secondary "all tools / multi-file" surface, not the default.
2. **Page view = focus + overview.**
   - **Focus mode** (default for editing): one page fills the canvas (zoom/pan, overlay
     drawing). A thumbnail strip navigates pages. Selecting a page makes it the focus.
   - **Overview mode** (toggle): a grid of all pages for browsing + page-board edits
     (reorder / rotate / delete / duplicate / extract / select). Click a page → drop
     into focus mode on it.
3. **Rollout = branch + big-bang merge.** Everything is built on `feature/redesign` off
   `dev`. Standalone tool components may stay during development for reference, but the
   release is a single merge once the editor is complete — no half-migrated production
   state, no runtime flag.

## Why this shape (analysis summary)

- **CloakIMG is a near-perfect chrome template.** Its editor is a pure-flexbox shell —
  `TopBar / ToolRail (left, 72px) / StageHost+ToolStage (center) / PropertiesPanel
(right, 328px)` — with a `layout` (mobile/tablet/desktop) switch and a morphing
  `MobileEditorSurface` bottom sheet (collapsed → picker → tool). State is a 3-way
  context split (stable **Actions** / volatile **ToolState** / **Read**) so slider drags
  never re-render the chrome. `StageHost`/`ToolStage` mount the canvas **once** and only
  swap the active tool's hook bindings — the anti-flash trick. All of this ports.
- **CloakPDF already has a working one-tool canvas.** [`src/tools/RedactPdf.tsx`](src/tools/RedactPdf.tsx)
  is functionally a single-tool editor: page `<img>` (PDF.js thumbnail) + absolutely
  positioned `<canvas>` overlay, `ResizeObserver` sizing, **fraction-rect** geometry
  (`{xPct,yPct,wPct,hPct}`), page nav, per-page undo. Generalize it → the center stage.
  [`src/tools/OrganizePages.tsx`](src/tools/OrganizePages.tsx) + `SortableGrid` +
  `useSortableDrag` → the overview page-board.
- **The tool classification already exists.** [`src/workflow/registry.ts`](src/workflow/registry.ts)
  lists exactly the 20 "single-PDF-in → single-PDF-out" tools — the natural rail tools.
  Its exclusions are precisely the tools that stay outside the editor.
- **Routing note:** despite CLAUDE.md's "useState + URL hash" claim, routing is **pure
  in-memory React state** ([`src/App.tsx`](src/App.tsx)) — no hash, no deep links, refresh
  returns home. Deep-linkable editor state is a Phase-3 decision (see Open questions).

## Core architecture: the document model

CloakIMG bakes raster pixels into history every commit. **Do not copy that** — a 50-page
PDF would blow memory (CloakIMG caps history at ~30 for a _single_ image). Model the doc
**non-destructively** and materialize bytes only on export.

```ts
// src/editor/doc.ts
interface CanvasDoc {
  id: string
  fileName: string
  bytes: Uint8Array            // canonical, pdf-lib-writable source of truth
  pageCount: number
  pages: PageMeta[]            // { index, widthPt, heightPt, rotation, thumbUrl|null }
  objects: CanvasObject[]      // non-destructive overlays, fraction-rect space
}

// discriminated union, reuses AnnotatePdf's Annotation + RedactPdf's RedactionRect shapes
interface CanvasObject {
  id: string
  kind: 'annotation' | 'signature' | 'stamp' | 'text' | 'watermark' | 'pageNumber' | ...
  pageIndex: number
  rect: { xPct: number; yPct: number; wPct: number; hPct: number }   // top-left, 0..1
  payload: unknown
}
```

**Everything is a `DocTransform`** — one code path for the canvas, the right-panel Apply
buttons, and the headless workflow runner:

```ts
type DocTransform = (doc: CanvasDoc) => Promise<{ bytes: Uint8Array; label: string }>;
// applyTransform(t) runs under a busy spinner → new bytes → re-render dims/thumbnails → commit
```

Three op classes (each wraps an existing `pdf-operations.ts` writer):

| Class                                | Tools                                                                                             | Behavior                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Overlay-object** (non-destructive) | annotate, signature, stamp/watermark, page-numbers, header/footer, bates                          | Tagged objects painted on the overlay canvas; burned into bytes only at export        |
| **Destructive-drag**                 | redact                                                                                            | Draw boxes → on Apply, `redactPdf` rasterizes+burns (stays destructive per CLAUDE.md) |
| **Whole-doc byte op**                | compress, grayscale, flatten, repair, reverse, extract, remove-blank, n-up, metadata, scrub, crop | Options-only panel → byte transform on Apply, new bytes pushed as a history entry     |

**History** ([`src/editor/history.ts`](src/editor/history.ts)): linear op-list, cursor index,
cap ~40. Entries snapshot `{ bytes-by-ref | objects-diff, label }` — **never** rendered
rasters. Object-only edits keep `bytes` by reference; only true byte transforms snapshot new
bytes. `commit(label)` bumps a `docVersion`; undo/redo restore bytes+objects and re-render
only affected thumbnails.

## Desktop layout (port CloakIMG, recolor Ocean-Blue)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ◀ CloakPDF   resume.pdf · 12 pages   [Focus|Overview]  ↶ ↷ ⟲ │ − 100% + │ Export │
├──────┬─────────────────────────────────────────────────┬─────────────┤
│ ▌Red │                                                 │ Redact      │
│  Ann │            ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                 │ Auto-detect │
│  Sig │            ▒  PDF PAGE (focus mode)  ▒           │ ☑ Email ... │
│  ...  │            ▒  img + overlay canvas  ▒           │ [Detect]    │
│  Org │            ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                 │ ─ Objects ─ │
│      │   ◀  [▭ ▭ ▭▮ ▭ ▭ ▭]  page strip  ▶              │      [✕ Cancel]│
└──────┴─────────────────────────────────────────────────┴─────────────┘
  rail 72px          center flex-1 (min-w-0)                 panel 328px
```

- **Left rail** — icon buttons grouped by category, hairline `bg-slate-200/70` separators;
  active = single Ocean-Blue 2.5px left edge-bar (one cue, per DESIGN.md).
- **Center** — persistent `PdfStage` (never remounted on tool switch) + page-thumbnail
  strip + history scrubber. A `Focus | Overview` segmented toggle in the TopBar swaps the
  stage between single-page focus and the grid page-board.
- **Right** — `key={activeTool}` panel hosting the tool's existing options JSX + an
  Objects/layers list pinned at bottom (auto-hidden when empty).
- **Tablet** (760–1180px) narrows the panel via a `collapsed` prop — no third layout.

### Overview mode (the page-board)

Reuses `SortableGrid` + `useSortableDrag` + `PageThumbnail`. Multi-select pages; the right
panel shows page-board actions (rotate, delete, duplicate, extract to new PDF, insert
blank, splice another PDF). Click a page → focus mode on it. This is where
`organize-pages`, `reverse-pages`, `remove-blank-pages`, `extract-pages`, `contact-sheet`,
and `n-up` live as overview verbs rather than separate tools.

## Mobile layout (mirror `MobileEditorSurface` exactly)

Below 760px the rail + right panel disappear; the page spans full width. One **in-flow
morphing bottom surface**: collapsed (just a "Tools" glyph on the page) → picker (4-col
grid) → tool (the _same_ options component desktop uses) → sticky ✕/✓ footer. Sheet height
is `ResizeObserver`-measured, capped at 50% of the column so the page stays dominant;
because the sheet is in-flow (not fixed), the canvas reflows and the whole page stays
visible. Overview mode = full-screen page grid. Honor CloakIMG's documented gotchas: await
flush-pending-apply before tool switch, restore the transition string after drag, no
transform-animation on the picker's scroll children (kills iOS momentum scroll).

## State architecture (`src/editor/EditorContext.tsx`)

Port CloakIMG's sliced-context pattern, PDF-shaped:

- **`EditorActionsCtx`** — stable callbacks: `setActiveTool, patchToolState, applyTransform,
commit, undo/redo/jumpTo, reset, registerPendingApply/flushPendingApply,
cancelCurrentTool, addObject/updateObject/removeObject, setViewMode, deliverExport`.
  Never re-renders.
- **`ToolStateCtx`** — high-frequency per-slider-tick tool options.
- **`ActiveToolCtx`** — just `activeTool` (rail + dispatchers subscribe here).
- **`EditorReadCtx`** — doc identity, view (zoom/pan/selectedPage/viewMode), history flags,
  layout breakpoint.

**Per-tool state** is namespaced — `toolState: Record<ToolId, object>`, each tool owns a
slice with its own defaults (`patchToolState(toolId, partial)` merges). Slices persist
across tool switches; reset on doc-replace. (CloakIMG's single ~120-field flat struct is
rejected as a mismatch for PDF's per-page, per-tool diversity.)

## Center stage (`src/editor/PdfStage.tsx`)

Generalize `RedactPdf`'s surface, mounted **once** (CloakIMG `StageHost` anti-flash):

- `<div ref=containerRef relative>` holding `<img src={thumbnails[selectedPage]}
className="w-full h-auto pointer-events-none">` (PDF.js `renderPageThumbnail` at
  `PREVIEW_SCALE=max(1.5,dpr)`; strip thumbnails ~0.4) + absolutely-positioned
  `<canvas absolute inset-0 touch-none>` sized by `ResizeObserver`.
- A `useStageProps`-style context lets the active tool register
  `{ paintOverlay(ctx,cw,ch), onPointerDown/Move/Up(imgPoint), cursor }`, cleared on
  unmount so stale overlays never bleed.
- **All geometry** stays in top-left fraction-rect space (0..1) for storage + pointer math
  (`(clientX-rect.left)/rect.width` clamped via `getBoundingClientRect`), converted to PDF
  points only at transform time — exactly RedactPdf's model.
- Render via **PDF.js**, mutate via **pdf-lib** — the split is preserved. Pass
  `PDFJS_WASM_URL` to every `getDocument`; `slice(0)` the input buffer per consumer
  (PDF.js detaches it to its worker; pdf-lib needs the original bytes at Apply).

## Tool disposition

| Tool                                                                         | Disposition                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| redact-pdf                                                                   | Rail — destructive-drag (focus)                                               |
| annotate-pdf                                                                 | Rail — overlay (focus)                                                        |
| signature, stamp-pdf, add-page-numbers, header-footer, bates-numbering       | Rail — overlay (focus)                                                        |
| crop-pages                                                                   | Rail — per-page preview (focus)                                               |
| fill-pdf-form                                                                | Rail — form overlay (focus); Phase 3                                          |
| organize-pages, extract-pages, reverse-pages, remove-blank-pages, n-up-pages | Rail — page-board (overview)                                                  |
| compress, grayscale, flatten, repair-pdf, metadata, pdf-scrub                | Rail — whole-doc options-only                                                 |
| add-bookmarks, file-attachment                                               | Rail — panel (tree/list)                                                      |
| ocr                                                                          | Rail — heavy panel (Tesseract); Phase 3                                       |
| **merge, images-to-pdf**                                                     | Multi-file launcher → "doc constructor" → open result in editor               |
| **split-pdf**                                                                | Standalone + editor Export option (1→many)                                    |
| **pdf-to-image, extract-images, contact-sheet**                              | Standalone + editor "Export as…"                                              |
| **pdf-inspector**                                                            | Standalone + editor info panel                                                |
| **pdf-password, digital-signature**                                          | Standalone (security: embeds secret/cert)                                     |
| **ask-pdf**                                                                  | Special sibling (desktopOnly+beta, ~1.3 GB models, chat output) — own surface |

## Rail groups (reuse the 4 non-AI categories)

1. **Privacy & Security** — redact, pdf-scrub, metadata (redact front-loaded; brand-defining)
2. **Annotate & Sign** — annotate, signature, stamp/watermark, page-numbers, header/footer, bates, fill-form
3. **Pages** (overview verbs) — organize, extract, reverse, remove-blank, n-up
4. **Transform** — crop, compress, grayscale, flatten, repair, ocr
5. **Document** — bookmarks, attachments

## Milestones (all on `feature/redesign`)

- **M0 — Editor shell + doc core.** `{kind:"editor"}` view; `src/editor/` (`breakpoints.ts`,
  `EditorContext.tsx` w/ 4 sliced contexts + `CanvasDoc` + op-list history, `PdfStage.tsx`
  - `useStageProps`, `EditorShell.tsx`, `MobileEditorSurface.tsx`, `tools.ts`). Load via
    `usePdfFile`+`renderAllThumbnails`; focus + overview modes; zoom/pan/page-nav; undo
    skeleton. Home → minimal launcher routing into the editor. **Exit:** drop a PDF, view /
    navigate / zoom / overview-grid, empty rail.
- **M1 — Reference tools.** redact (destructive-drag) + annotate (overlay) + organize-pages
  (overview page-board) — proves persistent-stage → dispatcher → history → deliver on
  desktop + mobile.
- **M2 — Overlay + whole-doc tranche.** stamp, signature, page-numbers, header/footer,
  bates; compress, grayscale, flatten, repair, reverse, extract, remove-blank, n-up,
  metadata, scrub, crop.
- **M3 — Careful tools + polish.** fill-form, ocr searchable path, bookmarks, attachments;
  draft autosave (IndexedDB keyed by SHA-256, reusing the RAG persistence idiom); Export
  menu (pdf-to-image / contact-sheet / split as output formats); multi-file constructors
  (merge / images-to-pdf) hand-off into the editor.
- **M4 — Editor-first home + cutover.** Thin launcher as the default home; "all tools"
  directory for standalone surfaces (compare, inspector, password, digital-sig, ask-pdf);
  retire migrated standalone tool components; full QA across breakpoints; **big-bang merge
  to `dev`.**

## Top risks → mitigations

1. **History memory blowup** if we raster-snapshot like CloakIMG → op-list/objects-diff
   only, re-derive rasters from `pdf-renderer`. _(The single most important deviation.)_
2. **PDF.js detaches the input ArrayBuffer** → `slice(0)` per consumer (RedactPdf already does).
3. **Destructive ops degrade downstream** (redact loses selectable text; grayscale/flatten)
   → order late, surface the warning the redact tool already shows.
4. **Per-page DPI/coordinate scale** (multi-page) vs CloakIMG's single global scale →
   per-page converters, never one global scale.
5. **blob: thumbnail leaks** across sessions → centralize revoke in the context's
   doc-replace/unmount.
6. **Unmount destroys unsaved overlay state** until M3 autosave → land draft autosave before cutover.
7. **Mobile landscape >760px** flips out of the mobile sheet mid-session → gate on
   `min(innerW,innerH)` / coarse-pointer, not naive `innerWidth`.

## Open questions (decide during M0–M3)

- **Deep-linking / browser back:** the app has no router today. A canvas users expect to
  bookmark/refresh-into will surprise them. Decide in M3 whether to add hash/History sync.
- **Workflows:** the runner already funnels steps through `useToolOutput.deliver`. With the
  unified doc model it becomes the headless mirror of `applyTransform`. Keep the Workflows
  surface as-is initially; optionally register the whole editor as one interactive step later.
- **Reuse vs rewrite per tool:** default is to lift each tool's existing options JSX +
  `pdf-operations` writer into a Tool/Panel pair, not rewrite logic. Revisit per tool.

## Key reuse map

| Need                            | Reuse from CloakPDF                                                                      | Port from CloakIMG                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 3-pane shell                    | —                                                                                        | `UnifiedEditor`, `ToolRail`, `PropertiesPanel`, `ToolStage`, `StageHost`, `TopBar`     |
| Mobile surface                  | —                                                                                        | `MobileEditorSurface`, `MobileToolFooter`, `breakpoints.ts`                            |
| State + history                 | —                                                                                        | `EditorContext` (sliced), `history.ts`, `useApplyOnToolSwitch`, `useKeyboardShortcuts` |
| Page render / thumbnails        | `pdf-renderer.ts`, `usePreviewScale`, `PagePreviewNav`, `PageThumbnail`, `ThumbnailGrid` | —                                                                                      |
| Overlay canvas + fraction rects | `RedactPdf.tsx`, `layout-extract.ts`, `pii.ts`                                           | `StageHost`/`useStageProps` seam                                                       |
| Page-board                      | `OrganizePages.tsx`, `SortableGrid`, `useSortableDrag`                                   | —                                                                                      |
| Byte transforms                 | `pdf-operations.ts` (all writers)                                                        | —                                                                                      |
| Delivery / workflows            | `useToolOutput`, `usePdfFile`, `workflow/registry.ts`                                    | —                                                                                      |
| Design tokens                   | `DESIGN.md`, `theme.ts` (Ocean-Blue accent, slate-200 hairlines, no resting shadow)      | minimalist-chrome conventions                                                          |
