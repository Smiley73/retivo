/**
 * Monthly cashflow series: actual dollars per month (not chart run-rates) from a fixed start anchor, used by the drawdown engine and the cashflow chart.
 * A $3,000 monthly pension is 3000 in each active month; a one-off lands whole in its event month rather than spread across the year.
 */

export interface MonthlyCashflowSeries {
  /** Calendar year of `values[0]`. */
  readonly startYear: number;
  /** 0-11 month index of `values[0]` within `startYear` (Jan = 0). */
  readonly startMonthIndex: number;
  /** Per-month dollar amounts; `values[k]` lands in (startYear, startMonthIndex) + k months. */
  readonly values: Float64Array;
}

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

/** Empty series covering [startYear..endYear] from January. */
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
 * Even-split an annual-dollars-by-year map into dollars per month; years outside the window are
 * dropped. One-offs use `addOneOff`.
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

/** Sum two series of equal start and length into a fresh series; throws on misalignment. */
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
 * Add `amount` at (year, monthIndex); a no-op outside the series window. Returns the mutated
 * series.
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

/** Sum the monthly values within `year`; 0 when the year misses the window. */
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

/** Alias for `annualRollup`. */
export function rollupYear(
  series: MonthlyCashflowSeries,
  year: number,
): number {
  return annualRollup(series, year);
}

/**
 * Dev-only invariant (guarded by `import.meta.env.DEV` at the call site): the series covers Jan of
 * retirementYear through Dec of horizonYear without gaps.
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
 * Throws when the length is not a multiple of 12, `startMonthIndex` is outside [0, 11], or a value
 * is non-finite.
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
