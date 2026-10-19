/**
 * Sampling-noise gate for a difference between two Monte Carlo success
 * probabilities.
 *
 * The two runs are summary-only (no per-path outcomes are retained), so a true
 * paired standard error is unavailable. The gate uses the INDEPENDENT
 * two-proportion standard error `sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)`, an upper
 * bound on the paired one: it can over-suppress a real difference, never
 * manufacture a false one. A difference is signal only when `|delta| > se`.
 * Each side carries its own path count, because a cached run stamps its own.
 * See "The Monte Carlo stress test" in docs/math-projections.md.
 *
 * Pure; probabilities are fractions in 0..1 and path counts are positive.
 */
export interface SuccessDeltaGate {
  /** `p1 - p2` (0..1 scale). */
  readonly delta: number;
  /** Unpaired two-proportion standard error of `delta` (0..1 scale). */
  readonly se: number;
  /** `|delta| > se`. With `se = 0` (both sides at 0 or 1) any non-zero delta is
   *  signal and a zero delta is not. */
  readonly meaningful: boolean;
}

export function successDeltaGate(
  p1: number,
  pathCount1: number,
  p2: number,
  pathCount2: number,
): SuccessDeltaGate {
  const var1 = (p1 * (1 - p1)) / pathCount1;
  const var2 = (p2 * (1 - p2)) / pathCount2;
  const se = Math.sqrt(var1 + var2);
  const delta = p1 - p2;
  return { delta, se, meaningful: Math.abs(delta) > se };
}
