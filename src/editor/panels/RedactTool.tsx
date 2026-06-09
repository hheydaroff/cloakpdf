// RedactTool.tsx — Destructive-drag tool. The Stage lets the user drag
// redaction boxes on the focused page (stored as `redaction` overlay objects in
// fraction space); the Panel auto-detects PII and applies the burn. On Apply,
// `redactPdf` rasterises the boxed pages and destroys the underlying text — so
// the redaction objects are dropped from the doc afterwards (they're now in the
// pixels). Reuses the exact geometry + PII pipeline the standalone RedactPdf
// tool proved. See REDESIGN.md (destructive-drag class).

import { Loader2, ScanSearch, Search } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { canvas as canvasColors } from "../../config/theme.ts";
import { detectPiiRects, extractTextGeometry, findTextRects } from "../../utils/layout-extract.ts";
import { redactPdf } from "../../utils/pdf-operations.ts";
import { PII_LABELS, PII_TYPES, type PiiType } from "../../utils/pii.ts";
import { docToFile } from "../doc.ts";
import { useEditorActions, useEditorRead } from "../EditorContext.tsx";
import { useStageProps } from "../stage.tsx";
import type { FractionRect } from "../types.ts";

function drawBox(ctx: CanvasRenderingContext2D, r: FractionRect, w: number, h: number) {
  const x = r.xPct * w;
  const y = r.yPct * h;
  const bw = r.wPct * w;
  const bh = r.hPct * h;
  ctx.fillStyle = canvasColors.redactFill;
  ctx.fillRect(x, y, bw, bh);
  ctx.strokeStyle = canvasColors.redactStroke;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, bw, bh);
}

export function Stage() {
  const { doc, selectedPage } = useEditorRead();
  const { addObject } = useEditorActions();
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState<FractionRect | null>(null);

  const paintOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, pageIndex: number) => {
      for (const o of doc?.objects ?? []) {
        if (o.kind === "redaction" && o.pageIndex === pageIndex && o.rect)
          drawBox(ctx, o.rect, w, h);
      }
      if (box) drawBox(ctx, box, w, h);
    },
    [doc, box],
  );

  useStageProps({
    cursor: "crosshair",
    paintOverlay,
    onPointerDown: (p) => {
      startRef.current = { x: p.xPct, y: p.yPct };
    },
    onPointerMove: (p) => {
      const s = startRef.current;
      if (!s) return;
      setBox({
        xPct: Math.min(s.x, p.xPct),
        yPct: Math.min(s.y, p.yPct),
        wPct: Math.abs(p.xPct - s.x),
        hPct: Math.abs(p.yPct - s.y),
      });
    },
    onPointerUp: (p) => {
      const s = startRef.current;
      startRef.current = null;
      setBox(null);
      if (!s) return;
      const rect: FractionRect = {
        xPct: Math.min(s.x, p.xPct),
        yPct: Math.min(s.y, p.yPct),
        wPct: Math.abs(p.xPct - s.x),
        hPct: Math.abs(p.yPct - s.y),
      };
      if (rect.wPct > 0.01 && rect.hPct > 0.01) {
        addObject({ kind: "redaction", pageIndex: selectedPage, rect });
      }
    },
    onPointerCancel: () => {
      startRef.current = null;
      setBox(null);
    },
  });

  return null;
}

export function Panel() {
  const { doc } = useEditorRead();
  const { addObjects, applyTransform } = useEditorActions();
  const [piiTypes, setPiiTypes] = useState<Set<PiiType>>(
    () => new Set(PII_TYPES.filter((t) => t !== "date")),
  );
  const [detecting, setDetecting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  // Find-text-and-redact: type a name/phrase, black out every occurrence.
  const [term, setTerm] = useState("");
  const [finding, setFinding] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  const redactions = (doc?.objects ?? []).filter((o) => o.kind === "redaction");
  const count = redactions.length;

  const toggle = (t: PiiType) =>
    setPiiTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  const detect = useCallback(async () => {
    if (!doc || piiTypes.size === 0) return;
    setDetecting(true);
    setSummary(null);
    try {
      const pages = await extractTextGeometry(docToFile(doc), { ocr: true });
      const found = detectPiiRects(pages, [...piiTypes]);
      if (found.length === 0) {
        setSummary("No matching sensitive data found — draw boxes by hand if needed.");
        return;
      }
      addObjects(
        found.map((r) => ({
          kind: "redaction" as const,
          pageIndex: r.pageIndex,
          rect: { xPct: r.xPct, yPct: r.yPct, wPct: r.wPct, hPct: r.hPct },
        })),
        "Detect PII",
      );
      setSummary(`Added ${found.length} box${found.length > 1 ? "es" : ""}.`);
    } catch {
      setSummary("Couldn't scan this document for sensitive data.");
    } finally {
      setDetecting(false);
    }
  }, [doc, piiTypes, addObjects]);

  const find = useCallback(async () => {
    const q = term.trim();
    if (!doc || !q) return;
    setFinding(true);
    setSummary(null);
    try {
      const pages = await extractTextGeometry(docToFile(doc), { ocr: true });
      const rects = findTextRects(pages, [q], { caseSensitive, wholeWord });
      if (rects.length === 0) {
        setSummary(`No text-layer matches for “${q}”. It may be an image — run OCR first.`);
        return;
      }
      addObjects(
        rects.map((r) => ({
          kind: "redaction" as const,
          pageIndex: r.pageIndex,
          rect: { xPct: r.xPct, yPct: r.yPct, wPct: r.wPct, hPct: r.hPct },
        })),
        `Find “${q}”`,
      );
      setSummary(`Added ${rects.length} box${rects.length === 1 ? "" : "es"} for “${q}”.`);
      setTerm("");
    } catch {
      setSummary("Couldn't search this document for that text.");
    } finally {
      setFinding(false);
    }
  }, [doc, term, caseSensitive, wholeWord, addObjects]);

  const apply = useCallback(() => {
    void applyTransform(async (d) => {
      const rects = d.objects
        .filter((o) => o.kind === "redaction" && o.rect)
        .map((o) => ({ pageIndex: o.pageIndex, ...o.rect! }));
      const bytes = await redactPdf(docToFile(d), rects);
      return {
        bytes,
        label: `Redact ${rects.length}`,
        objects: d.objects.filter((o) => o.kind !== "redaction"),
      };
    });
  }, [applyTransform]);

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-3 rounded-xl border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface p-3">
        <div className="flex items-start gap-2">
          <ScanSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
          <p className="text-xs text-slate-500 dark:text-dark-text-muted">
            Auto-detect emails, phones & IDs, or drag boxes on the page.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PII_TYPES.map((t) => {
            const on = piiTypes.has(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggle(t)}
                disabled={detecting}
                aria-pressed={on}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  on
                    ? "bg-primary-600 text-white"
                    : "border border-slate-200 dark:border-dark-border bg-slate-100 dark:bg-dark-bg text-slate-600 dark:text-dark-text-muted"
                }`}
              >
                {PII_LABELS[t]}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void detect()}
          disabled={detecting || finding || piiTypes.size === 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          {detecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ScanSearch className="h-4 w-4" />
          )}
          {detecting ? "Scanning…" : "Detect & add boxes"}
        </button>
      </div>

      {/* Find text & redact — black out every occurrence of a name or phrase. */}
      <div className="space-y-2 rounded-xl border border-slate-200 dark:border-dark-border bg-white/70 dark:bg-dark-surface p-3">
        <div className="flex items-start gap-2">
          <Search className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
          <p className="text-xs text-slate-500 dark:text-dark-text-muted">
            Type a name or phrase to black out every occurrence — what auto-detect can't catch.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={term}
            placeholder="Search text…"
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void find();
              }
            }}
            disabled={finding}
            className="min-w-0 flex-1 rounded-lg border border-slate-200 dark:border-dark-border bg-white dark:bg-dark-surface px-2.5 py-1.5 text-sm text-slate-800 dark:text-dark-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void find()}
            disabled={detecting || finding || !term.trim()}
            aria-label="Find and redact"
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            {finding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Find"}
          </button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-dark-text-muted">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              disabled={finding}
              className="h-4 w-4 rounded border-slate-300 text-primary-600 focus-visible:ring-primary-500"
            />
            Match case
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-dark-text-muted">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
              disabled={finding}
              className="h-4 w-4 rounded border-slate-300 text-primary-600 focus-visible:ring-primary-500"
            />
            Whole word
          </label>
        </div>
      </div>

      {summary && (
        <p role="status" className="text-xs text-slate-500 dark:text-dark-text-muted">
          {summary}
        </p>
      )}

      <span className="text-sm text-slate-600 dark:text-dark-text-muted">
        {count} redaction{count === 1 ? "" : "s"}
      </span>

      <button
        type="button"
        onClick={apply}
        disabled={count === 0}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
      >
        Apply {count} redaction{count === 1 ? "" : "s"}
      </button>
      <p className="text-xs text-slate-400 dark:text-dark-text-muted">
        Redacted pages are flattened to images so the hidden text is permanently removed.
      </p>
    </div>
  );
}
