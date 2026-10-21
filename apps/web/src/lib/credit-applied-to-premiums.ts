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
  /** How far the draw's MAGI can fall before it reaches the poverty line (see
   *  {@link aboveFplFloorCents}). Absent → no limit; the deterministic solver
   *  instead checks the line against the draw it commits. */
  readonly floorHeadroomCents?: number;
}

/**
 * `min(max(0, credit − offset), medical, remainingNeed)`, floored at zero, and
 * no more than `floorHeadroomCents` when given. The model has no surplus
 * deposit, so a year with no draw has nothing to lower and the rest of the
 * credit is dropped.
 */
export function creditAppliedToPremiumsCents(args: CreditAppliedToPremiumsArgs): number {
  const excessCents = Math.max(0, args.creditCents - args.offsetCents);
  const limitCents = Math.min(excessCents, args.medicalCents, args.remainingNeedCents);
  return Math.max(
    0,
    args.floorHeadroomCents === undefined ? limitCents : Math.min(limitCents, args.floorHeadroomCents),
  );
}

/** A year's tax result, as {@link aboveFplFloorCents} reads it (integer cents). */
interface FplFloorArgs {
  readonly magiCents: number;
  readonly taxableSsCents: number;
  readonly fplPercentage: number;
  /** The year's gross Social Security, whose untaxed part ACA MAGI adds back. */
  readonly grossSsCents: number;
}

/**
 * How many cents of ACA MAGI sit above the 100% poverty line. The ratio of ACA
 * MAGI to the line is the same before and after the engine deflates MAGI, so
 * the figure is in projection-year dollars. A draw lowered by this much or less
 * cannot leave the household under the line, where the credit is zero: lowering
 * the draw lowers ACA MAGI by at most the same amount, because ACA MAGI adds
 * back all Social Security and counts a dollar of draw at most once. Zero below
 * the line, where no credit is earned.
 */
export function aboveFplFloorCents(args: FplFloorArgs): number {
  if (!(args.fplPercentage >= 100)) return 0;
  const acaMagiCents =
    args.magiCents + Math.max(0, args.grossSsCents - args.taxableSsCents);
  return Math.max(0, Math.floor(acaMagiCents * (1 - 100 / args.fplPercentage)));
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

/**
 * A year's draw need on a monthly series: the sum over the months
 * `[start, end)` of `max(0, expense − income)`. This is the draw the year makes
 * before any tax is folded in, and the cap on the credit applied to premiums.
 */
export function sumPositiveNeed(
  expense: ArrayLike<number>,
  income: ArrayLike<number>,
  start: number,
  end: number,
): number {
  let need = 0;
  for (let i = start; i < end; i += 1) need += Math.max(0, expense[i] - income[i]);
  return need;
}

/**
 * Fold one year's tax draw (`drawDollars`) into the monthly `expense` series
 * over the months `[start, end)`. A positive draw is spread evenly over twelve
 * months. A negative draw (the credit applied to premiums outweighing the tax
 * need) is spread in proportion to each month's need, `max(0, expense − income)`,
 * so no month's draw drops below zero and the year's draw falls by the whole
 * amount; an even split would lose the share of any month whose need is smaller.
 * A year with no need falls back to the even split.
 */
export function foldYearDrawIntoExpense(
  expense: Float64Array,
  income: ArrayLike<number>,
  start: number,
  end: number,
  drawDollars: number,
): void {
  const need = drawDollars < 0 ? sumPositiveNeed(expense, income, start, end) : 0;
  for (let i = start; i < end; i += 1) {
    expense[i] +=
      need > 0 ? (drawDollars * Math.max(0, expense[i] - income[i])) / need : drawDollars / 12;
  }
}
