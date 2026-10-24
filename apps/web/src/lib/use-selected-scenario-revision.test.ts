import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSelectedScenarioRevision } from './use-selected-scenario-revision';
import { WORKSPACE_CHANGED_EVENT } from './workspace-events';
import { notifyScenariosChanged, SELECTED_SCENARIO_CHANGED_EVENT } from './scenario-mutations';

function dispatch(eventName: string): void {
  act(() => {
    window.dispatchEvent(new Event(eventName));
  });
}

describe('useSelectedScenarioRevision', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts at 0', () => {
    const { result } = renderHook(() => useSelectedScenarioRevision());
    expect(result.current).toBe(0);
  });

  it('increments on SELECTED_SCENARIO_CHANGED_EVENT', () => {
    const { result } = renderHook(() => useSelectedScenarioRevision());
    dispatch(SELECTED_SCENARIO_CHANGED_EVENT);
    expect(result.current).toBe(1);
  });

  it('does NOT increment on WORKSPACE_CHANGED_EVENT', () => {
    const { result } = renderHook(() => useSelectedScenarioRevision());
    dispatch(WORKSPACE_CHANGED_EVENT);
    expect(result.current).toBe(0);
  });

  it('does NOT increment on notifyScenariosChanged', () => {
    const { result } = renderHook(() => useSelectedScenarioRevision());
    act(() => notifyScenariosChanged());
    expect(result.current).toBe(0);
  });

  it('keeps a stable value across a re-render with no event', () => {
    const { result, rerender } = renderHook(() => useSelectedScenarioRevision());
    dispatch(SELECTED_SCENARIO_CHANGED_EVENT);
    expect(result.current).toBe(1);
    rerender();
    expect(result.current).toBe(1);
  });

  it('removes the listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useSelectedScenarioRevision());
    unmount();
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain(SELECTED_SCENARIO_CHANGED_EVENT);
  });

  it('stops incrementing after unmount', () => {
    const { result, unmount } = renderHook(() => useSelectedScenarioRevision());
    dispatch(SELECTED_SCENARIO_CHANGED_EVENT);
    expect(result.current).toBe(1);
    unmount();
    dispatch(SELECTED_SCENARIO_CHANGED_EVENT);
    expect(result.current).toBe(1);
  });
});
