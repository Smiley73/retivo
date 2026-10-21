/**
 * Per-year filing facts, read from the engine's own resolvers rather than
 * re-derived: which members are alive, which tax unit files, the household
 * size, the age-65 count and the health coverage the year's limits depend on.
 */
import type { PipelineContext } from '../balance-projection-runner-types';
import { buildMemberInputs, resolveHouseholdDeathYears } from '../balance-projection-runner-tax-helpers';
import { age65PlusMemberIdsForYear, resolveTaxUnitsForYear } from '../balance-projection-runner-tax';
import type { FilingStatus } from '../federal-tax';
import {
  defaultHouseholdSlcspByAge,
  householdMarketplaceCoverageMonths,
  overrideBenchmarkCentsForCoverageMonths,
  resolveCoverageMonths,
  storedAcaBenchmarkOverrides,
  type TaxMemberInput,
} from '../tax-integration-helpers';
import type { RothSuggestionUnsupportedReason } from './types';

export interface YearFacts {
  readonly year: number;
  readonly filingStatus: FilingStatus;
  readonly householdSize: number;
  /** Members who attain 65 by the end of the year and are alive. */
  readonly age65Count: number;
  readonly members: readonly TaxMemberInput[];
}

/** What year Y+2 says about whether year Y's MAGI can set an IRMAA tier. */
export interface LookbackFacts {
  readonly year: number;
  readonly withinHorizon: boolean;
  /** Members with a Medicare month in year Y+2, the count IRMAA is billed for. */
  readonly medicareBeneficiaries: 0 | 1 | 2;
}

export type YearFactsResult =
  | { readonly kind: 'ok'; readonly facts: YearFacts }
  | { readonly kind: 'unsupported'; readonly reason: RothSuggestionUnsupportedReason };

interface AliveFlags {
  readonly primaryAlive: boolean;
  readonly secondaryAlive: boolean;
}

/** A member is alive through the whole of their death year; an unusable
 *  birthdate has no death year and reads as alive, as it does in the engine. */
function aliveFlags(ctx: PipelineContext, year: number): AliveFlags {
  const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
  return {
    primaryAlive: year <= (primaryDeathYear ?? Infinity),
    secondaryAlive: ctx.secondary !== undefined && year <= (secondaryDeathYear ?? Infinity),
  };
}

/** One year's filing facts, or why the search cannot handle the year: a
 *  separate-returns plan resolves to two tax units and an unresolvable plan to
 *  none, and neither has a single MAGI line to fill against. */
export function resolveYearFacts(ctx: PipelineContext, year: number): YearFactsResult {
  const { primaryAlive, secondaryAlive } = aliveFlags(ctx, year);
  const resolution = resolveTaxUnitsForYear(ctx, year, primaryAlive, secondaryAlive);
  if (resolution.kind !== 'resolved' || resolution.taxUnits.length === 0) {
    return { kind: 'unsupported', reason: 'filing-unresolved' };
  }
  if (resolution.taxUnits.length > 1) {
    return { kind: 'unsupported', reason: 'separate-filing-plan' };
  }
  const unit = resolution.taxUnits[0];
  const members = buildMemberInputs(ctx, year, primaryAlive, secondaryAlive);
  return {
    kind: 'ok',
    facts: {
      year,
      filingStatus: unit.filingStatus,
      householdSize: unit.householdSize ?? members.length,
      age65Count: age65PlusMemberIdsForYear(ctx, year, primaryAlive, secondaryAlive).length,
      members,
    },
  };
}

/** Whether year `year + 2` exists in the projection and has a living member
 *  with Medicare months, the only case year `year`'s MAGI can set a tier. */
export function resolveLookbackFacts(ctx: PipelineContext, year: number): LookbackFacts {
  const lookbackYear = year + 2;
  if (lookbackYear > ctx.horizonYear) {
    return { year: lookbackYear, withinHorizon: false, medicareBeneficiaries: 0 };
  }
  const { primaryAlive, secondaryAlive } = aliveFlags(ctx, lookbackYear);
  const members = buildMemberInputs(ctx, lookbackYear, primaryAlive, secondaryAlive);
  const onMedicare = members.filter((m) => {
    const { partBMonths, partDMonths } = resolveCoverageMonths(m);
    return partBMonths > 0 || partDMonths > 0;
  });
  return {
    year: lookbackYear,
    withinHorizon: true,
    medicareBeneficiaries: Math.min(2, onMedicare.length) as 0 | 1 | 2,
  };
}

/** The household's benchmark plan cost for the year, in cents, priced the way
 *  the tax pass prices it: the scenario's per-year override prorated to the
 *  Marketplace months, else the age-priced fallback. */
export function benchmarkSlcspCentsForYear(ctx: PipelineContext, facts: YearFacts): number {
  const override = storedAcaBenchmarkOverrides(ctx.resolvedScenario.acaPtcBenchmark).find(
    (o) => o.taxYear === facts.year,
  );
  if (override === undefined) {
    return Math.round(defaultHouseholdSlcspByAge(facts.members, facts.year) * 100);
  }
  return overrideBenchmarkCentsForCoverageMonths(
    override.annualSlcspDollars,
    householdMarketplaceCoverageMonths(facts.members),
  );
}
