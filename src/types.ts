/**
 * Shared TypeScript type definitions used across the application.
 */

import type { ComponentType } from "react";

/** A 1-based inclusive page range used by the Split PDF tool. */
export interface PageRange {
  start: number;
  end: number;
}

/** Configuration options for the Add Watermark tool. */
export interface WatermarkOptions {
  /** The watermark text to display. */
  text: string;
  /** Font size in PDF points. */
  fontSize: number;
  /** RGB colour with values in the 0–255 range. */
  color: { r: number; g: number; b: number };
  /** Opacity from 0 (fully transparent) to 1 (fully opaque). */
  opacity: number;
  /** Rotation angle in degrees (negative = counter-clockwise). */
  rotation: number;
}

/** Standard PDF document metadata fields. */
export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modificationDate: string;
}

/** Absolute position and dimensions (in PDF points) for signature placement. */
export interface Position {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Metadata describing a single PDF tool shown on the home screen. */
export interface Tool {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  category?: string;
  /**
   * When `true`, the tool card renders a small "Beta" badge next to
   * the title. Use it for tools that are functional but still
   * iterating on quality / UX — sets expectations without hiding
   * the feature.
   */
  beta?: boolean;
  /**
   * Device-specific requirement notes shown beneath the description
   * on the tool card and as a callout inside the tool. Use for tools
   * whose footprint is meaningfully heavier than the rest of the
   * suite (e.g. on-device AI tools that load 1 GB+ of weights into
   * RAM) so users self-select before clicking through.
   *
   * Both strings are required when present — the consumer picks the
   * one that matches the current device via `isMobileDevice()`. We
   * never want to show *both* in the same place since they describe
   * the same constraint at different floors.
   */
  requirements?: {
    /** Shown on desktops / laptops / tablets in landscape. */
    desktop: string;
    /** Shown on phones (UA-string match in `isMobileDevice()`). */
    mobile: string;
  };
}

/** Position of page numbers on the page. */
export type PageNumberPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Display format for page numbers. */
export type PageNumberFormat = "1" | "Page 1" | "1 / N" | "Page 1 of N";

/** Configuration options for the Add Page Numbers tool. */
export interface PageNumberOptions {
  position: PageNumberPosition;
  format: PageNumberFormat;
  fontSize: number;
  color: { r: number; g: number; b: number };
  margin: number;
  startNumber: number;
  firstPage: number;
}

/** Configuration options for the Header & Footer tool. */
export interface HeaderFooterOptions {
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
  fontSize: number;
  color: { r: number; g: number; b: number };
  margin: number;
  skipFirstPage: boolean;
}

/** Crop margins in PDF points. */
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Position of Bates numbers on the page. */
export type BatesPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Configuration options for the Bates Numbering tool. */
export interface BatesNumberOptions {
  prefix: string;
  suffix: string;
  startNumber: number;
  digits: number;
  position: BatesPosition;
  fontSize: number;
  color: { r: number; g: number; b: number };
  margin: number;
}

/** Union of all valid tool identifiers. */
export type ToolId =
  | "merge"
  | "compress"
  | "rotate"
  | "delete"
  | "reorder"
  | "images-to-pdf"
  | "watermark"
  | "signature"
  | "metadata"
  | "ocr"
  | "pdf-password"
  | "flatten"
  | "add-blank-page"
  | "duplicate-page"
  | "add-page-numbers"
  | "header-footer"
  | "crop-pages"
  | "pdf-to-image"
  | "fill-pdf-form"
  | "extract-pages"
  | "reverse-pages"
  | "redact-pdf"
  | "stamp-pdf"
  | "add-bookmarks"
  | "pdf-inspector"
  | "repair-pdf"
  | "nup-pages"
  | "remove-blank-pages"
  | "bates-numbering"
  | "contact-sheet"
  | "grayscale"
  | "file-attachment"
  | "split-pdf"
  | "extract-images"
  | "compare-pdf"
  | "digital-signature"
  | "ask-pdf";
