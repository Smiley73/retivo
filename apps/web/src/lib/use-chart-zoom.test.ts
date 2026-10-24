import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useChartZoom } from './use-chart-zoom';

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
    expect(result.current.xDomain).toEqual([2031, 2040]);
    expect(result.current.isZoomed).toBe(true);
    expect(result.current.yDomain).toBeNull();
  });

  it('clamps_drag_to_full_domain', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2020, 2070);
    expect(result.current.xDomain).toEqual([2025, 2060]);
  });

  it('min_range_no_op', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2030.3, 2030.7);
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('inside_out_rounding', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    drag(result, 2045, 2035);
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
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('array_spread_does_not_reset', () => {
    const { result, rerender } = renderHook(
      (d: [number, number]) =>
        useChartZoom({ xDomainFull: d, rowsForY: ROWS }),
      { initialProps: FULL as [number, number] },
    );
    drag(result, 2030, 2040);
    expect(result.current.isZoomed).toBe(true);
    act(() => { rerender([...FULL] as [number, number]); });
    expect(result.current.isZoomed).toBe(true);
    expect(result.current.xDomain).toEqual([2030, 2040]);
  });

  it('invalid_active_label_noop', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    // The engine never emits NaN; this guards toYear's non-finite path.
    act(() => { result.current.mouseHandlers.onPointerDown(Number.NaN); });
    act(() => { result.current.mouseHandlers.onPointerMove(2040); });
    act(() => { result.current.mouseHandlers.onPointerUp(); });
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('non_finite_pointer_x_after_up_noop', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS }),
    );
    act(() => { result.current.mouseHandlers.onPointerDown(Number.NaN); });
    act(() => { result.current.mouseHandlers.onPointerUp(); });
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
    expect(computeY).toHaveBeenCalledOnce();
    const passedRows = (computeY.mock.calls[0] as unknown as [readonly { x: number }[]])[0];
    expect(passedRows.every((r) => r.x >= 2030 && r.x <= 2040)).toBe(true);
    expect(result.current.yDomain).toEqual([0, 500_000]);
  });

  it('y_collapse_falls_back', () => {
    const computeY = vi.fn(() => null);
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: ROWS, computeY }),
    );
    drag(result, 2030, 2040);
    expect(result.current.yDomain).toBeNull();
  });

  it('null_rows_locks_hook', () => {
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: null }),
    );
    drag(result, 2030, 2040);
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });

  it('empty_rows_zoom_without_computing_y', () => {
    const computeY = vi.fn(() => [0, 1] as [number, number]);
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: FULL, rowsForY: [], computeY }),
    );
    drag(result, 2030, 2040);
    expect(result.current.xDomain).toEqual([2030, 2040]);
    expect(result.current.yDomain).toBeNull();
    expect(computeY).not.toHaveBeenCalled();
  });

  it('zero_width_full_domain_locks_hook', () => {
    const degenerate: [number, number] = [2030, 2030];
    const { result } = renderHook(() =>
      useChartZoom({ xDomainFull: degenerate, rowsForY: ROWS }),
    );
    drag(result, 2030, 2030);
    expect(result.current.xDomain).toBeNull();
    expect(result.current.isZoomed).toBe(false);
  });
});
