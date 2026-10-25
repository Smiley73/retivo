/** Isolate-first legend visibility: the first click isolates, later clicks toggle, and the lone-visible click restores all. */
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
    act(() => result.current.toggle('Alpha', ALL));
    act(() => result.current.toggle('Beta', ALL));
    act(() => result.current.toggle('Alpha', ALL));
    expect([...result.current.hidden].sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('keeps a legendId-shared paired key visible on isolate and clears it on restore-all', () => {
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
    act(() => result.current.toggle('Alpha', ALL));
    expect([...result.current.hidden].sort()).toEqual(['Beta', 'Gamma']);

    const SHRUNK = ['Alpha', 'Beta'];
    act(() => result.current.toggle('Alpha', SHRUNK));
    expect(result.current.hidden.size).toBe(0);

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
