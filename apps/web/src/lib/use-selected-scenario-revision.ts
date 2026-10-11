/**
 * Selected-scenario "pointer changed, re-read" subscription primitive.
 *
 * The active-scenario selection is a per-device pointer in the local-only
 * `selectedScenario` IDB store, switched from the sidebar picker. It is NOT
 * an aggregate row, so `useAggregates(type)` does not cover it — a page that
 * re-derives from the active scenario (the PDF report's default pick, the
 * Scenarios index's "Active" highlight, the Expenses chart's projection keyed
 * on `selectedScenarioId`, the sidebar picker's displayed value) needs a
 * narrow signal that fires only when the pointer moves.
 *
 * This hook subscribes to ONLY {@link SELECTED_SCENARIO_CHANGED_EVENT}. It
 * deliberately ignores {@link WORKSPACE_CHANGED_EVENT} and
 * {@link SCENARIOS_CHANGED_EVENT}: consumers already take their aggregate-data
 * arrays from `useAggregates` as effect deps, which covers scenario
 * add/edit/delete and bulk fills — folding those channels in here would
 * double-fire the same recompute.
 *
 * Lifecycle: per-mount add/remove listener, no module-scope singleton, cleaned
 * up on unmount. SSR-guarded: with no `window` it stays at 0 and never
 * subscribes.
 */
import { useEffect, useState } from 'react';
import { SELECTED_SCENARIO_CHANGED_EVENT } from './scenario-mutations';

/**
 * Subscribes once to {@link SELECTED_SCENARIO_CHANGED_EVENT} and returns a
 * revision number that increments each time the active-scenario pointer is
 * switched. Include it in a load-effect dependency array to re-read the
 * pointer when the sidebar selection changes while the page is mounted.
 */
export function useSelectedScenarioRevision(): number {
  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChanged = (): void => setRev((r) => r + 1);
    window.addEventListener(SELECTED_SCENARIO_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(SELECTED_SCENARIO_CHANGED_EVENT, onChanged);
    };
  }, []);

  return rev;
}
