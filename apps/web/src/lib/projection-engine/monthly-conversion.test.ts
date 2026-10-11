import { describe, expect, it } from 'vitest';
import {
  aggregateMonthlyToYearly,
  monthlyEquivalent,
  monthsBetween,
  stepIndexAtRetirement,
} from './monthly-conversion';

describe('monthlyEquivalent', () => {
  it('compounds to the same annual factor', () => {
    const m = monthlyEquivalent(7);
    expect(Math.pow(1 + m / 100, 12)).toBeCloseTo(1.07, 9);
  });

  it('0 → 0', () => {
    expect(monthlyEquivalent(0)).toBe(0);
  });
});

describe('monthsBetween', () => {
  it('counts whole months across years', () => {
    expect(monthsBetween(2020, 0, 2021, 0)).toBe(12);
    expect(monthsBetween(2020, 5, 2021, 7)).toBe(14);
    expect(monthsBetween(2025, 5, 2024, 5)).toBe(-12);
  });
});

describe('stepIndexAtRetirement', () => {
  it('zero-bases on the first-year January', () => {
    expect(stepIndexAtRetirement(2030, 0, 2030)).toBe(0);
    expect(stepIndexAtRetirement(2030, 5, 2030)).toBe(5);
    expect(stepIndexAtRetirement(2031, 0, 2030)).toBe(12);
  });
});

describe('aggregateMonthlyToYearly', () => {
  it('sums each 12-month window', () => {
    const arr = new Float64Array(24).fill(1);
    expect(aggregateMonthlyToYearly(arr, 0, 2)).toEqual([12, 12]);
  });

  it('skips indices outside the array bounds', () => {
    // 6-month array; ask for 2 windows starting at idx 0 → year 0 reads
    // idx 0..5 (all in-range), year 1 reads idx 6..11 (all out-of-range).
    const arr = new Float64Array(6).fill(2);
    expect(aggregateMonthlyToYearly(arr, 0, 2)).toEqual([12, 0]);
  });
});
