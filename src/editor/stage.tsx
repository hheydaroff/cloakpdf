// stage.tsx — The persistent-canvas registration seam, ported from CloakIMG's
// StageHost/useStageProps. The single <PdfStage> mounts once in EditorShell and
// never tears down on tool switch; the active tool registers its overlay paint
// + pointer handlers + cursor here via `useStageProps`, and they auto-clear on
// unmount so a stale overlay never bleeds into the next tool. This is what
// keeps the page raster from flashing when the user changes tools.

import {
  createContext,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

/** A pointer position in page-fraction space (0–1, top-left origin) plus the
 *  0-based page it landed on. The canonical coordinate the overlay tools store. */
export interface StagePoint {
  /** 0–1 across the page width. */
  xPct: number;
  /** 0–1 down the page height. */
  yPct: number;
  /** Page the pointer is over (the focused page in focus mode). */
  pageIndex: number;
}

export interface PdfStageProps {
  /** Paint the active tool's overlay for `pageIndex` onto the overlay canvas.
   *  `w`/`h` are the overlay canvas's device-pixel dimensions. */
  paintOverlay?: (ctx: CanvasRenderingContext2D, w: number, h: number, pageIndex: number) => void;
  onPointerDown?: (p: StagePoint, e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove?: (p: StagePoint, e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp?: (p: StagePoint, e: ReactPointerEvent<HTMLElement>) => void;
  cursor?: CSSProperties["cursor"];
}

const EMPTY: PdfStageProps = {};

// Value context (changes per tool render) + setter context (stable). Tools
// consume only the setter, so they don't re-render on sibling stage churn.
const StagePropsCtx = createContext<PdfStageProps>(EMPTY);
const StageSetCtx = createContext<(p: PdfStageProps) => void>(() => {});

export function StageProvider({ children }: { children: ReactNode }) {
  const [props, setProps] = useState<PdfStageProps>(EMPTY);
  const set = useCallback((next: PdfStageProps) => {
    setProps((prev) => (shallowEqual(prev, next) ? prev : next));
  }, []);
  return (
    <StageSetCtx.Provider value={set}>
      <StagePropsCtx.Provider value={props}>{children}</StagePropsCtx.Provider>
    </StageSetCtx.Provider>
  );
}

/** Tool components call this each render to register their stage props. The
 *  setter shallow-bails on unchanged props; registration clears on unmount. */
export function useStageProps(props: PdfStageProps): void {
  const set = useContext(StageSetCtx);
  useLayoutEffect(() => {
    set(props);
  });
  useEffect(() => {
    return () => set(EMPTY);
  }, [set]);
}

/** Read the currently-registered stage props. Consumed by PdfStage. */
export function useActiveStageProps(): PdfStageProps {
  return useContext(StagePropsCtx);
}

function shallowEqual(a: PdfStageProps, b: PdfStageProps): boolean {
  return (
    a.paintOverlay === b.paintOverlay &&
    a.onPointerDown === b.onPointerDown &&
    a.onPointerMove === b.onPointerMove &&
    a.onPointerUp === b.onPointerUp &&
    a.cursor === b.cursor
  );
}
