// Asset-allocation glide shared by the Monte Carlo per-account glide and the deterministic drawdown, so both use one growth share.
// The engines apply it differently: the deterministic path blends two scalar rates, MC blends the asset mix and samples historical returns.

import type { RetirementAllocationOverride } from '../db/types.js';

/**
 * Target growth share (0 to 1) at calendar year `y`: 0 from `incomeOnlyYear`,
 * `startGrowthPct` without a glide, a window with `endYear` at or before the glide
 * start snaps to `endFrac`, else linear across the window.
 */
export function targetGrowthShareForStep(
  y: number,
  allocation: RetirementAllocationOverride,
  effectiveGlideStartYear: number,
  glideEnabled: boolean,
): number {
  const incomeOnlyYear = allocation.incomeOnlyYear ?? null;
  if (incomeOnlyYear !== null && y >= incomeOnlyYear) return 0;
  if (!glideEnabled) return allocation.startGrowthPct / 100;
  const startFrac = allocation.startGrowthPct / 100;
  const endFrac = allocation.endGrowthPct! / 100;
  if (allocation.endYear !== null && allocation.endYear <= effectiveGlideStartYear) {
    return y < effectiveGlideStartYear ? startFrac : endFrac;
  }
  if (y <= effectiveGlideStartYear) return startFrac;
  if (y >= allocation.endYear!) return endFrac;
  const span = allocation.endYear! - effectiveGlideStartYear;
  const elapsed = y - effectiveGlideStartYear;
  return startFrac + (endFrac - startFrac) * (elapsed / span);
}

/** The effective glide-start year and whether a glide is enabled, shared so the deterministic context, tooltip post-pass and MC builder agree. */
export function resolveGlideAnchors(
  allocation: RetirementAllocationOverride,
  retirementYear: number,
): { effectiveGlideStartYear: number; glideEnabled: boolean } {
  const effectiveGlideStartYear = Math.max(
    retirementYear,
    allocation.glideStartYear ?? retirementYear,
  );
  const glideEnabled =
    allocation.endGrowthPct !== null &&
    allocation.endGrowthPct !== undefined &&
    allocation.endYear !== null &&
    allocation.endYear !== undefined;
  return { effectiveGlideStartYear, glideEnabled };
}

/** Blended glide return (percent) at year `y`: the growth and income rates weighted by the year's target growth share. */
export function blendedGlideReturnPct(
  y: number,
  allocation: RetirementAllocationOverride,
  retirementYear: number,
): number {
  const { effectiveGlideStartYear, glideEnabled } = resolveGlideAnchors(
    allocation,
    retirementYear,
  );
  const share = targetGrowthShareForStep(
    y,
    allocation,
    effectiveGlideStartYear,
    glideEnabled,
  );
  return share * allocation.growthRatePct + (1 - share) * allocation.incomeRatePct;
}
