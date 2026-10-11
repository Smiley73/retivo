/**
 * Direct unit tests for `splitInitialByTaxTreatment`, including non-50/50
 * MIXED regression coverage.
 *
 * Pins:
 *  - PRE_TAX / POST_TAX collapse the total to one bucket (mixedBuckets
 *    ignored).
 *  - MIXED with explicit `mixedBuckets` honors the stored split.
 *    Buckets that don't sum exactly to `total` are scaled proportionally
 *    (preTax / (preTax + postTax)) so callers can pass `projOut.total`
 *    as the total + `projOut.preTax` / `projOut.postTax` as the bucket
 *    split without an fp64 sum mismatch breaking the contract.
 *  - MIXED with `mixedBuckets` sum === 0 falls back to 50/50.
 *  - MIXED with no `mixedBuckets` argument falls back to 50/50 (legacy
 *    contract preserved).
 */
import { describe, expect, it } from 'vitest';
import { splitInitialByTaxTreatment } from './tax-treatment-split';

describe('splitInitialByTaxTreatment', () => {
  it('PRE_TAX collapses to the pre bucket; mixedBuckets ignored', () => {
    const out = splitInitialByTaxTreatment(100_000, 'PRE_TAX', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(100_000);
    expect(out.initialPost).toBe(0);
  });

  it('POST_TAX collapses to the post bucket; mixedBuckets ignored', () => {
    const out = splitInitialByTaxTreatment(100_000, 'POST_TAX', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(0);
    expect(out.initialPost).toBe(100_000);
  });

  it('HSA collapses the whole total to the post bucket; mixedBuckets ignored', () => {
    // HSA is single-sided per spec — the whole balance is tax-free / post,
    // regardless of any pre/post bucket split that may be passed. The
    // no-income-tax character of qualified withdrawals is applied later in
    // the drawdown tax pass, independent of this bucket routing.
    const out = splitInitialByTaxTreatment(100_000, 'HSA', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(0);
    expect(out.initialPost).toBe(100_000);
  });

  it('ROTH collapses the whole total to the post bucket; mixedBuckets ignored', () => {
    // Roth is post-tax funded + tax-free at withdrawal — the whole at-retirement
    // balance seeds into the post bucket, same as POST_TAX and HSA. The
    // tax-free withdrawal character is applied later by `taxTreatment === 'ROTH'`.
    const out = splitInitialByTaxTreatment(100_000, 'ROTH', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(0);
    expect(out.initialPost).toBe(100_000);
  });

  it('MIXED with non-50/50 buckets summing to total: honors the stored split', () => {
    // 210k/90k = 70/30 stored split. Buckets sum to 300k = total → no scaling.
    const out = splitInitialByTaxTreatment(300_000, 'MIXED', {
      preTax: 210_000,
      postTax: 90_000,
    });
    expect(out.initialPre).toBeCloseTo(210_000, 6);
    expect(out.initialPost).toBeCloseTo(90_000, 6);
  });

  it('MIXED with non-50/50 buckets that drift from total: scales to total', () => {
    // 70/30 stored split represented by buckets that don't sum exactly
    // to total (e.g. fp residue or slight projection-step drift).
    // Helper scales by share = preTax / (preTax + postTax).
    const out = splitInitialByTaxTreatment(300_000, 'MIXED', {
      preTax: 700,
      postTax: 300,
    });
    // 700 / (700 + 300) = 0.7 → 210k pre, 90k post.
    expect(out.initialPre).toBeCloseTo(210_000, 6);
    expect(out.initialPost).toBeCloseTo(90_000, 6);
    // Invariant: pre + post === total exactly.
    expect(out.initialPre + out.initialPost).toBeCloseTo(300_000, 6);
  });

  it('MIXED with buckets summing to 0: falls back to 50/50', () => {
    const out = splitInitialByTaxTreatment(100_000, 'MIXED', {
      preTax: 0,
      postTax: 0,
    });
    expect(out.initialPre).toBeCloseTo(50_000, 6);
    expect(out.initialPost).toBeCloseTo(50_000, 6);
  });

  it('MIXED with no mixedBuckets argument: falls back to 50/50 (legacy contract)', () => {
    const out = splitInitialByTaxTreatment(100_000, 'MIXED');
    expect(out.initialPre).toBeCloseTo(50_000, 6);
    expect(out.initialPost).toBeCloseTo(50_000, 6);
  });

  it('MIXED with null mixedBuckets: falls back to 50/50', () => {
    const out = splitInitialByTaxTreatment(100_000, 'MIXED', null);
    expect(out.initialPre).toBeCloseTo(50_000, 6);
    expect(out.initialPost).toBeCloseTo(50_000, 6);
  });
});
