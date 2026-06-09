// FindActTool.tsx — Search the document's text layer for any term and act on
// every occurrence at once: black it out (Redact), Highlight it, or Box it for
// review. This is the only path that *locates* existing user-supplied text —
// Redact finds a fixed PII taxonomy or hand-drawn boxes; Annotate places new
// marks but can't find existing ones. Deterministic literal matching (no model)
// over the same PDF.js text layer + Tesseract OCR fallback the Redact tool uses,
// so it works identically on every device.
//
// State lives in the tool slice (like Crop's `keep`), not as doc objects: the
// Stage paints the staged matches for the focused page, the Panel drives search
// + apply. On Apply the matches are burned (redactPdf / annotatePdf) and cleared.

import { Loader2, Search, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { canvas as canvasColors } from "../../config/theme.ts";
import {
  dedupeTerms,
  extractTextGeometry,
  findTextRects,
  type LayoutPage,
  type TextMatchRect,
} from "../../utils/layout-extract.ts";
import { type Annotation, annotatePdf, redactPdf } from "../../utils/pdf-operations.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead, useToolSlice } from "../EditorContext.tsx";
import { useStageProps } from "../stage.tsx";
import type { FractionRect } from "../types.ts";
import { Segmented } from "./WholeDocPanel.tsx";

const TOOL_ID = "find-act";

type ActMode = "redact" | "highlight" | "box";

/** A resolved match staged in the tool slice. */
interface StoredMatch extends TextMatchRect {
  id: string;
  /** Included in the Apply batch (the per-hit checkbox). */
  on: boolean;
}

interface FindActSlice {
  terms: string[];
  mode: ActMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: StoredMatch[];
  /** A scanned page was OCR'd — matching is over recognised text only. */
  scanned: boolean;
  /** A search has completed (so an empty list means "0 matches", not "no search"). */
  searched: boolean;
}

const HIGHLIGHT = { r: 250, g: 204, b: 21 }; // amber-400
const BOX = { r: 220, g: 38, b: 38 }; // red-600

function readSlice(slice: Record<string, unknown>): FindActSlice {
  return {
    terms: (slice.terms as string[]) ?? [],
    mode: (slice.mode as ActMode) ?? "redact",
    caseSensitive: (slice.caseSensitive as boolean) ?? false,
    wholeWord: (slice.wholeWord as boolean) ?? false,
    matches: (slice.matches as StoredMatch[]) ?? [],
    scanned: (slice.scanned as boolean) ?? false,
    searched: (slice.searched as boolean) ?? false,
  };
}

function paintMatch(
  ctx: CanvasRenderingContext2D,
  r: FractionRect,
  w: number,
  h: number,
  mode: ActMode,
) {
  const x = r.xPct * w;
  const y = r.yPct * h;
  const bw = r.wPct * w;
  const bh = r.hPct * h;
  if (mode === "redact") {
    ctx.fillStyle = canvasColors.redactFill;
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = canvasColors.redactStroke;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, bw, bh);
  } else if (mode === "highlight") {
    ctx.fillStyle = "rgba(250, 204, 21, 0.4)";
    ctx.fillRect(x, y, bw, bh);
  } else {
    ctx.strokeStyle = "rgba(220, 38, 38, 0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, bw, bh);
  }
}

export function Stage() {
  const slice = useToolSlice(TOOL_ID);
  const { matches, mode } = readSlice(slice);

  const paintOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pageIndex: number) => {
      for (const m of matches) {
        if (m.on && m.pageIndex === pageIndex) paintMatch(ctx, m, w, h, mode);
      }
    },
    [matches, mode],
  );

  useStageProps({ cursor: "default", paintOverlay });
  return null;
}

export function Panel() {
  const { doc, busyLabel } = useEditorRead();
  const { patchToolState, applyTransform, setSelectedPage, setViewMode } = useEditorActions();
  const slice = readSlice(useToolSlice(TOOL_ID));
  const { terms, mode, caseSensitive, wholeWord, matches, scanned, searched } = slice;

  const [input, setInput] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [ocr, setOcr] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Geometry cache keyed by the doc's byte buffer reference — applyTransform
  // mints fresh bytes, so a doc change invalidates it automatically. Lets term
  // edits / option toggles re-match without re-OCRing the same file.
  const geomRef = useRef<{ key: Uint8Array; pages: LayoutPage[]; scanned: boolean } | null>(null);

  const busy = busyLabel !== null;
  const enabled = matches.filter((m) => m.on);
  const pagesHit = new Set(matches.map((m) => m.pageIndex)).size;

  const ensureGeometry = useCallback(async (): Promise<{
    pages: LayoutPage[];
    scanned: boolean;
  }> => {
    const d = doc;
    if (!d) return { pages: [], scanned: false };
    const cached = geomRef.current;
    if (cached && cached.key === d.bytes) return cached;
    let sawScan = false;
    const pages = await extractTextGeometry(docToFile(d), {
      ocr: true,
      onOcrPage: (done, total) => {
        sawScan = true;
        setOcr({ done, total });
      },
    });
    const entry = { key: d.bytes, pages, scanned: sawScan };
    geomRef.current = entry;
    return entry;
  }, [doc]);

  const runSearch = useCallback(
    async (termList: string[], opts: { caseSensitive: boolean; wholeWord: boolean }) => {
      if (!doc) return;
      const cleaned = dedupeTerms(termList, opts.caseSensitive);
      if (cleaned.length === 0) {
        patchToolState(TOOL_ID, { terms: [], matches: [], searched: false, scanned: false });
        return;
      }
      setDetecting(true);
      setErr(null);
      setOcr(null);
      try {
        const { pages, scanned: sc } = await ensureGeometry();
        const found = findTextRects(pages, cleaned, opts);
        const stored: StoredMatch[] = found.map((m, i) => ({
          ...m,
          id: `${m.pageIndex}:${m.matchStart}:${m.matchEnd}:${m.term}:${i}`,
          on: true,
        }));
        patchToolState(TOOL_ID, {
          terms: cleaned,
          matches: stored,
          scanned: sc,
          searched: true,
        });
      } catch {
        patchToolState(TOOL_ID, { matches: [], searched: true });
        setErr("Couldn't search this document.");
      } finally {
        setDetecting(false);
        setOcr(null);
      }
    },
    [doc, ensureGeometry, patchToolState],
  );

  const onFind = useCallback(() => {
    const t = input.trim();
    const next = t ? [...terms, t] : terms;
    setInput("");
    void runSearch(next, { caseSensitive, wholeWord });
  }, [input, terms, caseSensitive, wholeWord, runSearch]);

  const removeTerm = (term: string) =>
    void runSearch(
      terms.filter((x) => x !== term),
      { caseSensitive, wholeWord },
    );

  const toggleOption = (key: "caseSensitive" | "wholeWord") => {
    const opts = { caseSensitive, wholeWord, [key]: !slice[key] };
    patchToolState(TOOL_ID, { [key]: opts[key] });
    if (terms.length > 0) void runSearch(terms, opts);
  };

  const toggleHit = (id: string) =>
    patchToolState(TOOL_ID, {
      matches: matches.map((m) => (m.id === id ? { ...m, on: !m.on } : m)),
    });

  const setAll = (on: boolean) =>
    patchToolState(TOOL_ID, { matches: matches.map((m) => ({ ...m, on })) });

  const clearAll = () => {
    setInput("");
    setErr(null);
    patchToolState(TOOL_ID, { terms: [], matches: [], searched: false, scanned: false });
  };

  const jump = (pageIndex: number) => {
    setSelectedPage(pageIndex);
    setViewMode("focus");
  };

  const apply = useCallback(() => {
    if (enabled.length === 0) return;
    const afterApply = () =>
      patchToolState(TOOL_ID, { matches: [], terms: [], searched: false, scanned: false });
    if (mode === "redact") {
      void applyTransform(async (d) => {
        const rects = enabled.map((m) => ({
          pageIndex: m.pageIndex,
          xPct: m.xPct,
          yPct: m.yPct,
          wPct: m.wPct,
          hPct: m.hPct,
        }));
        const bytes = await redactPdf(docToFile(d), rects);
        return { bytes, label: `Redact ${rects.length} match${rects.length === 1 ? "" : "es"}` };
      }).then(afterApply);
      return;
    }
    const color = mode === "highlight" ? HIGHLIGHT : BOX;
    const anns: Annotation[] = enabled.map((m) => {
      // Highlight: translucent fill + a hairline border in the fill colour
      // (≈ invisible). Box: a visible ~2-pt outline, no fill.
      const base = {
        kind: "rect" as const,
        pageIndex: m.pageIndex,
        x: m.xPct,
        y: m.yPct,
        w: m.wPct,
        h: m.hPct,
        color,
        thicknessFrac: mode === "box" ? 0.004 : 0.0008,
      };
      return mode === "highlight" ? { ...base, fill: { color, opacity: 0.4 } } : base;
    });
    void applyTransform(async (d) => ({
      bytes: await annotatePdf(docToFile(d), anns),
      label: `${mode === "highlight" ? "Highlight" : "Box"} ${anns.length}`,
    })).then(afterApply);
  }, [enabled, mode, applyTransform, patchToolState]);

  // Group matches by page for the hit-list.
  const byPage = new Map<number, StoredMatch[]>();
  for (const m of matches) {
    const list = byPage.get(m.pageIndex) ?? [];
    list.push(m);
    byPage.set(m.pageIndex, list);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500 dark:text-dark-text-muted">
        Find every occurrence of a word or phrase, then redact, highlight, or box them all at once.
      </p>

      <Segmented
        value={mode}
        onChange={(m: ActMode) => patchToolState(TOOL_ID, { mode: m })}
        options={[
          { value: "redact", label: "Redact" },
          { value: "highlight", label: "Highlight" },
          { value: "box", label: "Box" },
        ]}
      />

      {/* Search box */}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={input}
            placeholder="Search text…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onFind();
              }
            }}
            disabled={detecting}
            className="w-full rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface py-1.5 pl-8 pr-2.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={onFind}
          disabled={detecting || (!input.trim() && terms.length === 0)}
          aria-label="Find matches"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          {detecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
        </button>
      </div>

      {/* Active term chips */}
      {terms.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {terms.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-dark-bg px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-dark-text-muted"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTerm(t)}
                disabled={detecting}
                aria-label={`Remove “${t}”`}
                className="rounded-full p-0.5 hover:bg-slate-200 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Options */}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {(["caseSensitive", "wholeWord"] as const).map((key) => (
          <label
            key={key}
            className="flex items-center gap-2 text-sm text-slate-600 dark:text-dark-text-muted"
          >
            <input
              type="checkbox"
              checked={slice[key]}
              onChange={() => toggleOption(key)}
              disabled={detecting}
              className="h-4 w-4 rounded border-slate-300 text-primary-600 focus-visible:ring-primary-500"
            />
            {key === "caseSensitive" ? "Match case" : "Whole word"}
          </label>
        ))}
      </div>

      {detecting && ocr && (
        <p className="text-xs text-slate-500 dark:text-dark-text-muted" role="status">
          Reading scanned pages… ({ocr.done}/{ocr.total})
        </p>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}

      {scanned && matches.length > 0 && (
        <p className="rounded-lg bg-amber-50 dark:bg-amber-900/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Scanned pages were read with OCR — matching is over recognised text only. Verify visually.
        </p>
      )}

      {/* Results */}
      {searched && !detecting && (
        <>
          {matches.length === 0 ? (
            <p className="rounded-lg bg-slate-50 dark:bg-dark-bg px-3 py-2 text-xs text-slate-500 dark:text-dark-text-muted">
              No text-layer matches. The term may still be present as an image — scan visually, or
              run OCR first.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700 dark:text-dark-text tabular-nums">
                  {matches.length} match{matches.length === 1 ? "" : "es"} · {pagesHit} page
                  {pagesHit === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setAll(true)}
                    className="text-primary-600 hover:underline"
                  >
                    All
                  </button>
                  <span className="text-slate-300 dark:text-dark-border">·</span>
                  <button
                    type="button"
                    onClick={() => setAll(false)}
                    className="text-primary-600 hover:underline"
                  >
                    None
                  </button>
                </div>
              </div>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-dark-border divide-y divide-slate-100 dark:divide-dark-border">
                {[...byPage.entries()].map(([pageIndex, list]) => (
                  <div key={pageIndex} className="p-2">
                    <button
                      type="button"
                      onClick={() => jump(pageIndex)}
                      className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400 hover:text-primary-600 focus-visible:outline-none"
                    >
                      Page {pageIndex + 1}
                    </button>
                    <ul className="flex flex-col gap-1">
                      {list.map((m) => (
                        <li key={m.id} className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={m.on}
                            onChange={() => toggleHit(m.id)}
                            aria-label={`Include match on page ${pageIndex + 1}`}
                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-primary-600 focus-visible:ring-primary-500"
                          />
                          <button
                            type="button"
                            onClick={() => jump(pageIndex)}
                            className="min-w-0 flex-1 truncate text-left text-xs text-slate-600 dark:text-dark-text-muted hover:text-slate-900 dark:hover:text-dark-text"
                            title={m.line}
                          >
                            {m.line.slice(0, m.matchStart)}
                            <mark className="bg-amber-200/70 dark:bg-amber-500/30 text-slate-900 dark:text-dark-text">
                              {m.line.slice(m.matchStart, m.matchEnd)}
                            </mark>
                            {m.line.slice(m.matchEnd)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={apply}
                  disabled={busy || enabled.length === 0}
                  className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-semibold text-white transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                    mode === "redact"
                      ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
                      : "bg-primary-600 hover:bg-primary-700 focus-visible:ring-primary-500"
                  }`}
                >
                  {busy
                    ? "Working…"
                    : `${mode === "redact" ? "Redact" : mode === "highlight" ? "Highlight" : "Box"} ${enabled.length}`}
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  className="rounded-lg border border-slate-200 dark:border-dark-border px-3 py-2.5 text-sm text-slate-500 dark:text-dark-text-muted hover:bg-slate-50 dark:hover:bg-dark-surface-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  Clear
                </button>
              </div>
              {mode === "redact" && (
                <p className="text-xs text-slate-400 dark:text-dark-text-muted">
                  Redacted pages are flattened to images so the hidden text is permanently removed.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
