/**
 * Tests for `expectPracticalEqual`. Pins the tolerance
 * semantics: 1e-10 passes, 1e-9 fails; arrays element-wise; Maps
 * key-set + value-wise; NaN-NaN is equal under Object.is; nulls
 * differ from zeros.
 */
import { describe, it, expect } from 'vitest';
import { expectPracticalEqual } from './expect-practical-equal';

describe('expectPracticalEqual', () => {
  it('passes when scalar diff is at the 1e-10 relative tolerance', () => {
    expect(() =>
      expectPracticalEqual(1_000_000, 1_000_000.00000001),
    ).not.toThrow();
  });

  it('fails when scalar diff exceeds the 1e-9 relative tolerance', () => {
    expect(() => expectPracticalEqual(1_000_000, 1_001_000)).toThrow();
  });

  it('recurses element-wise on arrays', () => {
    expect(() =>
      expectPracticalEqual([1, 2, 3.0000000001], [1, 2, 3]),
    ).not.toThrow();
    expect(() => expectPracticalEqual([1, 2, 3], [1, 2])).toThrow();
  });

  it('checks Map key-sets and recurses values', () => {
    const a = new Map<string, number>([['k', 1.0000000001]]);
    const b = new Map<string, number>([['k', 1]]);
    expect(() => expectPracticalEqual(a, b)).not.toThrow();
    const c = new Map<string, number>([['k', 1], ['j', 2]]);
    expect(() => expectPracticalEqual(a, c)).toThrow();
  });

  it('treats NaN === NaN as equal under Object.is', () => {
    expect(() => expectPracticalEqual(Number.NaN, Number.NaN)).not.toThrow();
  });

  it('fails when comparing null to 0', () => {
    expect(() => expectPracticalEqual(null, 0)).toThrow();
  });

  it('passes within $0.01 absolute even when relative would fail', () => {
    // $0.005 diff on a $1 amount: rel = 0.005, absolute = 0.005, pass.
    expect(() => expectPracticalEqual(1.005, 1)).not.toThrow();
  });
});
