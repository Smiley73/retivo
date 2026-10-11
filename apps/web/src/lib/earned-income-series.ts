/**
 * Shared per-member earned-income (part-time wage) series builder for the
 * SSA earnings test. Extracted from the deterministic runner's
 * cashflow builder so EVERY surface that assembles an `SsContext` — the
 * drawdown runner AND the Balance Projection page's chart/table pipeline —
 * feeds the projection engine the same earnings-test inputs and cannot
 * disagree on earnings-tested scenarios.
 *
 * Only `kind === 'partTime'` streams count as earned income; each is
 * scoped to its owning member via `stream.payload.memberId`. Pensions,
 * annuities, and one-off windfalls are unearned and excluded.
 */
import {
  projectIncomeByMonth,
  type IncomeMonthlyContext,
} from './income-projection';
import { birthYearForBenefitPurposes } from './ssa-formulas';
import type { ResolvedIncomeStream } from './income-resolution';
import type { RetirementAgePerMember } from '../db/types';

/** Per-member earned-income series for the SSA earnings test: the annual
 *  rollup plus the ACTUAL per-calendar-month dollars (12 per year). */
export interface EarnedIncomeSeries {
  annualByMember: Record<string, Record<number, number>>;
  monthlyByMember: Record<string, Record<number, number[]>>;
}

/**
 * Earliest calendar year ANY member's Social Security entitlement can
 * begin: the minimum over both members of the own-claim year (benefit-purpose
 * birth year + claim age) and, when set, the survivor-claim year. The shared
 * earned-income series must start no later than this year — the projection
 * engine's earnings-test/ARF warm-up looks back to the member's actual
 * entitlement year, which can precede the modeled "primary retirement" year
 * (e.g. an early own claim or an age-60 survivor claim); a series that starts
 * at retirement silently drops the pre-retirement withholding those years
 * carry. Whole-year math is intentionally conservative (a survivor claim age
 * with months may resolve up to one year LATER — starting the series a year
 * early is harmless; late loses data). Returns `null` when no member has a
 * parseable birthdate.
 *
 * This widens only the range the earnings-test engine can SEE; the app's
 * separate "spendable drawdown income" series keeps its own retirement-based
 * range and still excludes pre-retirement wages.
 */
export function earliestSsEntitlementYear(
  members: ReadonlyArray<{
    payload: { birthdate?: string; isPrimary: boolean };
  }>,
  ss:
    | {
        primary?: RetirementAgePerMember;
        secondary?: RetirementAgePerMember;
        survivor?: {
          primary?: RetirementAgePerMember;
          secondary?: RetirementAgePerMember;
        };
      }
    | undefined,
): number | null {
  const DEFAULT_CLAIM_AGE_YEARS = 67; // buildSsContext's absent-claim default.
  const years: number[] = [];
  for (const member of members) {
    const bd = member.payload.birthdate;
    if (!bd) continue;
    let birthYear: number;
    try {
      birthYear = birthYearForBenefitPurposes(bd);
    } catch {
      continue;
    }
    const own = member.payload.isPrimary ? ss?.primary : ss?.secondary;
    years.push(birthYear + (own?.ageYears ?? DEFAULT_CLAIM_AGE_YEARS));
    const survivor = member.payload.isPrimary ? ss?.survivor?.primary : ss?.survivor?.secondary;
    if (survivor) years.push(birthYear + survivor.ageYears);
  }
  return years.length > 0 ? Math.min(...years) : null;
}

/**
 * Build the per-member earned income (part-time wages) by calendar year, in
 * dollars, keyed by member aggregate id — the SSA earnings-test input.
 *
 * Reuses the same per-month income projection as the cashflow series. The
 * ANNUAL figure rolls each month's part-time run-rate up via the documented
 * `/12` mean (matching `otherOrdinaryIncomeForYear`); the MONTHLY series
 * exposes the actual per-month dollars (`run-rate / 12`) so the SSA
 * grace-year and FRA-year monthly tests read real month boundaries
 * instead of an annualized approximation. Returns `undefined` when there are
 * no part-time streams so `buildSsContext` skips the earnings test.
 *
 * @param resolvedIncome - the scenario-resolved income streams (all kinds —
 *   filtered to part-time here)
 * @param incomeCtx - the month-capable income context (`retirementMonth0`
 *   included) the caller already assembled for its cashflow series
 * @param yearRange - projection range (inclusive calendar years)
 */
export function buildEarnedIncomeSeries(
  resolvedIncome: ReadonlyArray<ResolvedIncomeStream>,
  incomeCtx: IncomeMonthlyContext,
  yearRange: { from: number; to: number },
): EarnedIncomeSeries | undefined {
  const partTime = resolvedIncome.filter((s) => s.payload.kind === 'partTime');
  if (partTime.length === 0) return undefined;

  const annualByMember: Record<string, Record<number, number>> = {};
  const monthlyByMember: Record<string, Record<number, number[]>> = {};
  // Group part-time streams by owning member, project each group, sum the
  // part-time run-rate per year (÷12 mean per the run-rate unit contract)
  // AND keep the actual per-month dollars (run-rate ÷ 12 at each month).
  const memberIds = [...new Set(partTime.map((s) => s.payload.memberId))];
  for (const memberId of memberIds) {
    const streamsForMember = partTime.filter((s) => s.payload.memberId === memberId);
    const rows = projectIncomeByMonth(streamsForMember, incomeCtx, yearRange);
    const runRateByYear: Record<number, number> = {};
    const monthlyByYear: Record<number, number[]> = {};
    for (const r of rows) {
      runRateByYear[r.year] = (runRateByYear[r.year] ?? 0) + r.partTimeIncome;
      const months = (monthlyByYear[r.year] ??= new Array<number>(12).fill(0));
      // Run-rate is annualized $/yr at that month → actual dollars = ÷ 12.
      months[r.month0] += r.partTimeIncome / 12;
    }
    const annualByYear: Record<number, number> = {};
    const memberMonthly: Record<number, number[]> = {};
    for (const [year, runRateSum] of Object.entries(runRateByYear)) {
      const annual = runRateSum / 12;
      if (annual > 0) {
        annualByYear[Number(year)] = annual;
        memberMonthly[Number(year)] = monthlyByYear[Number(year)];
      }
    }
    if (Object.keys(annualByYear).length > 0) {
      annualByMember[memberId] = annualByYear;
      monthlyByMember[memberId] = memberMonthly;
    }
  }
  return Object.keys(annualByMember).length > 0
    ? { annualByMember, monthlyByMember }
    : undefined;
}
