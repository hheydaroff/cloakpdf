/**
 * Unit tests for the pure geometry helpers in layout-extract.ts.
 *
 * These cover the maths that turns liteparse's point-space items into the
 * page-fraction rectangles RedactPdf consumes, plus reading-order
 * reconstruction. The wasm extraction itself is exercised by the browser
 * smoke (it needs a real Vite/WebAssembly environment); here we pin the
 * shape-normalisation and coordinate logic that must stay correct for
 * redaction to land on the right place.
 */
import { describe, expect, it } from "vitest";
import {
  detectPiiRects,
  itemFractionRect,
  type LayoutItem,
  type LayoutPage,
  layoutToReadingOrderText,
  normalizeParseResult,
  substringFractionRect,
} from "../../src/utils/layout-extract.ts";

function item(partial: Partial<LayoutItem>): LayoutItem {
  return { text: "", x: 0, y: 0, width: 0, height: 0, fontSize: 0, ...partial };
}
function page(partial: Partial<LayoutPage>): LayoutPage {
  return { pageNumber: 1, width: 100, height: 200, text: "", items: [], ...partial };
}

describe("normalizeParseResult", () => {
  it("maps raw liteparse pages to typed LayoutPages", () => {
    const out = normalizeParseResult({
      pages: [
        {
          pageNum: 1,
          width: 595,
          height: 842,
          text: "hello",
          textItems: [{ text: "a", x: 1, y: 2, width: 3, height: 4, fontSize: 5 }],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ pageNumber: 1, width: 595, height: 842, text: "hello" });
    expect(out[0].items[0]).toEqual({ text: "a", x: 1, y: 2, width: 3, height: 4, fontSize: 5 });
  });

  it("drops items with no coordinates and defaults missing fields", () => {
    const out = normalizeParseResult({
      pages: [{ textItems: [{ text: "keep", x: 0, y: 0 }, { text: "drop — no coords" }] }],
    });
    expect(out[0].pageNumber).toBe(1); // falls back to index+1
    expect(out[0].items).toHaveLength(1);
    expect(out[0].items[0]).toMatchObject({ text: "keep", width: 0, height: 0, fontSize: 0 });
  });

  it("handles null / empty input", () => {
    expect(normalizeParseResult(null)).toEqual([]);
    expect(normalizeParseResult({})).toEqual([]);
  });
});

describe("itemFractionRect", () => {
  it("converts point-space box to page fractions (top-left origin, no flip)", () => {
    const p = page({ width: 200, height: 400 });
    const r = itemFractionRect(item({ x: 50, y: 100, width: 100, height: 20 }), p);
    expect(r).toEqual({ xPct: 0.25, yPct: 0.25, wPct: 0.5, hPct: 0.05 });
  });

  it("clamps out-of-range coordinates into [0,1]", () => {
    const p = page({ width: 100, height: 100 });
    const r = itemFractionRect(item({ x: -10, y: 120, width: 999, height: 50 }), p);
    expect(r.xPct).toBe(0);
    expect(r.yPct).toBe(1);
    expect(r.wPct).toBe(1);
  });
});

describe("substringFractionRect", () => {
  it("locates a substring by proportional character offset (no pad)", () => {
    const p = page({ width: 100, height: 200 });
    // text length 10, spans the full page width → 10pt per char
    const it = item({ text: "0123456789", x: 0, y: 50, width: 100, height: 10 });
    const r = substringFractionRect(it, p, 2, 5, 0);
    expect(r.xPct).toBeCloseTo(0.2, 5);
    expect(r.wPct).toBeCloseTo(0.3, 5);
    expect(r.yPct).toBeCloseTo(0.25, 5);
    expect(r.hPct).toBeCloseTo(0.05, 5);
  });

  it("pads outward so the match is never left exposed, clamped to the item", () => {
    const p = page({ width: 100, height: 200 });
    const it = item({ text: "0123456789", x: 0, y: 0, width: 100, height: 10 });
    const padded = substringFractionRect(it, p, 2, 5, 0.75);
    const tight = substringFractionRect(it, p, 2, 5, 0);
    expect(padded.xPct).toBeLessThan(tight.xPct);
    expect(padded.wPct).toBeGreaterThan(tight.wPct);
    // never extends past the item's own box
    const full = substringFractionRect(it, p, 0, it.text.length, 5);
    expect(full.xPct).toBe(0);
    expect(full.wPct).toBeCloseTo(1, 5);
  });

  it("floors to a visible box when item.width is 0 (would otherwise leave PII exposed)", () => {
    const p = page({ width: 100, height: 200 });
    // A bogus width:0 item must not collapse the redaction box to zero area.
    const r = substringFractionRect(
      item({ text: "0123456789", x: 0, y: 50, width: 0, height: 10 }),
      p,
      2,
      5,
    );
    expect(r.wPct).toBeGreaterThan(0);
    expect(r.hPct).toBeGreaterThan(0);
  });
});

describe("layoutToReadingOrderText", () => {
  it("orders two columns top-to-bottom, left-to-right within a row", () => {
    const p = page({
      items: [
        item({ text: "RIGHT-TOP", x: 300, y: 10, width: 80, height: 10 }),
        item({ text: "LEFT-TOP", x: 10, y: 10, width: 80, height: 10 }),
        item({ text: "RIGHT-BOT", x: 300, y: 40, width: 80, height: 10 }),
        item({ text: "LEFT-BOT", x: 10, y: 40, width: 80, height: 10 }),
      ],
    });
    expect(layoutToReadingOrderText(p)).toBe("LEFT-TOP RIGHT-TOP\nLEFT-BOT RIGHT-BOT");
  });

  it("groups items within the row tolerance onto one line", () => {
    const p = page({
      items: [
        item({ text: "a", x: 0, y: 10, width: 5, height: 10 }),
        item({ text: "b", x: 10, y: 12, width: 5, height: 10 }), // within 3pt tolerance
        item({ text: "c", x: 0, y: 40, width: 5, height: 10 }),
      ],
    });
    expect(layoutToReadingOrderText(p)).toBe("a b\nc");
  });

  it("falls back to liteparse page text when there are no items", () => {
    expect(layoutToReadingOrderText(page({ items: [], text: "  raw text  " }))).toBe("raw text");
  });
});

describe("detectPiiRects", () => {
  it("maps a PII span inside an item to a redaction rect on the right page", () => {
    const p = page({
      pageNumber: 2,
      width: 600,
      height: 800,
      items: [
        item({ text: "admin@slicedinvoices.com", x: 60, y: 200, width: 180, height: 10 }),
        item({ text: "Web Design service", x: 60, y: 240, width: 120, height: 10 }),
      ],
    });
    const rects = detectPiiRects([p], ["email"]);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({
      pageIndex: 1,
      type: "email",
      value: "admin@slicedinvoices.com",
    });
    // The rect lands on the email item's row (yPct ≈ 200/800) and is within [0,1].
    expect(rects[0].yPct).toBeCloseTo(0.25, 4);
    expect(rects[0].xPct).toBeGreaterThanOrEqual(0);
    expect(rects[0].xPct + rects[0].wPct).toBeLessThanOrEqual(1);
  });

  it("locates a mid-item match (offset > 0) further right than a leading one", () => {
    // Full-width item so the substring's char offset maps onto page fractions.
    const p = page({
      width: 600,
      height: 800,
      items: [item({ text: "Mail: x@y.com", x: 0, y: 10, width: 600, height: 10 })],
    });
    const [rect] = detectPiiRects([p], ["email"]);
    // "x@y.com" starts at char 6 of 13 → roughly the right half of the item.
    expect(rect.xPct).toBeGreaterThan(0.3);
  });

  it("respects the type filter", () => {
    const p = page({
      width: 600,
      height: 800,
      items: [item({ text: "call 123-456-7890", x: 0, y: 10, width: 100, height: 10 })],
    });
    expect(detectPiiRects([p], ["email"])).toHaveLength(0);
    expect(detectPiiRects([p], ["phone"])).toHaveLength(1);
  });

  it("covers a phone split across word-items on one row (OCR/PDF.js word split)", () => {
    // Tesseract emits one item per word, so "123 456 7890" arrives split. Per-item
    // detection would miss it entirely; row-based detection must catch it and the
    // box must span all three words.
    const p = page({
      width: 600,
      height: 800,
      items: [
        item({ text: "123", x: 0, y: 100, width: 30, height: 12 }),
        item({ text: "456", x: 40, y: 100, width: 30, height: 12 }),
        item({ text: "7890", x: 80, y: 100, width: 40, height: 12 }),
      ],
    });
    const rects = detectPiiRects([p], ["phone"]);
    expect(rects).toHaveLength(1);
    expect(rects[0].type).toBe("phone");
    expect(rects[0].xPct).toBeLessThan(0.05); // starts at the first word (x≈0)
    const right = rects[0].xPct + rects[0].wPct;
    expect(right).toBeGreaterThan(80 / 600); // extends across to the last word
    expect(right).toBeLessThanOrEqual(1);
  });

  it("does not merge values that sit on different rows", () => {
    // Two unrelated numbers on different lines must not be joined into one match.
    const p = page({
      width: 600,
      height: 800,
      items: [
        item({ text: "555", x: 0, y: 100, width: 30, height: 12 }),
        item({ text: "999", x: 0, y: 400, width: 30, height: 12 }),
      ],
    });
    // Neither lone 3-digit token is a phone (needs ≥7 digits across ≥2 groups).
    expect(detectPiiRects([p], ["phone"])).toHaveLength(0);
  });

  it("never emits a zero-area box for a detected match on a width-0 item", () => {
    const p = page({
      width: 600,
      height: 800,
      items: [item({ text: "admin@slicedinvoices.com", x: 60, y: 200, width: 0, height: 10 })],
    });
    const [rect] = detectPiiRects([p], ["email"]);
    expect(rect).toBeDefined();
    expect(rect.wPct).toBeGreaterThan(0);
    expect(rect.hPct).toBeGreaterThan(0);
  });
});
