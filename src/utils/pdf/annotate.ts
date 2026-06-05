/**
 * Annotate — vector overlay (pen / highlighter / shapes / text).
 */

import { PDFDocument, rgb, LineCapStyle, StandardFonts } from "@pdfme/pdf-lib";

// ── Annotate — vector overlay (pen / highlighter / shapes / text) ─

/** RGB colour in the 0–255 range for an annotation. */
export interface AnnotationColor {
  r: number;
  g: number;
  b: number;
}

/**
 * A single annotation, in page-relative fraction coordinates (0–1 from the
 * top-left) so it maps to any page size. Sizes are fractions too — stroke
 * thickness as a fraction of page width, text size as a fraction of page
 * height — so a stroke drawn on the preview lands at the same relative
 * weight in the output regardless of page dimensions.
 */
export type Annotation =
  | {
      kind: "stroke";
      pageIndex: number;
      points: { x: number; y: number }[];
      color: AnnotationColor;
      thicknessFrac: number;
      opacity: number;
    }
  | {
      kind: "rect" | "ellipse";
      pageIndex: number;
      x: number;
      y: number;
      w: number;
      h: number;
      color: AnnotationColor;
      thicknessFrac: number;
      /** Optional interior fill. Omit for an outline-only shape. */
      fill?: { color: AnnotationColor; opacity?: number };
    }
  | {
      kind: "line" | "arrow";
      pageIndex: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: AnnotationColor;
      thicknessFrac: number;
    }
  | {
      kind: "text";
      pageIndex: number;
      x: number;
      y: number;
      text: string;
      sizeFrac: number;
      color: AnnotationColor;
    };

/**
 * Burn annotations onto a PDF as vector graphics.
 *
 * Unlike redaction, this is additive and non-destructive: the existing
 * page content (including selectable text) is untouched — pen strokes,
 * highlights, boxes, and text labels are drawn on top via pdf-lib's
 * vector primitives, so the result stays a real PDF, not a flattened
 * image. Coordinates arrive top-left-origin in fractions and are
 * converted to pdf-lib's bottom-left point space per page.
 *
 * @param file - The source PDF.
 * @param annotations - Annotations to draw, each tagged with its page.
 * @returns Annotated PDF bytes.
 */
export async function annotatePdf(file: File, annotations: Annotation[]): Promise<Uint8Array> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await PDFDocument.load(arrayBuffer);
  const pages = pdf.getPages();
  // Embed the text font lazily — only if a text annotation is present.
  let font: Awaited<ReturnType<typeof pdf.embedFont>> | null = null;

  for (const a of annotations) {
    const page = pages[a.pageIndex];
    if (!page) continue;
    const { width: W, height: H } = page.getSize();
    const color = rgb(a.color.r / 255, a.color.g / 255, a.color.b / 255);

    if (a.kind === "stroke") {
      if (a.points.length < 2) continue;
      const thickness = Math.max(0.5, a.thicknessFrac * W);
      for (let i = 1; i < a.points.length; i++) {
        const p0 = a.points[i - 1];
        const p1 = a.points[i];
        page.drawLine({
          start: { x: p0.x * W, y: (1 - p0.y) * H },
          end: { x: p1.x * W, y: (1 - p1.y) * H },
          thickness,
          color,
          opacity: a.opacity,
          lineCap: LineCapStyle.Round,
        });
      }
    } else if (a.kind === "rect") {
      const fill = a.fill
        ? rgb(a.fill.color.r / 255, a.fill.color.g / 255, a.fill.color.b / 255)
        : undefined;
      page.drawRectangle({
        x: a.x * W,
        y: (1 - a.y - a.h) * H,
        width: a.w * W,
        height: a.h * H,
        borderColor: color,
        borderWidth: Math.max(0.5, a.thicknessFrac * W),
        color: fill,
        opacity: a.fill ? (a.fill.opacity ?? 1) : 0,
        borderOpacity: 1,
      });
    } else if (a.kind === "ellipse") {
      const fill = a.fill
        ? rgb(a.fill.color.r / 255, a.fill.color.g / 255, a.fill.color.b / 255)
        : undefined;
      page.drawEllipse({
        x: (a.x + a.w / 2) * W,
        y: (1 - (a.y + a.h / 2)) * H,
        xScale: (a.w / 2) * W,
        yScale: (a.h / 2) * H,
        borderColor: color,
        borderWidth: Math.max(0.5, a.thicknessFrac * W),
        color: fill,
        opacity: a.fill ? (a.fill.opacity ?? 1) : 0,
        borderOpacity: 1,
      });
    } else if (a.kind === "line" || a.kind === "arrow") {
      const thickness = Math.max(0.5, a.thicknessFrac * W);
      const start = { x: a.x1 * W, y: (1 - a.y1) * H };
      const end = { x: a.x2 * W, y: (1 - a.y2) * H };
      page.drawLine({ start, end, thickness, color, lineCap: LineCapStyle.Round });
      if (a.kind === "arrow") {
        // Two short segments off the end point form the arrowhead.
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLen = Math.max(6, thickness * 3.5);
        for (const spread of [Math.PI - 0.45, Math.PI + 0.45]) {
          page.drawLine({
            start: end,
            end: {
              x: end.x + headLen * Math.cos(angle + spread),
              y: end.y + headLen * Math.sin(angle + spread),
            },
            thickness,
            color,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    } else if (a.kind === "text") {
      if (!a.text) continue;
      if (!font) font = await pdf.embedFont(StandardFonts.Helvetica);
      const size = a.sizeFrac * H;
      // `y` is the top of the text in fraction space; pdf-lib anchors text at
      // its baseline, so drop one font size below the click point.
      page.drawText(a.text, {
        x: a.x * W,
        y: (1 - a.y) * H - size,
        size,
        font,
        color,
      });
    }
  }

  return pdf.save();
}
