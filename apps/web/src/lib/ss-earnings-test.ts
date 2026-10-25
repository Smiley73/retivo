/**
 * SSA retirement earnings test: part of a pre-FRA claimant's benefit is withheld when part-time earned income passes the
 * annual exempt amount (https://www.ssa.gov/oact/cola/rtea.html). Years past the published amounts are extrapolated; refresh: docs/yearly-tax-refresh.md.
 */

import type { CalibrationSnapshot } from './calibration';
import { fraMonthsForBirthdate, birthYearForBenefitPurposes, birthMonthForBenefitPurposes } from './ssa-formulas';

/** The annual exempt amounts for a calendar year in whole dollars: `lowerThreshold` before the FRA year ($1 withheld per $2 over), `higherThreshold` in the FRA year before the FRA month ($1 per $3). */
export interface SsEarningsTestThresholds {
  readonly lowerThreshold: number;
  readonly higherThreshold: number;
}

export const SSA_EARNINGS_TEST: CalibrationSnapshot<SsEarningsTestThresholds> = {
  values: {
    2024: { lowerThreshold: 22_320, higherThreshold: 59_520 },
    2025: { lowerThreshold: 23_400, higherThreshold: 62_160 },
    2026: { lowerThreshold: 24_480, higherThreshold: 65_160 },
  },
  metadata: {
    source: 'https://www.ssa.gov/oact/cola/rtea.html',
    asOfDate: '2026-06-05',
    jurisdiction: 'US-federal',
  },
};

export interface ResolvedThresholds {
  readonly lowerThreshold: number;
  readonly higherThreshold: number;
  readonly estimated: boolean;
}

/** Exempt amounts for `year`: stored values for a published year; later years compound the latest amounts at `inflationRatePct` and earlier years clamp to the earliest, both `estimated: true`. */
export function resolveEarningsTestThresholds(
  snapshot: CalibrationSnapshot<SsEarningsTestThresholds>,
  year: number,
  inflationRatePct: number,
): ResolvedThresholds {
  const keys = Object.keys(snapshot.values).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) {
    throw new Error('SSA_EARNINGS_TEST snapshot has no entries');
  }
  const earliest = keys[0];
  const latest = keys[keys.length - 1];

  if (year >= earliest && year <= latest && snapshot.values[year] !== undefined) {
    const v = snapshot.values[year];
    return { lowerThreshold: v.lowerThreshold, higherThreshold: v.higherThreshold, estimated: false };
  }

  if (year < earliest) {
    const v = snapshot.values[earliest];
    return { lowerThreshold: v.lowerThreshold, higherThreshold: v.higherThreshold, estimated: true };
  }

  // Past the latest year the amounts grow with the national average wage index, rounded to the nearest $10 (20 CFR
  // 404.430(a)(2)); the model approximates AWI growth with scenario inflation (surfaced by `estimated`) but keeps the rounding.
  const v = snapshot.values[latest];
  const factor = Math.pow(1 + Math.max(0, inflationRatePct) / 100, year - latest);
  const roundToTen = (n: number): number => Math.round(n / 10) * 10;
  return {
    lowerThreshold: roundToTen(v.lowerThreshold * factor),
    higherThreshold: roundToTen(v.higherThreshold * factor),
    estimated: true,
  };
}

export interface EarningsTestInput {
  readonly year: number;
  readonly isoBirthdate: string;
  readonly earnedIncomeDollars: number;
  /** Gross annual benefit chargeable by this beneficiary's excess earnings (20 CFR 404.415/404.434): the record-level total (own checks plus auxiliary benefits payable on their record), the family pool the deduction is charged against. */
  readonly grossBenefitDollars: number;
  readonly inflationRatePct: number;
  /** Actual earned income per month (12 entries, Jan..Dec); drives the grace-year monthly test and the FRA-year pre-FRA-month sum, else annual-only fallbacks. */
  readonly monthlyEarningsDollars?: readonly number[];
  /** Zero-based entitlement month, supplied only in the first entitlement year: bounds the chargeable window and marks the annual gross as covering only the entitled months. Absent means entitled from January. */
  readonly entitlementStartMonth0?: number;
  /** True in the SSA grace year (POMS RS 02501.030); enables the monthly non-service-month test. */
  readonly graceYearMonthly?: boolean;
  /**
   * Actual gross benefit per month (12 entries) when checks vary within the year (a spousal or survivor benefit starting
   * midyear, or the FRA-year rate switch); each is the record-level check and the in-window sum should equal
   * `grossBenefitDollars`. Absent means the uniform annual ÷ 12 (annual ÷ entitled count in the entitlement-start year).
   */
  readonly monthlyBenefitDollars?: readonly number[];
}

export interface EarningsTestResult {
  readonly withheldDollars: number;
  readonly reducedBenefitDollars: number;
  readonly rateApplied: 'pre-fra-year' | 'fra-year' | 'grace-year-monthly' | 'none';
  readonly estimated: boolean;
  /** Whole checks withheld (0..12), the ARF restoration input (POMS RS 00615.482): each chargeable month with any dollars withheld is removed from the early-claim reduction at the FRA recomputation. */
  readonly withheldMonths: number;
  /**
   * Payable fraction of each month's check (12 entries, [0, 1]). SSA charges excess earnings against the earliest
   * chargeable months first (20 CFR 404.415/404.434); months outside the chargeable window are 1. The monthly engine
   * consumes this schedule directly.
   */
  readonly payFactorByMonth: readonly number[];
}

const fullPay = (): number[] => new Array<number>(12).fill(1);

// FRA frame via the SSA day-1-adjusted birth year and month, so FRA=67 (`fraMonths % 12 === 0`) still lands in the right
// calendar month; `null` for an unparseable or out-of-table birthdate, so the caller skips the test.
function fraFrameFor(isoBirthdate: string): { fraYear: number; fraMonth0: number } | null {
  try {
    const fraMonths = fraMonthsForBirthdate(isoBirthdate);
    const adjustedBirthYear = birthYearForBenefitPurposes(isoBirthdate);
    const birthMonth0 = birthMonthForBenefitPurposes(isoBirthdate);
    const fraAbsMonths = adjustedBirthYear * 12 + birthMonth0 + fraMonths;
    return { fraYear: Math.floor(fraAbsMonths / 12), fraMonth0: fraAbsMonths % 12 };
  } catch {
    return null;
  }
}

// Float tolerance, so a Float64 residue does not count as an extra withheld month.
const CHARGE_EPS = 1e-9;

// Chargeable window and check sizes: entitled, testable months (entitlement start to December, never at or after the FRA
// month). `monthlyBenefitDollars` charges each month's actual check, else the uniform annual ÷ 12 (annual ÷ entitled count
// in the entitlement-start year).
function chargeableFrame(
  input: EarningsTestInput,
  isFraYear: boolean,
  fraMonth0: number,
): { from: number; to: number; count: number; checksByMonth: number[]; capDollars: number } {
  const from = input.entitlementStartMonth0 ?? 0;
  const to = isFraYear ? fraMonth0 - 1 : 11; // inclusive
  const count = Math.max(0, to - from + 1);
  const checksByMonth = new Array<number>(12).fill(0);
  if (input.monthlyBenefitDollars) {
    for (let m = from; m <= to; m += 1) {
      checksByMonth[m] = Math.max(0, input.monthlyBenefitDollars[m] ?? 0);
    }
  } else {
    const divisor = input.entitlementStartMonth0 !== undefined && count > 0 ? count : 12;
    const check = input.grossBenefitDollars / divisor;
    for (let m = from; m <= to; m += 1) checksByMonth[m] = check;
  }
  // Deductions charge only the chargeable checks (a FRA-year withholding never touches the at/after-FRA checks), so the cap
  // is their sum rather than the whole-year gross.
  let capDollars = 0;
  for (let m = from; m <= to; m += 1) capDollars += checksByMonth[m];
  return { from, to, count, checksByMonth, capDollars };
}

// Whole-check count the schedule charged (the ARF input): any month with dollars withheld counts, since a partially withheld check is still a non-payment month.
const monthsCharged = (withheldByMonth: readonly number[]): number =>
  withheldByMonth.reduce((n, w) => (w > CHARGE_EPS ? n + 1 : n), 0);

function annualTestFor(
  input: EarningsTestInput,
  isFraYear: boolean,
  fraMonth0: number,
  thresholds: { lowerThreshold: number; higherThreshold: number },
  capDollars: number,
): { withheld: number; rate: 'pre-fra-year' | 'fra-year' | 'none' } {
  if (!isFraYear) {
    const excess = Math.max(0, input.earnedIncomeDollars - thresholds.lowerThreshold);
    return { withheld: Math.min(capDollars, excess / 2), rate: excess > 0 ? 'pre-fra-year' : 'none' };
  }
  // FRA year: only earnings before the FRA month count, at the higher exempt amount; actual monthly earnings when supplied
  // (20 CFR 404.430), else month-share proration.
  const earningsBeforeFra = input.monthlyEarningsDollars
    ? input.monthlyEarningsDollars
        .slice(0, Math.max(0, fraMonth0))
        .reduce((sum, m) => sum + Math.max(0, m), 0)
    : input.earnedIncomeDollars * (fraMonth0 / 12);
  const excess = Math.max(0, earningsBeforeFra - thresholds.higherThreshold);
  return { withheld: Math.min(capDollars, excess / 3), rate: excess > 0 ? 'fra-year' : 'none' };
}

interface EtInternalResult {
  withheld: number;
  rate: EarningsTestResult['rateApplied'];
  months: number;
  withheldByMonth: number[];
}

// Grace-year monthly non-service test (20 CFR 404.435): pay in full any entitled pre-FRA month at or below 1/12 of the exempt
// amount and withhold a service month's whole check; `null` when it cannot run.
function graceMonthlyOutcome(
  input: EarningsTestInput,
  frame: { from: number; to: number; count: number; checksByMonth: number[]; capDollars: number },
  monthlyLimit: number,
): EtInternalResult | null {
  if (
    input.graceYearMonthly !== true ||
    input.monthlyEarningsDollars === undefined ||
    frame.count <= 0
  ) {
    return null;
  }
  const withheldByMonth = new Array<number>(12).fill(0);
  let withheldSum = 0;
  for (let m = frame.from; m <= frame.to; m += 1) {
    if ((input.monthlyEarningsDollars[m] ?? 0) > monthlyLimit) {
      // A service month withholds its actual check (a zero-check month withholds nothing and earns no ARF month).
      withheldByMonth[m] = frame.checksByMonth[m];
      withheldSum += frame.checksByMonth[m];
    }
  }
  const withheld = Math.min(frame.capDollars, withheldSum);
  return {
    withheld,
    rate: withheld > 0 ? 'grace-year-monthly' : 'none',
    months: monthsCharged(withheldByMonth),
    withheldByMonth,
  };
}

const noReductionResult = (gross: number, estimated: boolean): EarningsTestResult => ({
  withheldDollars: 0,
  reducedBenefitDollars: Math.max(0, gross),
  rateApplied: 'none',
  estimated,
  withheldMonths: 0,
  payFactorByMonth: fullPay(),
});

/**
 * Earnings-test withholding for one beneficiary-year. Before the FRA year the lower exempt amount applies; in the FRA
 * year the higher one applies to earnings before the FRA month; the test stops at the FRA month. In the grace year (20 CFR
 * 404.435 / POMS RS 02501.030: the first entitled taxable year with a non-service month, identified by the caller) a
 * month at or below 1/12 of the exempt amount is paid in full, and the smaller of the annual and monthly withholdings wins.
 * A missing or unparseable birthdate means no reduction (the caller surfaces the gap).
 */
export function computeEarningsTest(
  input: EarningsTestInput,
  snapshot: CalibrationSnapshot<SsEarningsTestThresholds>,
): EarningsTestResult {
  const noReduction = (estimated: boolean): EarningsTestResult =>
    noReductionResult(input.grossBenefitDollars, estimated);
  if (input.grossBenefitDollars <= 0 || input.earnedIncomeDollars <= 0) {
    return noReduction(false);
  }
  const fra = fraFrameFor(input.isoBirthdate);
  if (fra === null) return noReduction(false);
  if (input.year > fra.fraYear) return noReduction(false);

  const thresholds = resolveEarningsTestThresholds(snapshot, input.year, input.inflationRatePct);
  const isFraYear = input.year === fra.fraYear;
  const frame = chargeableFrame(input, isFraYear, fra.fraMonth0);

  const annual = annualTestFor(input, isFraYear, fra.fraMonth0, thresholds, frame.capDollars);
  // Sequential charging (20 CFR 404.415/404.434): annual withholding fills whole checks from the first chargeable month, each at its actual size.
  const annualWithheldByMonth = new Array<number>(12).fill(0);
  let remaining = annual.withheld;
  for (let m = frame.from; m <= frame.to && remaining > CHARGE_EPS; m += 1) {
    const take = Math.min(remaining, frame.checksByMonth[m]);
    annualWithheldByMonth[m] = take;
    remaining -= take;
  }
  let result: EtInternalResult = {
    withheld: annual.withheld,
    rate: annual.rate,
    months: monthsCharged(annualWithheldByMonth),
    withheldByMonth: annualWithheldByMonth,
  };
  const grace = graceMonthlyOutcome(
    input,
    frame,
    (isFraYear ? thresholds.higherThreshold : thresholds.lowerThreshold) / 12,
  );
  // The smaller-withholding test wins in the grace year.
  if (grace !== null && grace.withheld <= result.withheld) result = grace;

  const payFactorByMonth = result.withheldByMonth.map((w, m) => {
    const check = frame.checksByMonth[m];
    return check > CHARGE_EPS ? Math.max(0, 1 - w / check) : 1;
  });
  return {
    withheldDollars: result.withheld,
    reducedBenefitDollars: Math.max(0, input.grossBenefitDollars - result.withheld),
    rateApplied: result.withheld > 0 ? result.rate : 'none',
    estimated: thresholds.estimated,
    withheldMonths: result.months,
    payFactorByMonth,
  };
}
