/** Monthly-stepping conversion helpers shared by the deterministic engine and the Monte Carlo runner. */

/** Annual percent rate to the monthly percent that compounds to the same annual factor: `(1 + annual/100)^(1/12) - 1`. */
export function monthlyEquivalent(annualPct: number): number {
  return (Math.pow(1 + annualPct / 100, 1 / 12) - 1) * 100;
}
