/** Monthly-stepping conversion helpers shared by the deterministic engine and the Monte Carlo runner. */

/** Annual percent rate to the monthly percent that compounds to the same annual factor: `(1 + annual/100)^(1/12) - 1`. */
export function monthlyEquivalent(annualPct: number): number {
  return (Math.pow(1 + annualPct / 100, 1 / 12) - 1) * 100;
}

/** Whole-month gap from (yearA, monthA) to (yearB, monthB); months are 0-based; negative when B precedes A. */
export function monthsBetween(
  yearA: number,
  monthA: number,
  yearB: number,
  monthB: number,
): number {
  return (yearB - yearA) * 12 + (monthB - monthA);
}

/** Step index of a retirement date relative to January of `firstYear` (step 0). */
export function stepIndexAtRetirement(
  retirementYear: number,
  retirementMonth: number,
  firstYear: number,
): number {
  return monthsBetween(firstYear, 0, retirementYear, retirementMonth);
}

/** Sums each year's twelve values of a per-step array; `firstStep` is the index of January of the first emitted year. */
export function aggregateMonthlyToYearly(
  perStep: Float64Array,
  firstStep: number,
  yearCount: number,
): number[] {
  const out: number[] = new Array(yearCount).fill(0);
  for (let y = 0; y < yearCount; y += 1) {
    let sum = 0;
    for (let m = 0; m < 12; m += 1) {
      const idx = firstStep + y * 12 + m;
      if (idx >= 0 && idx < perStep.length) sum += perStep[idx];
    }
    out[y] = sum;
  }
  return out;
}
