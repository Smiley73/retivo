import { describe, expect, it } from 'vitest';
import { applyRounding, EXACT_ROUNDING, NEAREST_THOUSAND_ROUNDING, roundingDescriptor, roundToNearestThousand } from './rounding';

describe('roundToNearestThousand', () => {
  it('rounds half up on the absolute value', () => {
    expect(roundToNearestThousand(1499)).toBe(1000);
    expect(roundToNearestThousand(1500)).toBe(2000);
    expect(roundToNearestThousand(1499.99)).toBe(1000);
    expect(roundToNearestThousand(2500)).toBe(3000);
  });

  it('mirrors negatives', () => {
    expect(roundToNearestThousand(-1499)).toBe(-1000);
    expect(roundToNearestThousand(-1500)).toBe(-2000);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundToNearestThousand(-499), 0)).toBe(true);
    expect(roundToNearestThousand(0)).toBe(0);
    expect(roundToNearestThousand(499)).toBe(0);
  });

  it('keeps null as null and refuses a non-finite number', () => {
    expect(roundToNearestThousand(null)).toBeNull();
    expect(roundToNearestThousand(Number.NaN)).toBeNull();
    expect(roundToNearestThousand(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('rounding choice', () => {
  it('applies only while exact figures are off', () => {
    expect(applyRounding(1234.56, true)).toBe(1234.56);
    expect(applyRounding(1234.56, false)).toBe(1000);
    expect(applyRounding(null, false)).toBeNull();
  });

  it('describes itself for the disclosure', () => {
    expect(roundingDescriptor(true)).toBe(EXACT_ROUNDING);
    expect(roundingDescriptor(false)).toBe(NEAREST_THOUSAND_ROUNDING);
    expect(NEAREST_THOUSAND_ROUNDING.stepDollars).toBe(1000);
    expect(NEAREST_THOUSAND_ROUNDING.statement).toContain('nearest $1,000');
    expect(EXACT_ROUNDING.stepDollars).toBeNull();
  });
});
