import { describe, expect, it } from 'vitest';
import { computeSafeWithdrawalRuleComparison } from './safe-withdrawal-rate';

const compare = (plannedFirstYearAnnualSpend: number, years: number[] = [2030]) =>
  computeSafeWithdrawalRuleComparison({
    portfolioAtRetirement: 1_000_000,
    years,
    plannedFirstYearAnnualSpend,
  });

describe('computeSafeWithdrawalRuleComparison', () => {
  // A test that only asserted 4% < 4.5% would pass on a wrong rate.
  it('implies exactly 4% and 4.5% of the portfolio as first-year spend', () => {
    const { fourPercentRule, fourPointFivePercentRule } = compare(0);
    expect(fourPercentRule.ratePct).toBe(4);
    expect(fourPercentRule.impliedFirstYearAnnualSpend).toBe(40_000);
    expect(fourPointFivePercentRule.ratePct).toBe(4.5);
    expect(fourPointFivePercentRule.impliedFirstYearAnnualSpend).toBe(45_000);
  });

  // Reading only the first year would not catch a per-year inflation step wrongly applied to the rule line.
  it('holds each rule line flat across every requested year', () => {
    const years = [2030, 2031, 2032, 2033, 2034];
    const { fourPercentRule, fourPointFivePercentRule } = compare(0, years);
    expect(fourPercentRule.lineValuesByYear.map((v) => v.value)).toEqual(Array(5).fill(40_000));
    expect(fourPointFivePercentRule.lineValuesByYear.map((v) => v.value)).toEqual(
      Array(5).fill(45_000),
    );
    expect(fourPercentRule.lineValuesByYear.map((v) => v.year)).toEqual(years);
  });

  it('returns no line values for an empty year range', () => {
    const { fourPercentRule, fourPointFivePercentRule } = compare(0, []);
    expect(fourPercentRule.lineValuesByYear).toEqual([]);
    expect(fourPointFivePercentRule.lineValuesByYear).toEqual([]);
  });

  it('signs the delta positive when the plan spends more than the rule allows and negative when less', () => {
    expect(compare(50_000).fourPercentRule.plannedMinusRuleFirstYearDelta).toBe(10_000);
    expect(compare(42_000).fourPercentRule.plannedMinusRuleFirstYearDelta).toBe(2_000);
    expect(compare(42_000).fourPointFivePercentRule.plannedMinusRuleFirstYearDelta).toBe(-3_000);
    expect(compare(30_000).fourPercentRule.plannedMinusRuleFirstYearDelta).toBe(-10_000);
  });
});
