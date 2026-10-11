/**
 * Tests for the isolate-first legend visibility hook. From the pristine
 * all-visible state a click isolates the clicked series; later clicks toggle
 * series individually; clicking the lone-visible series restores all. The
 * updater prunes orphan keys first so a mid-life series-universe change can't
 * trigger a spurious restore-all. Each call returns a fresh `Set` identity.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSeriesVisibility } from './useSeriesVisibility';

const ALL = ['Alpha', 'Beta', 'Gamma'];

describe('useSeriesVisibility', () => {
  it('isolates the clicked series on the first click from all-visible', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    act(() => result.current.toggle('Alpha', ALL));
    expect([...result.current.hidden].sort()).toEqual(['Beta', 'Gamma']);
    expect(result.current.isHidden('Alpha')).toBe(false);
  });

  it('re-enables a hidden series without disturbing the others', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    act(() => result.current.toggle('Alpha', ALL)); // isolate Alpha
    act(() => result.current.toggle('Beta', ALL)); // re-enable Beta
    expect([...result.current.hidden]).toEqual(['Gamma']);
  });

  it('restores all when the only-visible series is clicked', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    act(() => result.current.toggle('Alpha', ALL)); // isolate Alpha (only visible)
    act(() => result.current.toggle('Alpha', ALL)); // click lone-visible → restore
    expect(result.current.hidden.size).toBe(0);
  });

  it('hides just the clicked series when several are visible', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    // Make several visible: isolate Alpha, then re-enable Beta → Alpha+Beta visible.
    act(() => result.current.toggle('Alpha', ALL));
    act(() => result.current.toggle('Beta', ALL));
    // Now click Alpha (visible, not the only one) → hide just Alpha.
    act(() => result.current.toggle('Alpha', ALL));
    expect([...result.current.hidden].sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('keeps a legendId-shared paired key visible on isolate and clears it on restore-all', () => {
    // The de-duplicated legend-key universe treats a solid/dashed channel pair
    // as one shared key (e.g. `Portfolio`). Isolating it hides every other key
    // but leaves the shared key visible; clicking it back restores all.
    const keys = ['Portfolio', 'Expenses', 'Income'];
    const { result } = renderHook(() => useSeriesVisibility());
    act(() => result.current.toggle('Portfolio', keys));
    expect(result.current.isHidden('Portfolio')).toBe(false);
    expect([...result.current.hidden].sort()).toEqual(['Expenses', 'Income']);
    act(() => result.current.toggle('Portfolio', keys));
    expect(result.current.hidden.size).toBe(0);
  });

  it('prunes orphan keys when the series universe changes mid-life', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    // Isolate Alpha against the full universe → Beta, Gamma hidden.
    act(() => result.current.toggle('Alpha', ALL));
    expect([...result.current.hidden].sort()).toEqual(['Beta', 'Gamma']);

    // Universe shrinks (Gamma drops out, e.g. a groupBy/showExcluded rebuild).
    // Beta is the only real hidden key; Alpha is the only visible one. Clicking
    // Alpha must restore all (not be treated as still-isolated) — the orphan
    // Gamma is pruned before the count check, so no spurious clear-then-stuck.
    const SHRUNK = ['Alpha', 'Beta'];
    act(() => result.current.toggle('Alpha', SHRUNK));
    expect(result.current.hidden.size).toBe(0);

    // Universe grows: isolate against a larger set still works correctly.
    const GROWN = ['Alpha', 'Beta', 'Gamma', 'Delta'];
    act(() => result.current.toggle('Delta', GROWN));
    expect([...result.current.hidden].sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('handles a compounded sequence: isolate → re-enable → click lone-other → restore-all', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    act(() => result.current.toggle('Alpha', ALL)); // isolate Alpha
    act(() => result.current.toggle('Beta', ALL)); // re-enable Beta → Alpha+Beta visible
    act(() => result.current.toggle('Alpha', ALL)); // hide Alpha → Beta lone-visible
    expect([...result.current.hidden].sort()).toEqual(['Alpha', 'Gamma']);
    act(() => result.current.toggle('Beta', ALL)); // click lone-visible Beta → restore all
    expect(result.current.hidden.size).toBe(0);
  });

  it('returns a fresh Set identity on the isolate and restore-all branches', () => {
    const { result } = renderHook(() => useSeriesVisibility());
    const initial = result.current.hidden;
    act(() => result.current.toggle('Alpha', ALL)); // isolate
    const afterIsolate = result.current.hidden;
    expect(afterIsolate).not.toBe(initial);
    act(() => result.current.toggle('Alpha', ALL)); // restore all
    const afterRestore = result.current.hidden;
    expect(afterRestore).not.toBe(afterIsolate);
  });
});
