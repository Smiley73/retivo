import { describe, expect, it } from 'vitest';
import {
  inflationFactorAt,
  realDeflatorAt,
  type ProjectionContext,
} from './projection-context';

const ctx = (overrides: Partial<ProjectionContext> = {}): ProjectionContext => ({
  asOfYear: 2026,
  asOfMonthIndex: 0,
  asOfMonth: 2026 * 12 + 0,
  firstProjectionMonth: 2026 * 12 + 0,
  primaryRetirementMonth: 2030 * 12 + 0,
  horizonMonth: 2060 * 12 + 0,
  inflationPct: 3,
  ...overrides,
});

describe('inflationFactorAt', () => {
  it('returns 1 when inflationPct is 0 for any (year, monthIndex)', () => {
    const c = ctx({ inflationPct: 0 });
    expect(inflationFactorAt(c, 2026, 0)).toBe(1);
    expect(inflationFactorAt(c, 2030, 5)).toBe(1);
    expect(inflationFactorAt(c, 2060, 11)).toBe(1);
    expect(inflationFactorAt(c, 2020, 3)).toBe(1);
  });

  it('compounds month-precise from asOfMonth at 3 %/yr', () => {
    const c = ctx({
      asOfYear: 2026,
      asOfMonthIndex: 5,
      asOfMonth: 2026 * 12 + 5,
      inflationPct: 3,
    });
    expect(inflationFactorAt(c, 2026, 11)).toBeCloseTo(Math.pow(1.03, 0.5), 10);
  });

  it('matches whole-year compounding when target is exactly N years out', () => {
    const c = ctx({
      asOfYear: 2026,
      asOfMonthIndex: 0,
      asOfMonth: 2026 * 12 + 0,
      inflationPct: 3,
    });
    expect(inflationFactorAt(c, 2029, 0)).toBeCloseTo(Math.pow(1.03, 3), 10);
  });

  it('returns a factor < 1 when target precedes asOfMonth', () => {
    const c = ctx({
      asOfYear: 2026,
      asOfMonthIndex: 5,
      asOfMonth: 2026 * 12 + 5,
      inflationPct: 3,
    });
    const factor = inflationFactorAt(c, 2026, 0);
    expect(factor).toBeLessThan(1);
    expect(factor).toBeCloseTo(Math.pow(1.03, -5 / 12), 10);
  });
});

describe('realDeflatorAt', () => {
  it('returns 1 when inflationPct is 0', () => {
    const c = ctx({ inflationPct: 0 });
    expect(realDeflatorAt(c, 2030, 5)).toBe(1);
    expect(realDeflatorAt(c, 2026, 0)).toBe(1);
  });

  it('is the multiplicative inverse of inflationFactorAt', () => {
    const c = ctx({
      asOfYear: 2026,
      asOfMonthIndex: 5,
      asOfMonth: 2026 * 12 + 5,
      inflationPct: 3,
    });
    const cases: Array<[number, number]> = [
      [2026, 0],
      [2026, 11],
      [2030, 3],
      [2055, 7],
      [2026, 5], // asOfMonth itself
    ];
    for (const [year, monthIndex] of cases) {
      const factor = inflationFactorAt(c, year, monthIndex);
      const deflator = realDeflatorAt(c, year, monthIndex);
      expect(factor * deflator).toBeCloseTo(1, 12);
    }
  });
});
