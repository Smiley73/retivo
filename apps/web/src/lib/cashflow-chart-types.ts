// Row and marker shapes for the cashflow band chart, in `lib/` so lib code need not import from `components/` (`lib-independent-of-ui`).

/**
 * Vertical reference line on the cashflow chart: a member's end of life
 * (`kind: 'death'`) or the retirement line. A death marker's `fractionalYear` is
 * the integer death year (death is Dec 31), which the inner chart maps to that
 * year's terminal sample (monthly: December, `deathYear + 11/12`; yearly: the
 * integer). A retirement marker keeps its true fractional date.
 */
export interface CashflowChartMarker {
  fractionalYear: number;
  label: string;
  color: string;
  /** `'death'`: an integer-year life-expectancy marker the monthly charts remap to the December sample; unset or `'retirement'`: a true fractional date. */
  kind?: 'death' | 'retirement';
}

/** Merged per-month expense and income sample, sorted by `fractionalYear`; amounts are annualized run-rates ($/yr at that month). */
export interface CashflowMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  essential: number;
  discretionary: number;
  /** Portfolio tax cash (federal tax + IRMAA − ACA-PTC) atop essential and discretionary; negative in a year the credit applied to premiums lowered the draw, so the stack top still equals what income covers. */
  taxes: number;
  /** Essential + discretionary + taxes: the expense-stack top and the shortfall comparison. */
  total: number;
  earned: number;
  withdrawal: number;
  totalIncome: number;
  /** Invisible baseline of the shortfall ribbon (= totalIncome). */
  shortfallBase: number;
  shortfallHeight: number;
  /** Per-category band values (id → dollars) in "by category" mode, allocated so `Σ byCategory === essential + discretionary`; undefined in Total mode. Never feeds `total` or `shortfallHeight`. */
  byCategory?: Record<string, number>;
}
