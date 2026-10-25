import { describe, expect, it } from 'vitest';
import {
  areaPath,
  computeStackBands,
  defaultXDomain,
  linePath,
  nearestRow,
  resolveYDomain,
  rowsInDomain,
  xToPx,
  yToPx,
} from './scales';
import type { ChartDatum, SeriesSpec } from './types';

const plot = { x: 10, y: 5, width: 100, height: 50 };

describe('xToPx / yToPx', () => {
  it('xToPx maps left→right across the plot width', () => {
    expect(xToPx(2020, [2020, 2040], plot)).toBe(10);
    expect(xToPx(2030, [2020, 2040], plot)).toBe(60);
    expect(xToPx(2040, [2020, 2040], plot)).toBe(110);
  });

  it('yToPx inverts (larger y → smaller pixel)', () => {
    expect(yToPx(0, [0, 100], plot)).toBe(55);
    expect(yToPx(100, [0, 100], plot)).toBe(5);
  });

  it('log scale clamps a value below the floor to the bottom of the plot', () => {
    expect(yToPx(100, [10000, 1_000_000], plot, 'log')).toBe(55);
  });
});

describe('resolveYDomain over the data extent', () => {
  const domain = (
    rows: ChartDatum[],
    series: SeriesSpec[],
    extraValues?: number[],
  ): [number, number] => resolveYDomain(rows, series, null, 'linear', extraValues);

  function expectDomain(actual: [number, number], expected: [number, number]): void {
    expect(actual[0]).toBeCloseTo(expected[0], 6);
    expect(actual[1]).toBeCloseTo(expected[1], 6);
  }

  const stacked: SeriesSpec[] = [
    { kind: 'bar', dataKey: 'pos', name: 'pos', color: '#0a0', stackId: 's' },
    { kind: 'bar', dataKey: 'neg', name: 'neg', color: '#a00', stackId: 's' },
  ];
  const stackedRows: ChartDatum[] = [
    { x: 1, pos: 100, neg: -40 },
    { x: 2, pos: 60, neg: -90 },
  ];
  const bar: SeriesSpec[] = [{ kind: 'bar', dataKey: 'v', name: 'v', color: '#0' }];
  const line: SeriesSpec[] = [{ kind: 'line', dataKey: 'v', name: 'v', color: '#0' }];

  it('tracks the highest positive sum and lowest negative sum, padded 5% on each non-zero side', () => {
    expectDomain(domain(stackedRows, stacked), [-99.5, 109.5]);
  });

  it('computeStackBands stacks positives up and negatives down from zero', () => {
    const bands = computeStackBands(stackedRows, stacked);
    expect(bands.get('pos')).toEqual({ base: [0, 0], top: [100, 60] });
    expect(bands.get('neg')).toEqual({ base: [-40, -90], top: [0, 0] });
  });

  it('keeps a positive un-stacked bar on a zero baseline', () => {
    expectDomain(domain([{ x: 1, v: 500 }], bar), [0, 525]);
  });

  it('keeps a loose un-stacked area on a zero baseline', () => {
    const area: SeriesSpec[] = [{ kind: 'area', dataKey: 'v', name: 'v', color: '#0' }];
    expectDomain(domain([{ x: 1, v: 300 }], area), [0, 315]);
  });

  it('drops the minimum below zero for a negative un-stacked bar', () => {
    expectDomain(domain([{ x: 1, v: -200 }], bar), [-210, 0]);
  });

  it('falls back to a unit extent for all-zero data', () => {
    expectDomain(domain([{ x: 1, v: 0 }], bar), [0, 1.05]);
  });

  it('skips non-finite line values and falls back when all are non-finite', () => {
    expectDomain(domain([{ x: 1, v: 100 }, { x: 2, v: NaN }], line), [0, 105]);
    expectDomain(domain([{ x: 1, v: NaN }, { x: 2, v: NaN }], line), [0, 1.05]);
  });

  it('sums two un-stacked bars like a stack', () => {
    const two: SeriesSpec[] = [
      { kind: 'bar', dataKey: 'a', name: 'a', color: '#0' },
      { kind: 'bar', dataKey: 'b', name: 'b', color: '#1' },
    ];
    expectDomain(domain([{ x: 1, a: 200, b: 150 }], two), [0, 367.5]);
  });

  it('keeps two loose areas independent (max, not summed)', () => {
    const two: SeriesSpec[] = [
      { kind: 'area', dataKey: 'a', name: 'a', color: '#0' },
      { kind: 'area', dataKey: 'b', name: 'b', color: '#1' },
    ];
    expectDomain(domain([{ x: 1, a: 400, b: 250 }], two), [0, 420]);
  });

  it('widens the extent by finite extra values and ignores non-finite ones', () => {
    const rows = [{ x: 1, v: 100 }];
    expectDomain(domain(rows, line, [500]), [0, 525]);
    expectDomain(domain(rows, line, [-50]), [-57.5, 107.5]);
    expectDomain(domain(rows, line, [NaN, Infinity]), [0, 105]);
  });

  it('honors an explicit zoom domain', () => {
    expect(resolveYDomain([], [], [10, 20], 'linear')).toEqual([10, 20]);
  });

  it('floors the log domain at $10k', () => {
    expect(resolveYDomain([], [], null, 'log')[0]).toBe(10000);
  });

  it('guards inversion when both explicit log ends are below the floor', () => {
    const d = resolveYDomain([], [], [1, 50], 'log');
    expect(d[0]).toBe(10000);
    expect(d[1]).toBeGreaterThan(d[0]);
  });

  it('clamps the explicit log lower bound only when the upper is above the floor', () => {
    expect(resolveYDomain([], [], [500, 200000], 'log')).toEqual([10000, 200000]);
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
