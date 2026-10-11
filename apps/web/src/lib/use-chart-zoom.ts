/**
 * useChartZoom — drag-to-select zoom for the bespoke SVG chart engine.
 *
 * Manages x/y domain, the drag-selection marquee, and a reset fn. The
 * hook lives in the section component (not the lazy Inner) so the Reset
 * button can read `isZoomed` during the Inner's Suspense fallback.
 *
 * Engine-agnostic: the SVG `ChartFrame` converts a pointer event to a
 * data-space x and calls `pointerHandlers.onPointer{Down,Move,Up,Leave}`
 * (it no longer forwards Recharts `activeLabel` callbacks). Behaviour:
 *
 *   - Marquee via pointerDown/Move/Up/Leave on the chart surface.
 *   - Pointer-driven (mouse + pen); the engine ignores touch.
 *   - Whole-year snap: [ceil(min), floor(max)]; <1 yr → no-op.
 *   - Y auto-fits via computeY when zoomed; null falls back to chart default.
 *   - Auto-reset on xDomainFull content change (not row reference).
 */

import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Engine-agnostic pointer handlers bound to the chart surface. The
 *  data-space x is computed by the engine and passed in. */
interface ChartPointerHandlers {
  onPointerDown: (dataX: number) => void;
  onPointerMove: (dataX: number) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
}

/** Back-compat alias for the old name used by chart `*Inner` props. */
export type ChartMouseHandlers = ChartPointerHandlers;

export interface ChartZoomState {
  /** Narrowed x-domain when zoomed; null when unzoomed (let the Inner use its own xMax math). */
  xDomain: [number, number] | null;
  yDomain: [number, number] | null;
  isZoomed: boolean;
  isDragging: boolean;
  dragSelection: [number, number] | null;
  /** Engine-agnostic pointer handlers, spread onto the SVG ChartFrame.
   *  Field name kept as `mouseHandlers` so the existing section
   *  wrappers (`pages/*-section.tsx`) that forward it to the Inner do
   *  not need to change. */
  mouseHandlers: ChartPointerHandlers;
  reset: () => void;
}

export interface UseChartZoomArgs {
  xDomainFull: [number, number];
  /** null = empty / not yet loaded — hook locks immediately */
  rowsForY: readonly { x: number }[] | null;
  computeY?: (visibleRows: readonly { x: number }[]) => [number, number] | null;
}

function toYear(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Snap both ends to whole years; return null when the snapped range is
 * narrower than 1 year (min-range no-op, inside-out rounding).
 * Pure helper extracted from hook body.
 */
export function snapAndCommit(
  a: number,
  b: number,
  fullMin: number,
  fullMax: number,
): [number, number] | null {
  const lo = clamp(Math.ceil(Math.min(a, b)), fullMin, fullMax);
  const hi = clamp(Math.floor(Math.max(a, b)), fullMin, fullMax);
  if (hi - lo < 1) return null;
  return [lo, hi];
}

/**
 * Compute visible-window y-domain from rows + computeY.
 * Returns null when computeY is absent, rows is empty, or the domain collapses.
 * Pure helper extracted from hook body.
 */
export function computeYDomain(
  rowsForY: readonly { x: number }[] | null,
  newMin: number,
  newMax: number,
  computeY: ((visibleRows: readonly { x: number }[]) => [number, number] | null) | undefined,
): [number, number] | null {
  if (!computeY || rowsForY === null) return null;
  const visible = rowsForY.filter((r) => r.x >= newMin && r.x <= newMax);
  if (visible.length === 0) return null;
  return computeY(visible);
}

// Sub-hook — owns drag-selection state; exposes clearDrag() to reset both fields atomically.
function useDragSelectionState(): {
  dragSelection: [number, number] | null;
  isDragging: boolean;
  setDragSelection: (v: [number, number] | null) => void;
  setIsDragging: (v: boolean) => void;
  clearDrag: () => void;
} {
  const [dragSelection, setDragSelection] = useState<[number, number] | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const clearDrag = useCallback((): void => {
    setDragSelection(null);
    setIsDragging(false);
  }, []);
  return { dragSelection, isDragging, setDragSelection, setIsDragging, clearDrag };
}

// Sub-hook — owns x/y zoom domain state; exposes reset() and isZoomed.
function useZoomState(): {
  xDomain: [number, number] | null;
  yDomain: [number, number] | null;
  isZoomed: boolean;
  setXDomain: (v: [number, number] | null) => void;
  setYDomain: (v: [number, number] | null) => void;
  resetZoom: () => void;
} {
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const [yDomain, setYDomain] = useState<[number, number] | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const resetZoom = useCallback((): void => {
    setXDomain(null);
    setYDomain(null);
    setIsZoomed(false);
  }, []);
  return { xDomain, yDomain, isZoomed, setXDomain: (v) => { setXDomain(v); setIsZoomed(v !== null); }, setYDomain, resetZoom };
}

// Effect-only sub-hook — resets zoom+drag when [fullMin, fullMax] pair changes.
function useResetOnFullDomainChange(
  fullMin: number,
  fullMax: number,
  onReset: () => void,
): void {
  // Stable callback ref avoids re-running the effect on every render.
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  useEffect(() => { onResetRef.current(); }, [fullMin, fullMax]); // Content-compare [fullMin, fullMax]; onReset is stable via ref
}

// Options for buildPointerHandlers — extracted to keep fn signature ≤40 ln.
interface BuildPointerHandlersOptions {
  locked: boolean;
  fullMin: number;
  fullMax: number;
  rowsForY: readonly { x: number }[] | null;
  computeY?: (visibleRows: readonly { x: number }[]) => [number, number] | null;
  dragStartRef: MutableRefObject<number | null>;
  dragEndRef: MutableRefObject<number | null>;
  setDragSelection: (v: [number, number] | null) => void;
  setIsDragging: (v: boolean) => void;
  setXDomain: (v: [number, number] | null) => void;
  setYDomain: (v: [number, number] | null) => void;
}

// Nulls both drag refs atomically; shared by onPointerUp + onPointerLeave.
function clearDragRefs(
  dragStartRef: MutableRefObject<number | null>,
  dragEndRef: MutableRefObject<number | null>,
): void {
  dragStartRef.current = null;
  dragEndRef.current = null;
}

// Builds the four pointer handlers; closed over stable setters and drag refs.
function buildPointerHandlers(opts: BuildPointerHandlersOptions): ChartPointerHandlers {
  const { locked, fullMin, fullMax, rowsForY, computeY, dragStartRef, dragEndRef, setDragSelection, setIsDragging, setXDomain, setYDomain } = opts;
  return {
    onPointerDown(dataX: number): void {
      if (locked) return;
      const year = toYear(dataX);
      if (year === null) return;
      dragStartRef.current = year;
      dragEndRef.current = year;
      setIsDragging(true);
      setDragSelection(null);
    },
    onPointerMove(dataX: number): void {
      if (dragStartRef.current === null) return;
      const year = toYear(dataX);
      if (year === null) return;
      dragEndRef.current = year;
      setDragSelection([Math.min(dragStartRef.current, year), Math.max(dragStartRef.current, year)]);
    },
    onPointerUp(): void {
      const start = dragStartRef.current;
      const end = dragEndRef.current;
      clearDragRefs(dragStartRef, dragEndRef);
      setIsDragging(false);
      setDragSelection(null);
      if (start === null || end === null) return;
      const snapped = snapAndCommit(start, end, fullMin, fullMax);
      if (snapped === null) return;
      const [newMin, newMax] = snapped;
      setXDomain([newMin, newMax]);
      setYDomain(computeYDomain(rowsForY, newMin, newMax, computeY));
    },
    onPointerLeave(): void {
      if (dragStartRef.current === null) return;
      clearDragRefs(dragStartRef, dragEndRef);
      setIsDragging(false);
      setDragSelection(null);
    },
  };
}

export function useChartZoom({
  xDomainFull,
  rowsForY,
  computeY,
}: UseChartZoomArgs): ChartZoomState {
  const [fullMin, fullMax] = xDomainFull;
  const locked = rowsForY === null || fullMax - fullMin < 1;
  const { xDomain, yDomain, isZoomed, setXDomain, setYDomain, resetZoom } = useZoomState();
  const { dragSelection, isDragging, setDragSelection, setIsDragging, clearDrag } = useDragSelectionState();
  const dragStartRef = useRef<number | null>(null);
  const dragEndRef = useRef<number | null>(null);
  const resetAll = useCallback((): void => { resetZoom(); clearDrag(); dragStartRef.current = null; dragEndRef.current = null; }, [resetZoom, clearDrag]);
  useResetOnFullDomainChange(fullMin, fullMax, resetAll);
  const mouseHandlers = useMemo(
    () => buildPointerHandlers({ locked, fullMin, fullMax, rowsForY, computeY, dragStartRef, dragEndRef, setDragSelection, setIsDragging, setXDomain, setYDomain }),
    [locked, fullMin, fullMax, rowsForY, computeY, setDragSelection, setIsDragging, setXDomain, setYDomain],
  );
  return { xDomain, yDomain, isZoomed, isDragging, dragSelection, mouseHandlers, reset: resetAll };
}
