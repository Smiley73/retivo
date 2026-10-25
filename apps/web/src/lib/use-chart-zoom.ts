// `useChartZoom`: drag-to-select whole-year zoom for the SVG chart engine, with y auto-fit via `computeY`, reset on a full-domain
// change, and pointer-only (mouse and pen) input. It lives in the section component so Reset can read `isZoomed` during the Inner's Suspense fallback.

import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface ChartPointerHandlers {
  onPointerDown: (dataX: number) => void;
  onPointerMove: (dataX: number) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
}

export type ChartMouseHandlers = ChartPointerHandlers;

export interface ChartZoomState {
  /** Narrowed x-domain when zoomed; null when unzoomed. */
  xDomain: [number, number] | null;
  yDomain: [number, number] | null;
  isZoomed: boolean;
  isDragging: boolean;
  dragSelection: [number, number] | null;
  /** Spread onto the SVG ChartFrame; the name is kept so `pages/*-section.tsx` wrappers need no change. */
  mouseHandlers: ChartPointerHandlers;
  reset: () => void;
}

export interface UseChartZoomArgs {
  xDomainFull: [number, number];
  /** Null means empty or not yet loaded: the hook locks. */
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

/** Snaps both ends to whole years; null when the range is under a year. */
function snapAndCommit(
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

/** Visible-window y-domain from `computeY`; null when it is absent, no rows are visible, or the domain collapses. */
function computeYDomain(
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

function useResetOnFullDomainChange(
  fullMin: number,
  fullMax: number,
  onReset: () => void,
): void {
  // A ref keeps the effect from re-running every render.
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  useEffect(() => { onResetRef.current(); }, [fullMin, fullMax]); // Content-compare [fullMin, fullMax]; onReset is stable via ref
}

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

function clearDragRefs(
  dragStartRef: MutableRefObject<number | null>,
  dragEndRef: MutableRefObject<number | null>,
): void {
  dragStartRef.current = null;
  dragEndRef.current = null;
}

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
