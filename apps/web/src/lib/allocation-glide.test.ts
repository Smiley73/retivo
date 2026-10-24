import { describe, expect, it } from 'vitest';
import {
  blendedGlideReturnPct,
  resolveGlideAnchors,
  targetGrowthShareForStep,
} from './allocation-glide';
import type { RetirementAllocationOverride } from '../db/types';

const flat: RetirementAllocationOverride = {
  growthRatePct: 7,
  incomeRatePct: 3,
  startGrowthPct: 50,
  endGrowthPct: null,
  endYear: null,
  glideStartYear: null,
  incomeOnlyYear: null,
};

function share(alloc: RetirementAllocationOverride, y: number, retirementYear = 2030): number {
  const { effectiveGlideStartYear, glideEnabled } = resolveGlideAnchors(alloc, retirementYear);
  return targetGrowthShareForStep(y, alloc, effectiveGlideStartYear, glideEnabled);
}

describe('targetGrowthShareForStep — glide interpolation', () => {
  it('flat when no glide, linear interp during glide, clamped past endYear', () => {
    expect(share(flat, 2030)).toBe(0.5);
    expect(share(flat, 2050)).toBe(0.5);

    const glide: RetirementAllocationOverride = { ...flat, endGrowthPct: 30, endYear: 2040 };
    expect(share(glide, 2030)).toBe(0.5); // start
    expect(share(glide, 2035)).toBe(0.4); // halfway
    expect(share(glide, 2040)).toBe(0.3); // end
    expect(share(glide, 2045)).toBe(0.3); // past clamps to end
  });

  it('glideStartYear delays the glide so allocation stays flat from retirement to that year', () => {
    const offsetGlide: RetirementAllocationOverride = {
      ...flat,
      endGrowthPct: 30,
      endYear: 2040,
      glideStartYear: 2035,
    };
    expect(share(offsetGlide, 2030)).toBe(0.5); // retirement, pre-glide
    expect(share(offsetGlide, 2034)).toBe(0.5); // last flat year
    expect(share(offsetGlide, 2035)).toBe(0.5); // glide-start anchor stays at start
    expect(share(offsetGlide, 2037)).toBeCloseTo(0.42, 5); // 0.5 + (0.3-0.5) × 2/5
    expect(share(offsetGlide, 2040)).toBe(0.3); // end
    expect(share(offsetGlide, 2045)).toBe(0.3); // past clamps
  });

  it('degenerate window (glideStartYear ≥ endYear) snaps at the boundary', () => {
    const snap: RetirementAllocationOverride = {
      ...flat,
      endGrowthPct: 30,
      endYear: 2040,
      glideStartYear: 2040,
    };
    expect(share(snap, 2039)).toBe(0.5);
    expect(share(snap, 2040)).toBe(0.3);
  });
});

describe('targetGrowthShareForStep — incomeOnlyYear hard cutoff', () => {
  it('forces 0% growth from the cutoff year forward on a flat allocation', () => {
    const alloc: RetirementAllocationOverride = {
      ...flat,
      startGrowthPct: 60,
      incomeOnlyYear: 2040,
    };
    expect(share(alloc, 2030)).toBe(0.6);
    expect(share(alloc, 2039)).toBe(0.6);
    expect(share(alloc, 2040)).toBe(0);
    expect(share(alloc, 2050)).toBe(0);
  });

  it('preserves the natural glide endpoint, then snaps to 0% at the cutoff', () => {
    const alloc: RetirementAllocationOverride = {
      ...flat,
      endGrowthPct: 30,
      endYear: 2040,
      incomeOnlyYear: 2055,
    };
    expect(share(alloc, 2030)).toBe(0.5);
    expect(share(alloc, 2040)).toBe(0.3);
    expect(share(alloc, 2050)).toBe(0.3);
    expect(share(alloc, 2055)).toBe(0);
    expect(share(alloc, 2070)).toBe(0);
  });

  it('cutoff inside the glide window overrides the glide from that year forward', () => {
    const alloc: RetirementAllocationOverride = {
      ...flat,
      startGrowthPct: 60,
      endGrowthPct: 30,
      endYear: 2050,
      incomeOnlyYear: 2040,
    };
    expect(share(alloc, 2030)).toBe(0.6);
    expect(share(alloc, 2040)).toBe(0);
    expect(share(alloc, 2045)).toBe(0);
    expect(share(alloc, 2055)).toBe(0);
  });
});

describe('targetGrowthShareForStep — glide boundary', () => {
  it('glideStartYear==endYear snaps from start to end at the boundary year', () => {
    const alloc: RetirementAllocationOverride = {
      ...flat,
      endGrowthPct: 20,
      endYear: 2035,
      glideStartYear: 2035,
    };
    expect(share(alloc, 2034)).toBe(0.5);
    expect(share(alloc, 2035)).toBe(0.2);
  });

  it('already-retired household: glide anchors to the actual retirement year, not a later one', () => {
    const alloc: RetirementAllocationOverride = { ...flat, endGrowthPct: 10, endYear: 2032 };
    const { effectiveGlideStartYear } = resolveGlideAnchors(alloc, 2030);
    expect(effectiveGlideStartYear).toBe(2030);
    expect(share(alloc, 2030)).toBe(0.5);
    expect(share(alloc, 2031)).toBe(0.3); // 0.5 + (0.1-0.5) × 1/2
    expect(share(alloc, 2032)).toBe(0.1);
  });
});

describe('blendedGlideReturnPct — scalar two-rate blend', () => {
  it('blends growth/income rates by the year-share (flat allocation)', () => {
    expect(blendedGlideReturnPct(2030, flat, 2030)).toBeCloseTo(5, 9);
  });

  it('shifts toward the income rate as the glide reduces the growth share', () => {
    const glide: RetirementAllocationOverride = { ...flat, endGrowthPct: 0, endYear: 2040 };
    expect(blendedGlideReturnPct(2040, glide, 2030)).toBeCloseTo(3, 9);
    expect(blendedGlideReturnPct(2035, glide, 2030)).toBeCloseTo(4, 9);
  });

  it('incomeOnlyYear forces the pure income rate', () => {
    const alloc: RetirementAllocationOverride = { ...flat, incomeOnlyYear: 2040 };
    expect(blendedGlideReturnPct(2040, alloc, 2030)).toBeCloseTo(3, 9);
  });
});
