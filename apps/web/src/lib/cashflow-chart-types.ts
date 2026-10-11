/**
 * Shared row/marker shapes for the cashflow band chart (`CashflowProjectionChart`)
 * and its lib-side producers/consumers. Lives in `lib/` (not the component
 * file) so `lib/` code that needs these shapes doesn't have to import from
 * `components/` (see `.dependency-cruiser.cjs` — `lib-independent-of-ui`).
 */

/**
 * Vertical reference line dropped on the cashflow chart. Used both for a
 * member's projected end-of-life (`kind: 'death'`) and for the canonical
 * teal retirement line (`kind` unset / `'retirement'`).
 *
 * For death markers `fractionalYear` is the **integer death year**
 * (`birthYear + resolvedLifeExpectancyAge`; death is modelled on Dec 31
 * of that year). The inner chart maps a death marker to the
 * terminal data point of its death year in the active granularity so it
 * hugs the data: monthly → the December sample (`deathYear + 11/12`);
 * yearly → the integer `deathYear`. Retirement markers carry a true
 * fractional date and are NOT remapped. `color` is shared by the dashed
 * line and its label. The inner chart staggers labels vertically when
 * two markers sit within a few years of each other.
 */
export interface CashflowChartMarker {
  fractionalYear: number;
  label: string;
  color: string;
  /** `'death'` → an integer-year life-expectancy marker the monthly/
   *  always-monthly charts remap to the December sample. Unset /
   *  `'retirement'` → a true fractional date, rendered as-is. */
  kind?: 'death' | 'retirement';
}

/**
 * Merged per-month cashflow sample. Both expense + income live here so
 * the chart renders a single flat array sorted by `fractionalYear`. All
 * amounts are annualized run-rates ($/yr at that month).
 */
export interface CashflowMonthlyPoint {
  fractionalYear: number;
  year: number;
  month0: number;
  essential: number;
  discretionary: number;
  /** Portfolio tax cash (federal tax + IRMAA surcharge − ACA-PTC) at
   *  this sample — the Taxes band atop essential/discretionary. */
  taxes: number;
  /** Essential + discretionary + taxes — drives the expense-stack top
   *  and the shortfall comparison. */
  total: number;
  earned: number;
  withdrawal: number;
  totalIncome: number;
  /** Invisible baseline of the shortfall ribbon (= totalIncome). */
  shortfallBase: number;
  shortfallHeight: number;
  /** Per-expense-category band values (id → dollars) in "by category"
   *  mode; allocated against the displayed essential+discretionary
   *  via exact residual allocation so `Σ byCategory === essential +
   *  discretionary`. `undefined` in Total mode. NEVER feeds `total` /
   *  `shortfallHeight` (those stay on essential+discretionary+taxes). */
  byCategory?: Record<string, number>;
}
