/**
 * The saved-plan marker's state for the selected scenario, read from storage on
 * mount and on a scenario switch, plus `remember` for the save.
 */
import { useCallback, useMemo, useState } from 'react';
import type { MagiCapWindow } from '../../db/types';
import {
  buildSavedPlanRecord,
  readSavedPlan,
  savedPlanStatus,
  writeSavedPlan,
  type SavedPlanRecord,
  type SavedPlanStatus,
} from './roth-suggestion-saved-plan';
import type { RothSuggestionData } from './roth-suggestion-view-model';

interface UseRothSavedPlanResult {
  readonly status: SavedPlanStatus | null;
  /** Records a plan just saved to the scenario, against the data it was saved from. */
  readonly remember: (label: string, ladder: readonly MagiCapWindow[]) => void;
}

export function useRothSavedPlan(
  data: RothSuggestionData,
  scenarioId: string,
): UseRothSavedPlanResult {
  const [stored, setStored] = useState<{ scenarioId: string; record: SavedPlanRecord | null }>(
    () => ({ scenarioId, record: readSavedPlan(scenarioId) }),
  );
  // Read the new scenario's record in the same render the scenario changes, so
  // the previous scenario's marker is never painted against it.
  let record = stored.record;
  if (stored.scenarioId !== scenarioId) {
    record = readSavedPlan(scenarioId);
    setStored({ scenarioId, record });
  }

  const { scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams } = data;
  const status = useMemo(
    () =>
      savedPlanStatus(
        record,
        { scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams },
        scenarioId,
      ),
    [record, scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams, scenarioId],
  );

  const remember = useCallback(
    (label: string, ladder: readonly MagiCapWindow[]): void => {
      const next = buildSavedPlanRecord({
        data: { scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams },
        scenarioId,
        label,
        ladder,
        now: new Date(),
      });
      writeSavedPlan(scenarioId, next);
      setStored({ scenarioId, record: next });
    },
    [scenarios, accounts, balances, members, ssBenefits, expenses, incomeStreams, scenarioId],
  );

  return { status, remember };
}
