import { describe, expect, it } from 'vitest';
import { makeRng, seedFromString } from './sfc32.js';

describe('sfc32', () => {
  it('produces the same sequence given the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different sequences given different seeds', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    let diffs = 0;
    for (let i = 0; i < 20; i++) {
      if (a.next() !== b.next()) diffs += 1;
    }
    expect(diffs).toBeGreaterThanOrEqual(18);
  });

  it('uniform values are in [0, 1)', () => {
    const r = makeRng(123);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('uniformInt covers the inclusive range', () => {
    const r = makeRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 100000; i++) {
      seen.add(r.uniformInt(0, 4));
    }
    expect(seen).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('uniformInt distribution is roughly uniform over 5 buckets', () => {
    const r = makeRng(101);
    const counts = [0, 0, 0, 0, 0];
    const n = 50000;
    for (let i = 0; i < n; i++) {
      counts[r.uniformInt(0, 4)] += 1;
    }
    // Each bucket gets ~n/5 = 10000; allow ± 5% for randomness.
    for (const c of counts) {
      expect(c).toBeGreaterThan(9000);
      expect(c).toBeLessThan(11000);
    }
  });

  it('throws on inverted range', () => {
    const r = makeRng(0);
    expect(() => r.uniformInt(5, 1)).toThrow(RangeError);
  });
});

describe('seedFromString', () => {
  it('produces stable values across calls', () => {
    expect(seedFromString('abc')).toBe(seedFromString('abc'));
  });

  it('produces different values for different inputs', () => {
    expect(seedFromString('abc')).not.toBe(seedFromString('abd'));
  });

  it('returns a 32-bit unsigned integer', () => {
    const v = seedFromString('hello');
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });
});
