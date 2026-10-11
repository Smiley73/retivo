/**
 * Social Security earnings-test engine.
 *
 * Models the SSA retirement earnings test (RET): a beneficiary who claims
 * before their Full Retirement Age (FRA) and keeps working has part of their
 * benefit withheld when earned income exceeds an annual exempt amount. Two
 * rates apply (SSA, https://www.ssa.gov/oact/cola/rtea.html):
 *
 *   (a) In any year BEFORE the FRA year — the lower exempt amount applies and
 *       SSA withholds $1 of benefit for every $2 of earnings above it.
 *   (b) In the FRA year, for earnings BEFORE the FRA month — the higher exempt
 *       amount applies and SSA withholds $1 for every $3 above it. When actual
 *       per-month earnings are supplied, only the dollars actually earned in
 *       the pre-FRA months count (20 CFR 404.430); the flat month-share
 *       proration of annual earnings remains the fallback.
 *   (c) At or after the FRA month — no reduction (the test stops).
 *   (d) The SSA "grace year" (20 CFR 404.435 / POMS RS 02501.030) — the
 *       FIRST entitled taxable year that CONTAINS a non-service month
 *       (earnings at/below 1/12 of the applicable annual exempt amount),
 *       which is NOT necessarily the first entitlement year (a
 *       claimant whose entire entitlement year is service months gets the
 *       grace year in the first LATER year with a non-service month). The
 *       caller identifies it and sets `graceYearMonthly`; with actual
 *       monthly earnings, the beneficiary is then paid in full for every
 *       non-service month regardless of annual earnings, while a service
 *       month's check is withheld. SSA applies whichever of the
 *       annual/monthly tests pays more months, so the engine takes the
 *       smaller withholding of the two.
 *
 * Withheld dollars are also expressed as a whole-check `withheldMonths` count
 * so the FRA benefit recomputation (ARF — adjustment of the reduction factor,
 * POMS RS 00615.482) can restore those months at FRA: months withheld before
 * FRA no longer count as early-claim reduction months.
 *
 * Earned income for the test is part-time wages only (`IncomeStream.kind ===
 * 'partTime'`), scoped to the SS beneficiary by `stream.memberId`. Pensions,
 * annuities, one-off windfalls, and portfolio withdrawals are not earned
 * income and never trigger the test (a documented simplification — the SSA
 * also excludes most of those, so the model is close to the statute).
 *
 * Exempt amounts are stored as a year-keyed `CalibrationSnapshot`, refreshed
 * each year (see `docs/yearly-tax-refresh.md`). Years beyond the published
 * range are extrapolated via the scenario inflation rate and flagged
 * `estimated: true`.
 */

import type { CalibrationSnapshot } from './calibration';
import { fraMonthsForBirthdate, birthYearForBenefitPurposes, birthMonthForBenefitPurposes } from './ssa-formulas';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/**
 * The two annual exempt amounts for one calendar year (whole dollars).
 *   - `lowerThreshold` — applies in years before the FRA year ($1/$2 rate).
 *   - `higherThreshold` — applies in the FRA year, pre-FRA-month ($1/$3 rate).
 */
export interface SsEarningsTestThresholds {
  /** Lower annual exempt amount (pre-FRA-year, $1 withheld per $2 over). */
  readonly lowerThreshold: number;
  /** Higher annual exempt amount (FRA year before FRA month, $1 per $3 over). */
  readonly higherThreshold: number;
}

// ---------------------------------------------------------------------------
// Calibration snapshot (SSA published values)
// ---------------------------------------------------------------------------

/**
 * SSA earnings-test exempt amounts. Update `values[<new-year>]` and
 * `metadata.asOfDate` each year when SSA publishes the COLA notice
 * (typically October). Source is the stable SSA RET permalink.
 *
 * Published values (SSA, https://www.ssa.gov/oact/cola/rtea.html):
 *   2024: lower $22,320 · higher $59,520
 *   2025: lower $23,400 · higher $62,160
 *   2026: lower $24,480 · higher $65,160
 */
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

// ---------------------------------------------------------------------------
// Threshold resolution (with inflation extrapolation)
// ---------------------------------------------------------------------------

/** Result of resolving the exempt amounts for a given year. */
export interface ResolvedThresholds {
  readonly lowerThreshold: number;
  readonly higherThreshold: number;
  /** True when the year is beyond the published range and was extrapolated. */
  readonly estimated: boolean;
}

/**
 * Resolve the exempt amounts for `year`. Published years return their stored
 * values (`estimated: false`). Years after the latest published year are
 * extrapolated by compounding the latest stored amounts at `inflationRatePct`
 * for the year gap (`estimated: true`). Years before the earliest published
 * year clamp to the earliest stored values (`estimated: true` — outside the
 * published range either direction is an estimate).
 */
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

  // year > latest → extrapolate forward via inflation. Statutorily the
  // exempt amounts grow with the national average wage index (AWI) and are
  // rounded to the nearest $10 (20 CFR 404.430(a)(2)); the model
  // approximates AWI growth with the scenario inflation rate (a disclosed
  // approximation — the `estimated` flag + UI copy surface it) but applies
  // the statutory nearest-$10 rounding.
  const v = snapshot.values[latest];
  const factor = Math.pow(1 + Math.max(0, inflationRatePct) / 100, year - latest);
  const roundToTen = (n: number): number => Math.round(n / 10) * 10;
  return {
    lowerThreshold: roundToTen(v.lowerThreshold * factor),
    higherThreshold: roundToTen(v.higherThreshold * factor),
    estimated: true,
  };
}

// ---------------------------------------------------------------------------
// Earnings-test computation
// ---------------------------------------------------------------------------

/** Inputs for a single beneficiary, single year. */
export interface EarningsTestInput {
  /** Calendar year being evaluated. */
  readonly year: number;
  /** Beneficiary's ISO birthdate (YYYY-MM-DD). Drives the FRA year + month. */
  readonly isoBirthdate: string;
  /** Earned income (part-time wages) for the beneficiary this year, in dollars. */
  readonly earnedIncomeDollars: number;
  /** Gross annual benefit dollars chargeable by THIS beneficiary's excess
   *  earnings this year (20 CFR 404.415/404.434): the projection
   *  engine passes the RECORD-level combined total — the beneficiary's own
   *  checks plus any auxiliary benefits payable on their record plus their
   *  own auxiliary benefit — not just the personal benefit, so the
   *  deduction is computed and charged against the correct family pool. */
  readonly grossBenefitDollars: number;
  /** Assumed annual inflation rate (percent) for threshold extrapolation. */
  readonly inflationRatePct: number;
  /**
   * Actual earned income per calendar month (12 entries, dollars, Jan..Dec).
   * When present it drives the grace-year monthly test (d) and the FRA-year
   * pre-FRA-month earnings sum (b); absent → annual-only fallbacks.
   */
  readonly monthlyEarningsDollars?: readonly number[];
  /**
   * Zero-based month the beneficiary's entitlement begins, supplied ONLY when
   * `year` is the first entitlement year. Bounds the chargeable window (no
   * check exists before it) and marks the annual gross as covering only the
   * entitled months (the uniform-check fallback divides by the entitled
   * count). Absent → entitled from January.
   */
  readonly entitlementStartMonth0?: number;
  /**
   * True when `year` is the beneficiary's SSA grace year (POMS RS
   * 02501.030 — the FIRST entitled taxable year containing a non-service
   * month; the caller carries that per-member state). Enables the
   * monthly non-service-month test (d). Absent/false → annual test only.
   */
  readonly graceYearMonthly?: boolean;
  /**
   * ACTUAL gross benefit dollars per calendar month (12 entries, Jan..Dec) —
   * the real chargeable check sizes when they vary within the year (a
   * spousal excess or survivor benefit activating midyear, or the FRA-year
   * mixed pre-/post-restoration rates). Like `grossBenefitDollars`,
   * each month carries the RECORD-level combined check. When present,
   * deductions are charged against each specific month's real check;
   * its in-window sum should equal `grossBenefitDollars`. Absent → the
   * uniform annual ÷ 12 (entitlement-start year: annual ÷ entitled-count)
   * scalar fallback.
   */
  readonly monthlyBenefitDollars?: readonly number[];
}

/** Result of the earnings test for one beneficiary-year. */
export interface EarningsTestResult {
  /** Dollars of benefit withheld this year (0..grossBenefitDollars). */
  readonly withheldDollars: number;
  /** Gross benefit minus the withholding (never negative). */
  readonly reducedBenefitDollars: number;
  /** Which rule produced the withholding: 'pre-fra-year' ($1/$2 annual),
   *  'fra-year' ($1/$3 annual on pre-FRA-month earnings),
   *  'grace-year-monthly' (per-month non-service test won), or 'none'. */
  readonly rateApplied: 'pre-fra-year' | 'fra-year' | 'grace-year-monthly' | 'none';
  /** True when the year's exempt amounts were extrapolated (estimate flag). */
  readonly estimated: boolean;
  /**
   * Whole benefit checks withheld this year (0..12) — the ARF restoration
   * input (POMS RS 00615.482): each pre-FRA month whose check was withheld is
   * removed from the early-claim reduction when the benefit is recomputed at
   * FRA. Counted from the per-month charge schedule: every chargeable month
   * with any dollars withheld (a partially withheld check is still a
   * non-payment month, the prior ceil convention for uniform checks).
   */
  readonly withheldMonths: number;
  /**
   * Fraction of each calendar month's check payable (12 entries, Jan..Dec,
   * each in [0, 1]; 1 = full check). SSA charges excess earnings against the
   * earliest chargeable months first (20 CFR 404.415/404.434), so annual-test
   * withholding fills whole checks sequentially from the first entitled month
   * and the grace-year monthly test zeroes exactly the service months.
   * Months outside the chargeable window (pre-entitlement, at/after the FRA
   * month) are always 1. The monthly projection engine consumes this
   * schedule directly instead of spreading one annual factor over all
   * twelve months.
   */
  readonly payFactorByMonth: readonly number[];
}

/**
 * Compute the earnings-test withholding for one beneficiary in one year.
 *
 * Rate selection by FRA boundary:
 *   - `year < fraYear` → lower exempt amount, $1/$2 withholding.
 *   - `year === fraYear` → higher exempt amount, $1/$3 withholding, applied to
 *     the earnings counted BEFORE the FRA month. With `monthlyEarningsDollars`
 *     the pre-FRA earnings are the ACTUAL dollars earned in months before the
 *     FRA month (20 CFR 404.430); without it the model prorates the year's
 *     earned income by the pre-FRA month share (fallback approximation).
 *   - `year > fraYear` → no reduction.
 *   - `graceYearMonthly` set (the caller-identified grace year) +
 *     monthly earnings → the monthly non-service test also runs and the
 *     SMALLER withholding wins (SSA pays whichever test is more favorable
 *     in the grace year, 20 CFR 404.435).
 *
 * Missing/unparseable birthdate → no reduction (and not flagged estimated here;
 * the caller surfaces the birthdate gap in the estimate note).
 */
const fullPay = (): number[] => new Array<number>(12).fill(1);

/** FRA calendar frame (year + 0-indexed FRA month) via the SSA
 *  day-1-adjusted birth year + month, so FRA lands in the correct calendar
 *  month for every cohort (including FRA=67 where `fraMonths % 12 === 0`,
 *  which would zero the FRA-year share if ignored). `null` = unparseable /
 *  out-of-table birthdate → the caller skips the test. */
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

/** Float tolerance for the sequential charging loop and the per-month
 *  withheld/charged tests (keeps a Float64 residue from counting as an
 *  extra withheld month). */
const CHARGE_EPS = 1e-9;

/** The chargeable window + per-month check sizes for one member-year:
 *  entitled, testable months (entitlement start → December, never at/after
 *  the FRA month). With `monthlyBenefitDollars` the deductions charge
 *  each month's ACTUAL check (checks differ month to month when a spousal
 *  excess or survivor benefit activates midyear, or across the FRA-year
 *  rate switch); the uniform annual ÷ 12 (grace year: annual ÷
 *  entitled-count) scalar remains the fallback. */
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
    // Uniform scalar fallback. In the entitlement-start year the annual
    // gross covers only the entitled months (claim-year proration), so
    // divide by the entitled count; otherwise it is a full-year figure.
    const divisor = input.entitlementStartMonth0 !== undefined && count > 0 ? count : 12;
    const check = input.grossBenefitDollars / divisor;
    for (let m = from; m <= to; m += 1) checksByMonth[m] = check;
  }
  // Deductions can be charged only against the chargeable (entitled,
  // pre-FRA) months' checks — a FRA-year withholding never touches the
  // at/after-FRA checks, so the cap is the SUM OF CHARGEABLE CHECKS rather
  // than the whole-year gross. (Outside the FRA year the chargeable window
  // spans every entitled month, so the cap equals the gross benefit.)
  let capDollars = 0;
  for (let m = from; m <= to; m += 1) capDollars += checksByMonth[m];
  return { from, to, count, checksByMonth, capDollars };
}

/** Whole-check count the schedule actually charged (the ARF restoration
 *  input): every chargeable month with any dollars withheld counts — a
 *  partially withheld check is still a non-payment month, matching the
 *  prior `ceil(withheld / check)` convention for uniform checks. */
const monthsCharged = (withheldByMonth: readonly number[]): number =>
  withheldByMonth.reduce((n, w) => (w > CHARGE_EPS ? n + 1 : n), 0);

/** The annual ($1/$2 pre-FRA-year, $1/$3 FRA-year) test, capped by the
 *  chargeable checks. */
function annualTestFor(
  input: EarningsTestInput,
  isFraYear: boolean,
  fraMonth0: number,
  thresholds: { lowerThreshold: number; higherThreshold: number },
  capDollars: number,
): { withheld: number; rate: 'pre-fra-year' | 'fra-year' | 'none' } {
  if (!isFraYear) {
    // Pre-FRA year: lower exempt, $1 withheld per $2 over.
    const excess = Math.max(0, input.earnedIncomeDollars - thresholds.lowerThreshold);
    return { withheld: Math.min(capDollars, excess / 2), rate: excess > 0 ? 'pre-fra-year' : 'none' };
  }
  // FRA year: only earnings BEFORE the FRA month count; higher exempt
  // amount, $1 withheld per $3 over. Actual monthly earnings when supplied
  // (20 CFR 404.430); month-share proration of the annual figure otherwise.
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

/** Grace-year monthly non-service test (20 CFR 404.435): pay in full for any
 *  entitled pre-FRA month whose earnings are at/below 1/12 of the applicable
 *  annual exempt amount; withhold the whole check for a service month. Runs
 *  only in the caller-identified grace year (`graceYearMonthly`).
 *  Returns `null` when the monthly test cannot run this year. */
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
      // A service month withholds that month's ACTUAL check (a
      // zero-check service month withholds nothing and earns no ARF month).
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

/** The untested outcome: full benefit, every check paid. */
const noReductionResult = (gross: number, estimated: boolean): EarningsTestResult => ({
  withheldDollars: 0,
  reducedBenefitDollars: Math.max(0, gross),
  rateApplied: 'none',
  estimated,
  withheldMonths: 0,
  payFactorByMonth: fullPay(),
});

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
  // At or after FRA year-and-month entirely → no test.
  if (input.year > fra.fraYear) return noReduction(false);

  const thresholds = resolveEarningsTestThresholds(snapshot, input.year, input.inflationRatePct);
  const isFraYear = input.year === fra.fraYear;
  const frame = chargeableFrame(input, isFraYear, fra.fraMonth0);

  const annual = annualTestFor(input, isFraYear, fra.fraMonth0, thresholds, frame.capDollars);
  // Sequential-charging schedule (20 CFR 404.415/404.434): annual-test
  // withholding fills whole checks from the FIRST chargeable month forward,
  // each month's ACTUAL check size (checks may differ month to month).
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
  // The more favorable (smaller-withholding) test wins in the grace year.
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
