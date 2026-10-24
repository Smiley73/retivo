// Predicate for "did the portfolio give out by the last surviving member's death year", shared by the At-horizon cards and the
// stress-test horizon cards so both flip to danger on one condition. Token-agnostic; `lastDeathYear` is the integer death year.

export interface HorizonStatusInput {
  /** Balance at the horizon year; null when the drawdown did not run. */
  readonly balance: number | null;
  /** First year the portfolio ran out; null when the method funded the full horizon. */
  readonly depletionYear: number | null;
  /** Last surviving member's death year; null without a usable birthdate, falling back to the zero-balance heuristic. */
  readonly lastDeathYear: number | null;
}

export interface HorizonStatusResult {
  /** Depleted at or before the last death year; also true for a zero balance with no depletion year (an MC kernel can report that). */
  readonly isDanger: boolean;
}

export function horizonStatus(input: HorizonStatusInput): HorizonStatusResult {
  if (input.depletionYear !== null) {
    if (input.lastDeathYear !== null && input.depletionYear <= input.lastDeathYear) {
      return { isDanger: true };
    }
    return { isDanger: false };
  }
  // Fallback: a zero horizon balance without a depletion year counts as depleted; negative balances stay flagged.
  if (input.balance !== null && input.balance <= 0) {
    return { isDanger: true };
  }
  return { isDanger: false };
}
