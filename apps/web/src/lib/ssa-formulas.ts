/**
 * Pure US Social Security retirement-benefit formulas, ported verbatim
 * from the legacy `apps/api/src/social-security/ssa-formulas.ts`.
 *
 * No DB or framework deps — easy to unit-test exhaustively. Covers own-
 * benefit (PIA × adjustmentFactor), spousal-benefit reduction schedule,
 * and the SSA first-day-of-month birth-month rule. Survivor logic lives
 * in ss-spousal-survivor.ts. GPO/WEP, the earnings test, and COLA are out
 * of scope for this file: the earnings test lives in ss-earnings-test.ts and
 * the yearly COLA compounding in ss-projection.ts.
 *
 * See `docs/math-social-security-and-health.md` for how the claiming age changes the benefit.
 */

export class InvalidBirthYearError extends Error {
  constructor(public readonly year: number) {
    super(`Birth year ${year} is outside the supported FRA table (must be >= 1943).`);
    this.name = 'InvalidBirthYearError';
  }
}

/**
 * SSA first-day-of-month birth rule (POMS GN 00302.400): a person born
 * on the 1st of any month attains an age in the prior month, so the SSA
 * treats them as born in the preceding month for benefit-entitlement
 * purposes. Special case: January 1 → the prior year's December, which
 * means they're treated as born in the *prior year*.
 *
 * Returns the calendar year that determines the member's FRA cohort.
 */
export function birthYearForBenefitPurposes(isoBirthdate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoBirthdate);
  if (!match) throw new Error(`Invalid ISO birthdate: ${isoBirthdate}`);
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-based
  const day = Number(match[3]);
  // Day 1 of January → prior year's December → treat as prior year.
  if (day === 1 && month === 1) return year - 1;
  return year;
}

/**
 * Returns the zero-indexed benefit month (0 = January … 11 = December)
 * applying the SSA first-day-of-month rule (POMS GN 00302.400).
 * Born on the 1st → treated as born the previous month.
 */
export function birthMonthForBenefitPurposes(isoBirthdate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoBirthdate);
  if (!match) throw new Error(`Invalid ISO birthdate: ${isoBirthdate}`);
  const month = Number(match[2]); // 1-based
  const day = Number(match[3]);
  if (day === 1) {
    // Shift back one month (January → December of prior year, same
    // zero-indexed result: Jan=0 → Dec=11).
    return (month - 2 + 12) % 12;
  }
  return month - 1; // convert to zero-indexed
}

/**
 * FRA in total months, derived directly from an ISO birthdate string.
 * Applies the SSA first-day-of-month rule via `birthYearForBenefitPurposes`.
 * Throws `InvalidBirthYearError` when the derived birth year < 1943.
 */
export function fraMonthsForBirthdate(isoBirthdate: string): number {
  const year = birthYearForBenefitPurposes(isoBirthdate);
  return fraMonthsForBirthYear(year);
}

/**
 * Spousal-benefit adjustment factor applied to 50% of the worker's PIA
 * (POMS RS 00615.201 + RS 00615.015).
 *
 * - At or above FRA → factor 1.0 (no delayed-retirement credits transfer).
 * - Below FRA → reduction: 25/36 of 1% per month for the first 36 months
 *   early; 5/12 of 1% per month for each additional month beyond that.
 *   (At age 62 with FRA = 67: 25/36% × 36 + 5/12% × 24 = 25% + 10% = 35%
 *   reduction → factor 0.65.)
 *
 * @param fraMonths - recipient's own FRA in total months
 * @param claimAgeMonths - recipient's chosen claim age in total months
 */
export function spousalAdjustmentFactor(fraMonths: number, claimAgeMonths: number): number {
  if (claimAgeMonths >= fraMonths) return 1;
  const monthsEarly = fraMonths - claimAgeMonths;
  const firstBlock = Math.min(monthsEarly, 36);
  const secondBlock = Math.max(0, monthsEarly - 36);
  return 1 - firstBlock * (25 / 3600) - secondBlock * (5 / 1200);
}

const FRA_TABLE: Record<number, number> = {
  1955: 66 * 12 + 2,
  1956: 66 * 12 + 4,
  1957: 66 * 12 + 6,
  1958: 66 * 12 + 8,
  1959: 66 * 12 + 10,
};

export function fraMonthsForBirthYear(year: number): number {
  if (year < 1943) throw new InvalidBirthYearError(year);
  if (year <= 1954) return 66 * 12;
  if (year >= 1960) return 67 * 12;
  return FRA_TABLE[year];
}

/**
 * Widow(er) (survivor) FRA in total months (POMS RS 00615.003 / 42 USC
 * 416(g)). The survivor FRA cohort table is DISTINCT from the retirement
 * FRA table: it is the retirement schedule shifted two BIRTH-COHORT years
 * later, so a 1943–1961 cohort's survivor FRA is up to 4 MONTHS earlier
 * in age than their retirement FRA (e.g. born 1958 → retirement FRA 66y8m
 * but survivor FRA 66y4m; any "two years" in SSA's cohort documentation
 * is that cohort-boundary shift, never a two-year age gap). The two
 * schedules converge at 67 for births in 1962 and later.
 *
 * Supported cohorts mirror the retirement table's floor: birth years
 * before 1943 throw `InvalidBirthYearError` (the app's FRA support floor —
 * such a member already fails every other benefit derivation).
 */
export function survivorFraMonthsForBirthYear(year: number): number {
  if (year < 1943) throw new InvalidBirthYearError(year);
  // Statutory widow(er) schedule: 1940→65y2m … 1944→65y10m; 1945–1956→66;
  // 1957–1961 graduated; ≥1962→67. Equivalent to the retirement schedule
  // evaluated two cohort years earlier.
  if (year <= 1944) return 65 * 12 + (year - 1939) * 2;
  if (year <= 1956) return 66 * 12;
  if (year >= 1962) return 67 * 12;
  return 66 * 12 + (year - 1956) * 2;
}

/**
 * Survivor (widow[er]) FRA in total months from an ISO birthdate, applying
 * the SSA first-day-of-month rule via `birthYearForBenefitPurposes`.
 * Throws `InvalidBirthYearError` when the derived birth year < 1943.
 */
export function survivorFraMonthsForBirthdate(isoBirthdate: string): number {
  const year = birthYearForBenefitPurposes(isoBirthdate);
  return survivorFraMonthsForBirthYear(year);
}

const MAX_DRC_MONTHS = 70 * 12;

/**
 * Multiplier applied to PIA to get the monthly benefit at the chosen claim
 * age. 1.0 at FRA, < 1 if claimed earlier (down to ~0.70 at 62 for FRA=67),
 * > 1 if claimed later (up to ~1.24 at 70 for FRA=67). Delayed credits stop
 * accruing past age 70 — claim ages above that clamp.
 */
export function adjustmentFactor(fraMonths: number, claimAgeMonths: number): number {
  const claim = Math.min(claimAgeMonths, MAX_DRC_MONTHS);
  if (claim === fraMonths) return 1;
  if (claim < fraMonths) {
    const monthsEarly = fraMonths - claim;
    const firstBlock = Math.min(monthsEarly, 36);
    const secondBlock = Math.max(0, monthsEarly - 36);
    return 1 - firstBlock * (5 / 900) - secondBlock * (5 / 1200);
  }
  return 1 + (claim - fraMonths) * (2 / 300);
}

/**
 * Survivor (widow[er]) early-claim reduction factor.
 *
 * A surviving spouse claiming a survivor benefit before their own FRA
 * takes a sliding-scale reduction: 0% at survivor FRA down to a maximum
 * 28.5% at survivor age 60 (factor 0.715). The reduction is linear in
 * the months between age 60 and the survivor's FRA (42 USC 402(e)/(f);
 * SSA POMS RS 00615.301 / GN 00204.030).
 *
 * factor(a) = 1 − 0.285 × (FRA − a) / (FRA − 60) for 60 ≤ a ≤ FRA.
 *
 * - At or above survivor FRA → 1.0 (no reduction; survivor DRCs do not
 *   accrue, so claiming past FRA does not raise the factor).
 * - At survivor age 60 → 0.715 (full 28.5% reduction).
 * - Below age 60 → clamped to the age-60 factor (survivor benefits are
 *   not payable before 60; the floor keeps the factor well-defined).
 *
 * @param survivorClaimAgeMonths - survivor's age when claiming, in months
 * @param survivorFraMonths - survivor's own FRA in total months
 */
export function survivorEarlyFactor(
  survivorClaimAgeMonths: number,
  survivorFraMonths: number,
): number {
  if (survivorClaimAgeMonths >= survivorFraMonths) return 1;
  const age60Months = 60 * 12;
  const claim = Math.max(survivorClaimAgeMonths, age60Months);
  const span = survivorFraMonths - age60Months;
  if (span <= 0) return 1;
  const monthsEarly = survivorFraMonths - claim;
  return 1 - 0.285 * (monthsEarly / span);
}

/**
 * Monthly benefit in dollars (rounded to cents) at the requested claim age.
 */
export function monthlyBenefitAtAge(
  pia: number,
  fraMonths: number,
  claimAgeMonths: number,
): number {
  const raw = pia * adjustmentFactor(fraMonths, claimAgeMonths);
  return Math.round(raw * 100) / 100;
}

export const REFERENCE_AGE_MONTHS = {
  AT_62: 62 * 12,
  AT_70: 70 * 12,
} as const;
