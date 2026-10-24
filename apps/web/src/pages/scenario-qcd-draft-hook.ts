/** Draft-state hook for the QCD sub-page, mirroring the Roth-conversions draft hook: seeds the list from the parent-chain effective overrides and tracks isDirty against a frozen-at-mount baseline snapshot.
* The QCD list is one inheritable key: a child that sets it replaces the whole parent list. */
import { useMemo, useState } from 'react';
import { resolveScenario, scenarioChain } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioPayload } from '../db/types';
import { cryptoUuid } from '../lib/crypto-uuid';

type ScenarioOverrides = ScenarioPayload['overrides'];

type PersistedQcd = NonNullable<
  ScenarioOverrides['qualifiedCharitableDistributions']
>[number];

/** One editable QCD entry plus a transient draftId, a stable React key so removing a middle row never mis-associates picker state; stripped before persist. */
export type DraftQcd = PersistedQcd & {
  draftId: string;
};

function resolveEffectiveOverrides(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  localOverrides: ScenarioOverrides,
): ScenarioOverrides {
  if (!scenario.payload.parentScenarioId) return localOverrides;
  try {
    return resolveScenario(scenario.id, scenarios);
  } catch (error) {
    console.warn('[qcd] resolveScenario failed', {
      scenarioId: scenario.id,
      error,
    });
    return localOverrides;
  }
}

interface QcdDraftState {
  qcds: DraftQcd[];
}

// The draftId is stripped so it never influences dirty tracking.
function snapshot(state: QcdDraftState): string {
  return JSON.stringify({
    qcds: state.qcds.map((q) => ({
      memberId: q.memberId,
      sourceAccountId: q.sourceAccountId,
      annualAmountDollars: q.annualAmountDollars,
      start: q.start,
      end: q.end,
    })),
  });
}

export interface QcdDraftResult {
  draft: QcdDraftState;
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  /** Nearest ancestor whose QCD list this child inherits; null when local or absent. */
  inheritedFromName: string | null;
  addQcd: (entry: DraftQcd) => void;
  updateQcd: (index: number, entry: DraftQcd) => void;
  removeQcd: (index: number) => void;
  isDirty: boolean;
}

export function useQcdDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): QcdDraftResult {
  const localOverrides = scenario.payload.overrides;
  const effective = useMemo(
    () => resolveEffectiveOverrides(scenario, scenarios, localOverrides),
    [], // frozen at mount
  );

  const seededQcds = useMemo<DraftQcd[]>(
    () =>
      (effective.qualifiedCharitableDistributions ?? []).map((q) => ({
        ...q,
        draftId: cryptoUuid(),
      })),
    [], // frozen at mount
  );

  const [qcds, setQcds] = useState<DraftQcd[]>(seededQcds);

  // Effective is first-ancestor-wins, so walk to the nearest ancestor that sets qualifiedCharitableDistributions, not just the parent.
  const inheritedFromName = useMemo<string | null>(() => {
    if (localOverrides.qualifiedCharitableDistributions !== undefined) return null;
    if ((effective.qualifiedCharitableDistributions ?? []).length === 0) {
      return null;
    }
    if (!scenario.payload.parentScenarioId) return null;
    try {
      const chain = scenarioChain(scenario.id, scenarios);
      for (let i = 1; i < chain.length; i += 1) {
        if (
          chain[i].payload.overrides.qualifiedCharitableDistributions !==
          undefined
        ) {
          return chain[i].payload.name;
        }
      }
    } catch (error) {
      console.warn('[qcd] scenarioChain failed', {
        scenarioId: scenario.id,
        error,
      });
    }
    return null;
  }, []); // frozen at mount

  const baseline = useMemo(
    () => snapshot({ qcds: seededQcds }),
    [], // frozen at mount
  );
  const state: QcdDraftState = { qcds };
  const isDirty = useMemo(() => snapshot(state) !== baseline, [qcds, baseline]);

  const addQcd = (entry: DraftQcd): void => {
    setQcds((prev) => [...prev, entry]);
  };
  const updateQcd = (index: number, entry: DraftQcd): void => {
    setQcds((prev) => prev.map((q, i) => (i === index ? entry : q)));
  };
  const removeQcd = (index: number): void => {
    setQcds((prev) => prev.filter((_, i) => i !== index));
  };

  return {
    draft: state,
    localOverrides,
    effective,
    inheritedFromName,
    addQcd,
    updateQcd,
    removeQcd,
    isDirty,
  };
}
