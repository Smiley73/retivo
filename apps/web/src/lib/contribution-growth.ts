// Month-precise growth factor for an explicit `contributionGrowthPct` (factor 1 at `asOfMonth`); `tracks-inflation` accounts do not use it.

/** Lower bound (exclusive): -100% would zero the contribution, so anything below is a data error. */
const MIN_CONTRIBUTION_GROWTH_PCT = -100;
/** Upper bound (inclusive): a safety rail for aggressive raises, not a modeling claim. */
export const MAX_CONTRIBUTION_GROWTH_PCT = 25;
/** Lowest value the annual-increase input allows: just above the validator's exclusive -100. */
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

/** Growth factor `(1 + pct/100)^((eventMonth − asOfMonth) / 12)`, months as `year * 12 + monthIndex`; an out-of-band percent gives 1 so corrupt data cannot compound into Infinity or NaN. */
export function contributionGrowthFactor(
  pct: number,
  eventMonth: number,
  asOfMonth: number,
): number {
  if (!isValidContributionGrowthPct(pct) || pct === 0) return 1;
  return Math.pow(1 + pct / 100, (eventMonth - asOfMonth) / 12);
}
