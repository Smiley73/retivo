/**
 * Shared contribution-growth-factor helper consumed by BOTH the
 * deterministic projection engine (`projection.ts`) and the Monte Carlo
 * per-account ledger (`balance-projection-bundle-mc-ledger.ts`).
 *
 * The configured per-account contribution figure is interpreted as a
 * TODAY'S-dollars amount (factor = 1 at `asOfMonth`). An explicit
 * `contributionGrowthPct` (fixed-COLA mode) grows the contribution
 * nominally across accumulation steps month-precise, today-anchored —
 * mirroring `expense-projection.ts`'s `buildInflationFactorAt`:
 *
 *   factor(eventMonth) = (1 + pct/100)^((eventMonth − asOfMonth) / 12)
 *   asOfMonth = todayYear * 12 + todayMonthIndex
 *
 * Anchoring at TODAY (not the projection's own first step) is the whole
 * point: it cancels the display deflator (which uses the same today
 * anchor), so a configured contribution shows flat in the default
 * Today's-dollars view in BOTH engines and BOTH view modes.
 *
 * `tracks-inflation` accounts (absent `contributionGrowthPct`) do NOT
 * use this helper for their growth — the deterministic engine grows them
 * at the resolved scenario inflation rate (so the resolver materialises
 * that rate as a `fixed`-mode equivalent), while the MC engine scales the
 * today's-dollars base by each path's own cumulative CPI. The helper only
 * ever applies an explicit fixed-nominal rate.
 *
 * Sanitisation: the accepted domain is finite and `-100 < pct ≤ 25`.
 * An out-of-band / non-finite percent yields a factor of 1 (no growth) so
 * a corrupt stored value can never overflow the ~60-offset compounding
 * into Infinity/NaN and poison the projection / reconciliation invariant.
 */

/** Lower bound (exclusive) on a valid `contributionGrowthPct`. A −100%
 *  rate would zero the contribution outright; anything below is data
 *  error. */
export const MIN_CONTRIBUTION_GROWTH_PCT = -100;
/** Upper bound (inclusive) on a valid `contributionGrowthPct`. A
 *  safety rail, not a modeling claim: 25%/yr nominal lets a user model
 *  aggressive raises; above is almost certainly corrupt. The
 *  `PercentInput` uses `max={25}` to match. */
export const MAX_CONTRIBUTION_GROWTH_PCT = 25;
/** Minimum value the annual-increase PercentInput allows; the validator's lower bound is exclusive -100, so we stay safely above it. */
export const MIN_CONTRIBUTION_GROWTH_PCT_INPUT = -99;

/**
 * True iff `pct` is a finite percent inside the accepted domain
 * `(-100, 25]`. Used by the resolver + migration to decide whether
 * a stored value is honored or dropped to the tracks-inflation default.
 */
export function isValidContributionGrowthPct(pct: unknown): pct is number {
  return (
    typeof pct === 'number' &&
    Number.isFinite(pct) &&
    pct > MIN_CONTRIBUTION_GROWTH_PCT &&
    pct <= MAX_CONTRIBUTION_GROWTH_PCT
  );
}

/**
 * Month-precise, today-anchored growth factor for an explicit fixed-COLA
 * `contributionGrowthPct`. Returns 1 at `asOfMonth` and for any
 * out-of-band / non-finite percent (the guard) or a `0` rate.
 *
 * @param pct          fixed annual growth percent (e.g. 3 for 3 %/yr).
 * @param eventMonth   absolute month index of the contribution step
 *                     (`stepYear * 12 + stepMonthIndex`).
 * @param asOfMonth    today's absolute month index
 *                     (`todayYear * 12 + todayMonthIndex`).
 */
export function contributionGrowthFactor(
  pct: number,
  eventMonth: number,
  asOfMonth: number,
): number {
  if (!isValidContributionGrowthPct(pct) || pct === 0) return 1;
  return Math.pow(1 + pct / 100, (eventMonth - asOfMonth) / 12);
}
