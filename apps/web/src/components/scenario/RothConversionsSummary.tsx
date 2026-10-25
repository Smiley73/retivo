import React, { useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Aggregate, HouseholdMemberPayload, ScenarioOverrides } from '../../db/types';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { resolveScenario, scenarioChain } from '../../lib/scenario-resolution';
import { resolveConversionLeg } from '../../lib/roth-conversion-utils';
import {
  buildRothConversionResolveCtx,
  resolveConversionYears,
} from '../../lib/roth-conversion-window';
import { formatCurrency } from '../../lib/format-currency';
import { Muted } from '../Muted';
import {
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from '../../pages/scenarios-page-chrome';

export const ROTH_CONVERSION_OVERRIDE_KEYS = [
  'preRetirementRothConversions',
  'preRetirementRothConversionTaxRatePct',
] as const;

export function hasRothConversionOverride(ov: ScenarioOverrides): boolean {
  return ROTH_CONVERSION_OVERRIDE_KEYS.some((k) => ov[k] !== undefined);
}

export interface RothConversionsSummaryProps {
  scenarioId: string;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  onResetToInherited: () => void;
}

/**
 * Working-years Roth conversions summary: the count and the lifetime extra income tax (per-year
 * burden times each window's years, summed). The list reflects the effective parent-chain value;
 * tint and Reset key on a local override only.
 */
export const RothConversionsSummaryCard: React.FC<RothConversionsSummaryProps> = ({
  scenarioId,
  scenario,
  scenarios,
  members,
  onResetToInherited,
}) => {
  const navigate = useNavigate();
  const ov = scenario.payload.overrides;
  const hasLocalOverride = hasRothConversionOverride(ov);
  const canResetToInherited = hasLocalOverride && !scenario.payload.isPrimary;

  const effective = useMemo<ScenarioOverrides>(() => {
    if (!scenario.payload.parentScenarioId) return ov;
    try {
      return resolveScenario(scenario.id, scenarios);
    } catch {
      return ov;
    }
  }, [scenario, scenarios, ov]);

  const inheritedFromName = useMemo<string | null>(() => {
    if (ov.preRetirementRothConversions !== undefined) return null;
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
    } catch {
      return null;
    }
    return null;
  }, [scenario, scenarios, ov, effective]);

  const conversions = effective.preRetirementRothConversions ?? [];
  const ratePct = effective.preRetirementRothConversionTaxRatePct ?? 0;

  // A conversion whose `age` anchor cannot resolve or whose window is backwards counts as one year,
  // so it is never dropped from the headline.
  const totalBurdenCents = useMemo<number>(() => {
    const ctx = buildRothConversionResolveCtx(members);
    let total = 0;
    for (const c of conversions) {
      const burden = resolveConversionLeg(
        Math.round(c.annualAmountDollars * 100),
        ratePct,
      ).taxBurdenCents;
      const years = resolveConversionYears(c, ctx);
      const yearCount =
        years && years.endYear >= years.startYear
          ? years.endYear - years.startYear + 1
          : 1;
      total += burden * yearCount;
    }
    return total;
  }, [conversions, ratePct, members]);

  return (
    <SummarySectionCard
      title="Pre-retirement Roth conversions"
      headingId="roth-conversions-heading"
      overridden={scenario.payload.isPrimary ? undefined : hasLocalOverride}
      actions={
        <ConfigureResetActions
          subject="working-years Roth conversions"
          onConfigure={() => navigate(`/scenarios/${scenarioId}/roth-conversions`)}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {conversions.length === 0
          ? 'No scenario overrides.'
          : `${conversions.length} conversion${conversions.length === 1 ? '' : 's'} during your working years · about ${formatCurrency(totalBurdenCents / 100)} total in extra income tax (rate ${ratePct}%)`}
      </SummaryCardBody>
      {inheritedFromName && (
        <Muted className="m-0 mt-2 text-xs">
          Inherited from {inheritedFromName}.
        </Muted>
      )}
    </SummarySectionCard>
  );
};
