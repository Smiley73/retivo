/** Assembles an `SsContext` from household aggregates and scenario inputs. */
import { parseDate } from '@internationalized/date';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../db/types';
import { DEFAULT_COLA_PCT } from '../db/types';
import type { SsContext } from './ss-projection-types';

/**
 * Effective annual SS COLA for a scenario's override: the scenario inflation rate unless the override
 * sets `colaTracksInflation === false` (undefined tracks inflation, hence the inverted guard).
 */
export function resolveSsColaPct(
  ss: Pick<SocialSecurityOverride, 'colaPct' | 'colaTracksInflation'> | undefined,
  scenarioInflationPct: number,
): number {
  if (ss?.colaTracksInflation === false) {
    return ss.colaPct ?? DEFAULT_COLA_PCT;
  }
  return scenarioInflationPct;
}

// A statement's FRA benefit already includes COLAs through its as-of date, so COLAs apply only after that
// year. A strict parse plus round-trip rejects impossible dates like 2026-02-30 that a shape-only match
// would accept as the COLA anchor; no anchor falls back to the age-62 eligibility year.
function statementAnchorYearFrom(
  piaAsOfDate: string | null | undefined,
): number | undefined {
  if (!piaAsOfDate) return undefined;
  try {
    const parsed = parseDate(piaAsOfDate);
    return parsed.toString() === piaAsOfDate ? parsed.year : undefined;
  } catch {
    return undefined;
  }
}

/** Pairs members with their PIA rows and lifts each statement `piaAsOfDate` into the per-member COLA anchor. */
export function buildSsContext(
  members: Aggregate<HouseholdMemberPayload>[],
  ssBenefits: Aggregate<SocialSecurityBenefitPayload>[],
  scenarioInputs: {
    claimAgePrimary: RetirementAgePerMember;
    claimAgeSecondary?: RetirementAgePerMember;
    /** Per-member survivor claim age; absent withholds survivor-dependent results rather than guessing. */
    survivorClaimAgePrimary?: RetirementAgePerMember;
    survivorClaimAgeSecondary?: RetirementAgePerMember;
    lifeExpectancyPrimary: number;
    lifeExpectancySecondary?: number;
    colaPct: number;
    benefitReductionPct: number;
    /** Earned income (dollars) by member id then calendar year; drives the SSA earnings test, absent means no reduction. */
    earnedIncomeByMemberYear?: Readonly<Record<string, Readonly<Record<number, number>>>>;
    /** Monthly earned income (12 entries per year) for the month-precise grace-year and FRA-year tests. */
    earnedIncomeMonthlyByMemberYear?: Readonly<
      Record<string, Readonly<Record<number, ReadonlyArray<number>>>>
    >;
    earningsTestInflationRatePct?: number;
  },
): SsContext | null {
  const primary = members.find((m) => m.payload.isPrimary);
  if (!primary) return null;
  const secondary = members.find((m) => !m.payload.isPrimary);
  const benefitRowFor = (memberId: string) =>
    ssBenefits.find((s) => s.payload.householdMemberId === memberId);
  const earnedFor = (memberId: string): Readonly<Record<number, number>> | undefined =>
    scenarioInputs.earnedIncomeByMemberYear?.[memberId];
  const earnedMonthlyFor = (
    memberId: string,
  ): Readonly<Record<number, ReadonlyArray<number>>> | undefined =>
    scenarioInputs.earnedIncomeMonthlyByMemberYear?.[memberId];
  const primaryRow = benefitRowFor(primary.id);
  const primaryAnchor = statementAnchorYearFrom(primaryRow?.payload.piaAsOfDate);
  const secondaryRow = secondary ? benefitRowFor(secondary.id) : undefined;
  const secondaryAnchor = statementAnchorYearFrom(secondaryRow?.payload.piaAsOfDate);
  return {
    primary: {
      id: primary.id,
      payload: primary.payload,
      pia: primaryRow?.payload.pia ?? null,
      claimAge: scenarioInputs.claimAgePrimary,
      lifeExpectancyAge: scenarioInputs.lifeExpectancyPrimary,
      ...(primaryAnchor !== undefined ? { statementAnchorYear: primaryAnchor } : {}),
      ...(scenarioInputs.survivorClaimAgePrimary
        ? { survivorClaimAge: scenarioInputs.survivorClaimAgePrimary }
        : {}),
      ...(earnedFor(primary.id) ? { earnedIncomeByYear: earnedFor(primary.id) } : {}),
      ...(earnedMonthlyFor(primary.id)
        ? { earnedIncomeMonthlyByYear: earnedMonthlyFor(primary.id) }
        : {}),
    },
    secondary: secondary
      ? {
          id: secondary.id,
          payload: secondary.payload,
          pia: secondaryRow?.payload.pia ?? null,
          claimAge: scenarioInputs.claimAgeSecondary ?? { ageYears: 67, ageMonths: 0 },
          lifeExpectancyAge:
            scenarioInputs.lifeExpectancySecondary ?? scenarioInputs.lifeExpectancyPrimary,
          ...(secondaryAnchor !== undefined
            ? { statementAnchorYear: secondaryAnchor }
            : {}),
          ...(scenarioInputs.survivorClaimAgeSecondary
            ? { survivorClaimAge: scenarioInputs.survivorClaimAgeSecondary }
            : {}),
          ...(earnedFor(secondary.id) ? { earnedIncomeByYear: earnedFor(secondary.id) } : {}),
          ...(earnedMonthlyFor(secondary.id)
            ? { earnedIncomeMonthlyByYear: earnedMonthlyFor(secondary.id) }
            : {}),
        }
      : undefined,
    colaPct: scenarioInputs.colaPct,
    benefitReductionPct: scenarioInputs.benefitReductionPct,
    ...(scenarioInputs.earningsTestInflationRatePct !== undefined
      ? { earningsTestInflationRatePct: scenarioInputs.earningsTestInflationRatePct }
      : {}),
  };
}
