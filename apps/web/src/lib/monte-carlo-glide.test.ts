/** Per-step asset mix of a retirement-allocation glide. */
import { describe, it, expect } from 'vitest';
import { buildGlideAssetMixSeries } from './monte-carlo-glide';
import type { AssetMix, RetirementAllocationOverride } from '../db/types';

const SUM_TOLERANCE = 0.05;

const BASE_MIX: AssetMix = { stocksPct: 70, bondsPct: 25, cashPct: 5 };

function makeAlloc(
  overrides: Partial<RetirementAllocationOverride> = {},
): RetirementAllocationOverride {
  return {
    growthRatePct: 7,
    incomeRatePct: 3,
    startGrowthPct: 70,
    endGrowthPct: 20,
    endYear: 2050,
    glideStartYear: 2030,
    incomeOnlyYear: null,
    ...overrides,
  };
}

describe('buildGlideAssetMixSeries', () => {
  it('(a) returns baseAssetMix unchanged for accumulation steps', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc(),
      retirementStepIdx: 60,
      stepCount: 120,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 0; i < 60; i += 1) {
      expect(series[i]).toBe(BASE_MIX);
    }
  });

  it('(b) interpolates linearly between effectiveGlideStartYear and endYear', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2050 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    const mid = series[180];
    expect(mid.stocksPct).toBeCloseTo(45, 5);
    expect(mid.bondsPct).toBeCloseTo(55 * (25 / 30), 5);
    expect(mid.cashPct).toBeCloseTo(55 * (5 / 30), 5);
  });

  it('(c) incomeOnlyYear snaps to 0% growth regardless of glide position', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ incomeOnlyYear: 2045, endYear: 2060 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    const snapStep = series[240];
    expect(snapStep.stocksPct).toBeCloseTo(0, 5);
    expect(snapStep.bondsPct + snapStep.cashPct).toBeCloseTo(100, 5);
    const laterStep = series[300];
    expect(laterStep.stocksPct).toBeCloseTo(0, 5);
  });

  it('(d) degenerate glide (startGrowthPct === endGrowthPct) keeps flat mix', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ startGrowthPct: 50, endGrowthPct: 50 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 60; i < 240; i += 1) {
      expect(series[i].stocksPct).toBeCloseTo(50, 5);
    }
  });

  it('(e) base bonds+cash = 0 routes all income to cash', () => {
    const allStocksMix: AssetMix = { stocksPct: 100, bondsPct: 0, cashPct: 0 };
    const series = buildGlideAssetMixSeries({
      baseAssetMix: allStocksMix,
      allocation: makeAlloc({ startGrowthPct: 70, endGrowthPct: 20 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    const retirementStep = series[60];
    expect(retirementStep.stocksPct).toBeCloseTo(70, 5);
    expect(retirementStep.bondsPct).toBeCloseTo(0, 5);
    expect(retirementStep.cashPct).toBeCloseTo(30, 5);
    const midStep = series[180];
    expect(midStep.bondsPct).toBeCloseTo(0, 5);
    expect(midStep.cashPct).toBeCloseTo(55, 5);
  });

  it('(f) every step sums to 100 ± tolerance', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ incomeOnlyYear: 2055 }),
      retirementStepIdx: 60,
      stepCount: 480,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 0; i < series.length; i += 1) {
      const sum = series[i].stocksPct + series[i].bondsPct + series[i].cashPct;
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(SUM_TOLERANCE);
    }
  });

  it('(g) glideStartYear: null → effectiveGlideStartYear equals retirementYear', () => {
    const withNull = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: null }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    expect(withNull[60].stocksPct).toBeCloseTo(70, 5);
    expect(withNull[180].stocksPct).toBeCloseTo(45, 5);
  });

  it('(h) glideStartYear < retirementYear clamps to retirementYear', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2020 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    expect(series[60].stocksPct).toBeCloseTo(70, 5);
    expect(series[180].stocksPct).toBeCloseTo(45, 5);
  });

  it('(i) endGrowthPct: null → flat post-retirement at startGrowthPct', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ endGrowthPct: null }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 60; i < 240; i += 1) {
      expect(series[i].stocksPct).toBeCloseTo(70, 5);
    }
  });

  it("(i') endYear: null → flat post-retirement at startGrowthPct", () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ endYear: null }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 60; i < 240; i += 1) {
      expect(series[i].stocksPct).toBeCloseTo(70, 5);
    }
  });

  it('(j) non-Jan retirement: first drawdown step aligns with kernel retirementStepIdx', () => {
    // The kernel's retirementStepIdx has no month offset; the old code passed 66 for a July retirement.
    const kernelRetirementStepIdx = (2030 - 2025) * 12; // = 60
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2050 }),
      retirementStepIdx: kernelRetirementStepIdx,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 0; i < kernelRetirementStepIdx; i += 1) {
      expect(series[i]).toBe(BASE_MIX);
    }
    expect(series[kernelRetirementStepIdx].stocksPct).toBeCloseTo(70, 5);
  });

  it('(k) regression: already-retired household uses actual past retirementYear, not firstYear', () => {
    // The old code took the retirement year from firstYear (2025) instead of the real past year (2020).
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2020, endYear: 2040 }),
      retirementStepIdx: 0,
      stepCount: 120,
      firstYear: 2025,
      retirementYear: 2020,
    });
    expect(series[0].stocksPct).toBeCloseTo(57.5, 5);
  });

  it('(l) degenerate window: endYear === glideStartYear snaps to endFrac at boundary', () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2030 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    for (let i = 0; i < 60; i += 1) {
      expect(series[i]).toBe(BASE_MIX);
    }
    expect(series[60].stocksPct).toBeCloseTo(20, 5);
    expect(series[120].stocksPct).toBeCloseTo(20, 5);
  });

  it("(l') degenerate window: endYear < glideStartYear snaps to endFrac from boundary", () => {
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2028 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    expect(series[60].stocksPct).toBeCloseTo(20, 5);
    expect(series[120].stocksPct).toBeCloseTo(20, 5);
  });
});
