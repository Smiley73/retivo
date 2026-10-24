// Subscription for "the active-scenario pointer changed". The pointer lives in the local-only `selectedScenario` store, not an aggregate row,
// so `useAggregates` does not cover it. Only `SELECTED_SCENARIO_CHANGED_EVENT` is subscribed: consumers already take aggregate arrays from `useAggregates`, and folding those channels in would double-fire.

import { useEffect, useState } from 'react';
import { SELECTED_SCENARIO_CHANGED_EVENT } from './scenario-mutations';

/** A revision that increments each time the active-scenario pointer switches; include it in a load-effect's dependencies. */
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
