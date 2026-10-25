/** Draft-state hook for the working-years Roth-conversions sub-page: seeds the list and rate from the parent-chain effective overrides, tracks isDirty against a frozen-at-mount baseline snapshot, and exposes add / update / remove / reset.
* The conversions list is one inheritable key: a child that sets it replaces the whole parent list. */
import { useMemo, useState } from 'react';
import { resolveScenario, scenarioChain } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioPayload } from '../db/types';
import { cryptoUuid } from '../lib/crypto-uuid';

type ScenarioOverrides = ScenarioPayload['overrides'];

type PersistedRothConversion = NonNullable<
  ScenarioOverrides['preRetirementRothConversions']
>[number];

/** One editable conversion entry plus a transient draftId, a stable React key so removing a middle row never mis-associates picker state; stripped before persist. */
export type DraftRothConversion = PersistedRothConversion & {
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
    console.warn('[roth-conversions] resolveScenario failed', {
      scenarioId: scenario.id,
      error,
    });
    return localOverrides;
  }
}

interface RothConversionsDraftState {
  conversions: DraftRothConversion[];
  taxRatePct: number;
}

// The draftId is stripped so it never influences dirty tracking.
function snapshot(state: RothConversionsDraftState): string {
  return JSON.stringify({
    conversions: state.conversions.map((c) => ({
      sourceAccountId: c.sourceAccountId,
      targetRothAccountId: c.targetRothAccountId,
      annualAmountDollars: c.annualAmountDollars,
      start: c.start,
      end: c.end,
    })),
    taxRatePct: state.taxRatePct,
  });
}

export interface RothConversionsDraftResult {
  draft: RothConversionsDraftState;
  localOverrides: ScenarioOverrides;
  effective: ScenarioOverrides;
  /** Nearest ancestor whose conversions this child inherits; null when local or absent. */
  inheritedFromName: string | null;
  addConversion: (entry: DraftRothConversion) => void;
  updateConversion: (index: number, entry: DraftRothConversion) => void;
  removeConversion: (index: number) => void;
  setTaxRatePct: (v: number) => void;
  isDirty: boolean;
}

export function useRothConversionsDraft(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): RothConversionsDraftResult {
  const localOverrides = scenario.payload.overrides;
  const effective = useMemo(
    () => resolveEffectiveOverrides(scenario, scenarios, localOverrides),
    [], // frozen at mount
  );

  const seededConversions = useMemo<DraftRothConversion[]>(
    () =>
      (effective.preRetirementRothConversions ?? []).map((c) => ({
        ...c,
        draftId: cryptoUuid(),
      })),
    [], // frozen at mount
  );
  const seededRate = effective.preRetirementRothConversionTaxRatePct ?? 0;

  const [conversions, setConversions] =
    useState<DraftRothConversion[]>(seededConversions);
  const [taxRatePct, setTaxRatePct] = useState<number>(seededRate);

  // Effective is first-ancestor-wins, so walk to the nearest ancestor that sets preRetirementRothConversions, not just the parent.
  const inheritedFromName = useMemo<string | null>(() => {
    if (localOverrides.preRetirementRothConversions !== undefined) return null;
    if ((effective.preRetirementRothConversions ?? []).length === 0) return null;
    if (!scenario.payload.parentScenarioId) return null;
    try {
      const chain = scenarioChain(scenario.id, scenarios);
      for (let i = 1; i < chain.length; i += 1) {
        if (
          chain[i].payload.overrides.preRetirementRothConversions !== undefined
        ) {
          return chain[i].payload.name;
        }
      }
    } catch (error) {
      console.warn('[roth-conversions] scenarioChain failed', {
        scenarioId: scenario.id,
        error,
      });
    }
    return null;
  }, []); // frozen at mount

  const baseline = useMemo(
    () =>
      snapshot({
        conversions: seededConversions,
        taxRatePct: seededRate,
      }),
    [], // frozen at mount
  );
  const state: RothConversionsDraftState = { conversions, taxRatePct };
  const isDirty = useMemo(
    () => snapshot(state) !== baseline,
    [conversions, taxRatePct, baseline],
  );

  const addConversion = (entry: DraftRothConversion): void => {
    setConversions((prev) => [...prev, entry]);
  };
  const updateConversion = (index: number, entry: DraftRothConversion): void => {
    setConversions((prev) => prev.map((c, i) => (i === index ? entry : c)));
  };
  const removeConversion = (index: number): void => {
    setConversions((prev) => prev.filter((_, i) => i !== index));
  };

  return {
    draft: state,
    localOverrides,
    effective,
    inheritedFromName,
    addConversion,
    updateConversion,
    removeConversion,
    setTaxRatePct,
    isDirty,
  };
}
