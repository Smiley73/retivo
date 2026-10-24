// Direct tests for `splitInitialByTaxTreatment`: PRE_TAX / POST_TAX collapse to one bucket; MIXED honors `mixedBuckets` (scaled by preTax / (preTax + postTax) when they miss the total), and falls back to 50/50 for a zero sum or no buckets.
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
    const out = splitInitialByTaxTreatment(100_000, 'HSA', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(0);
    expect(out.initialPost).toBe(100_000);
  });

  it('ROTH collapses the whole total to the post bucket; mixedBuckets ignored', () => {
    const out = splitInitialByTaxTreatment(100_000, 'ROTH', {
      preTax: 30_000,
      postTax: 70_000,
    });
    expect(out.initialPre).toBe(0);
    expect(out.initialPost).toBe(100_000);
  });

  it('MIXED with non-50/50 buckets summing to total: honors the stored split', () => {
    const out = splitInitialByTaxTreatment(300_000, 'MIXED', {
      preTax: 210_000,
      postTax: 90_000,
    });
    expect(out.initialPre).toBeCloseTo(210_000, 6);
    expect(out.initialPost).toBeCloseTo(90_000, 6);
  });

  it('MIXED with non-50/50 buckets that drift from total: scales to total', () => {
    const out = splitInitialByTaxTreatment(300_000, 'MIXED', {
      preTax: 700,
      postTax: 300,
    });
    expect(out.initialPre).toBeCloseTo(210_000, 6);
    expect(out.initialPost).toBeCloseTo(90_000, 6);
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
