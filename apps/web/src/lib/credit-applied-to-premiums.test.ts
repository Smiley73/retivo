// The table rows are the worked 2026 household in docs/math-social-security-and-health.md; each limit binds in at least one row.
import { describe, expect, it } from 'vitest';
import {
  creditAppliedToPremiumsCents,
  drawIncomeCents,
  foldYearDrawIntoExpense,
  povertyLineLimitCents,
  sumPositiveNeed,
  sumYearCents,
} from './credit-applied-to-premiums';

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

describe('creditAppliedToPremiumsCents, poverty-line limit', () => {
  const base = { creditCents: 640_580, offsetCents: 0, medicalCents: 720_000, remainingNeedCents: 2_200_000 };

  it('holds the line to the limit when that is the smallest bound', () => {
    expect(creditAppliedToPremiumsCents({ ...base, povertyLineLimitCents: 635_000 })).toBe(635_000);
  });

  it('leaves the line alone when the limit is larger or absent', () => {
    expect(creditAppliedToPremiumsCents({ ...base, povertyLineLimitCents: 900_000 })).toBe(640_580);
    expect(creditAppliedToPremiumsCents({ ...base, povertyLineLimitCents: Number.POSITIVE_INFINITY })).toBe(640_580);
    expect(creditAppliedToPremiumsCents(base)).toBe(640_580);
  });

  it('is zero with a zero limit', () => {
    expect(creditAppliedToPremiumsCents({ ...base, povertyLineLimitCents: 0 })).toBe(0);
  });
});

describe('povertyLineLimitCents', () => {
  const income = (cents: number, magiCents = cents) => ({ incomeDrawCents: cents, magiOfDrawCents: magiCents });

  it('is the headroom when the draw is MAGI the lowered draw would shed', () => {
    // $22,000 of pre-tax draw at 140.6% of $15,650: $6,350 above the line.
    expect(povertyLineLimitCents({ headroomCents: 635_000, ...income(2_200_000) })).toBe(635_000);
  });

  it('is no limit when the draw sheds no more MAGI than the headroom', () => {
    expect(povertyLineLimitCents({ headroomCents: 0, ...income(0) })).toBe(Number.POSITIVE_INFINITY);
    expect(povertyLineLimitCents({ headroomCents: 635_000, ...income(300_000) })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('is zero on the line with MAGI-bearing draws', () => {
    expect(povertyLineLimitCents({ headroomCents: 0, ...income(1) })).toBe(0);
  });

  it('lets a draw that is half gain fall by twice the headroom', () => {
    // $8,000 from a brokerage account at half basis: $4,000 of MAGI against $2,350 of
    // headroom, so the draw can fall by $4,700 (each dollar sheds 50 cents of MAGI).
    expect(povertyLineLimitCents({ headroomCents: 235_000, ...income(800_000, 400_000) })).toBe(470_000);
    expect(povertyLineLimitCents({ headroomCents: 400_000, ...income(800_000, 400_000) })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('drawIncomeCents', () => {
  it('counts pre-tax and Roth earnings whole, and only the gain of a taxable-account draw', () => {
    expect(
      drawIncomeCents({
        preTaxDollars: 1_000,
        taxableAccountDollars: 2_000,
        rothEarningsDollars: 500,
        costBasisFraction: 0.25,
      }),
    ).toEqual({ incomeDrawCents: 350_000, magiOfDrawCents: 300_000 });
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

describe('sumPositiveNeed', () => {
  it('sums the months that draw and ignores the surplus months', () => {
    const expense = Float64Array.from([100, 100, 100, 100]);
    const income = Float64Array.from([40, 160, 100, 0]);
    expect(sumPositiveNeed(expense, income, 0, 4)).toBe(60 + 0 + 0 + 100);
    expect(sumPositiveNeed(expense, income, 2, 4)).toBe(100);
  });
});

describe('foldYearDrawIntoExpense', () => {
  const draw = (expense: Float64Array, income: Float64Array): number =>
    sumPositiveNeed(expense, income, 0, expense.length);

  it('spreads a positive draw evenly over twelve months', () => {
    const expense = new Float64Array(12).fill(100);
    foldYearDrawIntoExpense(expense, new Float64Array(12), 0, 12, 1_200);
    expect(Array.from(expense)).toEqual(new Array(12).fill(200));
  });

  it('spreads a negative draw in proportion to each month need, lowering the draw by all of it', () => {
    // One 10,000 month among eleven months income covers: an even split would
    // lose eleven twelfths of the 6,000 to the zero floors.
    const expense = new Float64Array(12).fill(1_000);
    const income = new Float64Array(12).fill(1_000);
    expense[2] = 11_000;
    foldYearDrawIntoExpense(expense, income, 0, 12, -6_000);
    expect(draw(expense, income)).toBeCloseTo(4_000, 9);
    expect(expense[2]).toBeCloseTo(5_000, 9);
    expect(expense[0]).toBe(1_000);
  });

  it('keeps every month at or above zero when the draw takes the whole need', () => {
    const expense = Float64Array.from([300, 0, 700, 0]);
    const income = new Float64Array(4);
    foldYearDrawIntoExpense(expense, income, 0, 4, -1_000);
    expect(Array.from(expense).every((v) => v >= 0)).toBe(true);
    expect(draw(expense, income)).toBeCloseTo(0, 9);
  });

  it('falls back to an even split when the year has no need', () => {
    const expense = new Float64Array(12);
    foldYearDrawIntoExpense(expense, new Float64Array(12).fill(5), 0, 12, -120);
    expect(Array.from(expense)).toEqual(new Array(12).fill(-10));
  });

  it('only touches the months in the range', () => {
    const expense = new Float64Array(24).fill(100);
    foldYearDrawIntoExpense(expense, new Float64Array(24), 12, 24, -600);
    expect(expense[11]).toBe(100);
    expect(expense[12]).toBeCloseTo(50, 9);
  });
});
