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
  /** The most the draw can fall before the household leaves the credit's range
   *  (see {@link povertyLineLimitCents}). Absent → no limit. */
  readonly povertyLineLimitCents?: number;
}

/**
 * `min(max(0, credit − offset), medical, remainingNeed)`, floored at zero, and
 * no more than `povertyLineLimitCents` when given. The model has no surplus
 * deposit, so a year with no draw has nothing to lower and the rest of the
 * credit is dropped.
 */
export function creditAppliedToPremiumsCents(args: CreditAppliedToPremiumsArgs): number {
  const excessCents = Math.max(0, args.creditCents - args.offsetCents);
  const limitCents = Math.min(
    excessCents,
    args.medicalCents,
    args.remainingNeedCents,
    args.povertyLineLimitCents ?? Number.POSITIVE_INFINITY,
  );
  return Math.max(0, limitCents);
}

/** Inputs to {@link povertyLineLimitCents}, in integer cents. */
interface PovertyLineLimitArgs {
  /** ACA MAGI above the poverty line at the draw the credit was priced on
   *  (`TaxYearResult.acaMagiAboveFplCents`). */
  readonly headroomCents: number;
  /** The part of that draw taken from accounts whose withdrawals are income:
   *  pre-tax and taxable-account withdrawals, plus the taxable Roth earnings.
   *  Qualified Roth and cash-like dollars are not (see {@link drawIncomeCents}). */
  readonly incomeDrawCents: number;
  /** How much ACA MAGI that income draw carries: all of a pre-tax withdrawal or of
   *  Roth earnings, but only the gain in a taxable-account one. */
  readonly magiOfDrawCents: number;
}

/**
 * The most the draw can be lowered by, so that the lowered draw still earns the
 * credit it was priced on. The credit is zero below 100% of the poverty line, and
 * a line the household does not earn at the draw it lowers would create money.
 * Above the line the credit only grows as MAGI falls, so a line priced at the
 * higher draw never overstates the credit at the lower one.
 *
 * Lowering the draw by L lowers ACA MAGI by at most `L × magiOfDraw / incomeDraw`:
 * ACA MAGI adds back all Social Security, so a dollar of draw counts once, a dollar
 * that is not income (a qualified Roth or cash-like withdrawal) does not count at
 * all, and a taxable-account dollar counts as its gain. So the draw can fall by the
 * whole income draw when the headroom covers its MAGI, and by the headroom scaled
 * back by that MAGI per dollar otherwise. Both engines price the credit on the draw
 * before the line and apply this one limit to it.
 */
export function povertyLineLimitCents(args: PovertyLineLimitArgs): number {
  if (args.magiOfDrawCents <= args.headroomCents) return Number.POSITIVE_INFINITY;
  return Math.floor((Math.max(0, args.headroomCents) * args.incomeDrawCents) / args.magiOfDrawCents);
}

/** Dollars of one year's draw, by what they do to ACA MAGI. */
interface DrawIncomeArgs {
  readonly preTaxDollars: number;
  readonly taxableAccountDollars: number;
  /** The taxable earnings of a nonqualified Roth draw. */
  readonly rothEarningsDollars: number;
  /** The share of a taxable-account withdrawal that is basis, which is not income. */
  readonly costBasisFraction: number;
}

/** The income draw and the ACA MAGI it carries, in integer cents, for
 *  {@link povertyLineLimitCents}. */
export function drawIncomeCents(
  args: DrawIncomeArgs,
): Pick<PovertyLineLimitArgs, 'incomeDrawCents' | 'magiOfDrawCents'> {
  const toCents = (dollars: number): number => Math.round(dollars * 100);
  const wholeCents = toCents(args.preTaxDollars + args.rothEarningsDollars);
  const taxableCents = toCents(args.taxableAccountDollars);
  return {
    incomeDrawCents: wholeCents + taxableCents,
    magiOfDrawCents: wholeCents + Math.round(taxableCents * (1 - args.costBasisFraction)),
  };
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
