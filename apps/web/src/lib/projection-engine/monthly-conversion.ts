/**
 * Monthly-stepping conversion helpers shared between the deterministic
 * projection engine and the Monte Carlo runner.
 */

/**
 * Convert an annual percent rate (e.g. 7 for 7 %/yr) to its monthly
 * equivalent percent that compounds to the same annual factor:
 * `(1 + annual/100)^(1/12) - 1`, scaled back to percent. Used to thread
 * the user's annual-scalar inputs (`ratePct`, `inflationPct`) into the
 * kernel's monthly step factor without changing UX.
 */
export function monthlyEquivalent(annualPct: number): number {
  return (Math.pow(1 + annualPct / 100, 1 / 12) - 1) * 100;
}

/** Whole-month gap from (yearA, monthA) to (yearB, monthB), with both
 *  month indices 0-based (Jan = 0). Negative when B precedes A. */
export function monthsBetween(
  yearA: number,
  monthA: number,
  yearB: number,
  monthB: number,
): number {
  return (yearB - yearA) * 12 + (monthB - monthA);
}

/** Step index of a retirement date relative to the first projected
 *  month. Step 0 = January of `firstYear`. */
export function stepIndexAtRetirement(
  retirementYear: number,
  retirementMonth: number,
  firstYear: number,
): number {
  return monthsBetween(firstYear, 0, retirementYear, retirementMonth);
}

/** Aggregate a length-`12·N` per-step `Float64Array` into a length-`N`
 *  array, summing each year's twelve values. `firstStep` is the index
 *  in `perStep` corresponding to January of the first emitted year. */
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
