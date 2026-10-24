// Per-member earned-income (part-time wage) series for the SSA earnings test, shared so every `SsContext` builder feeds
// the engine the same inputs. Only `partTime` streams count, scoped to their `memberId`; pensions and windfalls are unearned.

import {
  projectIncomeByMonth,
  type IncomeMonthlyContext,
} from './income-projection';
import { birthYearForBenefitPurposes } from './ssa-formulas';
import type { ResolvedIncomeStream } from './income-resolution';
import type { RetirementAgePerMember } from '../db/types';

export interface EarnedIncomeSeries {
  annualByMember: Record<string, Record<number, number>>;
  monthlyByMember: Record<string, Record<number, number[]>>;
}

/**
 * Earliest year any member's Social Security entitlement can begin (own claim or
 * survivor claim), or `null` without a parseable birthdate. The series must start
 * no later: the earnings-test warm-up looks back to the entitlement year, which
 * can precede the modeled retirement year. Whole-year math is conservative, as
 * starting a year early is harmless and late loses data. The spendable-income
 * series keeps its retirement-based range.
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
 * Per-member part-time wages by calendar year in dollars, keyed by member id, or
 * `undefined` without part-time streams so `buildSsContext` skips the earnings
 * test. The annual figure is the run-rate's `/12` mean; the monthly series keeps
 * real per-month dollars for the grace-year and FRA-year tests.
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
  const memberIds = [...new Set(partTime.map((s) => s.payload.memberId))];
  for (const memberId of memberIds) {
    const streamsForMember = partTime.filter((s) => s.payload.memberId === memberId);
    const rows = projectIncomeByMonth(streamsForMember, incomeCtx, yearRange);
    const runRateByYear: Record<number, number> = {};
    const monthlyByYear: Record<number, number[]> = {};
    for (const r of rows) {
      runRateByYear[r.year] = (runRateByYear[r.year] ?? 0) + r.partTimeIncome;
      const months = (monthlyByYear[r.year] ??= new Array<number>(12).fill(0));
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
