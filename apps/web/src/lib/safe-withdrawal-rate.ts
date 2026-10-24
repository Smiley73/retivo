// Safe-withdrawal-rate (4% / 4.5% rule) arithmetic over plain numbers, since `lib/` may not import view models
// (`lib-independent-of-ui`). The at-retirement portfolio is already in today's dollars; each rule's first-year spend is held flat in real terms.

/** Bengen's 1994 finding: an inflation-adjusted 4% initial withdrawal survived every rolling 30-year period (Journal of Financial Planning), corroborated by the Trinity study. */
const SAFE_WITHDRAWAL_RATE_BENGEN_PCT = 4;

/** Bengen's later refinement: 4.5% under a more equity-heavy mix than the 1994 baseline. */
const SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT = 4.5;

interface SafeWithdrawalRuleYearValue {
  readonly year: number;
  readonly value: number;
}

export interface SafeWithdrawalRuleFigures {
  /** As a percent (4 or 4.5), not a fraction. */
  readonly ratePct: number;
  readonly impliedFirstYearAnnualSpend: number;
  /** One entry per requested year, every `value` equal to `impliedFirstYearAnnualSpend`. */
  readonly lineValuesByYear: ReadonlyArray<SafeWithdrawalRuleYearValue>;
  /** `planned − implied` at the first year: positive means the plan spends more than the rule allows. */
  readonly plannedMinusRuleFirstYearDelta: number;
}

export interface SafeWithdrawalRuleComparison {
  readonly fourPercentRule: SafeWithdrawalRuleFigures;
  readonly fourPointFivePercentRule: SafeWithdrawalRuleFigures;
}

function computeSafeWithdrawalRuleFigures(params: {
  readonly portfolioAtRetirement: number;
  /** Any order; each maps to the same value. */
  readonly years: ReadonlyArray<number>;
  readonly plannedFirstYearAnnualSpend: number;
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
