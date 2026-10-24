// Contribution growth factor shared by the deterministic engine and the Monte Carlo ledger: a today's-dollars figure (factor 1 at `asOfMonth`),
// grown month-precise from today for an explicit `contributionGrowthPct`. `tracks-inflation` accounts do not use this helper.

/** Lower bound (exclusive): -100% would zero the contribution, so anything below is a data error. */
export const MIN_CONTRIBUTION_GROWTH_PCT = -100;
/** Upper bound (inclusive): a safety rail for aggressive raises, not a modeling claim; `PercentInput` uses `max={25}`. */
export const MAX_CONTRIBUTION_GROWTH_PCT = 25;
/** Minimum value the annual-increase PercentInput allows; the validator's lower bound is exclusive -100, so we stay safely above it. */
export const MIN_CONTRIBUTION_GROWTH_PCT_INPUT = -99;

/** True iff `pct` is finite and in `(-100, 25]`; the resolver and migration drop any other stored value to tracks-inflation. */
export function isValidContributionGrowthPct(pct: unknown): pct is number {
  return (
    typeof pct === 'number' &&
    Number.isFinite(pct) &&
    pct > MIN_CONTRIBUTION_GROWTH_PCT &&
    pct <= MAX_CONTRIBUTION_GROWTH_PCT
  );
}

/**
 * Growth factor `(1 + pct/100)^((eventMonth − asOfMonth) / 12)`, with months as
 * `year * 12 + monthIndex`. An out-of-band or non-finite percent gives 1, so a
 * corrupt value cannot overflow the compounding into Infinity or NaN.
 */
export function contributionGrowthFactor(
  pct: number,
  eventMonth: number,
  asOfMonth: number,
): number {
  if (!isValidContributionGrowthPct(pct) || pct === 0) return 1;
  return Math.pow(1 + pct / 100, (eventMonth - asOfMonth) / 12);
}
