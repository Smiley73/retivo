// Row and marker shapes for the cashflow band chart, in `lib/` so lib code need not import from `components/` (`lib-independent-of-ui`).

/** Vertical reference line: a member's end of life (`kind: 'death'`, an integer year the monthly charts remap to that year's December sample) or the retirement line (true fractional date). */
export interface CashflowChartMarker {
  fractionalYear: number;
  label: string;
  color: string;
  kind?: 'death' | 'retirement';
}

/** Merged per-month expense and income sample, sorted by `fractionalYear`; amounts are annualized run-rates ($/yr at that month). */
export interface CashflowMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  essential: number;
  discretionary: number;
  /** Portfolio tax cash (federal tax + IRMAA − ACA-PTC) atop the expense stack; negative when the credit lowered the draw. */
  taxes: number;
  /** Essential + discretionary + taxes: the expense-stack top and the shortfall comparison. */
  total: number;
  earned: number;
  withdrawal: number;
  totalIncome: number;
  shortfallBase: number;
  shortfallHeight: number;
  /** Per-category band values (id → dollars) in "by category" mode, summing to `essential + discretionary`; undefined in Total mode. */
  byCategory?: Record<string, number>;
}
