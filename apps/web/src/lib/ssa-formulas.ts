/**
 * Pure Social Security retirement-benefit formulas: own benefit (PIA × adjustment factor), spousal reduction
 * and the SSA first-day-of-month birth rule. Survivor logic, the earnings test and COLA live elsewhere; see docs/math-social-security-and-health.md, "Claiming-age adjustments".
 */

export class InvalidBirthYearError extends Error {
  constructor(public readonly year: number) {
    super(`Birth year ${year} is outside the supported FRA table (must be >= 1943).`);
    this.name = 'InvalidBirthYearError';
  }
}

/**
 * SSA first-day-of-month rule (POMS GN 00302.400): a person born on the 1st is treated as born in the
 * prior month, so January 1 counts as the prior year. Returns the year that sets the FRA cohort.
 */
export function birthYearForBenefitPurposes(isoBirthdate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoBirthdate);
  if (!match) throw new Error(`Invalid ISO birthdate: ${isoBirthdate}`);
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-based
  const day = Number(match[3]);
  if (day === 1 && month === 1) return year - 1;
  return year;
}

/** Zero-indexed benefit month (0 = January) under the first-day-of-month rule (POMS GN 00302.400). */
export function birthMonthForBenefitPurposes(isoBirthdate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoBirthdate);
  if (!match) throw new Error(`Invalid ISO birthdate: ${isoBirthdate}`);
  const month = Number(match[2]); // 1-based
  const day = Number(match[3]);
  if (day === 1) {
    return (month - 2 + 12) % 12;
  }
  return month - 1; // convert to zero-indexed
}

/** FRA in total months from an ISO birthdate; throws `InvalidBirthYearError` for a birth year before 1943. */
export function fraMonthsForBirthdate(isoBirthdate: string): number {
  const year = birthYearForBenefitPurposes(isoBirthdate);
  return fraMonthsForBirthYear(year);
}

/**
 * Spousal adjustment factor on 50% of the worker's PIA (POMS RS 00615.201, RS 00615.015): 1.0 at or above
 * FRA, else reduced 25/36 of 1% per month for the first 36 months early and 5/12 of 1% after (age 62 with
 * FRA 67 is a 35% reduction, factor 0.65).
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
 * Widow(er) FRA in total months (POMS RS 00615.003, 42 USC 416(g)). The survivor cohort table is the
 * retirement schedule shifted two birth-cohort years, so survivor FRA is up to 4 months earlier (born 1958:
 * retirement 66y8m, survivor 66y4m); the two converge at 67 for births from 1962. Throws
 * `InvalidBirthYearError` before 1943.
 */
export function survivorFraMonthsForBirthYear(year: number): number {
  if (year < 1943) throw new InvalidBirthYearError(year);
  // Statutory widow(er) schedule: 1940→65y2m … 1944→65y10m; 1945–1956→66; 1957–1961 graduated; ≥1962→67.
  if (year <= 1944) return 65 * 12 + (year - 1939) * 2;
  if (year <= 1956) return 66 * 12;
  if (year >= 1962) return 67 * 12;
  return 66 * 12 + (year - 1956) * 2;
}

/** Survivor FRA in total months from an ISO birthdate; throws `InvalidBirthYearError` before 1943. */
export function survivorFraMonthsForBirthdate(isoBirthdate: string): number {
  const year = birthYearForBenefitPurposes(isoBirthdate);
  return survivorFraMonthsForBirthYear(year);
}

const MAX_DRC_MONTHS = 70 * 12;

/**
 * Multiplier on PIA at the claim age: 1.0 at FRA, below 1 earlier (about 0.70 at 62 for FRA 67), above 1
 * later (about 1.24 at 70). Delayed credits stop at 70, so later ages clamp.
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
 * Survivor early-claim reduction (42 USC 402(e)/(f); POMS RS 00615.301, GN 00204.030):
 * `1 − 0.285 × (FRA − a) / (FRA − 60)`, linear from 1.0 at survivor FRA to 0.715 at age 60. Survivor
 * DRCs do not accrue, and ages below 60 clamp to the age-60 factor.
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

/** Monthly benefit in dollars, rounded to cents, at the claim age. */
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
