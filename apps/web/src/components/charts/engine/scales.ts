/**
 * Pure scale and domain helpers for the SVG chart engine, mapping data space to pixel space inside a plot rectangle.
 */
import type { ChartDatum, SeriesSpec } from './types';

// Floor ($) for log-scale Y domains: starting at 1 wastes the height on the empty $1-$10k band.
const LOG_FLOOR = 10000;

function linearScale(
  value: number,
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): number {
  if (d1 === d0) return r0;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

function logScale(
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

export function xToPx(
  x: number,
  domain: [number, number],
  plot: { x: number; width: number },
): number {
  return linearScale(x, domain[0], domain[1], plot.x, plot.x + plot.width);
}

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

// Data-space y extent across all series and rows, grouped as the renderer (`Series.tsx`) does: all
// bars form one signed stack, areas stack per `stackId` (loose areas against zero), and lines
// contribute independently.
function computeYExtent(
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

function padExtent(
  extent: [number, number],
  frac = 0.05,
): [number, number] {
  const [min, max] = extent;
  const range = max - min;
  const pad = range === 0 ? Math.abs(max) * frac || 1 : range * frac;
  return [min === 0 ? 0 : min - pad, max === 0 ? 0 : max + pad];
}

export interface StackBands {
  base: number[];
  top: number[];
}

/** Per-series [base, top] bands for a stack group using signed stacking, keyed by `dataKey`. */
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

export function defaultXDomain(rows: ChartDatum[]): [number, number] {
  if (rows.length === 0) return [0, 1];
  const xs = rows.map((r) => r.x);
  return [Math.min(...xs), Math.max(...xs)];
}

export function rowsInDomain(
  rows: ChartDatum[],
  domain: [number, number],
): ChartDatum[] {
  return rows.filter((r) => r.x >= domain[0] && r.x <= domain[1]);
}

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
 * Effective y-domain: an `explicit` (zoom-fitted) domain wins, clamped for log scale; otherwise the
 * data extent plus padding.
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

export function linePath(points: Array<{ px: number; py: number }>): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(2)} ${p.py.toFixed(2)}`)
    .join(' ');
}

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

