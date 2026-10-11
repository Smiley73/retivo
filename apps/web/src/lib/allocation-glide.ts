/**
 * Shared asset-allocation glide helper. Pure function used by BOTH the
 * Monte Carlo per-account glide (`monte-carlo-glide.ts` →
 * `buildGlideAssetMixSeries`) and the deterministic per-account drawdown
 * (`balance-projection-runner-context.ts` builds each non-CBP account's
 * blended `returnPctByMonth`; the runner post-pass derives the
 * growth/income Gains tooltip from the same share).
 *
 * `targetGrowthShareForStep` returns the target GROWTH share (0..1) at a
 * calendar year `y`, honoring `incomeOnlyYear` hard-cutoff, the
 * degenerate-window snap, and linear interpolation across the glide
 * window. Extracted (was private in `monte-carlo-glide.ts`) so the
 * deterministic and MC paths compute the SAME glide share.
 *
 * NB the two engines apply the share DIFFERENTLY: the deterministic
 * path blends two scalar rates (`share·growthRatePct + (1−share)·incomeRatePct`)
 * while MC blends the per-account asset MIX (stocks/bonds/cash) and applies
 * SAMPLED historical returns — so the returns differ by construction even
 * though the share is identical.
 */
import type { RetirementAllocationOverride } from '../db/types.js';

/**
 * Glide branch table: target growth share (0–1) for calendar year `y` in
 * drawdown. The first matching branch wins.
 *
 * Degenerate-window guard — when `endYear <= effectiveGlideStartYear` the
 * window is zero/negative duration: snap to `endFrac` at and past the
 * boundary, stay at `startFrac` before.
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
  // Degenerate-window: endYear collapses at or before glide start — snap immediately.
  if (allocation.endYear !== null && allocation.endYear <= effectiveGlideStartYear) {
    return y < effectiveGlideStartYear ? startFrac : endFrac;
  }
  if (y <= effectiveGlideStartYear) return startFrac;
  if (y >= allocation.endYear!) return endFrac;
  // Linear interpolation within glide window.
  const span = allocation.endYear! - effectiveGlideStartYear;
  const elapsed = y - effectiveGlideStartYear;
  return startFrac + (endFrac - startFrac) * (elapsed / span);
}

/**
 * Resolve the effective glide-start year + whether a glide is enabled for an
 * allocation override, given the household retirement year. Shared so the
 * deterministic context, the tooltip post-pass, and the MC mix builder
 * compute the same anchors.
 */
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

/**
 * Household BLENDED GLIDE return (percent) at calendar year `y`: the
 * configured growth/income return rates weighted by the year's target growth
 * share. Applied uniformly to each non-CBP account under allocation.
 */
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
