/**
 * Draft-state hook for the QCD sub-page. Mirrors the
 * working-years Roth-conversions draft hook: seeds the editable list from the
 * parent-chain `effective` overrides (so an inherited config shows from first
 * paint), tracks its own `isDirty` via a frozen-at-mount baseline JSON
 * snapshot, and exposes add / update / remove helpers.
 *
 * The QCD list is one inheritable key (first-ancestor-wins; a child that sets
 * it replaces the whole parent list — same shape as `preRetirementRothConversions`),
 * so the draft seeds from `effective` and Save writes the whole list.
 */
import { useMemo, useState } from 'react';
import { resolveScenario, scenarioChain } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioPayload } from '../db/types';
import { cryptoUuid } from '../lib/crypto-uuid';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** A persisted QCD entry — the exact stored shape. */
type PersistedQcd = NonNullable<
  ScenarioOverrides['qualifiedCharitableDistributions']
>[number];

/** One editable QCD entry. The persisted field shape plus a transient per-entry
 *  `draftId` — a stable React key so removing a middle row never mis-associates
 *  uncommitted picker UI state. The `draftId` is UI-only and is STRIPPED before
 *  persist (see the save helpers). */
export type DraftQcd = PersistedQcd & {
  draftId: string;
};

/** Resolve the parent-chain effective overrides for the scenario. Falls back to
 *  local overrides if resolution throws (consistent with the sibling draft
 *  hooks). */
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

/** Pure: JSON snapshot of the dirty-tracked fields. Symmetric with the baseline
 *  so a single string-equality check decides `isDirty`. The transient per-entry
 *  `draftId` is STRIPPED so it never influences dirty tracking. */
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
  /** Name of the nearest ancestor whose QCD list this child inherits (the list
   *  is shown but not locally overridden). `null` when local or absent. */
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
        draftId: cryptoUuid('qcd'),
      })),
    [], // frozen at mount
  );

  const [qcds, setQcds] = useState<DraftQcd[]>(seededQcds);

  // Inherited-from name: the child shows a list it has not locally overridden.
  // Effective is first-ancestor-wins, so walk the chain to the NEAREST ancestor
  // that actually sets `qualifiedCharitableDistributions`, not just the
  // immediate parent (mirrors the Roth-conversions hook).
  const inheritedFromName = useMemo<string | null>(() => {
    if (localOverrides.qualifiedCharitableDistributions !== undefined) return null;
    if ((effective.qualifiedCharitableDistributions ?? []).length === 0) {
      return null;
    }
    if (!scenario.payload.parentScenarioId) return null;
    try {
      const chain = scenarioChain(scenario.id, scenarios);
      // Skip the current scenario (index 0); find the nearest ancestor that
      // sets the QCD key.
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
