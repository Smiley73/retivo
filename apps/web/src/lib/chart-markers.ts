/**
 * Shared chart-marker helpers.
 *
 * `labelAnchorForX` returns the SVG `text-anchor` value the engine's
 * marker label should use given the marker's fractional X position
 * relative to the visible X domain. Past 75 % of the domain
 * the label is right-anchored so wide labels (e.g. "Christopher life
 * expectancy 87" on the rightmost death marker) extend leftward from
 * the line instead of getting clipped by the plot area.
 *
 * Charts render multiple marker kinds (retirement, life-expectancy,
 * scenario boundaries) — every one of them shares this rule so the
 * cluster reads as a consistent stack.
 */
export function labelAnchorForX(
  fractionalYear: number,
  xMin: number,
  xMax: number,
): 'start' | 'middle' | 'end' {
  if (!Number.isFinite(fractionalYear) || xMax <= xMin) return 'middle';
  const t = (fractionalYear - xMin) / (xMax - xMin);
  return t > 0.75 ? 'end' : 'middle';
}

/**
 * Y-axis domain floor ($) for the projection charts' log-scale mode.
 * Shared by `ProjectionChartInner` and `MonteCarloFanChart` so the two
 * stacked charts clip identically. On a log scale a domain starting at
 * `1` wastes most of the chart height on the empty $1–$10k band; the
 * $10k floor lets the plotted curves use the full height. `allowData-
 * Overflow` stays on in log mode so any sub-$10k point clips to the
 * floor rather than re-expanding the domain. Linear mode is unaffected.
 */
export const LOG_SCALE_FLOOR = 10000;

// Marker-label vertical staggering, shared by every chart that floats
// `<ReferenceLine>` labels in the top margin (cashflow, income
// breakdown, portfolio flows, tax burden, account-balance stack,
// projection, Monte Carlo, and the expense charts). Two markers closer
// than `MIN_DELTA_YEARS` would render their labels in roughly the same
// place at typical chart widths; alternate slots step further into the
// top margin so labels never overlap. Slot 0 sits closest to the plot
// edge; higher slots float up. Wrapping at `SLOT_COUNT` keeps a long
// cluster from marching off the top of the chart.
const SLOT_COUNT = 3;
// Lifted further into the top margin so the first-slot label clears the
// top Y-axis tick label (they previously crowded each other).
const SLOT_BASE_DY = -16;
const SLOT_STEP_DY = -14;
const MIN_DELTA_YEARS = 4;

/**
 * Slot index → `dy` offset (px) for a `position: 'top'` marker label so
 * stacked labels don't overlap in the top margin.
 */
export function markerSlotDy(slot: number): number {
  return SLOT_BASE_DY + slot * SLOT_STEP_DY;
}

/**
 * Year-axis ticks whose interval adapts to the visible span, so zooming in
 * still shows labels. A fixed 5-year step leaves a narrow zoom window with
 * one or zero ticks (e.g. 2031–2034 contains no multiple of 5); this picks
 * a "nice" step — 1 / 2 / 5 / 10 years — sized to the span and emits
 * multiples of it within `[min, max]`. The un-zoomed full horizon
 * (~40+ years) still lands on the familiar 5-year grid.
 */
export function adaptiveYearTicks(min: number, max: number): number[] {
  const span = Math.max(0, max - min);
  const step = span <= 6 ? 1 : span <= 14 ? 2 : span <= 50 ? 5 : 10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let y = start; y <= max; y += step) ticks.push(y);
  return ticks;
}

/**
 * Fixed 5-year tick cadence (not the adaptive cadence `adaptiveYearTicks`
 * picks for other charts), used by the safe-withdrawal-rate comparison chart
 * and the composition chart it feeds. A short window straddling no
 * multiple of 5 (e.g. 2032–2033) returns no ticks at all from the plain
 * cadence — these charts' own window can be as short as two plotted years
 * — so this falls back to labelling the first and last plotted year rather
 * than leaving the axis with no year label at all. Shared here (rather than
 * duplicated per chart module, as `SafeWithdrawalRateChartInner`,
 * `AccountBalanceStackChartInner` and `ExpensesCategoryChartInner` each did)
 * so a new caller doesn't add a fourth private copy; the three existing
 * private copies are left as-is.
 */
export function fiveYearTicks(min: number, max: number): number[] {
  const start = Math.ceil(min / 5) * 5;
  const ticks: number[] = [];
  for (let y = start; y <= max; y += 5) ticks.push(y);
  if (ticks.length === 0) return min === max ? [min] : [min, max];
  return ticks;
}

/**
 * Assign each marker a vertical `slot` so labels for markers closer than
 * `MIN_DELTA_YEARS` stagger instead of overlapping. Markers are sorted
 * by `fractionalYear`; a marker within `MIN_DELTA_YEARS` of its
 * predecessor takes the next slot (wrapping at `SLOT_COUNT`), otherwise
 * it resets to slot 0. The returned objects preserve every caller field
 * (the input `T`) plus the added `slot`. Pure.
 *
 * Input is `ReadonlyArray<T>` so callers passing a readonly
 * `markers ?? []` prop (e.g. `TaxBurdenChartInner`,
 * `AccountBalanceStackChartInner`) and callers passing a mutable array
 * both type-check.
 */
export function assignMarkerLabelSlots<T extends { fractionalYear: number }>(
  markers: ReadonlyArray<T>,
): Array<T & { slot: number }> {
  const sorted = [...markers].sort(
    (a, b) => a.fractionalYear - b.fractionalYear,
  );
  const out: Array<T & { slot: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    const prev = out[i - 1];
    const tooClose =
      prev !== undefined &&
      sorted[i].fractionalYear - prev.fractionalYear < MIN_DELTA_YEARS;
    const slot = tooClose ? (prev.slot + 1) % SLOT_COUNT : 0;
    out.push({ ...sorted[i], slot });
  }
  return out;
}
