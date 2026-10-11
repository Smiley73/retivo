import { describe, expect, it } from 'vitest';
import {
  SAFE_WITHDRAWAL_RATE_BENGEN_PCT,
  SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT,
  computeSafeWithdrawalRuleComparison,
  computeSafeWithdrawalRuleFigures,
} from './safe-withdrawal-rate';

describe('computeSafeWithdrawalRuleFigures', () => {
  it('computes the implied first-year spend as ratePct/100 × portfolio', () => {
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years: [2030],
      plannedFirstYearAnnualSpend: 0,
      ratePct: 4,
    });
    expect(figures.impliedFirstYearAnnualSpend).toBe(40_000);
  });

  it('exactly 0.045 of the portfolio at the 4.5% rate (not just > the 4% figure)', () => {
    // A test that only asserted 4% < 4.5% would pass on a wrong rate.
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years: [2030],
      plannedFirstYearAnnualSpend: 0,
      ratePct: SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT,
    });
    expect(figures.impliedFirstYearAnnualSpend).toBe(45_000);
  });

  it('holds the line value flat across the first, a middle, and the last year', () => {
    // A test that read only the first year would not catch a per-year
    // inflation step accidentally applied to the rule line.
    const years = [2030, 2031, 2032, 2033, 2034];
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years,
      plannedFirstYearAnnualSpend: 0,
      ratePct: 4,
    });
    expect(figures.lineValuesByYear.map((v) => v.value)).toEqual([
      40_000, 40_000, 40_000, 40_000, 40_000,
    ]);
    expect(figures.lineValuesByYear.map((v) => v.year)).toEqual(years);
  });

  it('signs the delta positive when the plan spends more than the rule allows', () => {
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years: [2030],
      plannedFirstYearAnnualSpend: 50_000,
      ratePct: 4,
    });
    expect(figures.plannedMinusRuleFirstYearDelta).toBe(10_000);
  });

  it('signs the delta negative when the plan spends less than the rule allows', () => {
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years: [2030],
      plannedFirstYearAnnualSpend: 30_000,
      ratePct: 4,
    });
    expect(figures.plannedMinusRuleFirstYearDelta).toBe(-10_000);
  });

  it('returns no line values for an empty year range', () => {
    const figures = computeSafeWithdrawalRuleFigures({
      portfolioAtRetirement: 1_000_000,
      years: [],
      plannedFirstYearAnnualSpend: 0,
      ratePct: 4,
    });
    expect(figures.lineValuesByYear).toEqual([]);
  });
});

describe('computeSafeWithdrawalRuleComparison', () => {
  it('computes both rules off the same portfolio and planned spend', () => {
    const comparison = computeSafeWithdrawalRuleComparison({
      portfolioAtRetirement: 1_000_000,
      years: [2030, 2031],
      plannedFirstYearAnnualSpend: 42_000,
    });
    expect(comparison.fourPercentRule.ratePct).toBe(SAFE_WITHDRAWAL_RATE_BENGEN_PCT);
    expect(comparison.fourPercentRule.impliedFirstYearAnnualSpend).toBe(40_000);
    expect(comparison.fourPercentRule.plannedMinusRuleFirstYearDelta).toBe(2_000);
    expect(comparison.fourPointFivePercentRule.ratePct).toBe(
      SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT,
    );
    expect(comparison.fourPointFivePercentRule.impliedFirstYearAnnualSpend).toBe(45_000);
    expect(comparison.fourPointFivePercentRule.plannedMinusRuleFirstYearDelta).toBe(-3_000);
  });
});
