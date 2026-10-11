/**
 * Per-step per-account asset mix derived from a `RetirementAllocationOverride`
 * glide trajectory. Extracted as a sibling to `monte-carlo-per-account.ts` so
 * the large parent files do not grow further. The glide itself is explained in
 * docs/math-income-expenses-and-returns.md ("The Asset allocation glide").
 */
import type { AssetMix, RetirementAllocationOverride } from '../db/types.js';
// The pure glide-share helper is shared with the deterministic per-account
// drawdown path; MC's mix×sampled return and the deterministic
// scalar-blend differ by construction but consume the SAME growth share.
import { targetGrowthShareForStep } from './allocation-glide.js';

/**
 * Split `incomePct` into bonds/cash weighted by the base mix ratio.
 * All flows to cash when base has no income bucket.
 */
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
 * Build a per-step asset-mix series for a single account.
 *
 * Returns a `ReadonlyArray<AssetMix>` of length `stepCount`.
 * Accumulation steps (`i < retirementStepIdx`) return `baseAssetMix`
 * unchanged. Drawdown steps apply the glide branch table via
 * `targetGrowthShareForStep` + `splitNonGrowth`.
 *
 * @param baseAssetMix      Account's effective asset mix (after per-account
 *                          override resolution, before glide).
 * @param allocation        The `retirementAllocation` override.
 * @param retirementStepIdx Step index of the first post-retirement month.
 * @param stepCount         Total number of simulation steps.
 * @param firstYear         Calendar year of step 0 (used to map step → year).
 * @param retirementYear    Actual calendar retirement year of the primary
 *                          member. Required explicitly — for already-retired
 *                          households `retirementStepIdx` is clamped to 0,
 *                          so deriving `retirementYear` from
 *                          `firstYear + floor(retirementStepIdx/12)` would
 *                          collapse to `firstYear` and restart the glide from
 *                          the wrong baseline.
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
