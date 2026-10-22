/** Per-year filing facts, read from the engine's own resolvers. */
import type { PipelineContext } from '../balance-projection-runner-types';
import { buildMemberInputs, resolveHouseholdDeathYears } from '../balance-projection-runner-tax-helpers';
import { age65PlusMemberIdsForYear, resolveTaxUnitsForYear } from '../balance-projection-runner-tax';
import type { FilingStatus } from '../federal-tax';
import type { IrmaaBeneficiaryEnrollment } from '../irmaa';
import {
  defaultHouseholdSlcspByAge,
  householdMarketplaceCoverageMonths,
  irmaaBeneficiaryEnrollments,
  overrideBenchmarkCentsForCoverageMonths,
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
  /** Their Part B and Part D months in year Y+2, which prorate the surcharge. */
  readonly irmaaBeneficiaries: readonly IrmaaBeneficiaryEnrollment[];
}

type YearFactsResult =
  | { readonly kind: 'ok'; readonly facts: YearFacts }
  | { readonly kind: 'unsupported'; readonly reason: RothSuggestionUnsupportedReason };

interface AliveFlags {
  readonly primaryAlive: boolean;
  readonly secondaryAlive: boolean;
}

/** Alive through the whole death year; no death year reads as alive, as in the engine. */
function aliveFlags(ctx: PipelineContext, year: number): AliveFlags {
  const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
  return {
    primaryAlive: year <= (primaryDeathYear ?? Infinity),
    secondaryAlive: ctx.secondary !== undefined && year <= (secondaryDeathYear ?? Infinity),
  };
}

/** One year's filing facts, or why the search cannot handle the year (two tax
 *  units or none: no single MAGI line to fill against). */
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

/** Whether year `year + 2` is projected and has a member with Medicare months. */
export function resolveLookbackFacts(ctx: PipelineContext, year: number): LookbackFacts {
  const lookbackYear = year + 2;
  if (lookbackYear > ctx.horizonYear) {
    return { year: lookbackYear, withinHorizon: false, medicareBeneficiaries: 0, irmaaBeneficiaries: [] };
  }
  const { primaryAlive, secondaryAlive } = aliveFlags(ctx, lookbackYear);
  const members = buildMemberInputs(ctx, lookbackYear, primaryAlive, secondaryAlive);
  const irmaaBeneficiaries = irmaaBeneficiaryEnrollments(members);
  return {
    year: lookbackYear,
    withinHorizon: true,
    medicareBeneficiaries: irmaaBeneficiaries.length as 0 | 1 | 2,
    irmaaBeneficiaries,
  };
}

/** The household's benchmark plan cost for the year in cents, priced as the tax pass prices it. */
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
