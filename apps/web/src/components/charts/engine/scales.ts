/**
 * Pure scale + domain helpers for the SVG chart engine. No JSX, no DOM —
 * fully unit-testable. Maps data-space values to pixel-space positions
 * inside a plot rectangle.
 */
import type { ChartDatum, SeriesSpec } from './types';

/** Floor ($) for log-scale Y domains: starting at 1 wastes the height on the empty $1-$10k band. */
export const LOG_FLOOR = 10000;

/** Linear map: value in [d0,d1] → pixel in [r0,r1]. */
export function linearScale(
  value: number,
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): number {
  if (d1 === d0) return r0;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

/** Log map (base 10), clamping values below `floor` to `floor`. */
export function logScale(
  value: number,
  d0: number,
  d1: number,
  r0: number,
  r1: number,
  floor = LOG_FLOOR,
): number {
  const lo = Math.max(floor, d0);
  const hi = Math.max(lo * 1.0001, d1);
  const v = Math.max(floor, value);
  const ld0 = Math.log10(lo);
  const ld1 = Math.log10(hi);
  const lv = Math.log10(v);
  return r0 + ((lv - ld0) / (ld1 - ld0)) * (r1 - r0);
}

/** Map a data x to a pixel inside the plot's horizontal span. */
export function xToPx(
  x: number,
  domain: [number, number],
  plot: { x: number; width: number },
): number {
  return linearScale(x, domain[0], domain[1], plot.x, plot.x + plot.width);
}

/** Map a data y to a pixel inside the plot's vertical span (inverted:
 *  larger y is higher on screen → smaller pixel). */
export function yToPx(
  y: number,
  domain: [number, number],
  plot: { y: number; height: number },
  scale: 'linear' | 'log' = 'linear',
): number {
  const bottom = plot.y + plot.height;
  const top = plot.y;
  return scale === 'log'
    ? logScale(y, domain[0], domain[1], bottom, top)
    : linearScale(y, domain[0], domain[1], bottom, top);
}

/** Signed pos/neg sums of a series group at a datum (missing → 0). */
function signedStack(d: ChartDatum, group: SeriesSpec[]): { pos: number; neg: number } {
  let pos = 0;
  let neg = 0;
  for (const s of group) {
    const v = d[s.dataKey] ?? 0;
    if (v >= 0) pos += v;
    else neg += v;
  }
  return { pos, neg };
}

/**
 * Compute the data-space y extent across all series + rows. Grouping
 * mirrors the renderer (`Series.tsx`):
 *
 * - All `kind:'bar'` series form ONE signed stack group (stackId is
 *   ignored, exactly like `BarStack`), tracking the highest positive sum
 *   and lowest negative sum across rows.
 * - `kind:'area'` series WITH a `stackId` are grouped by that id and
 *   signed-stacked per group; loose areas (no `stackId`) each contribute
 *   independently against zero.
 * - `kind:'line'` series each contribute independently (non-finite values
 *   skipped).
 *
 * Bars + areas read `d[dataKey] ?? 0` (renderer parity — no finite guard);
 * lines + `extraValues` keep their `Number.isFinite` guards. Lines + the
 * `extraMin`/`extraMax` (e.g. retirement markers) widen the extent.
 */
export function computeYExtent(
  rows: ChartDatum[],
  series: SeriesSpec[],
  extraValues: number[] = [],
): [number, number] {
  let min = 0;
  let max = 0;
  const barSeries = series.filter((s) => s.kind === 'bar');
  const stackedAreaIds = Array.from(
    new Set(
      series.filter((s) => s.kind === 'area' && s.stackId).map((s) => s.stackId),
    ),
  );
  const looseAreas = series.filter((s) => s.kind === 'area' && !s.stackId);
  const lineSeries = series.filter((s) => s.kind === 'line');
  for (const d of rows) {
    if (barSeries.length > 0) {
      const { pos, neg } = signedStack(d, barSeries);
      if (pos > max) max = pos;
      if (neg < min) min = neg;
    }
    for (const id of stackedAreaIds) {
      const group = series.filter((s) => s.kind === 'area' && s.stackId === id);
      const { pos, neg } = signedStack(d, group);
      if (pos > max) max = pos;
      if (neg < min) min = neg;
    }
    for (const s of looseAreas) {
      const v = d[s.dataKey] ?? 0;
      if (v > max) max = v;
      if (v < min) min = v;
    }
    for (const s of lineSeries) {
      const v = d[s.dataKey];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
  }
  for (const v of extraValues) {
    if (Number.isFinite(v)) {
      if (v > max) max = v;
      if (v < min) min = v;
    }
  }
  if (min === 0 && max === 0) return [0, 1];
  return [min, max];
}

/** Pad a [min,max] extent by `frac` on each non-zero side. */
export function padExtent(
  extent: [number, number],
  frac = 0.05,
): [number, number] {
  const [min, max] = extent;
  const range = max - min;
  const pad = range === 0 ? Math.abs(max) * frac || 1 : range * frac;
  return [min === 0 ? 0 : min - pad, max === 0 ? 0 : max + pad];
}

/** Build the stacked baseline + top for one series at a datum, given
 *  the signed running offsets. Returns [base, top] in data space. */
export interface StackBands {
  /** base value (lower edge) per row index. */
  base: number[];
  /** top value (upper edge) per row index. */
  top: number[];
}

/**
 * For a stack group, compute each series' [base, top] bands across all
 * rows using signed stacking (positive values stack up from the running
 * positive offset, negative values stack down). Returns a map keyed by
 * `dataKey`.
 */
export function computeStackBands(
  rows: ChartDatum[],
  group: SeriesSpec[],
): Map<string, StackBands> {
  const out = new Map<string, StackBands>();
  for (const s of group) out.set(s.dataKey, { base: [], top: [] });
  rows.forEach((d, i) => {
    let pos = 0;
    let neg = 0;
    for (const s of group) {
      const v = d[s.dataKey] ?? 0;
      const bands = out.get(s.dataKey);
      if (!bands) continue;
      if (v >= 0) {
        bands.base[i] = pos;
        bands.top[i] = pos + v;
        pos += v;
      } else {
        bands.top[i] = neg;
        bands.base[i] = neg + v;
        neg += v;
      }
    }
  });
  return out;
}

/** Default x-domain from rows when none is supplied. */
export function defaultXDomain(rows: ChartDatum[]): [number, number] {
  if (rows.length === 0) return [0, 1];
  const xs = rows.map((r) => r.x);
  return [Math.min(...xs), Math.max(...xs)];
}

/** Filter rows to those whose x falls inside [lo,hi] (inclusive). */
export function rowsInDomain(
  rows: ChartDatum[],
  domain: [number, number],
): ChartDatum[] {
  return rows.filter((r) => r.x >= domain[0] && r.x <= domain[1]);
}

/** Nearest row (by x) to a data-space x value; null when no rows. */
export function nearestRow(
  rows: ChartDatum[],
  x: number,
): ChartDatum | null {
  if (rows.length === 0) return null;
  let best = rows[0];
  let bestDist = Math.abs(rows[0].x - x);
  for (const r of rows) {
    const d = Math.abs(r.x - x);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Resolve the effective y-domain. When `explicit` is provided it wins
 * (zoom-fitted), clamped for log scale to keep the floor positive and
 * guard inversion. Otherwise derive from the data extent + padding.
 */
export function resolveYDomain(
  rows: ChartDatum[],
  series: SeriesSpec[],
  explicit: [number, number] | null,
  scale: 'linear' | 'log',
  extraValues: number[] = [],
): [number, number] {
  if (explicit) {
    if (scale === 'log') {
      const lo = Math.max(LOG_FLOOR, explicit[0]);
      const hi = Math.max(lo, explicit[1]);
      return hi > LOG_FLOOR ? [lo, hi] : [LOG_FLOOR, lo * 10];
    }
    return explicit;
  }
  if (scale === 'log') {
    const extent = computeYExtent(rows, series, extraValues);
    return [LOG_FLOOR, Math.max(LOG_FLOOR * 10, extent[1] * 1.05)];
  }
  return padExtent(computeYExtent(rows, series, extraValues));
}

/** Build the SVG `d` for a polyline through (x,y) data points. */
export function linePath(points: Array<{ px: number; py: number }>): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)} ${p.py.toFixed(2)}`)
    .join(' ');
}

/** Build the SVG `d` for a filled area between a top line and a base
 *  line (base reversed). */
export function areaPath(
  top: Array<{ px: number; py: number }>,
  base: Array<{ px: number; py: number }>,
): string {
  if (top.length === 0) return '';
  const fwd = top
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)} ${p.py.toFixed(2)}`)
    .join(' ');
  const back = [...base]
    .reverse()
    .map((p) => `L${p.px.toFixed(2)} ${p.py.toFixed(2)}`)
    .join(' ');
  return `${fwd} ${back} Z`;
}

