// Shared chart-marker helpers, so every chart's marker kinds read as one consistent stack.

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
 * Y-axis floor ($) for the projection charts' log-scale mode, shared so the stacked
 * charts clip identically. A domain starting at 1 wastes the chart height on the
 * empty $1-$10k band; `allowDataOverflow` stays on so a lower point clips to the floor.
 */
export const LOG_SCALE_FLOOR = 10000;

// Marker-label vertical staggering for every chart that floats `<ReferenceLine>` labels in the top margin.
// Markers closer than `MIN_DELTA_YEARS` take alternating slots stepping further up; slot 0 is nearest the plot edge.
const SLOT_COUNT = 3;
const SLOT_BASE_DY = -16;
const SLOT_STEP_DY = -14;
const MIN_DELTA_YEARS = 4;

/** Slot index to `dy` offset (px) for a `position: 'top'` marker label. */
export function markerSlotDy(slot: number): number {
  return SLOT_BASE_DY + slot * SLOT_STEP_DY;
}

/**
 * Year ticks whose step (1, 2, 5 or 10 years) adapts to the visible span, so a
 * zoomed window still gets labels (2031–2034 holds no multiple of 5). The full
 * horizon lands on the 5-year grid.
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
 * Fixed 5-year ticks for the safe-withdrawal-rate and composition charts. A
 * window as short as two years may straddle no multiple of 5, so it falls back
 * to the first and last year rather than an axis with no year label.
 */
export function fiveYearTicks(min: number, max: number): number[] {
  const start = Math.ceil(min / 5) * 5;
  const ticks: number[] = [];
  for (let y = start; y <= max; y += 5) ticks.push(y);
  if (ticks.length === 0) return min === max ? [min] : [min, max];
  return ticks;
}

/**
 * Assigns each marker a vertical `slot` so labels for markers closer than
 * `MIN_DELTA_YEARS` stagger: sorted by `fractionalYear`, a close marker takes the
 * predecessor's next slot (wrapping at `SLOT_COUNT`), otherwise slot 0.
 * Caller fields are preserved. Pure.
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
