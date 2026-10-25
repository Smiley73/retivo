/** Per-step per-account asset mix along a `RetirementAllocationOverride` glide.
 * See docs/math-income-expenses-and-returns.md ("The Asset allocation glide"). */
import type { AssetMix, RetirementAllocationOverride } from '../db/types.js';
import { targetGrowthShareForStep } from './allocation-glide.js';

function splitNonGrowth(
  incomePct: number,
  baseBondsPct: number,
  baseCashPct: number,
): { bondsPct: number; cashPct: number } {
  const baseIncomeTotal = baseBondsPct + baseCashPct;
  if (baseIncomeTotal > 0) {
    return {
      bondsPct: incomePct * (baseBondsPct / baseIncomeTotal),
      cashPct: incomePct * (baseCashPct / baseIncomeTotal),
    };
  }
  return { bondsPct: 0, cashPct: incomePct };
}

/**
 * Per-step asset-mix series for one account: `baseAssetMix` before
 * `retirementStepIdx`, the glide branch table after.
 * @param retirementYear Calendar retirement year of the primary member. Not
 *   derivable from `retirementStepIdx`, which is clamped to 0 for
 *   already-retired households.
 */
export function buildGlideAssetMixSeries(args: {
  readonly baseAssetMix: AssetMix;
  readonly allocation: RetirementAllocationOverride;
  readonly retirementStepIdx: number;
  readonly stepCount: number;
  readonly firstYear: number;
  readonly retirementYear: number;
}): ReadonlyArray<AssetMix> {
  const { baseAssetMix, allocation, retirementStepIdx, stepCount, firstYear, retirementYear } = args;

  const effectiveGlideStartYear = Math.max(
    retirementYear,
    allocation.glideStartYear ?? retirementYear,
  );
  const glideEnabled =
    allocation.endGrowthPct !== null &&
    allocation.endGrowthPct !== undefined &&
    allocation.endYear !== null &&
    allocation.endYear !== undefined;

  const result: AssetMix[] = new Array(stepCount);
  for (let i = 0; i < stepCount; i += 1) {
    if (i < retirementStepIdx) {
      result[i] = baseAssetMix;
      continue;
    }
    const y = firstYear + Math.floor(i / 12);
    const growthShare = targetGrowthShareForStep(
      y, allocation, effectiveGlideStartYear, glideEnabled,
    );
    const stocksPct = 100 * growthShare;
    const { bondsPct, cashPct } = splitNonGrowth(
      100 - stocksPct, baseAssetMix.bondsPct, baseAssetMix.cashPct,
    );
    result[i] = { stocksPct, bondsPct, cashPct };
  }
  return result;
}
