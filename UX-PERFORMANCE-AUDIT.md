# CloakPDF — UX & Performance Audit

> **Remediation log — 2026-05-30 (applied after this audit).** Verified end-to-end: `vp check` clean (137 files, 0 errors) · 166/166 unit tests · production build passes.
>
> **Shared layer (cascades to all 36 tools):** `ActionButton` focus-visible ring + `aria-busy` + loading spinner · `AlertBox` `role="alert"` · `ProgressBar` `role="progressbar"` + value ARIA · `LoadingSpinner` `role="status"` + sr-only label · `ConfirmModal` focus-trap + return-focus + removed global Enter-confirm · `FileInfoBar` `tabular-nums` · `SegmentedControl` focus ring · `LabeledSlider` `aria-valuetext` · `CheckboxField`/`FileDropZone`/`DateTimeInput` slate-400→500 contrast · `index.css` reduced-motion now covers modal/card entrances.
>
> **Critical bugs fixed:** ImagesToPdf now genuinely supports WebP (canvas→PNG) + determinate progress · CropPages remaps the crop box per page `/Rotate` (no more wrong-side crop) · AddSignature seeds page 0 on single-page PDFs and guards against delivering an unsigned file.
>
> **Per-tool pass:** 114 accessibility / copy / visual fixes applied across all 36 tools (concrete `aria-label`s on icon buttons, 44px touch targets, slate-400→500 text, `tabular-nums`, dark-mode parity, honest success/error copy, destructive-op confirmations).
>
> **Keyboard reorder (WCAG 2.1.1):** `useSortableDrag` gained `getKeyboardProps` + a polite live region; wired into Reorder Pages, Add Blank Page (card-as-button) and Images→PDF (grip-handle).
>
> **Decisions resolved:** viewport zoom-block kept as the documented deliberate tradeoff (no change); FlattenPDF now genuinely strips non-widget annotations (comments/highlights/links), copy re-broadened, pinned by a new unit test.
>
> **Performance batch:** workflow views lazy-loaded → home `index` chunk −12% gzip (112→99 KB) with pdf-lib/pdf-operations now off the home critical path · determinate OCR analyze progress · extract-images yields between pages · split-pdf parses the source once instead of once per part · PageThumbnail `decoding="async"`+`loading="lazy"` · duration-expectation status on the RSA-keygen and repair freezes.
>
> **Still open (tracked):** the _larger_ perf rewrites (lazy per-page render for OCR / Add Bookmarks, page-capped/windowed thumbnail grids, lazy diff render + page cap for Compare PDFs, Web Workers for RSA keygen / repair) and the remaining a11y/preview items (DuplicatePage & RedactPDF keyboard paths, WYSIWYG preview fidelity on non-3:4 pages) are sequenced for a follow-up pass. The synthesis prose below references a "FillPdfForm single-page silent failure" that the adversarial verifier downgraded — it is **not** a confirmed bug.

## Executive summary

CloakPDF is a genuinely mature codebase with an unusually disciplined backbone: one tool registry as the source of truth, a uniform dropzone→FileInfoBar→controls→ActionButton flow, exemplary client-side memory hygiene (canvases torn down, pdfjs docs destroyed, blob URLs revoked almost everywhere), and a font-loading setup that is close to best-in-class. The single biggest win available is also the cheapest: roughly a dozen accessibility and progress gaps live in shared primitives (ActionButton, ProgressBar, LoadingSpinner, AlertBox, ConfirmModal, useSortableDrag, index.css), so fixing them once cascades to all 36 tools. The biggest risks are correctness-of-claim and silent failure, not crashes: AddSignature and FillPdfForm can silently deliver an unsigned/unfilled file on single-page PDFs, ImagesToPdf hard-crashes on the WebP it advertises, CompressPdf ships a fabricated blur preview, FlattenPdf and Compress overstate what they remove/optimize, and several WYSIWYG tools anchor previews to a hard-coded 3:4 box so the stamp lands in the wrong place on Letter/A4. Accessibility is the weakest dimension by a wide margin — the primary CTA has no focus ring, drag-to-reorder has no keyboard path, and ~26 of 36 tools ship zero aria-labels — and it is also the most leveraged to fix. Held to the bar of "best PDF tool ever," CloakPDF has the architecture and the privacy story; it now needs a focused pass on shared-primitive a11y, preview fidelity, and honest result/error copy.

## Scorecard

Legend: 1 broken · 2 poor · 3 adequate · 4 good · 5 exemplary. Avg = mean of the five scores.

| Tool               | UX  | Perf | A11y | Type | Polish | Avg |
| ------------------ | --- | ---- | ---- | ---- | ------ | --- |
| repair-pdf         | 3   | 2    | 3    | 3    | 3      | 2.8 |
| signature          | 3   | 4    | 2    | 3    | 3      | 3.0 |
| compare-pdf        | 3   | 2    | 3    | 4    | 4      | 3.2 |
| split-pdf          | 3   | 2    | 3    | 4    | 4      | 3.2 |
| rotate             | 3   | 4    | 2    | 4    | 3      | 3.2 |
| duplicate-page     | 3   | 4    | 2    | 4    | 4      | 3.4 |
| file-attachment    | 3   | 4    | 2    | 3    | 3      | 3.0 |
| grayscale          | 3   | 4    | 3    | 3    | 3      | 3.2 |
| bates-numbering    | 3   | 4    | 2    | 4    | 3      | 3.2 |
| add-blank-page     | 4   | 4    | 2    | 4    | 4      | 3.6 |
| remove-blank-pages | 3   | 4    | 2    | 4    | 3      | 3.2 |
| extract-images     | 3   | 2    | 4    | 3    | 3      | 3.0 |
| crop-pages         | 3   | 4    | 3    | 3    | 3      | 3.2 |
| images-to-pdf      | 3   | 3    | 3    | 4    | 4      | 3.4 |
| digital-signature  | 3   | 3    | 3    | 4    | 4      | 3.4 |
| compress           | 3   | 4    | 3    | 4    | 3      | 3.4 |
| fill-pdf-form      | 3   | 3    | 3    | 4    | 4      | 3.4 |
| header-footer      | 3   | 4    | 3    | 4    | 4      | 3.6 |
| extract-pages      | 3   | 4    | 3    | 4    | 4      | 3.6 |
| merge              | 3   | 4    | 3    | 4    | 4      | 3.6 |
| pdf-password       | 3   | 3    | 3    | 4    | 4      | 3.4 |
| nup-pages          | 3   | 4    | 3    | 4    | 4      | 3.6 |
| reorder            | 3   | 4    | 2    | 4    | 4      | 3.4 |
| stamp-pdf          | 4   | 4    | 3    | 3    | 3      | 3.4 |
| pdf-to-image       | 3   | 4    | 4    | 4    | 4      | 3.8 |
| contact-sheet      | 4   | 3    | 3    | 3    | 4      | 3.4 |
| ocr                | 4   | 3    | 3    | 4    | 4      | 3.6 |
| reverse-pages      | 4   | 4    | 3    | 4    | 4      | 3.8 |
| add-page-numbers   | 4   | 5    | 2    | 4    | 4      | 3.8 |
| redact-pdf         | 4   | 4    | 2    | 4    | 4      | 3.6 |
| flatten            | 3   | 4    | 3    | 4    | 4      | 3.6 |
| delete             | 4   | 4    | 4    | 4    | 4      | 4.0 |
| ask-pdf            | 4   | 4    | 2    | 4    | 4      | 3.6 |
| metadata           | 4   | 5    | 4    | 4    | 3      | 4.0 |
| pdf-inspector      | 4   | 5    | 4    | 3    | 4      | 4.0 |

(Sorted worst→best by Avg, then by the worst single score; ties broken toward the weaker a11y/perf profile.)

## Top 15 prioritised fixes

Ranked by impact × reach ÷ effort. Systemic shared-primitive fixes dominate the top because one edit lifts every tool.

| #   | Fix                                                                                                                                                           | Impact   | Effort | Where                                                                                                                                       | Why                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add `focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2` + `aria-busy={processing}` + a spinning `Loader2` glyph to ActionButton | Critical | S      | `src/components/ActionButton.tsx:41-50`                                                                                                     | The primary CTA of ~30 tools is invisible to keyboard focus and silent to AT; one edit fixes focus, busy state, and loading glyph everywhere.                           |
| 2   | Add `role="progressbar"` + `aria-valuenow/min/max` to ProgressBar and `role="status"` + sr-only "Loading…" to LoadingSpinner                                  | Major    | S      | `src/components/ProgressBar.tsx:41`, `src/components/LoadingSpinner.tsx:15`                                                                 | Long OCR/compress/render jobs advance silently for SR users across every tool; fixes status announcement in one place.                                                  |
| 3   | Lazy-load the three workflow views in App.tsx via `React.lazy`                                                                                                | Major    | S      | `src/App.tsx:41`                                                                                                                            | WorkflowRunner statically pulls pdf-lib+pako (~233 kB gzip `dist-zAddkrI3.js`) onto the home-screen critical path before any PDF is touched; lazying moves it off-path. |
| 4   | Replace `text-slate-400`/`placeholder-slate-400` used as real text with `text-slate-500`                                                                      | Major    | M      | 40+ files incl. `FileDropZone.tsx:186`, `App.tsx:258,286`, `SplitPdf.tsx:199`, `ReversePages.tsx:109`                                       | slate-400 (#94a3b8 ≈ 2.9:1) is real prose, hints, and load-bearing instructions across 40+ files — a blanket WCAG 1.4.3 AA failure.                                     |
| 5   | Add `tabular-nums` to FileInfoBar's file-size/page-count `<p>`                                                                                                | Major    | S      | `src/components/FileInfoBar.tsx:30-32`                                                                                                      | One edit stabilises the most-seen numeric display in the app across ~35 tools.                                                                                          |
| 6   | Guard single-page PDFs in AddSignature & FillPdfForm so they can't silently deliver an unchanged file                                                         | Critical | S      | `AddSignature.tsx:515,650`; `FillPdfForm.tsx:134,259`                                                                                       | A 1-page PDF currently delivers an UNSIGNED `_signed` file (no page ever selectable) — a silent correctness failure on a security tool.                                 |
| 7   | Reject/decode WebP at drop time in ImagesToPdf instead of hard-throwing at Create-PDF                                                                         | Critical | M      | `ImagesToPdf.tsx:230,234,123`; `pdf-operations.ts:396`                                                                                      | The dropzone advertises WebP, queues it, then `imagesToPdf` throws on it — a guaranteed crash on advertised input.                                                      |
| 8   | Add keyboard move path + item semantics to useSortableDrag/SortableGrid                                                                                       | Major    | L      | `useSortableDrag.ts:62-76`; `SortableGrid.tsx:44-125`                                                                                       | Drag-to-reorder is mouse-only (WCAG 2.1.1) in 4 tools incl. ReorderPages, whose entire purpose is keyboard-inoperable; one shared fix covers all.                       |
| 9   | Drive WYSIWYG preview containers from the real page aspect ratio, not a hard-coded `aspect-3/4`                                                               | Major    | S each | `HeaderFooter.tsx:390`, `BatesNumbering.tsx:342`, `StampPdf.tsx`, `AddSignature.tsx:607`                                                    | On Letter/A4/landscape the overlay and font scale drift off the true page edges — the preview lies about where the stamp lands.                                         |
| 10  | Gate success-callout copy on `output.inWorkflow`/`deliveryWord` (or skip the panel)                                                                           | Major    | S      | `RemoveBlankPages.tsx:211`, `EditMetadata.tsx:259`, `RepairPdf.tsx:112`, `ReversePages.tsx:181`, `AddBookmarks.tsx:391`, `NupPages.tsx:154` | 6 workflow-eligible tools assert "has been downloaded" mid-workflow when the file was handed to the next step — factually wrong.                                        |
| 11  | Add `.animate-spin`, `.animate-scale-in`, `.animate-fade-in-up` to the prefers-reduced-motion block                                                           | Minor    | S      | `src/index.css:255-261`                                                                                                                     | Spinners, modal entrances, and card entrances still animate under reduced-motion; one CSS edit honours the preference app-wide.                                         |
| 12  | Add `role="alert"` to AlertBox and an optional retry/change-file slot                                                                                         | Major    | S      | `src/components/AlertBox.tsx:18-26`                                                                                                         | Failures surfaced by useAsyncProcess aren't announced, and dead-end errors (Repair, encrypted inputs) offer no next action.                                             |
| 13  | Remove the fabricated CSS-blur preview from CompressPdf                                                                                                       | Major    | M      | `CompressPdf.tsx:128-158`                                                                                                                   | The preset cards depict a blur the compressor never applies (it changes raster scale + JPEG quality) — an invented metric that misrepresents behavior.                  |
| 14  | Add ConfirmModal Tab focus-trap + restore focus on close; scope Enter-to-confirm                                                                              | Major    | M      | `ConfirmModal.tsx:41-55`                                                                                                                    | Tab walks into the dimmed background, focus never returns to the trigger, and global Enter can confirm a destructive action accidentally.                               |
| 15  | Fix per-stamp colour leaking onto interactive surfaces (one-accent break)                                                                                     | Major    | M      | `StampPdf.tsx:426-439`; `EditMetadata.tsx:195`; `FileAttachment.tsx:239`                                                                    | 7 preset chips paint red/green/orange/blue/yellow onto buttons, plus a red Redact-All CTA and an emerald download hover — the clearest ONE-ACCENT violations.           |

## Systemic themes

**1. Icon-only controls with no accessible name.** Dozens of icon-only buttons — page steppers (ChevronLeft/Right), rotation controls, per-row delete/download, the position-picker grids — expose no `aria-label` (or rely on `title`, which is unreliable and invisible on touch). **Why it matters:** SR/keyboard users can't identify the control; selected-state is often colour-only too (WCAG 4.1.2). **Affected:** ~26 of 36 tools ship zero aria-labels (RotatePages, AddPageNumbers, HeaderFooter, BatesNumbering, FileAttachment, ImagesToPdf, MergePdf, and more). **One fix:** sweep the 26-file list adding explicit `aria-label`+`aria-pressed`; replace hand-rolled radio grids (position pickers, mode toggles, preset pickers) with the shared SegmentedControl which already emits `role="group"`+`aria-pressed`. **Where:** per-tool, but the toggle/picker subset collapses into SegmentedControl adoption.

**2. Missing :focus-visible ring on the primary CTA and bespoke buttons.** ActionButton (every tool's main action) has no focus ring, and many tools hand-roll primary/secondary buttons (Split divider strip, ExtractPages header links, PdfPassword toggles, DigitalSignature CTAs, RedactPdf pills, AskPdf composer/Send) that also omit it. **Why it matters:** keyboard users cannot see the most important control on the page (WCAG 2.4.7). **Affected:** all 36 via ActionButton, plus ~10 tools with bespoke buttons. **One fix:** add the ring to ActionButton (#1), then grep for hand-rolled `<button>`s with hover-but-no-focus and add the same treatment. **Where:** `ActionButton.tsx:45` + the bespoke-button cluster.

**3. WYSIWYG previews anchored to a hard-coded 3:4 box.** Several position/style tools position overlays (and derive font scale) against `aspect-3/4` while the page image is `object-contain`'d inside it, so on Letter (0.77), A4 (0.71), or landscape the stamp renders in the letterbox gutter, not at the true margin. **Why it matters:** the preview is the tool's core promise and it lies about output placement. **Affected:** HeaderFooter, BatesNumbering, StampPdf (multi-page/mixed-size), AddSignature, plus single-page-only previews in CropPages/NupPages/StampPdf that show page 1 even when it's excluded. **One fix:** drive the container `style={{ aspectRatio: pageDim.width/pageDim.height }}` from the real page dimensions so percentages and `usePreviewScale` map 1:1. **Where:** `HeaderFooter.tsx:390`, `BatesNumbering.tsx:342`, `AddSignature.tsx:607`, `StampPdf.tsx:544`.

**4. Success states confirm the action but not the result, and lie mid-workflow.** Most tools render a generic "X done successfully. The PDF has been downloaded." — wrong in a workflow (file was forwarded, not downloaded), and silent on the actual outcome (how many pages removed, files split, fields written). **Why it matters:** users can't verify the operation did what they intended; the copy is factually false mid-chain. **Affected:** 6 tools assert false "downloaded" (RemoveBlankPages, EditMetadata, RepairPdf, ReversePages, AddBookmarks, NupPages); SplitPdf has no success state at all; ~10 more omit result counts. Compress is the lone good model. **One fix:** add a `succeeded`/`lastResult` channel to useAsyncProcess and a deliveryWord-aware success callout pattern that echoes the concrete outcome. **Where:** `useAsyncProcess.ts:104`, `useToolOutput.ts:55-61` + per-tool callouts.

**5. Long main-thread jobs with indeterminate or no progress.** Many per-page loops show only a bare `LoadingSpinner` even though the renderer already exposes an `onProgress(rendered,total)` callback that's simply not wired; a few loops also never yield to the event loop. **Why it matters:** the app freezes with no feedback on exactly the large PDFs that need it. **Affected:** thumbnail-load phase in ~12 tools (Split, Reorder, Rotate, Delete, ExtractPages, AddBlankPage, DuplicatePage, PdfToImage load-phase, OcrPdf analyze, RemoveBlankPages); ExtractImages and ImagesToPdf never yield (UI-freeze); RepairPdf/DigitalSignature-keygen block synchronously. **One fix:** thread `onProgress` through usePdfFile's loader signature so the bare `load` can render a determinate ProgressBar, and add `await new Promise(r=>setTimeout(r,0))` to the two non-yielding loops. **Where:** `usePdfFile.ts:225`, `pdf-renderer.ts:228/307`, `ExtractImages.tsx:211`, `pdf-operations.ts:392-427`.

**6. Unbounded thumbnail rendering — no page cap or virtualization.** Every thumbnail grid mounts all pages as live blob-URL `<img>` nodes with decoded bitmaps; OcrPdf/AddBookmarks render all pages at ~2x DPR up front for a one-page-at-a-time viewer; ComparePdf holds both documents. **Why it matters:** a 500-page PDF = hundreds of simultaneous bitmaps/blob URLs — a memory cliff. **Affected:** ThumbnailGrid consumers (PdfToImage, RemoveBlankPages, RedactPdf, ExtractPages, DeletePages, etc.), OcrPdf, AddBookmarks, ComparePdf. **One fix:** add `loading="lazy"`+`decoding="async"` to thumbnail imgs immediately; cap eager render (first ~200 pages, rest on scroll) and virtualize ThumbnailGrid for large counts. **Where:** `PageThumbnail.tsx`, `ThumbnailGrid.tsx:17-25`, `OcrPdf.tsx:57`, `AddBookmarks.tsx:45`.

**7. Destructive/lossy ops described with benign copy and no acknowledgement.** Rasterising ops (Compress, Grayscale, Redact) destroy selectable text and grow the file; Flatten claims to remove "annotations/comments" it never touches; EditMetadata's "Redact All" wipes every field on one click. **Why it matters:** privacy tool overstating or understating what it does erodes trust. **Affected:** Compress ("optimize the file structure"), Grayscale (one passive hint), FlattenPdf (false annotation-removal claim), EditMetadata Redact All, RedactPdf (150-DPI downgrade undisclosed). **One fix:** standardise on Redact's honest inline-warning pattern ("pages become non-selectable and the file may grow"); narrow Flatten's copy to the truth or actually strip non-widget /Annots. **Where:** `CompressPdf.tsx:81`, `GrayscalePdf.tsx:92`, `FlattenPdf.tsx:61,192,207`, `EditMetadata.tsx:195`.

**8. Informational/empty outcomes mis-routed through the red error path.** AlertBox is documented as the error-only banner with an attention pulse, yet "no images found", "pages already fit", and a 1-page split all throw into it. **Why it matters:** a normal result reads as a pulsing failure and (in ExtractImages) discards the file, forcing re-upload. **Affected:** ExtractImages, CropPages, SplitPdf. **One fix:** route success/empty/no-op outcomes to InfoCallout (the sanctioned non-error surface) and keep the file mounted. **Where:** `ExtractImages.tsx:239`, `CropPages.tsx:209`, `SplitPdf.tsx`.

**9. Arbitrary `text-[Npx]` off the documented scale.** index.css explicitly forbids arbitrary px sizes in favour of the scale tokens, yet ~30 usages exist, heaviest in App.tsx and the entire `src/workflow/` subtree. **Why it matters:** the type ramp drifts and the two section-h2 variants (26 vs 36 cap) diverge. **Affected:** App.tsx hero/section headings, all four workflow files, FillPdfForm badge (`text-[9px]`). **One fix:** promote hero/display/headline tokens to `@theme` and map each `text-[Npx]` to the nearest token. **Where:** `App.tsx:198…502`, `src/workflow/*`, `FillPdfForm.tsx:243`. (Detailed in Typography section.)

**10. Cards carrying a resting shadow (no-resting-shadow invariant).** DESIGN.md says cards earn elevation on hover only, but several control cards ship `shadow-sm` at rest. **Why it matters:** breaks the calm, flat resting tone the design system enforces. **Affected:** RemoveBlankPages (sensitivity card), CropPages (3 cards), ExtractImages (summary card). **One fix:** drop `shadow-sm`; the slate-200 1px border is the resting treatment. **Where:** `RemoveBlankPages.tsx:139`, `CropPages.tsx:286,325,494`, `ExtractImages.tsx:401`.

## Foundation findings

### Typography & Fonts

- **major** — FileInfoBar omits tabular-nums on the file-size/page-count header (`FileInfoBar.tsx:30-32`) — wrap the numeric `{details}` in `tabular-nums`; one edit fixes the most-seen numeric display across ~35 tools.
- **major** — Result-stat panels use `font-bold` + no tabular-nums (`CompressPdf.tsx:193-208`, `GrayscalePdf.tsx:148-150`, `OcrPdf.tsx:394-404`) — add `tabular-nums`, change `font-bold`→`font-semibold` to match the 600 cap.
- **major** — `src/workflow/` subtree bypasses the scale with arbitrary `text-[Npx]` (`WorkflowBuilder/Runner/ToolPickerModal/WorkflowsHome`) — map each to text-tag/meta/card-desc/card-title or add named `@theme` tokens.
- **minor** — Hero/section headings hard-code px breakpoints (`App.tsx:198,209,326,360,438,502`) — promote hero/display/headline-lg/headline-md to `@theme --text-*` tokens.
- **minor** — Eyebrow letter-spacing drifts off 0.12/0.16em (`App.tsx:498` 0.14em; `ToolPickerModal.tsx:276` 0.08em) — snap to the two documented tracking values.
- **minor** — Page-number badges lack tabular-nums (`PageThumbnail.tsx:54` and the reorder-family badges) — add `tabular-nums` so badges don't jiggle at 9→10/99→100.

### Shared Components

- **major** — ActionButton has no `:focus-visible` ring, no `aria-busy`, no loading glyph (`ActionButton.tsx:41-50`) — the single highest-leverage fix in the app.
- **major** — ProgressBar/LoadingSpinner are silent to AT (`ProgressBar.tsx:33-47`, `LoadingSpinner.tsx:14-18`) — add `role="progressbar"`/`role="status"` + sr-only label.
- **major** — AlertBox errors not announced (`AlertBox.tsx:18-26`) — add `role="alert"`.
- **major** — ConfirmModal: global Enter-to-confirm + no Tab focus-trap + no focus restore (`ConfirmModal.tsx:41-55`) — scope Enter, trap Tab, capture/restore `activeElement`.
- **major** — slate-400 body/label/hint text fails AA (`CheckboxField.tsx:29`, `FileDropZone.tsx:186`, `ColorPicker.tsx:186`, `InfoCallout.tsx`) — bump to slate-500.
- **minor** — useAsyncProcess exposes no success flag (`useAsyncProcess.ts:104`) — add `succeeded`/`lastResult` so tools have one consistent success affordance.
- **minor** — ConfirmModal/`animate-scale-in` not reduced-motion-exempt; ColorPicker SV area `role="presentation"` on an interactive surface with no keyboard path; ActionButton off-scale `min-w-55`.

### Performance

- **major** — pdf-lib + pako (~233 kB gzip) on the home-screen critical path via static WorkflowRunner import (`App.tsx:41`) — lazy the three workflow views.
- **major** — No virtualization or page cap on any thumbnail grid (`ThumbnailGrid.tsx:17-25` + consumers) — cap eager render, add `loading="lazy"`, virtualize for large counts.
- **major** — OcrPdf renders every page at ~2x DPR up front for a one-page viewer (`OcrPdf.tsx:57`) — render `selectedPage` lazily; classify with a cheap pass.
- **minor** — ContactSheet re-parses + re-renders the whole doc on Generate (`ContactSheet.tsx:43,93-138`) — reuse the decoded buffer/doc.
- **minor** — ExtractImages holds full-res blob AND base64 data-URL per image (`ExtractImages.tsx:33,194`) — use a revocable blob object URL.

### Accessibility

- **critical** — Primary CTA has no focus ring (`ActionButton.tsx:44-45`).
- **critical** — Drag-to-reorder has no keyboard alternative in all 4 sortable tools (`useSortableDrag.ts:62-76`, `SortableGrid.tsx`).
- **major** — 26/36 tools ship zero aria-labels; dozens of unnamed icon-only buttons.
- **major** — slate-400 as real text fails AA in 40+ files.
- **major** — ConfirmModal has no focus trap and never returns focus.
- **major** — Long jobs lack aria-live status in most tools.
- **major** — Viewport blocks pinch-zoom (`index.html:36-39`, WCAG 1.4.4) — remove `maximum-scale=1, user-scalable=no` globally; suppress zoom only on the specific preview/signature containers.
- **minor** — Reduced-motion block omits `fade-in-up`/`scale-in`/`spin`; icon steppers below 44px touch target.

### IA/Flow & Copy

- **major** — Workflow-eligible tools claim "downloaded" mid-workflow (6 tools) — gate on `output.inWorkflow`/`deliveryWord`.
- **major** — Success confirms the action, not the result (no before/after counts); SplitPdf has no success state at all.
- **major** — Error copy is the generic "Failed to X. Please try again." nearly everywhere with no recovery path; worst at dead-ends (Repair, Redact, encrypted inputs). PdfPassword models the good pattern.
- **major** — Irreversible destructive ops have only a passive hint, no acknowledgement (Flatten, Grayscale, EditMetadata Redact All).
- **minor** — RepairPdf diverges from the shared flow skeleton (dropzone stays mounted); footer "From drop to download" over-generalises read-only tools; "configurable style" registry copy is filler; FillPdfForm empty-state names a non-existent "Add Watermark" tool (it's "Stamp & Watermark").

## Typography & Fonts

Font loading is genuinely well-engineered and should be preserved as-is: `InterVariable.woff2` (344 KB) is preloaded with `crossorigin`, self-hosted with `font-display: swap`, declares the full 100–900 variable axis, and the 380 KB italic file is correctly gated (its only triggers are inside the desktop-only, model-gated AskPdf; the hero's editorial italic uses `font-serif` per spec), so the italic woff2 never loads in a normal session. Tabular-nums is applied correctly on ProgressBar, LabeledSlider, and kbd.

The two systemic weaknesses are scale discipline and tabular-nums coverage:

1. **~30 arbitrary `text-[Npx]` usages** violate the explicit index.css rule to use the scale tokens — concentrated in `App.tsx` (hero `text-[34px]…[58px]`, two divergent section h2 ramps at 26 vs 36 cap, subheads at 16.5/17/15.5/14/14.5/13.5px) and the entire `src/workflow/` subtree (11.5/12/13.5/14/14.5/20/22px), plus `FillPdfForm.tsx:243` `text-[9px]` (below the smallest `--text-xxs` 10px token). Fix: promote hero/display/headline-lg/headline-md to `@theme --text-*` tokens (or clamp utilities) and map each one-off px to the nearest existing token; add named tokens only where 14/14.5/11.5 are genuinely needed.

2. **tabular-nums gaps on exactly the digits the tools exist to show:** FileInfoBar's universal file-size/page-count header (~35 tools), the Compress/Grayscale/OCR result-stat panels, page-number badges across the reorder family (`PageThumbnail.tsx:54`, ReorderPages, AddBlankPage, DuplicatePage, MergePdf order badge, ImagesToPdf slot badge), AddBookmarks live count, FileAttachment/ImagesToPdf stacked sizes, ExtractImages dimensions/summary, ComparePdf diff badges, RepairPdf size rows, and PdfInspector's numeric rows. Fix: add `tabular-nums` at each numeric span; the single highest-value edit is FileInfoBar.

Minor drift to clean up alongside: `font-bold` (700) appears past the documented 600 weight cap on result stats and several badges/position grids (CompressPdf, GrayscalePdf, OcrPdf, AddBlankPage, AddPageNumbers) — snap to `font-semibold`; the uppercase eyebrow tracking has two off-spec values (0.14em, 0.08em) to snap to 0.12/0.16em; PdfInspector uses `font-mono` on dimension rows where `tabular-nums` on the Inter face is the intended treatment. Note for reviewers: `font-bold` exists in ~27 places and Inter ships 100–900, so there is no hard runtime cap — this is a DESIGN.md role-token consistency call, not a rendering bug, and decorative `h-1`/`w-px` skeleton utilities do not violate the text-scale rule.

## Recommended sequencing

**Phase 1 — quick systemic wins (S-effort, shared primitives; lift all 36 tools).**

1. ActionButton: focus-visible ring + `aria-busy` + Loader2 glyph (`ActionButton.tsx:41-50`).
2. ProgressBar/LoadingSpinner: `role="progressbar"`/`role="status"` + sr-only label.
3. AlertBox: `role="alert"`.
4. index.css: add `.animate-spin`, `.animate-scale-in`, `.animate-fade-in-up` to the reduced-motion block.
5. FileInfoBar: `tabular-nums` on the file-size/page-count header.
6. Lazy-load the three workflow views in App.tsx (perf critical-path win).
7. slate-400 → slate-500 sweep on real text (start with FileDropZone hint + App.tsx search/result-count, then the 40-file long tail).
8. Remove `maximum-scale=1, user-scalable=no` from the global viewport; scope zoom-suppression to preview/signature containers.

**Phase 2 — per-tool correctness, copy & honesty (S/M-effort).** 9. Single-page guards in AddSignature & FillPdfForm (silent-unchanged-file bug). 10. WebP handling in ImagesToPdf (advertised-input crash). 11. Remove CompressPdf's fabricated blur preview; correct Compress/Grayscale/Flatten destructive-op copy. 12. Workflow-aware success copy across the 6 false-"downloaded" tools; add result counts and a SplitPdf success state (via a new `succeeded` channel on useAsyncProcess). 13. Drive WYSIWYG preview containers from real page aspect ratio (HeaderFooter, BatesNumbering, StampPdf, AddSignature). 14. Route empty/no-op outcomes to InfoCallout, keep file mounted (ExtractImages, CropPages, SplitPdf); fix the rotated-page manual-crop bug and the N-up aspect-stretch bug. 15. One-accent cleanup: neutralise StampPdf preset chips, EditMetadata Redact-All red CTA, FileAttachment emerald hover. 16. aria-label sweep across the 26 zero-aria-label tools; replace hand-rolled radio grids/mode toggles/preset pickers with SegmentedControl.

**Phase 3 — deeper perf & a11y (M/L-effort, structural).** 17. Keyboard path in useSortableDrag + SortableGrid (covers all 4 reorder tools). 18. ConfirmModal focus-trap + focus-restore + scoped Enter; then route genuinely irreversible ops through it. 19. Thread `onProgress` through usePdfFile's loader so bare-`load` tools get determinate ProgressBars; add event-loop yields to ExtractImages/ImagesToPdf; move RSA keygen (DigitalSignature) and large encrypt/decrypt (PdfPassword) off the main thread. 20. Thumbnail virtualization / page cap in ThumbnailGrid; lazy per-page render in OcrPdf and AddBookmarks; reuse the decoded doc in ContactSheet; revocable blob thumbnails in ExtractImages. 21. Larger correctness investments: AddBookmarks nested outline levels, ComparePdf alignment + tolerance control, DigitalSignature chain-size ceiling and visible-signature disclosure, type-scale token promotion to `@theme` to retire the `text-[Npx]` usages.

### Organise & Edit

#### merge

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
Clean and well-structured — keyboard-operable reorder, derived-not-mutated sort, stable UUID keys, named encrypted-file gate. The gaps are minor: silent non-PDF drops, no batch partition on the encrypted gate, no in-app success confirmation.

- **major** — Non-PDF files filtered out silently with no feedback — `src/tools/MergePdf.tsx:47` — when `pdfs.length < newFiles.length` surface "Skipped N non-PDF files"; accept `.pdf` extension fallback when `f.type` is empty.
- **minor** — Encrypted file in a batch queues none of the other valid PDFs — `src/tools/MergePdf.tsx:51-56` — partition the batch: append valid PDFs via `setFiles` AND surface the encrypted one in the notice.
- **minor** — No in-app success confirmation after merge — `src/tools/MergePdf.tsx:83-89,172` — add a success channel to `useAsyncProcess` and a "Merged N files" callout.
- **minor** — Reorder/remove buttons ~28px, below 44px touch target — `src/tools/MergePdf.tsx:131-155` — bump to `min-w-11 min-h-11`.
- **minor** — File-size meta uses slate-400 (sub-AA, ~2.6:1) — `src/tools/MergePdf.tsx:126` — use slate-500/600 per the `--text-meta` token.
- **minor** — Position badge + size meta lack tabular-nums (jiggle on reorder) — `src/tools/MergePdf.tsx:119-121,126-128` — add `tabular-nums`.
- **minor** — Remove-button hover wash has no dark variant — `src/tools/MergePdf.tsx:151` — add `dark:hover:bg-red-900/20`.
- Does well: derived (non-mutating) sort with manual reorder disabled while sorted; real keyboard-operable up/down buttons with aria-labels; stable `crypto.randomUUID()` keys; single Ocean-Blue accent + shared FileDropZone/EncryptedPdfNotice gate.

#### split-pdf

Scores: UX 3 · Perf 2 · A11y 3 · Type 4 · Polish 4 (avg 3.2)
Intuitive click-between-pages model with proper stateful aria-labels on dividers, undercut by an avoidable full re-parse per export part and several silent dead-ends.

- **major** — Every split part re-reads + re-parses the whole source PDF — `src/tools/SplitPdf.tsx:110-114` (→ `pdf-operations.ts:1690-1700`) — load the source `arrayBuffer`+`PDFDocument` once, add `splitIntoParts(doc, ranges)` copying from the single loaded doc.
- **minor** — No determinate progress for thumbnail render or multi-part export — `src/tools/SplitPdf.tsx:32,110-114,195-196,241` — track `i/parts.length` in the export loop to drive a ProgressBar.
- **minor** — "Every N pages" silently does nothing when N ≥ page count — `src/tools/SplitPdf.tsx:66-74,169,174-180` — clamp `everyN` to `thumbnails.length - 1` or surface inline feedback.
- **minor** — Divider/quick-split buttons have no :focus-visible ring (input does) — `src/tools/SplitPdf.tsx:155-162,174-190,209-216` — add `focus-visible:ring-2 focus-visible:ring-primary-500`.
- **minor** — Core gesture hint rendered at sub-AA slate-400 — `src/tools/SplitPdf.tsx:199-201` — promote to slate-500/600 (it teaches the primary click-the-gap interaction).
- **minor** — Single-page PDF lands in a dead-end with a misleading "click between pages" hint — `src/tools/SplitPdf.tsx:150,199-201,208,236` — when `thumbnails.length <= 1`, replace with an InfoCallout explaining nothing to split.
- Does well: stateful divider aria-labels ("Split after page N" / "Remove split…"); single part downloads plain, multiple parts zip with zero-padded natural-sort names; stable thumbnail keys + blob-URL revoke on reset; semantic red (a cut) keeps primary as the sole accent.

#### extract-pages

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
A polished entry layer (stable keys, blob cleanup, accent discipline) undercut by a guess-and-check range input and two invisibly-conflicting selection modes.

- **major** — Range input silently swallows invalid / out-of-range / descending input — `src/tools/ExtractPages.tsx:26-40,100-102,202-209` — on non-empty input yielding 0 indices, show an aria-live inline error ("No pages in that range — this PDF has N pages"); detect garbage/descending explicitly.
- **major** — Range mode and click-select conflict invisibly — stale highlights extract the wrong pages — `src/tools/ExtractPages.tsx:83-86,122-126,186-196` — make modes mutually exclusive: dim/clear thumbnail overlays when the range box has text, clear the range box on thumbnail click.
- **minor** — Header reads "filename — 0 pages" with active controls during render — `src/tools/ExtractPages.tsx:119-127,177-178` — gate the count header + controls behind `!pdf.loading`.
- **minor** — All thumbnails rendered eagerly behind a bare indeterminate spinner — `src/tools/ExtractPages.tsx:46-53,177-178` — surface determinate progress (renderer's `onProgress` exists; thread it through `usePdfFile`).
- **minor** — Select-all / Clear / Change-file links lack :focus-visible ring + sub-44px — `src/tools/ExtractPages.tsx:129-153` — add the ring + hit padding the range input already has.
- **minor** — Range input not linked to its helper via aria-describedby — `src/tools/ExtractPages.tsx:164-174` — give the helper an id, point `aria-describedby` at it (and the future error node).
- Does well: correct memory hygiene (revoke blob URLs, canvas teardown, `pdf.destroy()`); stable `${file.name}-${i}` keys; one Ocean-Blue accent with category tint confined to the dropzone; the one form control has a real associated `<label>` + focus ring.

#### reorder

Scores: UX 3 · Perf 4 · A11y 2 · Type 4 · Polish 4 (avg 3.4)
Cheap and correct: thumbnails render once and reuse, drag state keyed by original page identity, blob URLs revoked. Residual gaps are an indeterminate load spinner and a silent workflow handoff.

- **minor** — Load shows indeterminate spinner despite an available per-page progress callback — `src/tools/ReorderPages.tsx:33,98-99` — thread `onProgress` into `renderAllThumbnails`, render `<ProgressBar>`.
- **minor** — Apply gives no confirmation; in-workflow the step unmounts silently — `src/tools/ReorderPages.tsx:59-66,181-188` — surface a brief success line; confirm the in-workflow handoff is acknowledged.
- **minor** — Page-number badge + caption lack tabular-nums — `src/tools/ReorderPages.tsx:142-148,151-152,167-168` — add `tabular-nums` (family-wide with AddBlankPage/DuplicatePage).
- Does well: thumbnails rendered once and reused (drag only mutates an index array — no re-parse); stable `page-${originalIndex}` keys; correct blob/canvas/pdfjs teardown; Apply gated on actual change via `isReordered`, single-page PDFs can never fire a no-op.

#### delete

Scores: UX 4 · Perf 4 · A11y 4 · Type 4 · Polish 4 (avg 4.0)
A minimal page-picker that reuses the scaffold well and guards triple-deep against deleting all pages, using the app's established destructive red idiom. The genuine under-reported issue is missing dark variants on the red status text.

- **minor** — Thumbnail load discards the available determinate progress callback — `src/tools/DeletePages.tsx:30,92-93` — add `thumbProgress` state + determinate ProgressBar (RedactPdf proves it works through the hook).
- **minor** — No "produces a new PDF, originals can't be recovered" hint near the destructive CTA — `src/tools/DeletePages.tsx:54-62,123-131` — add an inline warning hint matching RedactPdf; do NOT add a ConfirmModal (no tool uses one).
- **minor** — Red status text has no dark variant — `src/tools/DeletePages.tsx:85,134` — add `dark:text-red-400`; pair the count with a non-color cue (Trash2 icon/bold).
- **minor** — Destructive red CTA is a shared idiom but undocumented in DESIGN.md — `src/tools/DeletePages.tsx:129` — add a "destructive actions may use bg-red-600" clause to DESIGN.md.
- **minor** — Array index used as React key — `src/tools/DeletePages.tsx:103-105` — use `key={thumb}` (blob URL is unique).
- Does well: triple-layered "cannot delete all pages" guard (handler + conditional CTA + defensive throw); leak-free thumbnail lifecycle; no per-category color leak; self-documenting CTA that pluralizes + echoes count and `deliveryWord`.

#### rotate

Scores: UX 3 · Perf 4 · A11y 2 · Type 4 · Polish 3 (avg 3.2)
Correct additive rotation and good resource hygiene, but it under-delivers on the one thing a rotate tool must nail — a faithful preview — and its per-page icon controls are an a11y/touch weak spot.

- **major** — Rotation preview is cosmetically wrong for 90°/270° — `src/tools/RotatePages.tsx:120-124` (via `PageThumbnail.tsx:45-51`) — swap the rendered aspect box for ±90°/270° so the thumbnail reflects true output orientation.
- **major** — Per-page rotate buttons have no accessible name and no focus ring — `src/tools/RotatePages.tsx:126-146` — add `aria-label` + `focus-visible:ring-2` (150 controls on a 50-page PDF).
- **minor** — PageThumbnail rendered without onClick — a focusable, cursor-pointer no-op — `src/tools/RotatePages.tsx:120-124` — give a real action or use a non-interactive preview variant.
- **minor** — Rotate icon buttons ~28px, below 44px (mobile-enabled tool) — `src/tools/RotatePages.tsx:126-146` — bump to `min-w-11 min-h-11`.
- **minor** — No numeric readout of accumulated rotation per page — `src/tools/RotatePages.tsx:117-149` — show a tabular-nums "90°" chip + a per-page reset.
- **minor** — No success confirmation after applying — `src/tools/RotatePages.tsx:66-73,165` — render a success callout on `task.run`, gate copy on `deliveryWord`.
- **minor** — "Rotate All" smuggled through FileInfoBar `extra`, vanishes in workflow mode — `src/tools/RotatePages.tsx:94-104` — render it as its own control in the controls row.
- **minor** — Instructional copy duplicated between dropzone hint and post-load heading — `src/tools/RotatePages.tsx:86,112-114` — replace the heading with result-oriented status.
- Does well: correct non-destructive additive rotation (adds onto existing `getRotation().angle`, only touches non-zero entries); clean blob/canvas/pdfjs teardown + cleared Map on reset; Apply gated on `rotations.size > 0` with empty-Map early-return and re-entrancy guard.

#### reverse-pages

Scores: UX 4 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.8)
A focused single-purpose tool with a standout before/after preview and a properly surfaced disabled-button reason, flawed mainly by a success callout that hard-codes "downloaded" while the button adapts to workflow mode.

- **major** — Success callout claims "downloaded" while the button says "Continue" in a workflow — `src/tools/ReversePages.tsx:169,181` — drive callout copy from output state like the button does.
- **minor** — Page count parsed once redundantly via getPageCount — `src/tools/ReversePages.tsx:39-44` — return `numPages` from the single render-time parse, drop the separate `getPageCount` call.
- **minor** — Completion not announced to AT (no aria-live/role=status) — `src/tools/ReversePages.tsx:179-183` — wrap the success block in `role="status" aria-live="polite"`.
- **minor** — Preview labels + single-page helper use slate-400 (~2.9:1) — `src/tools/ReversePages.tsx:109,112,123,140,146,156,174` — use slate-500 (these labels carry the before→after meaning).
- Does well: honest first+last-page-only preview with "… N more …"; disabled-button reason surfaced inline, not just greyed; blob-URL cleanup with documented ArrayBuffer-detach sequencing; descriptive alt text ("Was last, now first").

#### add-blank-page

Scores: UX 4 · Perf 4 · A11y 2 · Type 4 · Polish 4 (avg 3.6)
A reorder-style tool that nails the hard parts (live in-grid blank preview, correct insertion-offset math), weak mainly on accessibility (no focus ring, no AT status) and small polish tells.

- **major** — Custom "Add blank page" button has no visible focus indicator — `src/tools/AddBlankPage.tsx:137-144` — add `focus-visible:ring-2 focus-visible:ring-primary-500` (shared fix across AddSignature/AddBookmarks/RedactPdf).
- **minor** — Async insert + download silent to AT — `src/tools/AddBlankPage.tsx:261-276` — wrap the status paragraph in `aria-live="polite"`, announce "Inserted N blank pages".
- **minor** — `renderAllThumbnails` called without `onProgress` — `src/tools/AddBlankPage.tsx:41` — pass a progress handler, render a ProgressBar (RedactPdf precedent).
- **minor** — "Add blank page" always prepends regardless of intent — `src/tools/AddBlankPage.tsx:73-75` — append new blanks at the end (keep the initial leading blank).
- **minor** — Lazy "page(s)" pluralization — `src/tools/AddBlankPage.tsx:263-264` — render `${n === 1 ? "page" : "pages"}`.
- **minor** — Blank-count text uses font-bold past the 600 weight cap — `src/tools/AddBlankPage.tsx:213,253` — change to `font-semibold`.
- **minor** — Standalone insert leaves blanks in state with no success/reset — repeat-click footgun — `src/tools/AddBlankPage.tsx:83-101` — after standalone deliver, show success + clear blanks.
- Does well: the WYSIWYG drag grid IS the preview (no missing-preview gap); correct multi-insert offset math with A4 fallback; clean canvas/blob teardown on reset.

#### duplicate-page

Scores: UX 3 · Perf 4 · A11y 2 · Type 4 · Polish 4 (avg 3.4)
A clever single-grid "click a page → copy lands right after, then drag to reposition" interaction with correct form-field cloning, losing points on keyboard accessibility and a silent, repeatable post-apply state.

- **major** — Primary interaction (click page to duplicate) is keyboard-inoperable — `src/tools/DuplicatePage.tsx:192-212` — give the card `role="button" tabIndex={0}` + Enter/Space handler + aria-label + focus ring.
- **major** — Apply silently downloads and leaves stale copies — repeatable mis-fire — `src/tools/DuplicatePage.tsx:84-101,279-294` — show a success AlertBox in standalone mode and reset copies / disable Apply until the grid changes.
- **minor** — Copy cards lack drag/grab semantics + keyboard removal path — `src/tools/DuplicatePage.tsx:148-187` — add `aria-roledescription` + a per-copy keyboard-accessible remove control.
- **minor** — Once copies exist, a short tap on an original silently adds another copy — `src/tools/DuplicatePage.tsx:195-211` — disambiguate: move "add copy" to an explicit +Copy affordance, reserve the body for drag.
- **minor** — Thumbnail load shows a bare spinner despite an available `onProgress` — `src/tools/DuplicatePage.tsx:40,124-125` — wire a determinate ProgressBar.
- **minor** — Lazy "(ies)" pluralization — `src/tools/DuplicatePage.tsx:281-283` — real singular/plural branch.
- **minor** — Original cards expose no per-card action affordance until hover — `src/tools/DuplicatePage.tsx:209-218` — add a persistent-on-hover/focus "+ Copy" overlay.
- Does well: correct blob/canvas/pdfjs teardown; clean copy-position math + form-widget promotion to unique AcroForm fields (`clonePageFormFields`); stable unique copy ids + page-index original keys; token-clean type scale, zero `text-[Npx]`.

#### remove-blank-pages

Scores: UX 3 · Perf 4 · A11y 2 · Type 4 · Polish 3 (avg 3.2)
Its thumbnail-grid-with-trash-overlay IS its live preview and the all-pages guard prevents the obvious footgun, but it's let down by a nameless hand-rolled slider, slate-400 instructional copy, and an indeterminate analysis spinner.

- **major** — Whole-document analysis shows only an indeterminate spinner, no percent — `src/tools/RemoveBlankPages.tsx:131-135` — add `onProgress` to `renderThumbnailsAndScores` (mirror `renderThumbnailsAndScan`), render a determinate ProgressBar.
- **major** — Hand-rolled range slider has no associated label — nameless to SR — `src/tools/RemoveBlankPages.tsx:141-156` — replace with shared `LabeledSlider` (`id`/`htmlFor` binding).
- **minor** — Resting shadow on the sensitivity card breaks the no-resting-shadow invariant — `src/tools/RemoveBlankPages.tsx:139` — drop `shadow-sm`.
- **minor** — Blank-page count invisible in workflow mode (FileInfoBar `extra` self-suppresses) — `src/tools/RemoveBlankPages.tsx:116-128` — surface the count in a tool-owned element.
- **minor** — Instructional body copy at slate-400 (~2.85:1) — `src/tools/RemoveBlankPages.tsx:157-160,164,189` — use slate-500.
- **minor** — Success callout hardcodes "has been downloaded" (false mid-workflow) — `src/tools/RemoveBlankPages.tsx:209-213` — condition on output/`deliveryWord`.
- Does well: the trash-overlay grid IS a real before-commit preview; belt-and-suspenders delete-everything guards (handler + inline message + util throw); blob/canvas teardown, tabular-nums threshold pill, and `output.skip` auto-advance when zero blanks.

### Transform & Convert

#### compress

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 3 (avg 3.4)
Genuinely good determinate progress and an honest before/after result panel, undercut by a fabricated CSS-blur preview that misrepresents what compression does and benign "optimize" copy over a lossy full-page rasterization.

- **major** — Preset preview fakes the operation with CSS blur compression never applies — `src/tools/CompressPdf.tsx:128-158` — drop the blur; show honest preset metadata (the real op changes raster scale + JPEG quality, not blur).
- **minor** — Lossy full-page rasterization surfaced as benign "optimize the file structure" — `src/tools/CompressPdf.tsx:81` (+ `pdf-operations.ts:167-205`) — reword away from "optimize"; add a callout that output is rasterized (text non-selectable), like Redact.
- **minor** — Preset picker is a hand-rolled radio group with no programmatic selected state — `src/tools/CompressPdf.tsx:118-168` — use `SegmentedControl` or add `role="radiogroup"/radio` + `aria-checked`.
- **minor** — Result emerald numbers have no dark variant — `src/tools/CompressPdf.tsx:199,206` — add `dark:text-emerald-400`.
- **minor** — Preset cards use border-2, heavier than the 1px system — `src/tools/CompressPdf.tsx:122-124` — drop to 1px; let the primary border/ring carry selection.
- **minor** — "Maximum" preset labeled "Smallest file" can produce a larger output on text PDFs — `src/tools/CompressPdf.tsx:112-116` — describe presets by behavior or pick the smallest of three internally.
- Does well: determinate per-page ProgressBar; honest result panel (original vs compressed, clamps savings to 0, "already well optimized"); clean workflow seam + per-page canvas/pdfjs teardown with a yield.

#### pdf-to-image

Scores: UX 3 · Perf 4 · A11y 4 · Type 4 · Polish 4 (avg 3.8)
Exemplary documented memory hygiene and keyboard-accessible page selection; the gaps are all system-status: bare load spinner and no success/result summary after export.

- **minor** — Thumbnail-load phase shows a bare spinner despite the export phase wiring determinate progress — `src/tools/PdfToImage.tsx:40,130-131` — thread `onProgress` into the loader, mirror the export ProgressBar.
- **minor** — No success/result state after export — `src/tools/PdfToImage.tsx:97-99,240-241` — surface "Exported N images (X MB) as ZIP" from blob count + summed size.
- **minor** — 300-DPI all-pages export has no cancel + no size warning — `src/tools/PdfToImage.tsx:42,174-211` — add a Cancel that aborts the loop + destroys the doc; warn over a size threshold (don't touch the documented sequential render).
- **minor** — Form-section eyebrow labels at sub-AA slate-400 — `src/tools/PdfToImage.tsx:162,179,194,209` — use slate-500 (SegmentedControls keep them announced regardless).
- Does well: keyboard/SR-accessible page selection with correct SegmentedControl `ariaLabel`s; documented memory hygiene (sequential render, canvas teardown, `destroy()`); single download vs lazily-imported JSZip multi-page packaging; stale-result safety via `usePdfFile` requestId.

#### images-to-pdf

Scores: UX 3 · Perf 3 · A11y 3 · Type 4 · Polish 4 (avg 3.4)
A clean reorder-and-convert tool with good memory hygiene and a thoughtful touch-drag path, but it advertises WebP then hard-fails on it at Create-PDF time.

- **critical** — WebP accepted into the queue but the converter throws on it — `src/tools/ImagesToPdf.tsx:230,234,123` (+ `pdf-operations.ts:396-400`) — decode WebP to PNG via canvas before embedding, OR remove WebP from accept/hint and reject at drop time with an inline AlertBox.
- **major** — Batch conversion blocks the main thread with no per-image progress — `src/tools/ImagesToPdf.tsx:292-297` (+ `pdf-operations.ts:392-427`) — thread `onProgress(i,total)` + ProgressBar; `await setTimeout(0)` between images.
- **minor** — No success confirmation (output size + page count never surfaced) — `src/tools/ImagesToPdf.tsx:153-162,301` — capture `run()` boolean, render "Created an N-page PDF (X)".
- **minor** — slate-400 as real body text on the file-size sublabel — `src/tools/ImagesToPdf.tsx:78-80` — use slate-500.
- **minor** — Remove (X) button: no focus ring, non-specific label, sub-44px — `src/tools/ImagesToPdf.tsx:82-93` — add ring, enlarge target, `aria-label={`Remove ${name}`}`.
- **minor** — Slot badge + size sublabel lack tabular-nums — `src/tools/ImagesToPdf.tsx:63-65,78-80` — add `tabular-nums`.
- **minor** — Drag-to-reorder has no keyboard alternative — `src/tools/ImagesToPdf.tsx:51,141-151` — fix once in shared `useSortableDrag` (order materially affects output).
- Does well: exemplary object-URL hygiene (revoke on removal AND unmount); `React.memo`'d rows keyed by UUID; thoughtful TouchDragOverlay + contextual sort/drag helper copy; `loading="lazy"`/`decoding="async"` + `draggable={false}` on previews.

#### ocr

Scores: UX 4 · Perf 3 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
A verification-first OCR tool with honest upfront digital/scanned detection, side-by-side preview, and a robust stale-result guard, marred by an unencodable-glyph crash on the non-Latin Tesseract fallback path.

- **major** — Searchable-PDF export can crash on non-Latin scanned OCR (fallback path) — `src/tools/OcrPdf.tsx:252-258` (+ `pdf-operations.ts:999-1006`) — wrap `page.drawText` in `createSearchablePdf` in try/catch to skip unencodable runs, matching its layout sibling at 1071-1075.
- **major** — Initial load renders every page at ~2× DPR behind only an indeterminate spinner — `src/tools/OcrPdf.tsx:56-59,305-311` — thread the existing `onProgress` from `renderThumbnailsAndScan` into a determinate ProgressBar (keep the documented eager render).
- **minor** — Language picker lacks radiogroup semantics + label association — `src/tools/OcrPdf.tsx:334-356` — `role="radiogroup"` + `role="radio"` + `aria-checked`.
- **minor** — Emoji-flag language labels misrepresent languages + break on Windows — `src/tools/OcrPdf.tsx:62-77` — drop the flags, use plain language names.
- **minor** — No way to re-OCR with a different language after extraction — `src/tools/OcrPdf.tsx:299,334,387` — add a "Re-extract" affordance preserving rendered thumbnails.
- **minor** — Long "Analyzing document…" phase not announced to AT — `src/tools/OcrPdf.tsx:305-311,368-375` — add `role="status" aria-live="polite"`.
- Does well: robust stale-result protection via monotonic `extractIdRef`; honest upfront detection (digital extracts instantly, byte sizes stated plainly, no `deviceMemory`); verification-first side-by-side results UI with determinate bars; graceful liteparse→Tesseract fallback.

#### extract-images

Scores: UX 3 · Perf 2 · A11y 4 · Type 3 · Polish 3 (avg 3.0)
Excellent a11y on its image grid and disciplined resource teardown, but a main-thread-blocking extraction loop freezes on image-heavy PDFs, and a legitimate "no images" empty result is mis-routed through the red error path.

- **major** — Image extraction loop never yields to the main thread — `src/tools/ExtractImages.tsx:139-212` — insert `await setTimeout(0)` after `onProgress` (line 211), matching the compress/grayscale convention.
- **major** — "No images found" (a valid empty result) rendered as a red error that discards the file — `src/tools/ExtractImages.tsx:236-240,442` — return an empty array + a neutral InfoCallout that keeps the file mounted.
- **minor** — PNG re-encode silently inflates JPEG-origin images with no warning — `src/tools/ExtractImages.tsx:182-185,412-415` — add a "lossless PNG — may be larger than source" hint.
- **minor** — Download CTA: hand-rolled primary button, no focus ring or aria-busy — `src/tools/ExtractImages.tsx:421-436` — add `focus-visible:ring-2` + `aria-busy` (ActionButton can't supply the ring — same gap).
- **minor** — Long scan shows an indeterminate spinner despite determinate data — `src/tools/ExtractImages.tsx:334-342` — render shared ProgressBar with `current`/`total`.
- **minor** — Selection summary card carries a resting shadow — `src/tools/ExtractImages.tsx:401` — drop `shadow-sm`.
- **minor** — Numeric displays lack tabular-nums + literal 'x' separator — `src/tools/ExtractImages.tsx:392-394,404-409` — add `tabular-nums`, use '×' (U+00D7).
- Does well: model image grid a11y (`aria-label` + `aria-pressed` + visible focus ring); disciplined lifecycle (reused canvas pair, `seen` dedupe, `page.cleanup()`, `doc.destroy()`); one-accent compliance; robust decode path with tiny-image artifact filter.

#### crop-pages

Scores: UX 3 · Perf 4 · A11y 3 · Type 3 · Polish 3 (avg 3.2)
A capable crop tool with single-load architecture and precise error copy, carrying a real rotated-page correctness bug in the manual path (the auto path is already guarded) plus resting-shadow and shared-component drifts.

- **critical** — Manual crop silently misplaces the box on rotated pages — `src/tools/CropPages.tsx:158-166,483-491` (+ `pdf-operations.ts:1483-1492`) — mirror `cropPagesIndividual`'s rotation guard in `cropPages`: transform margins per page angle or skip + warn.
- **major** — Preview always shows page 1 even when page 1 is excluded — `src/tools/CropPages.tsx:248,594-645` — preview the first SELECTED page, label "Preview (page N)".
- **major** — Resting shadows on control cards break the no-resting-shadow invariant — `src/tools/CropPages.tsx:286,325,494` — drop `shadow-sm`.
- **major** — Mode toggle reimplements SegmentedControl without its semantics — `src/tools/CropPages.tsx:331-367` — use shared `SegmentedControl` (`role="group"` + `aria-pressed` + one-accent active style).
- **minor** — Raw checkbox instead of CheckboxField; `text-primary-600` is a no-op on a native checkbox — `src/tools/CropPages.tsx:505-511` — use `CheckboxField` or `accent-primary-600`.
- **minor** — mm displays + page-count counter lack tabular-nums — `src/tools/CropPages.tsx:378,403,425,445,467,566` — add `tabular-nums`.
- **minor** — Dead no-op effect with a misleading "suppress unused ref" comment — `src/tools/CropPages.tsx:245-246` — delete it (`previewRef` is used at 599).
- **minor** — "Pages already fit" informational outcome rendered as a red error — `src/tools/CropPages.tsx:209-216,653` — route to InfoCallout.
- **minor** — `applyToAll` not reset on Change-file — `src/tools/CropPages.tsx:68-75` — add `setApplyToAll(true)` to the `onReset` callback.
- **minor** — Switching mode toggle silently discards entered margins — `src/tools/CropPages.tsx:335-358` — derive the uniform value from existing margins instead of zeroing.
- Does well: single reused PDF load via `Promise.all` + blob revoke; auto-crop determinate progress with correct coordinate flip; unusually precise distinct error copy; auto path correctly skips rotated pages at the util layer.

#### flatten

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
A nice before/after illustration with correct one-accent compliance, undercut by a correctness-of-claim problem: the UI promises annotations/comments are removed, but `flattenPdf` only flattens form-field widgets.

- **major** — UI claims annotations/comments are removed, but only form fields are flattened — `src/tools/FlattenPdf.tsx:61,192,207` (+ `pdf-operations.ts:1648-1659`) — either narrow all copy to "flattens form fields", or actually strip non-widget `/Annots` (this is a privacy tool — do both).
- **minor** — Success state confirms the action but not the result — false confirmation on form-less PDFs — `src/tools/FlattenPdf.tsx:206-208` — return + surface a field count; say "No interactive form fields were found" when zero.
- **minor** — Decorative before/after diagram not hidden from AT — `src/tools/FlattenPdf.tsx:74-184` — `aria-hidden="true"` on the grid + a visually-hidden text equivalent.
- **minor** — Irreversible-output flatten offered with only neutral hint text — `src/tools/FlattenPdf.tsx:186-202` — add an `InfoCallout accent="warning"` irreversibility note (no ConfirmModal precedent).
- Does well: correct one-accent compliance (illustration + callout use primary tokens only); thoughtful fully-dark-mode-aware before/after diagram; sound error recovery (file stays loaded on failure, retry works).

#### grayscale

Scores: UX 3 · Perf 4 · A11y 3 · Type 3 · Polish 3 (avg 3.2)
A single-action tool with a nice before/after preview and exemplary per-page memory hygiene, weak mainly because destructive rasterization is understated by one passive hint — even though the app's own Redact tool sets the fuller-warning standard.

- **major** — Rasterization destroys selectable text with an understated one-line hint — `src/tools/GrayscalePdf.tsx:92` (+ `pdf-operations.ts:274-282`) — add a hint matching Redact ("text becomes non-selectable and the file may grow") as passive text, not a modal.
- **minor** — "After" preview uses CSS grayscale, not the engine's Rec.601 luminance — `src/tools/GrayscalePdf.tsx:119` — apply the 0.299/0.587/0.114 weights to a preview canvas or relabel "Approximate preview".
- **minor** — Determinate progress bar hidden during the first page's render — `src/tools/GrayscalePdf.tsx:129-135` — initialise `progress` to `{0, pageCount}` before calling.
- **minor** — Result panel shows output size only, never the before→after delta — `src/tools/GrayscalePdf.tsx:147-150` — show input→output + delta + pages converted (Compress pattern).
- **minor** — Long multi-page 2× rasterization has no cancel path — `src/tools/GrayscalePdf.tsx:137-142` — thread an AbortSignal (cross-cutting gap).
- **minor** — Before/After comparison silently disappears if the preview thumbnail fails — `src/tools/GrayscalePdf.tsx:103,53-55` — render a neutral placeholder on preview failure.
- Does well: exemplary per-page memory hygiene (free bitmap, `destroy()`, yield); leak-free race-safe preview lifecycle; honest "colour information is permanently removed" dropzone hint.

#### nup-pages

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
A tidy layout-picker shipping one real correctness bug: source pages are stretched to fill each grid cell with no aspect-fit, distorting any non-matching page — and the function's own JSDoc promises aspect preservation.

- **major** — Source pages stretched to fill cells — aspect ratio destroyed (violates own JSDoc) — `pdf-operations.ts:2008` — compute `scale = min(cellW/pageW, cellH/pageH)`, draw scaled + centered (letterbox mismatches).
- **minor** — Success callout hard-codes "downloaded" though tool is workflow-eligible — `src/tools/NupPages.tsx:154` — branch copy on `inWorkflow`/`deliveryWord`.
- **minor** — slate-400 for content-bearing layout description text — `src/tools/NupPages.tsx:129-131` — use slate-500 (the eyebrow at 95 is the systemic convention, out of scope).
- **minor** — Layout buttons lack pressed/selected semantics — `src/tools/NupPages.tsx:101-110` — `role="radiogroup"` + `aria-checked`.
- **minor** — No real-page preview of the N-up result — `src/tools/NupPages.tsx:111-123` — optionally render the first source page in the grid with the export aspect-fit.
- Does well: correct derived sheet math surfaced up front ("N pages → M sheets"); memory-conscious single `embedPage` reused across slots; clean shared-scaffold + one-accent usage; token-clean typography (no `text-[Npx]`).

#### contact-sheet

Scores: UX 4 · Perf 3 · A11y 3 · Type 3 · Polish 4 (avg 3.4)
A well-built tool with the live preview most tools lack, sticky controls, determinate progress, and clean memory hygiene, with a factually-wrong progress label during multi-sheet encode and no in-app success confirmation.

- **major** — No success state — output downloads silently, a PNG selection can silently yield a .zip — `src/tools/ContactSheet.tsx:208,212,221,226-228` — render a success callout stating exactly what was delivered; warn about the multi-sheet ZIP fallback up front.
- **minor** — Progress label "Rendering pages…" is wrong + frozen at 100% during multi-sheet PDF/ZIP encode — `src/tools/ContactSheet.tsx:174,178-221,406` — switch the label to "Building file…" once the page loop finishes.
- **minor** — Preview doesn't match export: cell shows bare "7", the burned sheet says bold "Page 7" — `src/tools/ContactSheet.tsx:167,379` — render `Page {idx+1}` in preview (or drop "Page" from export) + align weight/color.
- **minor** — Generate re-reads the File + re-opens the document — `src/tools/ContactSheet.tsx:43,93-94,124-138` — cache the decoded arrayBuffer/proxy from load, reuse on Generate.
- **minor** — No cancel on a job that can render hundreds of full-DPI pages — `src/tools/ContactSheet.tsx:109-188` — add a Cancel that flips an abort flag in the per-page loop.
- **minor** — Load-bearing sheet-count captions use slate-400 — `src/tools/ContactSheet.tsx:274,394` — promote to slate-500/600.
- **minor** — Canvas label sizing non-adaptive (fixed 28px band + bold 20px) while preview scales — `src/tools/ContactSheet.tsx:81,103,165` — derive the canvas font/band from `genCellW/H` like the preview.
- **minor** — Button pluralizes to "Contact Sheets" even when PDF output is a single file — `src/tools/ContactSheet.tsx:194-208,414` — gate the plural on `output === "png" && sheetsNeeded > 1`.
- Does well: live WYSIWYG ResizeObserver-driven preview with dashed empty slots; disciplined memory hygiene (canvas zeroing + `destroy()` + blob revoke); honest output-count messaging; adaptive render scale by grid density.

#### repair-pdf

Scores: UX 3 · Perf 2 · A11y 3 · Type 3 · Polish 3 (avg 2.8)
A deliberately minimal tool that uniquely reports a concrete result (before/after size), weak mainly because the synchronous main-thread load+save has no progress — a freeze cliff on exactly the large/corrupt files it targets.

- **major** — Repair runs synchronously on the main thread with no progress feedback — `pdf-operations.ts:1884-1891` (from `src/tools/RepairPdf.tsx:41`) — run load+save in a Web Worker; cheaper mitigation: an aria-live in-progress region.
- **minor** — Hand-rolled file panel instead of shared FileInfoBar — `src/tools/RepairPdf.tsx:63-101` — lean toward FileInfoBar (but keep the size rows as tool-owned elements — FileInfoBar nulls in workflows).
- **minor** — "Change" link has no dark-mode variant — `src/tools/RepairPdf.tsx:76` — add `dark:text-primary-400 dark:hover:text-primary-300`.
- **minor** — Stacked size rows lack tabular-nums — `src/tools/RepairPdf.tsx:87-88,96-97` — optionally add `tabular-nums` (low priority; not a DESIGN.md violation here).
- **minor** — Success copy claims "downloaded" even mid-workflow — `src/tools/RepairPdf.tsx:110-114` — branch on `inWorkflow`/`isLastStep`.
- **minor** — No result-meaning feedback: can't tell a repair from a no-op — `src/tools/RepairPdf.tsx:91-100,110-114` — surface the delta meaningfully ("No structural problems found — re-saved cleanly").
- Does well: reports a concrete before/after byte delta (counter-example to the app-wide "confirms action not result" gap); honest scoped error copy; correct workflow-seam usage with `!inWorkflow`-gated Change affordance.

### Annotate & Sign

#### signature

Scores: UX 3 · Perf 4 · A11y 2 · Type 3 · Polish 3 (avg 3.0)
A feature-rich, thoughtfully built signature tool (per-page positions, draw/upload, colour tint, live drag) undermined by a critical silent-failure on single-page PDFs and a preview that misleads on any non-3:4 page.

- **critical** — Single-page PDFs silently deliver an UNSIGNED file — `src/tools/AddSignature.tsx:515,272-313,647-651` — when `thumbnails.length === 1`, seed `selectedPages` to `{0}` (or force all-pages); guard `handleApply` to error/no-op visibly when `pageIndices.length === 0`.
- **major** — Preview is not WYSIWYG on non-3:4 pages — `src/tools/AddSignature.tsx:605-637` — drive the container aspect from `pageDims[selectedPage]` so the image fills it and percentages map 1:1.
- **major** — Apply-to-all uses page 0's dimensions for every page — `src/tools/AddSignature.tsx:276-289` — build a per-page positionMap reading each page's real size (mirror the per-page branch at 296-301).
- **major** — Drag handle is a non-focusable div with no keyboard path — `src/tools/AddSignature.tsx:614-637` — make it focusable + arrow-key nudge with the same 2-98% clamp.
- **minor** — Mode toggle missing aria-pressed/role — `src/tools/AddSignature.tsx:360-389` — use shared SegmentedControl.
- **minor** — Upload helper text + Remove/Change use slate-400 + no focus ring — `src/tools/AddSignature.tsx:424,443-452` — slate-500 + `focus-visible:ring-2`.
- **minor** — Size sliders labeled "px" but feed PDF points 1:1 — `src/tools/AddSignature.tsx:489,497,286-287` — relabel "pt" or present as % of page width.
- **minor** — Signature can overflow page edges with no warning — `src/tools/AddSignature.tsx:208-209,280-281` — clamp `x+width <= pageWidth`, `y+height <= pageHeight`.
- **minor** — Disabled Apply gives no reason on multi-page PDFs — `src/tools/AddSignature.tsx:647-651` — add "Select at least one page" helper.
- **minor** — Switching Upload→Draw silently discards the drawn signature — `src/tools/AddSignature.tsx:362-365` — preserve per-mode last value instead of wiping on every Draw click.
- Does well: single-pass per-file load (parallel thumbnail + pdf-lib import, dims read once); per-page position memory; correct Y-axis inversion + stale-async-guarded tint; data-URL decode without fetch round-trip + luminance-to-alpha tint.

#### fill-pdf-form

Scores: UX 3 · Perf 3 · A11y 3 · Type 4 · Polish 4 (avg 3.4)
A clean form-filler with thoughtful reading-order field sorting and an honest empty state, weak on exposing raw internal field names and a hand-rolled page-thumbnail button that drops the shared component's a11y.

- **major** — Raw internal field names shown as the only label — `src/tools/FillPdfForm.tsx:277-279` — prefer the widget's `/TU` tooltip (read off `acroField` dict — pdf-lib has no `getTooltip()`), fall back to a humanized name.
- **minor** — First field-bearing page not auto-selected; fields panel hidden on load — `src/tools/FillPdfForm.tsx:134,259` — `setSelectedPage(minPage)` in the load callback.
- **minor** — No live preview — typed values never appear on the render — `src/tools/FillPdfForm.tsx:236-247` — optional: overlay current values at widget rects (positions already known).
- **minor** — Thumbnail page buttons lack aria-pressed/aria-label + focus ring — `src/tools/FillPdfForm.tsx:226-235` — render shared `PageThumbnail` or add the missing attributes.
- **minor** — Page-number caption uses slate-400 as load-bearing text — `src/tools/FillPdfForm.tsx:248-250` — slate-500/600 + `tabular-nums`.
- **minor** — Field-count badge uses arbitrary `text-[9px]` + no tabular-nums — `src/tools/FillPdfForm.tsx:243` — use `text-xxs`/`text-tag` + `tabular-nums`.
- **minor** — Flatten irreversibility warned only by the lowest-contrast text — `src/tools/FillPdfForm.tsx:387-402` — promote to slate-500/600 (keep opt-in default).
- **minor** — Same PDF parsed by pdf-lib twice on load — `src/tools/FillPdfForm.tsx:64-76` — read arrayBuffer once, pass a pre-loaded `PDFDocument` to `getFieldPageIndices`.
- **minor** — Empty-state copy names a non-existent "Add Watermark" tool — `src/tools/FillPdfForm.tsx:217-218` — rename to "Stamp & Watermark".
- **minor** — No success/result confirmation after fill — `src/tools/FillPdfForm.tsx:162-169` — render a callout with fields written vs skipped.
- Does well: fields sorted into true reading order (pageIndex asc, then y desc) via resolved widget rects; honest specific empty state; partial fills preserved across page switches with per-type controlled inputs; clean thumbnail/canvas teardown; focus-visible rings on the form controls.

#### stamp-pdf

Scores: UX 4 · Perf 4 · A11y 3 · Type 3 · Polish 3 (avg 3.4)
A strong live-preview annotate tool (mirrors all four output styles), single-pass load, proper thumbnail revoke — with one clear design-system break: seven preset swatches leak per-stamp colour onto interactive buttons.

- **major** — Seven preset buttons paint per-stamp colour onto interactive surfaces (breaks ONE ACCENT) — `src/tools/StampPdf.tsx:57-106,426-439` — render chips on neutral slate, let the primary ring be the only accent; keep brand ink for the preview/output.
- **minor** — Preset chips have no hover or focus-visible state — `src/tools/StampPdf.tsx:431-435` — add `hover:border-slate-300` + `focus-visible:ring-2`.
- **minor** — Preview text uses Inter while output uses Helvetica Bold — `src/tools/StampPdf.tsx:455,578-601` — set `fontFamily: 'Helvetica, Arial, sans-serif'` on the preview spans.
- **minor** — Custom watermark preview clips long text while pdf-lib draws it off-page — `src/tools/StampPdf.tsx:555,578-588` (+ `pdf-operations.ts:459-484`) — auto-scale watermark font to page width in lockstep, or warn on overflow.
- **minor** — Preview shows one page but stamp can apply to all/many (mixed sizes differ) — `src/tools/StampPdf.tsx:544-547` — label "applied to all N pages" / note per-page centering.
- **minor** — No success/result confirmation after deliver — `src/tools/StampPdf.tsx:300,638-648` — echo "Applied DRAFT to 3 of 12 pages".
- **minor** — "Mode" eyebrow at slate-400 + inconsistent peer label styles — `src/tools/StampPdf.tsx:347,422,480,545` — slate-500 + one label style.
- **minor** — "All"/"Clear" page-selection buttons lack hit-area + explicit focus ring — `src/tools/StampPdf.tsx:489-505` — add `px-2 py-1` + `focus-visible:ring-2`.
- Does well: excellent live-preview geometry fidelity across all four modes (shared constants with pdf-lib, ResizeObserver-accurate font px); single-pass file load with thumbnail revoke; sensible `canApply` validation (no empty-watermark / no-page-selected dead-ends).

#### add-page-numbers

Scores: UX 4 · Perf 5 · A11y 2 · Type 4 · Polish 4 (avg 3.8)
Genuinely well-built: loads once, real per-page live preview with correct overlay positioning, sensible defaults + dirty-gated reset. Weak only on accessibility — two icon-only control groups have no accessible name.

- **major** — Position-grid buttons are icon-only with no accessible name or selected-state — `src/tools/AddPageNumbers.tsx:203-217` — add `aria-label={title}` + `aria-pressed`; optionally wrap in `role="group"`.
- **major** — Preview page-nav chevrons have no accessible name + no focus-visible ring — `src/tools/AddPageNumbers.tsx:343-361` — add `aria-label` "Previous/Next page" + `focus-visible:ring-2`.
- **minor** — Position buttons use font-bold (700), above the 600 cap — `src/tools/AddPageNumbers.tsx:209` — drop to `font-semibold`.
- **minor** — Number inputs silently rewrite out-of-range/empty values — `src/tools/AddPageNumbers.tsx:292-325` — surface an inline "Clamped to 1–N" hint.
- **minor** — Page numbers drawn synchronously, no determinate progress on very long PDFs — `src/tools/AddPageNumbers.tsx:140-147` (+ `pdf-operations.ts:1341-1383`) — thread `onProgress` + ProgressBar if it ever feels slow (light op).
- Does well: real live preview with correct fidelity (point→% overlay, scaled font, "(no number)" labels); loads the PDF exactly once via `Promise.all` + blob revoke; thoughtful defaults with dirty-gated reset + live format examples; number inputs correctly labeled with focus rings.

#### header-footer

Scores: UX 3 · Perf 4 · A11y 3 · Type 4 · Polish 4 (avg 3.6)
Good single-pass load and clean token-insertion UX, but the headline live preview positions overlays against a hard-coded 3:4 container while the page is `object-contain`'d, so for Letter/A4 the overlay and font scale drift off the true edges.

- **major** — Preview overlay positioned against a fixed 3:4 box, not the actual page — wrong for Letter/A4 — `src/tools/HeaderFooter.tsx:388-396,170-171` — drive the container aspect from `pageDim` (`style={{aspectRatio: w/h}}`) so overlays + `usePreviewScale` map 1:1.
- **minor** — Preview footer anchor doesn't match pdf-lib's baseline draw model — `src/tools/HeaderFooter.tsx:404,442` (+ `pdf-operations.ts:1432-1433`) — anchor the footer baseline with a descent offset.
- **minor** — Placeholder text uses slate-300 (~1.6:1) — lighter than the codebase floor — `src/tools/HeaderFooter.tsx:151` — raise to slate-400/500 (these placeholders are the only labels).
- **minor** — Six header/footer inputs have no programmatic labels (placeholder-only) — `src/tools/HeaderFooter.tsx:216-239,254-277` — add distinct `aria-label`s ("Header left text", etc.).
- Does well: single-pass concurrent load (no per-keystroke re-parse); blob revoke + faithful `{{page}}`/`{{total}}` token preview mirroring the output regex; cursor-position-aware token insertion via `requestAnimationFrame`; `skipFirstPage` honored consistently in preview.

#### bates-numbering

Scores: UX 3 · Perf 4 · A11y 2 · Type 4 · Polish 3 (avg 3.2)
Good live-preview architecture (single-pass load, Courier↔font-mono fidelity, input clamping), with the same fixed-3:4-container preview bug as Header/Footer plus weak a11y on the custom position grid and icon steppers.

- **major** — Preview overlay anchors to a hardcoded 3:4 box, not the actual page — wrong for A4/legal/landscape — `src/tools/BatesNumbering.tsx:340-359,66-92` — set the container `aspectRatio` from `pageDim` so overlay margins + width-based font scale land on the true page box.
- **major** — Position grid buttons unlabeled for AT + no selected state — `src/tools/BatesNumbering.tsx:250-264` — add `aria-label={title}` + `aria-pressed`.
- **major** — Icon-only page-stepper buttons: no accessible name + sub-44px — `src/tools/BatesNumbering.tsx:312-330` — add `aria-label` + enlarge hit area.
- **minor** — Position buttons use border-2, off the 1px system — `src/tools/BatesNumbering.tsx:256-259` — use 1px `border`.
- **minor** — slate-400 as real text on position eyebrow + digits hint — `src/tools/BatesNumbering.tsx:237,245` — slate-500.
- **minor** — Off-pattern spacing step `max-w-45` — `src/tools/BatesNumbering.tsx:249` — use `max-w-44`/`max-w-48`.
- **minor** — Custom buttons skip the focus ring the inputs opt into — `src/tools/BatesNumbering.tsx:256-259,316,327` — add `focus-visible:ring-2 focus-visible:ring-primary-500`.
- Does well: single-pass load (no per-keystroke re-parse) + blob revoke; deliberate Courier↔`font-mono` font fidelity with px-accurate sizing; robust input clamping (startNumber ≥ 0, digits 1-12); clean one-accent compliance.

### Security & Properties

#### pdf-password

Scores: UX 3 · Perf 3 · A11y 3 · Type 4 · Polish 4 (avg 3.4)
A good auto-detect-then-adapt flow with solid inline match validation and proper input/toggle aria, with one real correctness gap: the "Restrict permissions" panel is silently defeated because the owner password is forced equal to the user password.

- **major** — Permission restrictions silently defeated: owner password = user password — `src/tools/PdfPassword.tsx:246` (+ `pdf-security.ts:867-871`) — warn that anyone who can open the file can also lift restrictions in Acrobat; optionally expose a separate owner-password field (the `ownerPassword` param already exists).
- **major** — Custom buttons (show/hide, change-file, disclosure) have no :focus-visible ring — `src/tools/PdfPassword.tsx:151-158,309-315,362-371` — add `focus-visible:ring-2 focus-visible:ring-primary-500`.
- **minor** — No minimum length or strength feedback on the AES-256 password — `src/tools/PdfPassword.tsx:233-250` — add a non-blocking "use at least 8 characters" hint/strength meter.
- **minor** — Permission descriptions + field hints use slate-400 (below AA) — `src/tools/PdfPassword.tsx:139,299,394` — bump to slate-500/600 (six rows of load-bearing copy).
- **minor** — Permission rows use raw checkbox instead of shared CheckboxField — `src/tools/PdfPassword.tsx:399-404` — use CheckboxField for consistency (won't fix focus/contrast — those are separate).
- **minor** — No progress for per-stream encrypt/decrypt on large PDFs — `src/tools/PdfPassword.tsx:457` (+ `pdf-security.ts:876-1006`) — thread `onProgress` + yield every N streams.
- **minor** — Permissions disclosure lacks aria-expanded/aria-controls — `src/tools/PdfPassword.tsx:362-371` — add both + `id` on the panel.
- Does well: auto-detect-then-adapt flow (no mode toggle to get wrong, graceful detection fallback); thoughtful inline validation + raw-error rewriting (wrong-password vs missing-password); correct input a11y (real labels, state-aware toggle aria-label, correct autoComplete, honest empty-password handling).

#### redact-pdf

Scores: UX 4 · Perf 4 · A11y 2 · Type 4 · Polish 4 (avg 3.6)
Genuinely well-engineered: determinate progress on all three long phases, a robust review-before-burn safety model, stale-file ref guards, honest destructive warning. The weak dimension is accessibility — the core canvas is pointer-only with no keyboard path.

- **major** — Core redaction canvas is pointer-only with no accessible name or keyboard path — `src/tools/RedactPdf.tsx:580-588` — add `role="application"` + aria-label + a pointer-required note; ideally arrow-key/coordinate box placement (auto-detect covers PII boxes but not names/signatures).
- **major** — Custom buttons (PII pills, detect, undo/clear, steppers, change-file) have no :focus-visible ring — `src/tools/RedactPdf.tsx:386-392,430-464,491-507,532-563` — add a shared `focus-visible:ring-2 focus-visible:ring-primary-600 ring-offset-2`.
- **minor** — Scan summary + detect results not announced to SR — `src/tools/RedactPdf.tsx:476-480` — wrap `detectSummary` in `role="status" aria-live="polite"`.
- **minor** — Page stepper buttons fall below the 44px minimum — `src/tools/RedactPdf.tsx:543-563` — bump to `p-2.5` / `min-w-11 min-h-11`.
- **minor** — Redacted pages silently downgrade to 150-DPI JPEG; resolution loss not surfaced — `src/tools/RedactPdf.tsx:607-611` (+ `pdf-operations.ts:1771,1812`) — add the ~150-DPI re-render note to the warning.
- **minor** — `detectSummary` persists stale after subsequent edits — `src/tools/RedactPdf.tsx:476-480,196-224` — clear/recompute on manual box mutation, or derive a live "N boxes / M total".
- **minor** — No way to remove a single box; undo is LIFO-only — `src/tools/RedactPdf.tsx:213-231,580-588` — hit-test + click-to-delete a rect (keeps later edits intact).
- Does well: exemplary review-before-burn model (nothing destroyed until Apply, sanctioned red danger token + honest permanent-removal warning); determinate labelled progress on all three long phases; careful async-correctness (fileRef/redactionsRef latch, freshest-map merge, dup-box skip); resolution-independent fractional rects with ResizeObserver re-sync; PII pills pair color with `aria-pressed`.

#### metadata

Scores: UX 4 · Perf 5 · A11y 4 · Type 4 · Polish 3 (avg 4.0)
A clean form tool with genuinely good per-field dirty tracking, proper label association, and a single parse per op. Real slips: a Save button that stays enabled after a successful standalone save (re-downloading identical bytes) and a red-tinted "Redact All" that breaks one-accent.

- **major** — Save button stays enabled after a successful save and re-delivers — `src/tools/EditMetadata.tsx:148-161,249-261` — sync the baseline to the saved metadata on success so `isDirty` returns false, or gate `disabled={!isDirty || saved}`.
- **minor** — "Redact All" is a fully red-tinted CTA on an interactive surface (one-accent break) — `src/tools/EditMetadata.tsx:195-202` — render as a neutral ghost/secondary button, or sanction red destructive treatment app-wide in DESIGN.md.
- **minor** — Success copy hard-codes "downloaded" but tool is workflow-eligible (latent) — `src/tools/EditMetadata.tsx:257-261` — mirror the button's `deliveryWord` for defensive correctness (currently unreachable mid-workflow).
- **minor** — Empty-state placeholders use slate-400 (sub-AA) — `src/tools/EditMetadata.tsx:241` — bump to slate-500 project-wide via a shared token.
- **minor** — "Redact All" wipes all fields on one click with no destructive cue — `src/tools/EditMetadata.tsx:142-146,195-202` — add a "clears all fields — saved file can't be un-redacted" hint (reversible pre-Save; no modal needed).
- **minor** — Comma-separated keywords written as a single PDF keyword — `src/tools/EditMetadata.tsx:61` (+ `pdf-operations.ts:753`) — split on commas before `setKeywords`, or relax the placeholder.
- Does well: excellent honest per-field dirty tracking (tinted bg + icon + dot per changed row); every input correctly label-associated with visible focus ring; clean perf (single parse per read/save, `updateMetadata:false`, no leaks); correct date-deletion handling (deletes Info entries, never writes Invalid Date).

#### compare-pdf

Scores: UX 3 · Perf 2 · A11y 3 · Type 4 · Polish 4 (avg 3.2)
Polished and genuinely useful (real result summary, determinate progress, disciplined blob cleanup), but it renders every page of BOTH PDFs into live blob-URL images with no cap, misaligns the diff when page sizes differ, and over-reports on any re-saved text PDF.

- **major** — Whole document of both PDFs rendered to blob-URL images up front with no page cap — `src/tools/ComparePdf.tsx:148-198,283` — render diffs lazily (current + small window) or cap with "showing N of M"; lower the 1.5× diff scale.
- **major** — Diff overlay misaligns when the two PDFs have different page dimensions — `src/tools/ComparePdf.tsx:80-82,96,104,598-617` — render the overlay base at the same common (max) dimensions the diff was computed against, or letterbox both before diffing.
- **major** — Pixel diff over-reports "changed" on text PDFs + no tolerance control — `src/tools/ComparePdf.tsx:78,113-129,173,283` — add an anti-alias/4-neighbour check or a sensitivity slider; treat sub-threshold speckle as identical.
- **minor** — Custom inline progress bar reimplements ProgressBar + silent to AT — `src/tools/ComparePdf.tsx:411-426` — use shared ProgressBar and/or wrap the status line in `role="status" aria-live="polite"`.
- **minor** — slate-400 as real text on one-sided-page notices + placeholders — `src/tools/ComparePdf.tsx:522,527,551,574,627` — slate-500/600 (the one-sided notices are load-bearing).
- **minor** — `diffCanvases` doc comment claims a "dimmed composite" base it never draws — `src/tools/ComparePdf.tsx:70-73,119-128` — fix the comment to describe the transparent red overlay.
- **minor** — Result-summary count + diff badges lack tabular-nums — `src/tools/ComparePdf.tsx:444-446,451,455,515-519` — add `tabular-nums`.
- **minor** — Page-strip thumbnails use object-cover and crop non-3:4 pages — `src/tools/ComparePdf.tsx:643-655` — use `object-contain` (shared PageThumbnail convention).
- Does well: disciplined canvas teardown + blob-URL lifecycle on primary paths; genuine result confirmation (total + identical-vs-changed counts, per-page badges); determinate per-page progress with correct SegmentedControl `ariaLabel` + stepper aria-labels.

#### digital-signature

Scores: UX 3 · Perf 3 · A11y 3 · Type 4 · Polish 4 (avg 3.4)
A thoughtfully structured security tool with genuinely rich existing-signature inspection, but it ships an invisible-only signature with no disclosure, freezes the thread on RSA keygen, and dead-ends real CA chains on a fixed 8 KB ceiling.

- **major** — RSA keygen freezes the main thread with only an indeterminate spinner — `src/tools/DigitalSignature.tsx:237-260` (+ `pdf-signer.ts:340`) — move 2048-bit keygen to a Web Worker; at minimum add "this can take a few seconds" copy.
- **major** — Signature is cryptographic-only and invisible — no disclosure — `pdf-signer.ts:501-505` (+ `DigitalSignature.tsx:783-787`) — add a success InfoCallout that the signature is only visible in a reader's signature panel.
- **major** — 8192-byte signature ceiling dead-ends real CA chains — `pdf-signer.ts:278,409,562-564` — reserve a larger placeholder (16-32 KB) sized from actual length; on overflow offer leaf-cert-only instead of "report this issue".
- **major** — Editing the self-signed name after generating has no effect — signs with the stale name — `src/tools/DigitalSignature.tsx:630-657` — clear `certInfo`/`privateKey` on name change so Generate reappears, or keep it visible as "Regenerate".
- **major** — Custom upload/self-signed tab control exposes no selected state to AT — `src/tools/DigitalSignature.tsx:497-543` — use `SegmentedControl` or add `aria-pressed`.
- **minor** — Bespoke Load/Generate CTAs lack the design's focus-visible ring — `src/tools/DigitalSignature.tsx:592-605,644-657` — add `focus-visible:ring-2 focus-visible:ring-primary-400/50`.
- **minor** — Self-signed name validation error is unreachable + renders far from the input — `src/tools/DigitalSignature.tsx:238-241,647,661` — drop the unreachable branch or surface inline.
- **minor** — Password-reveal toggle icon uses slate-400 as its only colour (below 3:1) — `src/tools/DigitalSignature.tsx:583` — bump to slate-500.
- **minor** — File parsed twice — detection on load, again on sign — `pdf-signer.ts:175,452` — cache the loaded ArrayBuffer (low priority; not concurrent).
- Does well: excellent existing-signature inspection (PKCS#7 parse with raw-bytes ByteRange fallback, surfaces signer/issuer/serial/validity/algorithm + Self-Signed badge); honest amber/security disclosures; stable content-derived list key + cancellable detection.

#### pdf-inspector

Scores: UX 4 · Perf 5 · A11y 4 · Type 3 · Polish 4 (avg 4.0)
A clean, honest read-only inspector that does one thing well: parses once via pdf-lib, never mutates, leaks nothing, and deliberately bypasses the encryption gate to report status. Surviving findings are minor.

- **minor** — Numeric output ignores tabular-nums mandate; dimension rows use font-mono — `src/tools/PdfInspector.tsx:93-95,144-149` — add `tabular-nums` to file size / version / page count / dimensions, drop `font-mono`.
- **minor** — slate-400 millimetre dimension is real content below AA — `src/tools/PdfInspector.tsx:146-149` — promote to slate-500.
- **minor** — Metadata shown for encrypted PDFs with no caveat that strings may be unreadable — `src/tools/PdfInspector.tsx:99-126` (+ `pdf-operations.ts:1852-1871`) — when `isEncrypted`, note metadata may be unreadable or suppress the block.
- **minor** — No "change file" affordance after inspection (no FileInfoBar) — `src/tools/PdfInspector.tsx:71-78` — accept the persistent dropzone (defensible) or add a FileInfoBar for consistency.
- Does well: deliberately bypasses the encrypted gate (`allowEncrypted:true`) to report version/pages/size/status instead of dead-ending; genuinely cheap + side-effect-free (pdf-lib only, no worker/canvas/object URL); clean conditional sections (no empty rows) with icon+color redundant encoding on encryption status.

### AI

#### ask-pdf

Scores: UX 4 · Perf 4 · A11y 2 · Type 4 · Polish 4 (avg 3.6)
A thoughtfully engineered, comment-rich on-device RAG chat with an excellent determinate indexing flow and honest model-gate copy. The weak dimension is accessibility of the chat surface: unlabeled composer with suppressed focus, unannounced streamed answers, and a dead-end error path.

- **major** — Streamed assistant answers are not announced to SR — `src/tools/AskPdf.tsx:646-657,776-845` — add `aria-live="polite"` (+ `role="log"`, `aria-atomic="false"`) to the transcript container.
- **major** — Composer textarea is unlabeled (placeholder-only) + fails AA contrast — `src/tools/AskPdf.tsx:871-883` — add `aria-label` + darken placeholder to slate-500.
- **major** — Composer suppresses its own focus ring with no replacement — `src/tools/AskPdf.tsx:882` — give the textarea or its wrapper a visible `focus-visible`/`focus-within:ring-2 ring-primary-600`.
- **major** — Failed answer dead-ends: orphaned empty assistant bubble, no inline retry, question text lost — `src/tools/AskPdf.tsx:184-232,467` — render an inline error bubble with a Retry that re-submits the last question (keep it in a ref before the `setQuestion("")` clear).
- **minor** — Enter-to-send doesn't guard against IME composition — `src/tools/AskPdf.tsx:234-242` — bail when `isComposing` is true.
- **minor** — Send button is a bespoke CTA missing focus ring; busy spinners not reduced-motion-gated — `src/tools/AskPdf.tsx:913-930,811-815,830-834` — add `focus-visible:ring-2`; add a reduced-motion exemption for the `animate-spin`/`animate-pulse` glyphs.
- **minor** — Character-counter aria-live re-announces on every keystroke past 400 — `src/tools/AskPdf.tsx:901-912` — announce only threshold transitions via a separate polite region.
- **minor** — Per-token auto-scroll uses smooth behavior and ignores prefers-reduced-motion — `src/tools/AskPdf.tsx:99-104` — gate `behavior` on the reduced-motion media query.
- Does well: single monotonic determinate indexing bar (extract 30% / embed 70%) with human-readable phase labels; eager indexing the moment models+PDF are ready, with correct session invalidation on tier-swap/leaving-ready; XSS-safe markdown by construction (no `rehype-raw`, user turns as plain text); honest model-gate copy with explicit no-`deviceMemory` rejection.
