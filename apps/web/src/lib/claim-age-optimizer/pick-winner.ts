/**
 * Pick the winning claim-age pair from a list of simulated metric
 * values. Highest metric wins; flat-surface ties break
 * to **lower primary age** first, then **lower secondary age**. The
 * `alreadyAtOptimum` flag is set when the winner matches the
 * scenario's resolved (inherited or local) pair — and equality
 * is "ageYears match with ageMonths defaulted to 0 on either side", so
 * the resolved pair carries its own `ageMonths` and the winner (always
 * `ageMonths: 0` per the whole-year search) only matches when both the
 * resolved primary and secondary are exact whole years.
 */

export interface CandidateResult {
  /** Always a real age. For the 1-D secondary fallback branch
   *  (primary PIA missing / past window) the orchestrator carries the
   *  resolved primary age forward unchanged — preserved, not
   *  optimised. The "PIA not set" / "Past claim-age window" cell on
   *  the page is driven by the OptimizerResult's `partial` flag +
   *  `missingPiaMembers` list, not by a null age here. */
  readonly primaryAgeYears: number;
  /** `null` for single-member households (or when secondary's grid
   *  was empty). */
  readonly secondaryAgeYears: number | null;
  readonly metricValue: number;
}

export interface ResolvedPair {
  readonly primaryAgeYears: number;
  /** ageMonths carried so `alreadyAtOptimum` can apply the
   *  "ageMonths defaulted to 0" rule — a resolved primary of
   *  `{70, 6}` is NOT already at optimum vs a winner of `70` (which
   *  is implicitly `{70, 0}` per the whole-year search). */
  readonly primaryAgeMonths?: number;
  readonly secondaryAgeYears: number | null;
  readonly secondaryAgeMonths?: number;
}

export interface PickWinnerArgs {
  readonly results: ReadonlyArray<CandidateResult>;
  readonly currentResolvedPair: ResolvedPair | null;
  /** Reserved for future tie-break rules; the current implementation
   *  always uses 'lower-age-wins'. */
  readonly tieBreakerRule?: 'lower-age-wins';
}

export interface Winner {
  /** Always a real age. The page gates the "PIA not
   *  set" cell on `OptimizerResult.missingPiaMembers`, not on a null
   *  age, and the merge helper requires a real primary age to write
   *  through Apply. */
  readonly primaryAgeYears: number;
  readonly secondaryAgeYears: number | null;
  readonly metricValue: number;
  readonly alreadyAtOptimum: boolean;
}

export function pickWinner(args: PickWinnerArgs): Winner | null {
  if (args.results.length === 0) return null;
  let best = args.results[0];
  for (let i = 1; i < args.results.length; i += 1) {
    const candidate = args.results[i];
    if (isBetter(candidate, best)) best = candidate;
  }
  return {
    primaryAgeYears: best.primaryAgeYears,
    secondaryAgeYears: best.secondaryAgeYears,
    metricValue: best.metricValue,
    alreadyAtOptimum: pairsEqual(best, args.currentResolvedPair),
  };
}

function isBetter(candidate: CandidateResult, current: CandidateResult): boolean {
  if (candidate.metricValue !== current.metricValue) {
    return candidate.metricValue > current.metricValue;
  }
  // Flat metric tie → lower primary age wins.
  if (candidate.primaryAgeYears !== current.primaryAgeYears) {
    return candidate.primaryAgeYears < current.primaryAgeYears;
  }
  // Primary tied → lower secondary age wins. `null` (single-member /
  // past-window) is treated as larger than any real age so a
  // partial-secondary pair loses the tie to a fully-specified pair on
  // the same metric — defensive, since pairs in one result set are
  // expected to be uniform in shape.
  const candidateSecondary = candidate.secondaryAgeYears ?? Number.POSITIVE_INFINITY;
  const currentSecondary = current.secondaryAgeYears ?? Number.POSITIVE_INFINITY;
  return candidateSecondary < currentSecondary;
}

/**
 * The metric value of the candidate sitting at the scenario's CURRENT
 * (resolved) claim ages — the baseline the recommendation is compared
 * against in the "current → recommended" cell. `undefined` when the
 * current pair isn't a whole-year candidate in the searched grid (e.g. a
 * current claim age carrying months, or one already past the search
 * window), in which case there's no exact baseline to show. Uses the same
 * equality rule as `alreadyAtOptimum` (the resolved override's
 * ageMonths must be 0 to match a whole-year candidate).
 */
export function baselineMetricForResolved(
  results: ReadonlyArray<CandidateResult>,
  resolved: ResolvedPair | null,
): number | undefined {
  if (resolved === null) return undefined;
  const match = results.find((r) => pairsEqual(r, resolved));
  return match?.metricValue;
}

function pairsEqual(
  result: CandidateResult,
  resolved: ResolvedPair | null,
): boolean {
  if (resolved === null) return false;
  if (result.primaryAgeYears !== resolved.primaryAgeYears) return false;
  // Winners always carry `ageMonths: 0` (whole-year search), so
  // any non-zero `primaryAgeMonths` on the resolved override breaks
  // equality — `{70, 6}` is NOT already at optimum vs winner `70`.
  if ((resolved.primaryAgeMonths ?? 0) !== 0) return false;
  if (result.secondaryAgeYears !== resolved.secondaryAgeYears) return false;
  if ((resolved.secondaryAgeMonths ?? 0) !== 0) return false;
  return true;
}
