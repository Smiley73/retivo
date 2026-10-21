/**
 * The part of the ACA premium tax credit that lowers a year's portfolio draw
 * because the household entered the premium as a Medical expense. Shared by the
 * deterministic funding solver and the Monte Carlo per-path tax so the two
 * engines compute it identically (explained in
 * docs/math-social-security-and-health.md, "How it reaches the numbers").
 */

/** Inputs to {@link creditAppliedToPremiumsCents}, all in integer cents. */
interface CreditAppliedToPremiumsArgs {
  /** The year's premium tax credit. */
  readonly creditCents: number;
  /** The part of the credit already used against federal tax and the IRMAA
   *  cash need (the engine passes its own figure, so the deterministic engine's
   *  cash-only IRMAA and the stress test's whole surcharge stay where they are). */
  readonly offsetCents: number;
  /** Medical expenses modeled for the year (every `isMedical` row). */
  readonly medicalCents: number;
  /** The draw the engine would otherwise commit this year. */
  readonly remainingNeedCents: number;
}

/**
 * `min(max(0, credit − offset), medical, remainingNeed)`, floored at zero. The
 * model has no surplus deposit, so a year with no draw has nothing to lower and
 * the rest of the credit is dropped.
 */
export function creditAppliedToPremiumsCents(args: CreditAppliedToPremiumsArgs): number {
  const excessCents = Math.max(0, args.creditCents - args.offsetCents);
  return Math.max(0, Math.min(excessCents, args.medicalCents, args.remainingNeedCents));
}

/**
 * One retirement year's total of a monthly cents series anchored at
 * (retirementYear, January): the twelve months of year index `yearIndex`.
 */
export function sumYearCents(monthlyCents: ReadonlyArray<number>, yearIndex: number): number {
  let total = 0;
  for (let m = 0; m < 12; m += 1) total += monthlyCents[yearIndex * 12 + m] ?? 0;
  return total;
}
