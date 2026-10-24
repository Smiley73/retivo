// The ACA premium tax credit that lowers a year's portfolio draw (the premium is a Medical expense), shared by both
// engines; see docs/math-social-security-and-health.md, "How it reaches the numbers".

interface CreditAppliedToPremiumsArgs {
  readonly creditCents: number;
  readonly offsetCents: number;
  readonly medicalCents: number;
  readonly remainingNeedCents: number;
  /** Absent: no limit. */
  readonly povertyLineLimitCents?: number;
}

/** `min(max(0, credit − offset), medical, remainingNeed, povertyLineLimit)`, floored at zero; the model has no surplus deposit, so the rest of the credit is dropped. */
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

interface PovertyLineLimitArgs {
  readonly headroomCents: number;
  readonly incomeDrawCents: number;
  readonly magiOfDrawCents: number;
}

/**
 * The most the draw can fall and still earn the credit it was priced on: the
 * credit is zero below 100% of the poverty line (§36B(c)(1)), and above it only
 * grows as MAGI falls. Lowering the draw by L sheds at most
 * `L × magiOfDraw / incomeDraw` of ACA MAGI, so the limit is the headroom scaled
 * by that ratio, or no limit when the headroom covers the whole income draw.
 */
export function povertyLineLimitCents(args: PovertyLineLimitArgs): number {
  if (args.magiOfDrawCents <= args.headroomCents) return Number.POSITIVE_INFINITY;
  return Math.floor((Math.max(0, args.headroomCents) * args.incomeDrawCents) / args.magiOfDrawCents);
}

interface DrawIncomeArgs {
  readonly preTaxDollars: number;
  readonly taxableAccountDollars: number;
  readonly rothEarningsDollars: number;
  readonly costBasisFraction: number;
}

/** The income draw and the ACA MAGI it carries, for `povertyLineLimitCents`. */
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

/** One retirement year's total (twelve months from `yearIndex`) of a monthly cents series anchored at (retirementYear, January). */
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
 * Fold one year's tax draw into the monthly `expense` series over `[start, end)`.
 * A positive draw is spread evenly; a negative one (the credit applied to premiums)
 * in proportion to each month's need, so no month drops below zero and the year's
 * draw falls by the whole amount. A year with no need takes the even split.
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
