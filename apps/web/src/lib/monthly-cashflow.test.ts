/**
 * Tests for the MonthlyCashflowSeries adapters. Pins that the series holds
 * actual dollars per month, not chart run-rates.
 */
import { describe, expect, it } from 'vitest';
import {
  addOneOff,
  annualRollup,
  assertAlignsWithRetirement,
  buildMonthlyFromAnnualMap,
  emptyMonthlySeries,
  rollupYear,
  seriesEndAbs,
  seriesStartAbs,
  sumMonthlySeries,
  validateSeries,
} from './monthly-cashflow';

describe('buildMonthlyFromAnnualMap', () => {
  it('splits $120k/yr flat expense into $10k per active month (not $120k/mo)', () => {
    const map = new Map<number, number>([[2030, 120000]]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2030);
    expect(series.values.length).toBe(12);
    for (let m = 0; m < 12; m += 1) {
      expect(series.values[m]).toBeCloseTo(10000, 6);
    }
  });

  it('handles multi-year windows with mixed amounts', () => {
    const map = new Map<number, number>([
      [2030, 120000],
      [2031, 60000],
    ]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2031);
    expect(series.values.length).toBe(24);
    expect(series.values[0]).toBeCloseTo(10000, 6);
    expect(series.values[11]).toBeCloseTo(10000, 6);
    expect(series.values[12]).toBeCloseTo(5000, 6);
    expect(series.values[23]).toBeCloseTo(5000, 6);
  });

  it('silently drops map entries outside the start/end window', () => {
    const map = new Map<number, number>([
      [2029, 999999],
      [2030, 12000],
      [2032, 999999],
    ]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2031);
    expect(series.values[0]).toBeCloseTo(1000, 6);
    expect(series.values[11]).toBeCloseTo(1000, 6);
    expect(series.values[12]).toBe(0);
    expect(series.values[23]).toBe(0);
  });

  it('returns an empty series when end < start', () => {
    const series = buildMonthlyFromAnnualMap(new Map(), 2030, 2029);
    expect(series.values.length).toBe(0);
  });
});

describe('addOneOff', () => {
  // Pinned defect: a September one-off windfall must
  // land in September, not January. The pre-monthly drawdown engine
  // pinned every annualized deposit to month 0, so a $40k Sept event
  // appeared as a January spike on the cashflow chart and got
  // compounded for 12 extra months by the projection engine.
  it('drops $40k into Sept only — surrounding months stay at 0', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2030, 8, 40000); // Sept = index 8
    expect(series.values[7]).toBe(0); // Aug
    expect(series.values[8]).toBe(40000); // Sept
    expect(series.values[9]).toBe(0); // Oct
    expect(annualRollup(series, 2030)).toBeCloseTo(40000, 6);
  });

  it('no-ops outside the series window without throwing', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2029, 0, 99999);
    addOneOff(series, 2031, 0, 99999);
    expect(annualRollup(series, 2030)).toBe(0);
  });

  it('zero-amount call is a no-op', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2030, 5, 0);
    expect(annualRollup(series, 2030)).toBe(0);
  });

  it('multiple one-offs in the same month accumulate', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2030, 3, 100);
    addOneOff(series, 2030, 3, 250);
    expect(series.values[3]).toBeCloseTo(350, 6);
  });
});

describe('annualRollup', () => {
  it('sums the 12 monthly values for the matching year', () => {
    const map = new Map<number, number>([[2030, 12000]]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2030);
    expect(annualRollup(series, 2030)).toBeCloseTo(12000, 6);
  });

  it('returns 0 for years outside the series window', () => {
    const map = new Map<number, number>([[2030, 12000]]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2030);
    expect(annualRollup(series, 2029)).toBe(0);
    expect(annualRollup(series, 2031)).toBe(0);
  });

  it('rollup matches the input annual within $0.01 (round-trip invariant)', () => {
    const annual = 87654;
    const map = new Map<number, number>([[2030, annual]]);
    const series = buildMonthlyFromAnnualMap(map, 2030, 2030);
    expect(annualRollup(series, 2030)).toBeCloseTo(annual, 2);
  });
});

describe('sumMonthlySeries', () => {
  it('adds aligned series element-wise', () => {
    const a = emptyMonthlySeries(2030, 2030);
    const b = emptyMonthlySeries(2030, 2030);
    addOneOff(a, 2030, 0, 100);
    addOneOff(b, 2030, 0, 25);
    addOneOff(b, 2030, 6, 500);
    const out = sumMonthlySeries(a, b);
    expect(out.values[0]).toBe(125);
    expect(out.values[6]).toBe(500);
    expect(out.values.length).toBe(12);
  });

  it('throws on misaligned start anchors', () => {
    const a = emptyMonthlySeries(2030, 2030);
    const b = emptyMonthlySeries(2031, 2031);
    expect(() => sumMonthlySeries(a, b)).toThrow(/start mismatch/);
  });

  it('throws on mismatched length', () => {
    const a = emptyMonthlySeries(2030, 2030);
    const b = emptyMonthlySeries(2030, 2031);
    expect(() => sumMonthlySeries(a, b)).toThrow(/length mismatch/);
  });
});

describe('seriesStartAbs / seriesEndAbs', () => {
  it('returns absolute month indices for the series window', () => {
    const series = emptyMonthlySeries(2030, 2031);
    expect(seriesStartAbs(series)).toBe(2030 * 12);
    expect(seriesEndAbs(series)).toBe(2030 * 12 + 23);
  });
});

describe('validateSeries', () => {
  it('accepts well-aligned series', () => {
    const series = emptyMonthlySeries(2030, 2030);
    expect(() => validateSeries(series)).not.toThrow();
  });

  it('rejects out-of-range startMonthIndex', () => {
    const series = { startYear: 2030, startMonthIndex: 12, values: new Float64Array(12) };
    expect(() => validateSeries(series)).toThrow(/startMonthIndex/);
  });

  it('rejects non-finite entries', () => {
    const series = emptyMonthlySeries(2030, 2030);
    series.values[3] = Number.NaN;
    expect(() => validateSeries(series)).toThrow(/non-finite/);
  });
});

describe('rollupYear', () => {
  // `rollupYear` is the bucket drawdown path's bridge from monthly
  // inputs back to annual cadence.
  it('returns the same sum as annualRollup (aliases)', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2030, 0, 1000);
    addOneOff(series, 2030, 8, 40000);
    expect(rollupYear(series, 2030)).toBe(annualRollup(series, 2030));
    expect(rollupYear(series, 2030)).toBeCloseTo(41000, 6);
  });

  it('returns 0 for years outside the series window', () => {
    const series = emptyMonthlySeries(2030, 2030);
    addOneOff(series, 2030, 0, 1000);
    expect(rollupYear(series, 2029)).toBe(0);
    expect(rollupYear(series, 2031)).toBe(0);
  });
});

describe('assertAlignsWithRetirement', () => {
  it('accepts a Jan-anchored full-horizon series', () => {
    const series = emptyMonthlySeries(2030, 2032);
    expect(() => assertAlignsWithRetirement(series, 2030, 2032)).not.toThrow();
  });

  it('throws on mismatched anchor', () => {
    const series = emptyMonthlySeries(2031, 2032);
    expect(() => assertAlignsWithRetirement(series, 2030, 2032)).toThrow(/expected start/);
  });

  it('throws on non-January start month', () => {
    const series = { startYear: 2030, startMonthIndex: 3, values: new Float64Array(36) };
    expect(() => assertAlignsWithRetirement(series, 2030, 2032)).toThrow(/expected start/);
  });

  it('throws on wrong length', () => {
    const series = emptyMonthlySeries(2030, 2031); // 24 months
    expect(() => assertAlignsWithRetirement(series, 2030, 2032)).toThrow(/expected length 36/);
  });
});
