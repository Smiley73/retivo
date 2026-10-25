import { describe, expect, it } from 'vitest';
import { monthlyEquivalent } from './monthly-conversion';

describe('monthlyEquivalent', () => {
  it('compounds to the same annual factor', () => {
    const m = monthlyEquivalent(7);
    expect(Math.pow(1 + m / 100, 12)).toBeCloseTo(1.07, 9);
  });

  it('0 → 0', () => {
    expect(monthlyEquivalent(0)).toBe(0);
  });
});
