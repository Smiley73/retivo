/**
 * `buildSsContext` — assembles an `SsContext` from raw IndexedDB
 * aggregates + scenario inputs. Extracted from `ss-projection.ts` to
 * keep that file under the ≤ 400-line shape limit.
 */
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
 * Resolve the effective annual SS COLA rate for a scenario's SS
 * override. The single canonical read point — the deterministic
 * cashflow engine, the MC engine, and the page's chart preview all
 * call this so the COLA-vs-inflation choice never diverges between
 * surfaces.
 *
 * Default-on (product decision, mirrors the chart's real-dollar
 * intent): the COLA tracks the scenario inflation rate unless the
 * override explicitly opts out (`colaTracksInflation === false`).
 * Absent / `true` → inflation. The inverted-default `=== false` is
 * deliberate here (not the usual `=== true` UI guard): a scenario that
 * has never set the flag should still track inflation, so undefined
 * must resolve to the tracking branch.
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

/**
 * Statement COLA anchor year from a `piaAsOfDate` ISO string: the
 * statement's quoted FRA benefit already includes every COLA through its
 * as-of date, so COLAs are layered only for years AFTER that year. Returns
 * `undefined` for an absent, malformed, or calendar-invalid date (engines
 * then fall back to the age-62 eligibility-year anchor — the documented
 * fallback). Strict `parseDate` + round-trip equality (the same
 * pattern as `birthdate-validation.ts`) — a shape-only `YYYY-…` match would
 * accept impossible dates like `2026-02-30` and let a garbage year become
 * the load-bearing COLA anchor; fail safe instead.
 */
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

/**
 * Build an `SsContext` from raw aggregates. Caller wires the scenario-
 * resolved claim age + survivor claim age + life expectancy + COLA +
 * reduction; this helper pairs members with their PIA rows and lifts the
 * statement `piaAsOfDate` into the per-member COLA anchor.
 */
export function buildSsContext(
  members: Aggregate<HouseholdMemberPayload>[],
  ssBenefits: Aggregate<SocialSecurityBenefitPayload>[],
  scenarioInputs: {
    claimAgePrimary: RetirementAgePerMember;
    claimAgeSecondary?: RetirementAgePerMember;
    /**
     * Per-member survivor-benefit claim age (separate from the own claim
     * age). Absent → survivor-dependent results for that member are withheld
     * (never guessed); the projection flags the missing input instead of defaulting.
     */
    survivorClaimAgePrimary?: RetirementAgePerMember;
    survivorClaimAgeSecondary?: RetirementAgePerMember;
    lifeExpectancyPrimary: number;
    lifeExpectancySecondary?: number;
    colaPct: number;
    benefitReductionPct: number;
    /**
     * Optional per-member earned income (part-time wages) by calendar year, in
     * dollars, keyed by member aggregate id. Drives the SSA earnings test.
     * Absent → no earnings-test reduction (prior behaviour).
     */
    earnedIncomeByMemberYear?: Readonly<Record<string, Readonly<Record<number, number>>>>;
    /**
     * Optional per-member ACTUAL monthly earned income (12 entries per year,
     * dollars), keyed by member aggregate id then calendar year. Enables the
     * month-precise grace-year and FRA-year earnings tests.
     */
    earnedIncomeMonthlyByMemberYear?: Readonly<
      Record<string, Readonly<Record<number, ReadonlyArray<number>>>>
    >;
    /** Scenario inflation rate (%) for extrapolating earnings-test thresholds. */
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
