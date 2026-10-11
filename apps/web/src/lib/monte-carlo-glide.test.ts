/**
 * Unit tests for `buildGlideAssetMixSeries` — per-step per-account
 * asset mix derived from a RetirementAllocationOverride glide.
 */
import { describe, it, expect } from 'vitest';
import { buildGlideAssetMixSeries } from './monte-carlo-glide';
import type { AssetMix, RetirementAllocationOverride } from '../db/types';

/** Tolerance matching ASSET_MIX_SUM_TOLERANCE in the engine tests. */
const SUM_TOLERANCE = 0.05;

const BASE_MIX: AssetMix = { stocksPct: 70, bondsPct: 25, cashPct: 5 };

/** Helper: allocation with a linear glide from startGrowthPct to endGrowthPct. */
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
    // Retirement at step 60 (firstYear 2025, retirementYear 2030).
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
    // firstYear=2025, retirementStepIdx=60 → retirementYear=2030.
    // glideStartYear=2030 → effectiveGlideStartYear=2030.
    // endYear=2050. At year 2040 (mid-point): share = 0.70 + (0.20-0.70)*(10/20) = 0.45.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2050 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Step at year 2040: i = (2040-2025)*12 = 180.
    const mid = series[180];
    expect(mid.stocksPct).toBeCloseTo(45, 5);
    // bonds/cash split proportional to base 25/5 ratio (income = 55%).
    // total income = 30; base ratio: bonds = 25/30, cash = 5/30.
    expect(mid.bondsPct).toBeCloseTo(55 * (25 / 30), 5);
    expect(mid.cashPct).toBeCloseTo(55 * (5 / 30), 5);
  });

  it('(c) incomeOnlyYear snaps to 0% growth regardless of glide position', () => {
    // incomeOnlyYear=2045 which is within the glide window.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ incomeOnlyYear: 2045, endYear: 2060 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Step at year 2045: i=(2045-2025)*12=240.
    const snapStep = series[240];
    expect(snapStep.stocksPct).toBeCloseTo(0, 5);
    expect(snapStep.bondsPct + snapStep.cashPct).toBeCloseTo(100, 5);
    // Step at year 2050, still past incomeOnlyYear.
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
    // At retirement (step 60, year 2030 = effectiveGlideStartYear): 70% stocks, 0% bonds, 30% cash.
    const retirementStep = series[60];
    expect(retirementStep.stocksPct).toBeCloseTo(70, 5);
    expect(retirementStep.bondsPct).toBeCloseTo(0, 5);
    expect(retirementStep.cashPct).toBeCloseTo(30, 5);
    // Mid-glide step (year 2040, step 180): 45% stocks, 0% bonds, 55% cash.
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
    // With null glideStartYear the ramp should start at retirementYear=2030.
    const withNull = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: null }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Step 60 = year 2030 = effectiveGlideStartYear → still on branch 3 (y <= effectiveGlideStartYear)
    // startGrowthPct=70% at retirement.
    expect(withNull[60].stocksPct).toBeCloseTo(70, 5);
    // Step at year 2040 = same linear path as in test (b).
    expect(withNull[180].stocksPct).toBeCloseTo(45, 5);
  });

  it('(h) glideStartYear < retirementYear clamps to retirementYear', () => {
    // User sets glideStartYear=2020, retirement=2030 → effectiveGlideStartYear=2030.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2020 }),
      retirementStepIdx: 60,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Should behave identically to glideStartYear=2030.
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
    // Regression: the kernel (monte-carlo.ts) uses
    // Math.max(0, (retirementYear - firstYear) * 12) — no month offset.
    // glide-series retirementStepIdx must use the same convention so
    // assetMixSeries[i] and buildStepInputs' retirementStepIdx are identical.
    //
    // Simulate July retirement: firstYear=2025, retirementYear=2030,
    // retirementMonth0=6 → kernel retirementStepIdx = (2030-2025)*12 = 60.
    // The old bug would pass 60+6=66; this test asserts step 60 (not 66)
    // is the first drawdown step (i.e., returns the glide mix, not BASE_MIX).
    const kernelRetirementStepIdx = (2030 - 2025) * 12; // = 60
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2050 }),
      retirementStepIdx: kernelRetirementStepIdx,
      stepCount: 360,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Steps 0..59: accumulation — must return BASE_MIX unchanged.
    for (let i = 0; i < kernelRetirementStepIdx; i += 1) {
      expect(series[i]).toBe(BASE_MIX);
    }
    // Step 60: first drawdown step — must return the glide mix (startGrowthPct=70%).
    // If the month offset were included the mix at step 60 would still be BASE_MIX.
    expect(series[kernelRetirementStepIdx].stocksPct).toBeCloseTo(70, 5);
  });

  it('(k) regression: already-retired household uses actual past retirementYear, not firstYear', () => {
    // Already retired: primaryRetirementYear=2020, firstYear=2025 (today).
    // retirementStepIdx is clamped to 0.
    // Old code: retirementYear = firstYear + floor(0/12) = 2025 → wrong baseline.
    // Fixed: retirementYear=2020 passed explicitly → effectiveGlideStartYear=2020.
    // glideStartYear=2020, endYear=2040 (20-yr window). At firstYear=2025 (step 0):
    // elapsed = 2025-2020 = 5, span = 2040-2020 = 20.
    // share = 0.70 + (0.20-0.70)*(5/20) = 0.70 - 0.125 = 0.575 → 57.5%.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2020, endYear: 2040 }),
      retirementStepIdx: 0,
      stepCount: 120,
      firstYear: 2025,
      retirementYear: 2020,
    });
    // Step 0 = year 2025: mid-glide, 57.5% stocks.
    expect(series[0].stocksPct).toBeCloseTo(57.5, 5);
  });

  it('(l) degenerate window: endYear === glideStartYear snaps to endFrac at boundary', () => {
    // endYear=2030 equals effectiveGlideStartYear=2030 → zero-duration window.
    // Steps at year 2030 (i=60) and beyond → endGrowthPct=20%.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2030 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Steps before 2030 are accumulation → BASE_MIX.
    for (let i = 0; i < 60; i += 1) {
      expect(series[i]).toBe(BASE_MIX);
    }
    // Step 60 = year 2030 = boundary → snaps to endGrowthPct=20%.
    expect(series[60].stocksPct).toBeCloseTo(20, 5);
    // Later steps also stay at endGrowthPct.
    expect(series[120].stocksPct).toBeCloseTo(20, 5);
  });

  it("(l') degenerate window: endYear < glideStartYear snaps to endFrac from boundary", () => {
    // endYear=2028 < effectiveGlideStartYear=2030 → negative-duration window.
    // Same snap-to-endFrac behaviour.
    const series = buildGlideAssetMixSeries({
      baseAssetMix: BASE_MIX,
      allocation: makeAlloc({ glideStartYear: 2030, endYear: 2028 }),
      retirementStepIdx: 60,
      stepCount: 240,
      firstYear: 2025,
      retirementYear: 2030,
    });
    // Step 60 = year 2030 ≥ effectiveGlideStartYear → snap to endGrowthPct=20%.
    expect(series[60].stocksPct).toBeCloseTo(20, 5);
    expect(series[120].stocksPct).toBeCloseTo(20, 5);
  });
});
