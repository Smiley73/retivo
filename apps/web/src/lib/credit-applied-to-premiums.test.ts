/**
 * The three-way minimum behind the credit applied to premiums. Each case is a
 * row of the worked 2026 household in docs/math-social-security-and-health.md
 * (single filer, $31,300 of Social Security, $7,200 benchmark): the credit is
 * $5,134.20 with nothing to offset, and each of the three limits binds in at
 * least one row.
 */
import { describe, expect, it } from 'vitest';
import { creditAppliedToPremiumsCents, sumYearCents } from './credit-applied-to-premiums';

describe('creditAppliedToPremiumsCents', () => {
  it.each([
    // [label, credit, offset, medical, remaining need, expected line] (cents)
    ['A: the excess binds', 513_420, 0, 720_000, 3_990_000, 513_420],
    ['B: the draw binds', 513_420, 0, 720_000, 270_000, 270_000],
    ['C: nothing to lower', 513_420, 0, 720_000, 0, 0],
    ['D: the Medical expenses bind', 513_420, 0, 300_000, 1_170_000, 300_000],
    ['E: federal tax uses part of the credit first', 209_052, 98_025, 720_000, 870_000, 111_027],
  ])('%s', (_label, creditCents, offsetCents, medicalCents, remainingNeedCents, expected) => {
    expect(
      creditAppliedToPremiumsCents({ creditCents, offsetCents, medicalCents, remainingNeedCents }),
    ).toBe(expected);
  });

  it('is zero when the offset already used the whole credit', () => {
    expect(
      creditAppliedToPremiumsCents({
        creditCents: 100_000,
        offsetCents: 100_000,
        medicalCents: 720_000,
        remainingNeedCents: 3_990_000,
      }),
    ).toBe(0);
  });

  it('never goes below zero when a limit is negative', () => {
    expect(
      creditAppliedToPremiumsCents({
        creditCents: 513_420,
        offsetCents: 0,
        medicalCents: 720_000,
        remainingNeedCents: -1,
      }),
    ).toBe(0);
  });
});

describe('sumYearCents', () => {
  it('sums the twelve months of one retirement year', () => {
    const monthly = Array.from({ length: 36 }, (_, i) => (i < 12 ? 100 : i < 24 ? 200 : 300));
    expect(sumYearCents(monthly, 0)).toBe(1_200);
    expect(sumYearCents(monthly, 1)).toBe(2_400);
    expect(sumYearCents(monthly, 2)).toBe(3_600);
  });

  it('reads months past the end of the series as zero', () => {
    expect(sumYearCents([100, 100], 3)).toBe(0);
  });
});
