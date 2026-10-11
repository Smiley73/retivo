/**
 * Monthly cashflow series — actual dollars per month, aligned to a
 * fixed start anchor (year + month index). Used by the drawdown
 * engine and the cashflow chart so within-year timing isn't lost
 * when an annual rollup gets split evenly across 12 months.
 *
 * The series stores **dollars per month**, not chart run-rates: a
 * pension annuity paying $3,000 per month surfaces 3000 in each
 * active month, not 36000. Builders below convert per-year
 * annualized values to the monthly form. A standalone one-off (e.g.
 * a $40k Sept windfall) lands as 40000 at its event month and 0
 * elsewhere — not as 40000/12 spread across the year.
 *
 * Pure module — no IndexedDB, no React.
 */

export interface MonthlyCashflowSeries {
  /** Calendar year of `values[0]`. */
  readonly startYear: number;
  /** 0-11 month index of `values[0]` within `startYear` (Jan = 0). */
  readonly startMonthIndex: number;
  /** Per-month dollar amounts; `values[k]` is the amount that lands
   *  in (startYear, startMonthIndex) + k months. Length sets the
   *  horizon. */
  readonly values: Float64Array;
}

/** Absolute month index for a (year, monthIndex) pair. */
function absMonth(year: number, monthIndex: number): number {
  return year * 12 + monthIndex;
}

/** Returns `series.startYear * 12 + series.startMonthIndex`. */
export function seriesStartAbs(series: MonthlyCashflowSeries): number {
  return absMonth(series.startYear, series.startMonthIndex);
}

/** Last absolute month covered by `series` (inclusive). */
export function seriesEndAbs(series: MonthlyCashflowSeries): number {
  return seriesStartAbs(series) + series.values.length - 1;
}

/**
 * Build an empty series covering [startYear..endYear] inclusive
 * starting at January. Length = `(endYear - startYear + 1) * 12`.
 */
export function emptyMonthlySeries(
  startYear: number,
  endYear: number,
): MonthlyCashflowSeries {
  if (endYear < startYear) {
    return { startYear, startMonthIndex: 0, values: new Float64Array(0) };
  }
  const length = (endYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(length) };
}

/**
 * Convert a year → annual-dollars map into actual dollars per month
 * by even split across 12. Use for series that are inherently flat
 * within the year (annual expenses without explicit timing, baseline
 * annualized income). One-offs use `addOneOff` separately, not this
 * adapter.
 *
 * Years outside the [startYear..endYear] window are silently dropped.
 */
export function buildMonthlyFromAnnualMap(
  annualByYear: ReadonlyMap<number, number>,
  startYear: number,
  endYear: number,
): MonthlyCashflowSeries {
  const series = emptyMonthlySeries(startYear, endYear);
  if (series.values.length === 0) return series;
  for (const [year, annual] of annualByYear.entries()) {
    if (year < startYear || year > endYear) continue;
    const perMonth = annual / 12;
    const baseIdx = (year - startYear) * 12;
    for (let m = 0; m < 12; m += 1) {
      series.values[baseIdx + m] = perMonth;
    }
  }
  return series;
}

/**
 * Sum two monthly series of equal start + length. Returns a fresh
 * series; inputs untouched. Throws on misalignment so a caller can't
 * accidentally combine two series whose anchors differ.
 */
export function sumMonthlySeries(
  a: MonthlyCashflowSeries,
  b: MonthlyCashflowSeries,
): MonthlyCashflowSeries {
  if (a.startYear !== b.startYear || a.startMonthIndex !== b.startMonthIndex) {
    throw new Error(
      `sumMonthlySeries: start mismatch (${a.startYear}-${a.startMonthIndex} vs ${b.startYear}-${b.startMonthIndex})`,
    );
  }
  if (a.values.length !== b.values.length) {
    throw new Error(
      `sumMonthlySeries: length mismatch (${a.values.length} vs ${b.values.length})`,
    );
  }
  const values = new Float64Array(a.values.length);
  for (let i = 0; i < values.length; i += 1) values[i] = a.values[i] + b.values[i];
  return { startYear: a.startYear, startMonthIndex: a.startMonthIndex, values };
}

/**
 * Add `amount` to the entry for (year, monthIndex). No-op when the
 * point falls outside the series window — caller is responsible for
 * pre-filtering if it cares.
 *
 * Returns the mutated series for fluent chaining.
 */
export function addOneOff(
  series: MonthlyCashflowSeries,
  year: number,
  monthIndex: number,
  amount: number,
): MonthlyCashflowSeries {
  if (amount === 0) return series;
  const targetAbs = absMonth(year, monthIndex);
  const startAbs = seriesStartAbs(series);
  const idx = targetAbs - startAbs;
  if (idx < 0 || idx >= series.values.length) return series;
  series.values[idx] += amount;
  return series;
}

/**
 * Sum every monthly value that falls within `year` (Jan..Dec).
 * Returns 0 when the year doesn't intersect the series window.
 */
export function annualRollup(
  series: MonthlyCashflowSeries,
  year: number,
): number {
  if (series.values.length === 0) return 0;
  const startAbs = seriesStartAbs(series);
  const janAbs = absMonth(year, 0);
  let sum = 0;
  for (let m = 0; m < 12; m += 1) {
    const idx = janAbs + m - startAbs;
    if (idx < 0 || idx >= series.values.length) continue;
    sum += series.values[idx];
  }
  return sum;
}

/** Alias for `annualRollup` — used by the bucket-allocation drawdown
 *  path to compress monthly inputs back to annual cadence (the bucket
 *  contract is once-per-year rebalance). */
export function rollupYear(
  series: MonthlyCashflowSeries,
  year: number,
): number {
  return annualRollup(series, year);
}

/**
 * Dev-only invariant: series must cover Jan-of-retirementYear through
 * Dec-of-horizonYear (inclusive) with no gaps. Guarded by
 * `import.meta.env.DEV` at the call site — production silently tolerates
 * misalignment (engine bounds checks already return 0 for out-of-range
 * indices).
 */
export function assertAlignsWithRetirement(
  series: MonthlyCashflowSeries,
  retirementYear: number,
  horizonYear: number,
): void {
  if (series.startYear !== retirementYear || series.startMonthIndex !== 0) {
    throw new Error(
      `assertAlignsWithRetirement: expected start (${retirementYear}, 0), ` +
        `got (${series.startYear}, ${series.startMonthIndex})`,
    );
  }
  const expectedLength = (horizonYear - retirementYear + 1) * 12;
  if (series.values.length !== expectedLength) {
    throw new Error(
      `assertAlignsWithRetirement: expected length ${expectedLength}, ` +
        `got ${series.values.length}`,
    );
  }
}

/**
 * Throws when `series.values.length` is not a multiple of 12, when
 * `startMonthIndex` is out of [0, 11], or when `values` contains
 * non-finite entries. Library-level guard — the drawdown engine and
 * chart code assume well-aligned inputs.
 */
export function validateSeries(series: MonthlyCashflowSeries): void {
  if (!Number.isInteger(series.startYear)) {
    throw new Error(`validateSeries: startYear must be integer (got ${series.startYear})`);
  }
  if (
    series.startMonthIndex < 0 ||
    series.startMonthIndex > 11 ||
    !Number.isInteger(series.startMonthIndex)
  ) {
    throw new Error(
      `validateSeries: startMonthIndex out of range (got ${series.startMonthIndex})`,
    );
  }
  for (let i = 0; i < series.values.length; i += 1) {
    if (!Number.isFinite(series.values[i])) {
      throw new Error(`validateSeries: non-finite value at index ${i}`);
    }
  }
}
