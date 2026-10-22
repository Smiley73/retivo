/**
 * Saving a ranked plan from the comparison table: the dialog's row and copy, and
 * the confirm that writes the ladder through the page's `persistOverrides` and
 * then remembers it for the marker.
 */
import { useCallback, useState } from 'react';
import type { ScenarioPayload } from '../../db/types';
import { buildSuggestionCap } from '../../lib/roth-betr-apply-helpers';
import type { RothBETRPageData } from './roth-betr-data';
import {
  describeReplacedCap,
  summarizeSavePlan,
  type ReplacedCap,
  type SavePlanSummary,
} from './roth-suggestion-save-view';
import type { SavedPlanStatus } from './roth-suggestion-saved-plan';
import type { RothSuggestionData, RothSuggestionRow } from './roth-suggestion-view-model';
import { useRothSavedPlan } from './use-roth-saved-plan';

interface SaveDialogView {
  readonly open: boolean;
  readonly scenarioName: string;
  readonly summary: SavePlanSummary | null;
  readonly replaced: ReplacedCap;
  readonly targetName: string | null;
  readonly saving: boolean;
}

interface UseRothSuggestionSaveResult {
  readonly status: SavedPlanStatus | null;
  readonly dialog: SaveDialogView;
  readonly openFor: (row: RothSuggestionRow) => void;
  readonly close: () => void;
  readonly confirm: () => void;
}

export function useRothSuggestionSave(args: {
  readonly pageData: RothBETRPageData;
  readonly data: RothSuggestionData;
  readonly selectedScenarioId: string;
  /** The results on screen were computed on data that has since changed; a plan
   *  from them is not saved. */
  readonly resultsStale: boolean;
  /** The page's save path; resolves true when the scenario was written. */
  readonly persistOverrides: (
    fragment: Partial<ScenarioPayload['overrides']>,
  ) => Promise<boolean>;
  /** The page's error banner. */
  readonly onError: (message: string) => void;
}): UseRothSuggestionSaveResult {
  const { pageData, data, selectedScenarioId, resultsStale, persistOverrides, onError } = args;
  const { status, remember } = useRothSavedPlan(data, selectedScenarioId);
  const [target, setTarget] = useState<{ row: RothSuggestionRow; open: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const scenario = data.scenarios.find((s) => s.id === selectedScenarioId);

  const summary = target === null ? null : summarizeSavePlan(target.row);
  const targetRothId = summary?.targetRothId ?? null;
  const targetName =
    targetRothId === null
      ? null
      : (pageData.rothIraAccounts.find((a) => a.id === targetRothId)?.name ?? null);

  const openFor = useCallback((row: RothSuggestionRow): void => {
    setTarget({ row, open: true });
  }, []);
  const close = useCallback((): void => {
    setTarget((t) => (t === null ? null : { ...t, open: false }));
  }, []);

  const confirm = useCallback((): void => {
    if (target === null || summary === null || scenario === undefined || saving) return;
    if (resultsStale) {
      // The data moved under an open dialog. The panel's out-of-date notice says why.
      close();
      return;
    }
    setSaving(true);
    void (async () => {
      try {
        const fragment = buildSuggestionCap({
          ladder: target.row.ladder,
          localOverrides: scenario.payload.overrides,
          parentCap: pageData.parentCap,
        });
        if (await persistOverrides(fragment)) {
          remember(summary.label, target.row.ladder);
          close();
        }
      } catch (e) {
        onError((e as Error).message ?? "Couldn't save to the scenario.");
      } finally {
        setSaving(false);
      }
    })();
  }, [target, summary, scenario, saving, resultsStale, pageData.parentCap, persistOverrides, remember, close, onError]);

  return {
    status,
    dialog: {
      open: target?.open ?? false,
      scenarioName: scenario?.payload.name ?? '',
      summary,
      replaced: describeReplacedCap(data.scenarios, selectedScenarioId, pageData.parentCap),
      targetName,
      saving,
    },
    openFor,
    close,
    confirm,
  };
}
