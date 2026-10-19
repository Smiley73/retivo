import { describe, expect, it } from 'vitest';
import { structurallyEqual } from './structural-equality';

describe('structurallyEqual', () => {
  it('compares Maps by key regardless of insertion order', () => {
    const a = new Map([['x', { n: 1 }], ['y', { n: 2 }]]);
    const b = new Map([['y', { n: 2 }], ['x', { n: 1 }]]);
    expect(structurallyEqual(a, b)).toBe(true);
    expect(structurallyEqual(a, new Map([['x', { n: 1 }]]))).toBe(false);
    expect(structurallyEqual(a, new Map([['x', { n: 1 }], ['z', { n: 2 }]]))).toBe(false);
  });

  it('compares typed arrays element-wise', () => {
    expect(structurallyEqual(new Float64Array([1, 2]), new Float64Array([1, 2]))).toBe(true);
    expect(structurallyEqual(new Float64Array([1, 2]), new Float64Array([1, 3]))).toBe(false);
    expect(structurallyEqual(new Float64Array([1]), new Float32Array([1]))).toBe(false);
  });

  it('treats NaN as NaN and 0 as -0', () => {
    expect(structurallyEqual({ v: NaN }, { v: NaN })).toBe(true);
    expect(structurallyEqual([0], [-0])).toBe(true);
    expect(structurallyEqual(1, 2)).toBe(false);
  });

  it('treats an undefined-valued key as absent', () => {
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1, b: 0 }, { a: 1 })).toBe(false);
  });

  it('finds a one-cent change deep inside an accountBalances entry', () => {
    const row = (withdrawn: number) => ({
      year: 2040,
      accountBalances: new Map([['acct', { balance: 100_000, withdrawn }]]),
    });
    expect(structurallyEqual([row(5_000)], [row(5_000)])).toBe(true);
    expect(structurallyEqual([row(5_000)], [row(5_000.01)])).toBe(false);
  });

  it('distinguishes arrays from objects and differing lengths', () => {
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual([], {})).toBe(false);
    expect(structurallyEqual(null, {})).toBe(false);
  });
});
