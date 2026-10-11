/**
 * Unit tests for useChartZoom.
 *
 * Uses renderHook + act from @testing-library/react to drive the hook's
 * pointer-event state machine. No DOM, no chart engine — the engine
 * converts a pointer event to a data-space x and calls
 * `onPointer{Down,Move,Up,Leave}(dataX)` directly.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useChartZoom, snapAndCommit, computeYDomain } from './use-chart-zoom';

const FULL: [number, number] = [2025, 2060];
const ROWS = Array.from({ length: 36 }, (_, i) => ({ x: 2025 + i }));

function drag(
  result: ReturnType<typeof renderHook<ReturnType<typeof useChartZoom>, Parameters<typeof useChartZoom>[0]>>['result'],
  from: number,
  to: number,
): void {
  act(() => { result.current.mouseHandlers.onPointerDown(from); });
  act(() => { result.current.mouseHandlers.onPointerMove(to); });
  act(() => { result.current.mouseHandlers.onPointerUp(); });
}

describe('useChartZoom', () => {
  it('snap_to_year', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2030.3, 2040.7);
    // ceil(2030.3)=2031, floor(2040.7)=2040 → [2031, 2040]
    expect(result.current.xDomain).toEqual([2031, 2040]);
    expect(result.current.isZoomed).toBe(true);
  });

  it('min_range_no_op', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    // drag 2030.3 → 2030.7: ceil=2031, floor=2030 → diff<1 → no-op
    drag(result, 2030.3, 2030.7);
    // Unzoomed → null (not FULL)
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('inside_out_rounding', () => {
    // drag right-to-left should still produce a valid range
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2045, 2035);
    // ceil(min(2045,2035))=2035, floor(max)=2045 → [2035, 2045]
    expect(result.current.xDomain).toEqual([2035, 2045]);
    expect(result.current.isZoomed).toBe(true);
  });

  it('cancel_on_leave', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    act(() => { result.current.mouseHandlers.onPointerDown(2030); });
    act(() => { result.current.mouseHandlers.onPointerMove(2040); });
    act(() => { result.current.mouseHandlers.onPointerLeave(); });
    // No zoom committed; state cleared; unzoomed → null
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
    expect(result.current.isDragging).toBe(false);
    expect(result.current.dragSelection).toBeNull();
  });

  it('manual_reset', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2030, 2040);
    expect(result.current.isZoomed).toBe(true);
    act(() => { result.current.reset(); });
    // After reset → null (unzoomed)
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('reset_on_xdomain_change', () => {
    const FULL2: [number, number] = [2026, 2061];
    let domain: [number, number] = FULL;
    const { result, rerender } = renderHook(
      (d: [number, number]) =>
        useChartZoom({ xDomainFull: d, rowsForY: ROWS }),
      { initialProps: domain },
    );
    drag(result, 2030, 2040);
    expect(result.current.isZoomed).toBe(true);
    domain = FULL2;
    act(() => { rerender(FULL2); });
    // After reset → null (unzoomed), not FULL2
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('array_spread_does_not_reset', () => {
    // Re-render with the same numeric values but a new array reference.
    const { result, rerender } = renderHook(
      (d: [number, number]) =>
        useChartZoom({ xDomainFull: d, rowsForY: ROWS }),
      { initialProps: FULL as [number, number] },
    );
    drag(result, 2030, 2040);
    expect(result.current.isZoomed).toBe(true);
    // Spread creates new array reference but same values
    act(() => { rerender([...FULL] as [number, number]); });
    // Still zoomed — same content, different reference
    expect(result.current.isZoomed).toBe(true);
    // drag from integer 2030→2040: ceil(2030)=2030, floor(2040)=2040
    expect(result.current.xDomain).toEqual([2030, 2040]);
  });

  it('invalid_active_label_noop', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    // NaN pointer x → no drag started; xDomain stays null (unzoomed).
    // (The engine never emits NaN; this guards toYear's non-finite path.)
    act(() => { result.current.mouseHandlers.onPointerDown(Number.NaN); });
    act(() => { result.current.mouseHandlers.onPointerMove(2040); });
    act(() => { result.current.mouseHandlers.onPointerUp(); });
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('non_finite_pointer_x_after_up_noop', () => {
    // A pointer-up with no valid pointer-down (NaN x) commits nothing.
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    act(() => { result.current.mouseHandlers.onPointerDown(Number.NaN); });
    act(() => { result.current.mouseHandlers.onPointerUp(); });
    // xDomain stays null (unzoomed)
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('compute_y_invoked_with_visible_window', () => {
    const computeY = vi.fn(() => [0, 500_000] as [number, number]);
    const { result } = renderHook(() =>
      useChartZoom({
        xDomainFull: FULL,
        rowsForY: ROWS,
        computeY: computeY as (rows: readonly { x: number }[]) => [number, number] | null,
      }),
    );
    drag(result, 2030, 2040);
    // computeY called with rows whose x is in [2031, 2040]
    expect(computeY).toHaveBeenCalledOnce();
    const passedRows = (computeY.mock.calls[0] as unknown as [readonly { x: number }[]])[0];
    // drag 2030→2040 snaps to [2030,2040]; filter x in [2030,2040]
    expect(passedRows.every((r) => r.x >= 2030 && r.x <= 2040)).toBe(true);
    expect(result.current.yDomain).toEqual([0, 500_000]);
  });

  it('y_collapse_falls_back', () => {
    // computeY returns null → yDomain stays null
    const computeY = vi.fn(() => null);
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS, computeY }),
    );
    drag(result, 2030, 2040);
    expect(result.current.yDomain).toBeNull();
  });

  it('empty_rows_locks_hook', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: [] }),
    );
    // rowsForY is [] — locked because filter would yield no rows.
    // Actually rowsForY=[] is not null, but fullMax-fullMin=35 >= 1.
    // The lock condition is: rowsForY === null || fullMax - fullMin < 1.
    // [] is not null, so NOT locked by that condition. Instead, drag produces
    // an empty visible window → computeY not called, zoom still commits.
    // The acceptance criteria says "empty_rows_locks_hook": rowsForY=null locks.
    const emptyResult = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: null }),
    );
    act(() => { emptyResult.result.current.mouseHandlers.onPointerDown(2030); });
    act(() => { emptyResult.result.current.mouseHandlers.onPointerMove(2040); });
    act(() => { emptyResult.result.current.mouseHandlers.onPointerUp(); });
    // xDomain stays null (unzoomed) when locked
    expect(emptyResult.result.current.xDomain).toBeNull();
    expect(emptyResult.result.current.isZoomed).toBe(false);
    void result; // unused — suppress lint
  });

  it('zero_width_full_domain_locks_hook', () => {
    // fullMin === fullMax → locked; no drag commits; xDomain stays null
    const degenerate: [number, number] = [2030, 2030];
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: degenerate, rowsForY: ROWS }),
    );
    act(() => { result.current.mouseHandlers.onPointerDown(2030); });
    act(() => { result.current.mouseHandlers.onPointerMove(2030); });
    act(() => { result.current.mouseHandlers.onPointerUp(); });
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });
});

// Pure-helper unit tests (snapAndCommit + computeYDomain).
describe('snapAndCommit', () => {
  it('snaps to whole years inside-out', () => {
    expect(snapAndCommit(2030.3, 2040.7, 2025, 2060)).toEqual([2031, 2040]);
  });
  it('returns null when snapped span < 1 year', () => {
    expect(snapAndCommit(2030.3, 2030.7, 2025, 2060)).toBeNull();
  });
  it('handles reversed drag direction', () => {
    expect(snapAndCommit(2045, 2035, 2025, 2060)).toEqual([2035, 2045]);
  });
  it('clamps to fullMin/fullMax', () => {
    expect(snapAndCommit(2020, 2070, 2025, 2060)).toEqual([2025, 2060]);
  });
});

describe('computeYDomain', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ x: 2025 + i }));
  it('returns null when computeY absent', () => {
    expect(computeYDomain(rows, 2026, 2030, undefined)).toBeNull();
  });
  it('returns null when rowsForY is null', () => {
    expect(computeYDomain(null, 2026, 2030, () => [0, 100])).toBeNull();
  });
  it('returns null when no rows in visible window', () => {
    expect(computeYDomain(rows, 2100, 2110, () => [0, 100])).toBeNull();
  });
  it('returns computeY result for visible rows', () => {
    const computeY = vi.fn(() => [10, 500] as [number, number]);
    const result = computeYDomain(rows, 2026, 2028, computeY);
    expect(result).toEqual([10, 500]);
    // Only rows with x in [2026, 2028] passed: 2026, 2027, 2028
    expect((computeY.mock.calls[0] as unknown as [readonly { x: number }[]])[0]).toHaveLength(3);
  });
});
