/**
 * Shared "did the portfolio give out before the last surviving member
 * died?" predicate. Used by the deterministic "At horizon" stat cards
 * on `BalanceProjectionPage` and the stress-test horizon cards on
 * `PlanStressTestSection` so both surfaces flip to `var(--danger)` on
 * the same condition.
 *
 * The helper is UI-token-agnostic — callers apply their own color. The
 * `lastDeathYear` parameter is named for clarity in isolation: it
 * answers "did the portfolio deplete at or before the last surviving
 * member's projected death year?" `lastDeathYear` is now the integer
 * death year (death = Dec 31 of `deathYear`, the life-expectancy year);
 * callers resolve it upstream from the household's life-expectancy
 * markers (`Math.ceil` of an integer marker is the identity).
 */

export interface HorizonStatusInput {
  /** Portfolio balance at the horizon year. May be `null` when the
   *  drawdown didn't run (deterministic side surfaces "—" instead). */
  readonly balance: number | null;
  /** First calendar year the portfolio ran out of dollars. `null` when
   *  the chosen method funded the full horizon. */
  readonly depletionYear: number | null;
  /** Last surviving household member's projected death year. `null`
   *  when no member has a usable birthdate — the helper falls back to
   *  the zero-balance heuristic for the stress-test card. */
  readonly lastDeathYear: number | null;
}

export interface HorizonStatusResult {
  /** True when the projection depleted before — or at — the last
   *  surviving member's death year. Stress-test fallback:
   *  also true when `balance` is at-or-near zero and the drawdown
   *  engine didn't expose a depletion year (e.g. when the MC kernel
   *  reports a zero ending balance without a separate depletion
   *  signal). */
  readonly isDanger: boolean;
}

export function horizonStatus(input: HorizonStatusInput): HorizonStatusResult {
  if (input.depletionYear !== null) {
    // Authoritative signal: drawdown reported the exact depletion year.
    // Compare to the household's last surviving death year; depletion
    // at-or-before that year flips the card to danger.
    if (input.lastDeathYear !== null && input.depletionYear <= input.lastDeathYear) {
      return { isDanger: true };
    }
    return { isDanger: false };
  }
  // Stress-test fallback: when the drawdown side doesn't expose a
  // depletion year but the horizon balance reads as zero, treat that
  // as a depletion-by-end-of-horizon. Negative balances stay flagged.
  if (input.balance !== null && input.balance <= 0) {
    return { isDanger: true };
  }
  return { isDanger: false };
}
