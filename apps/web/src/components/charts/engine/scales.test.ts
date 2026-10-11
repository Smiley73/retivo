/**
 * Unit tests for the pure SVG chart-engine scale + stacking helpers.
 * No DOM — these are the math the renderer relies on.
 */
import { describe, expect, it } from 'vitest';
import {
  areaPath,
  computeStackBands,
  computeYExtent,
  defaultXDomain,
  linePath,
  linearScale,
  logScale,
  nearestRow,
  padExtent,
  resolveYDomain,
  rowsInDomain,
  xToPx,
  yToPx,
} from './scales';
import type { ChartDatum, SeriesSpec } from './types';

const plot = { x: 10, y: 5, width: 100, height: 50 };

describe('linearScale / xToPx / yToPx', () => {
  it('maps domain endpoints to range endpoints', () => {
    expect(linearScale(0, 0, 10, 0, 100)).toBe(0);
    expect(linearScale(10, 0, 10, 0, 100)).toBe(100);
    expect(linearScale(5, 0, 10, 0, 100)).toBe(50);
  });

  it('xToPx maps left→right across the plot width', () => {
    expect(xToPx(2020, [2020, 2040], plot)).toBe(10);
    expect(xToPx(2040, [2020, 2040], plot)).toBe(110);
  });

  it('yToPx inverts (larger y → smaller pixel)', () => {
    expect(yToPx(0, [0, 100], plot)).toBe(55); // bottom
    expect(yToPx(100, [0, 100], plot)).toBe(5); // top
  });

  it('logScale clamps below the floor', () => {
    const v = logScale(100, 10000, 1_000_000, 100, 0);
    expect(v).toBe(100); // clamped to floor → bottom of range
  });
});

describe('computeYExtent + signed stacking', () => {
  const series: SeriesSpec[] = [
    { kind: 'bar', dataKey: 'pos', name: 'pos', color: '#0a0', stackId: 's' },
    { kind: 'bar', dataKey: 'neg', name: 'neg', color: '#a00', stackId: 's' },
  ];
  const rows: ChartDatum[] = [
    { x: 1, pos: 100, neg: -40 },
    { x: 2, pos: 60, neg: -90 },
  ];

  it('tracks the highest positive sum and lowest negative sum', () => {
    expect(computeYExtent(rows, series)).toEqual([-90, 100]);
  });

  it('computeStackBands stacks positives up and negatives down from zero', () => {
    const bands = computeStackBands(rows, series);
    expect(bands.get('pos')).toEqual({ base: [0, 0], top: [100, 60] });
    expect(bands.get('neg')).toEqual({ base: [-40, -90], top: [0, 0] });
  });

  it('keeps a positive un-stacked bar on a [0, v] baseline', () => {
    const s: SeriesSpec[] = [{ kind: 'bar', dataKey: 'v', name: 'v', color: '#0' }];
    const extent = computeYExtent([{ x: 1, v: 500 }], s);
    expect(extent).toEqual([0, 500]);
    expect(extent[0]).toBe(0); // min pinned to the 0 baseline
  });

  it('keeps a loose un-stacked area on a [0, v] baseline', () => {
    const s: SeriesSpec[] = [{ kind: 'area', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 300 }], s)).toEqual([0, 300]);
  });

  it('drops min below zero for a negative un-stacked bar', () => {
    const s: SeriesSpec[] = [{ kind: 'bar', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: -200 }], s)).toEqual([-200, 0]);
  });

  it('falls back to [0, 1] for all-zero data', () => {
    const s: SeriesSpec[] = [{ kind: 'bar', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 0 }], s)).toEqual([0, 1]);
  });

  it('skips non-finite line values and falls back when all are non-finite', () => {
    const s: SeriesSpec[] = [{ kind: 'line', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 100 }, { x: 2, v: NaN }], s)).toEqual([0, 100]);
    expect(computeYExtent([{ x: 1, v: NaN }, { x: 2, v: NaN }], s)).toEqual([0, 1]);
  });

  it('stacks two un-stacked bars (sum, like BarStack)', () => {
    const s: SeriesSpec[] = [
      { kind: 'bar', dataKey: 'a', name: 'a', color: '#0' },
      { kind: 'bar', dataKey: 'b', name: 'b', color: '#1' },
    ];
    expect(computeYExtent([{ x: 1, a: 200, b: 150 }], s)).toEqual([0, 350]);
  });

  it('keeps two loose areas independent (max, not summed)', () => {
    const s: SeriesSpec[] = [
      { kind: 'area', dataKey: 'a', name: 'a', color: '#0' },
      { kind: 'area', dataKey: 'b', name: 'b', color: '#1' },
    ];
    expect(computeYExtent([{ x: 1, a: 400, b: 250 }], s)).toEqual([0, 400]);
  });

  it('extraValues positive widens max beyond data', () => {
    const s: SeriesSpec[] = [{ kind: 'line', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 100 }], s, [500])).toEqual([0, 500]);
  });

  it('extraValues negative widens min below data', () => {
    const s: SeriesSpec[] = [{ kind: 'line', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 100 }], s, [-50])).toEqual([-50, 100]);
  });

  it('extraValues non-finite values are ignored', () => {
    const s: SeriesSpec[] = [{ kind: 'line', dataKey: 'v', name: 'v', color: '#0' }];
    expect(computeYExtent([{ x: 1, v: 100 }], s, [NaN, Infinity])).toEqual([0, 100]);
  });
});

describe('padExtent / resolveYDomain', () => {
  it('pads non-zero sides', () => {
    expect(padExtent([0, 100], 0.1)).toEqual([0, 110]);
  });

  it('resolveYDomain honors an explicit zoom domain', () => {
    expect(resolveYDomain([], [], [10, 20], 'linear')).toEqual([10, 20]);
  });

  it('resolveYDomain clamps log floor', () => {
    const d = resolveYDomain([], [], [1, 5], 'log');
    expect(d[0]).toBe(10000);
  });
});

describe('domain + lookup helpers', () => {
  const rows: ChartDatum[] = [
    { x: 2020, v: 1 },
    { x: 2025, v: 2 },
    { x: 2030, v: 3 },
  ];

  it('defaultXDomain spans the data', () => {
    expect(defaultXDomain(rows)).toEqual([2020, 2030]);
  });

  it('rowsInDomain filters inclusively', () => {
    expect(rowsInDomain(rows, [2024, 2031]).map((r) => r.x)).toEqual([2025, 2030]);
  });

  it('nearestRow finds the closest x', () => {
    expect(nearestRow(rows, 2026)?.x).toBe(2025);
  });
});

describe('path builders', () => {
  it('linePath builds an M…L… string', () => {
    expect(linePath([{ px: 0, py: 0 }, { px: 10, py: 5 }])).toBe('M0.00 0.00 L10.00 5.00');
  });

  it('areaPath closes the polygon', () => {
    const top = [{ px: 0, py: 0 }, { px: 10, py: 0 }];
    const base = [{ px: 0, py: 5 }, { px: 10, py: 5 }];
    expect(areaPath(top, base)).toContain('Z');
  });
});
