// history.ts — Linear undo/redo for the canvas editor.
//
// CRITICAL DIVERGENCE FROM CLOAKIMG: entries are NOT rendered page rasters.
// CloakIMG snapshots a full canvas bitmap per commit, which is fine for one
// image but would blow memory on a 50-page PDF. Each entry here holds the
// cheap, serializable doc state — `bytes` (by reference for overlay-only
// edits, a fresh array only after a true byte transform), the page-meta list,
// and the overlay objects. Rasters are re-derived from the renderer on demand.

import type { CanvasObject, PageMeta } from "./doc.ts";

export interface HistoryEntry {
  label: string;
  bytes: Uint8Array;
  pages: PageMeta[];
  objects: CanvasObject[];
}

/** Ref-held by EditorContext so commits don't trigger re-renders directly; a
 *  version counter notifies subscribers instead (mirrors CloakIMG's pattern). */
export class EditorHistory {
  private stack: HistoryEntry[] = [];
  private cursor = -1;
  private readonly cap: number;

  constructor(cap = 40) {
    this.cap = cap;
  }

  clear(): void {
    this.stack = [];
    this.cursor = -1;
  }

  /** Push a new entry, discarding any redo tail above the cursor and trimming
   *  the oldest entries past the cap (cursor follows the trim). */
  push(entry: HistoryEntry): void {
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(entry);
    if (this.stack.length > this.cap) {
      const overflow = this.stack.length - this.cap;
      this.stack = this.stack.slice(overflow);
    }
    this.cursor = this.stack.length - 1;
  }

  current(): HistoryEntry | null {
    return this.stack[this.cursor] ?? null;
  }

  base(): HistoryEntry | null {
    return this.stack[0] ?? null;
  }

  index(): number {
    return this.cursor;
  }

  size(): number {
    return this.stack.length;
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor < this.stack.length - 1;
  }

  undo(): HistoryEntry | null {
    if (!this.canUndo()) return null;
    this.cursor -= 1;
    return this.current();
  }

  redo(): HistoryEntry | null {
    if (!this.canRedo()) return null;
    this.cursor += 1;
    return this.current();
  }

  /** Move the cursor to an absolute index (clamped) and return that entry. */
  jumpTo(index: number): HistoryEntry | null {
    if (this.stack.length === 0) return null;
    this.cursor = Math.max(0, Math.min(index, this.stack.length - 1));
    return this.current();
  }

  labels(): string[] {
    return this.stack.map((e) => e.label);
  }
}
