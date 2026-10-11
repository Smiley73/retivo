/**
 * Safe-withdrawal-rate (4% / 4.5% rule) arithmetic — pure, engine- and
 * UI-independent.
 *
 * Given one at-retirement portfolio total (already in today's dollars — this
 * module does no deflation of its own) and a year range, this returns each
 * rule's implied first-year annual spend, its per-year line value, and its
 * signed delta against a caller-supplied planned first-year spend figure.
 *
 * The rule holds its FIRST-YEAR implied spend
 * flat in REAL terms at every later year — there is no per-year inflation
 * step to apply, since every dollar figure on the page is already real. Each
 * rule's `lineValuesByYear` is therefore the same number repeated once per
 * requested year, never a function of the year itself. Callers that plot the
 * series (the chart) get one point per year for free.
 *
 * `lib/` may not import `components/` or `pages/` (`.dependency-cruiser.cjs`
 * → `lib-independent-of-ui`), so this module takes plain numbers, never a
 * view model. Only the page-local hook that calls this reads the view model.
 *
 * No React, no data access, no formatting — callers own presentation.
 */

/**
 * Bengen's original 1994 safe-withdrawal-rate finding (Bengen, W.P.,
 * "Determining Withdrawal Rates Using Historical Data," Journal of Financial
 * Planning, 1994): an inflation-adjusted initial withdrawal of 4% of the
 * at-retirement portfolio survived every rolling 30-year period in his
 * historical study. Corroborated by the Trinity study (Cooley, Hubbard &
 * Walz, "Retirement Savings: Choosing a Withdrawal Rate That Is Sustainable,"
 * AAII Journal, 1998).
 */
export const SAFE_WITHDRAWAL_RATE_BENGEN_PCT = 4;

/**
 * Bengen's own later refinement of the 4% finding, raising the safe initial
 * withdrawal rate to 4.5% under a broader (more equity-heavy) asset mix than
 * the 1994 study's baseline allocation.
 */
export const SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT = 4.5;

/** One rule's line value at one year — constant across every year. */
interface SafeWithdrawalRuleYearValue {
  readonly year: number;
  readonly value: number;
}

/** One rule's (4% or 4.5%) figures against a given portfolio and plan. */
export interface SafeWithdrawalRuleFigures {
  /** The rule's rate, as a percent (4 or 4.5) — for display, not a fraction. */
  readonly ratePct: number;
  /** `ratePct/100 × portfolioAtRetirement`, today's dollars. */
  readonly impliedFirstYearAnnualSpend: number;
  /** One entry per requested year, every `value` equal to
   *  `impliedFirstYearAnnualSpend` (flat in real terms). */
  readonly lineValuesByYear: ReadonlyArray<SafeWithdrawalRuleYearValue>;
  /** `plannedFirstYearAnnualSpend − impliedFirstYearAnnualSpend` at the first
   *  requested year. Positive ⇒ the plan spends MORE than this rule allows;
   *  negative ⇒ the plan spends less. Named so the sign cannot be
   *  misread by a caller. */
  readonly plannedMinusRuleFirstYearDelta: number;
}

/** Both rules' figures, computed against the same portfolio and plan. */
export interface SafeWithdrawalRuleComparison {
  readonly fourPercentRule: SafeWithdrawalRuleFigures;
  readonly fourPointFivePercentRule: SafeWithdrawalRuleFigures;
}

/** Compute one rule's figures. */
export function computeSafeWithdrawalRuleFigures(params: {
  /** At-retirement portfolio total, today's dollars. */
  readonly portfolioAtRetirement: number;
  /** Years to emit a line value for, any order — each maps to the same
   *  constant value. */
  readonly years: ReadonlyArray<number>;
  /** The plan's own first-year annual spend, today's dollars. */
  readonly plannedFirstYearAnnualSpend: number;
  /** The rule's rate, as a percent (e.g. 4 or 4.5). */
  readonly ratePct: number;
}): SafeWithdrawalRuleFigures {
  const { portfolioAtRetirement, years, plannedFirstYearAnnualSpend, ratePct } = params;
  const impliedFirstYearAnnualSpend = (ratePct / 100) * portfolioAtRetirement;
  return {
    ratePct,
    impliedFirstYearAnnualSpend,
    lineValuesByYear: years.map((year) => ({ year, value: impliedFirstYearAnnualSpend })),
    plannedMinusRuleFirstYearDelta:
      plannedFirstYearAnnualSpend - impliedFirstYearAnnualSpend,
  };
}

/** Compute both the 4% and 4.5% rules' figures against the same basis. */
export function computeSafeWithdrawalRuleComparison(params: {
  readonly portfolioAtRetirement: number;
  readonly years: ReadonlyArray<number>;
  readonly plannedFirstYearAnnualSpend: number;
}): SafeWithdrawalRuleComparison {
  return {
    fourPercentRule: computeSafeWithdrawalRuleFigures({
      ...params,
      ratePct: SAFE_WITHDRAWAL_RATE_BENGEN_PCT,
    }),
    fourPointFivePercentRule: computeSafeWithdrawalRuleFigures({
      ...params,
      ratePct: SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT,
    }),
  };
}
