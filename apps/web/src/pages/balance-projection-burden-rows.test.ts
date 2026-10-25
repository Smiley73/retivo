// Pure Balance Projection burden row builders: death-year filtering, the MC drawdown-phase filter (tax) and the positive-floor / positive-conversion skips that both the on-page charts and the Export PDF render host depend on.
import { describe, expect, it } from 'vitest';
import {
  buildTaxBurdenRows,
  buildRmdRows,
  buildRothConversionsSeries,
  buildQcdRows,
  hasMedicaidRangeYear,
} from './balance-projection-burden-rows';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { DrawdownYear } from '../lib/drawdown-engine-types';

function year(partial: Partial<DrawdownYear> & { year: number }): DrawdownYear {
  return partial as DrawdownYear;
}

function drawdown(years: DrawdownYear[]): DrawdownByMethodResult {
  return { years } as unknown as DrawdownByMethodResult;
}

const identityDeflator = (): number => 1;

describe('buildTaxBurdenRows', () => {
  it('drops rows past the integer death year', () => {
    const dd = drawdown([
      year({ year: 2040, accountBalances: new Map(), federalTaxCents: 100_00 }),
      year({ year: 2041, accountBalances: new Map(), federalTaxCents: 200_00 }),
      year({ year: 2042, accountBalances: new Map(), federalTaxCents: 300_00 }),
    ]);
    const rows = buildTaxBurdenRows({
      resolvedDrawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: 2041,
      isMcBasisActive: false,
    });
    expect(rows.map((r) => r.year)).toEqual([2040, 2041]);
    expect(rows[0].federalTax).toBe(100);
  });

  it('under an MC basis drops accumulation years with no accountBalances', () => {
    const dd = drawdown([
      year({ year: 2039, federalTaxCents: 999_00 }),
      year({ year: 2040, accountBalances: new Map(), federalTaxCents: 100_00 }),
    ]);
    const rows = buildTaxBurdenRows({
      resolvedDrawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      isMcBasisActive: true,
    });
    expect(rows.map((r) => r.year)).toEqual([2040]);
  });

  it('keeps accumulation-shaped years when NOT under an MC basis', () => {
    const dd = drawdown([
      year({ year: 2039, federalTaxCents: 50_00 }),
      year({ year: 2040, federalTaxCents: 100_00 }),
    ]);
    const rows = buildTaxBurdenRows({
      resolvedDrawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      isMcBasisActive: false,
    });
    expect(rows.map((r) => r.year)).toEqual([2039, 2040]);
  });

  it('stores ACA-PTC as a negative benefit', () => {
    const dd = drawdown([
      year({ year: 2040, accountBalances: new Map(), acaPtcSubsidyCents: 1_200_00 }),
    ]);
    const [row] = buildTaxBurdenRows({
      resolvedDrawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      isMcBasisActive: false,
    });
    expect(row.acaPtcSubsidy).toBe(-1200);
  });

  it('carries the credit applied to premiums as a positive, deflated figure', () => {
    const dd = drawdown([
      year({ year: 2040, accountBalances: new Map(), acaPtcSubsidyCents: 5_134_20, acaCreditAppliedToPremiumsCents: 2_700_00 }),
    ]);
    const [row] = buildTaxBurdenRows({
      resolvedDrawdown: dd,
      basisDeflator: () => 0.5,
      lastDeathFractional: null,
      isMcBasisActive: false,
    });
    expect(row.acaCreditApplied).toBe(1_350);
    // The ACA credit is part of the subsidy bar, not an addition to it.
    expect(row.acaPtcSubsidy).toBeCloseTo(-2_567.1, 6);
  });

  it('returns [] when there is no drawdown', () => {
    expect(
      buildTaxBurdenRows({
        resolvedDrawdown: null,
        basisDeflator: identityDeflator,
        lastDeathFractional: null,
        isMcBasisActive: false,
      }),
    ).toEqual([]);
  });
});

describe('buildRmdRows', () => {
  it('skips years with a non-positive RMD floor', () => {
    const dd = drawdown([
      year({ year: 2040, rmdFloorCents: 0 }),
      year({ year: 2041, rmdFloorCents: 10_000_00, rmdShortfallCents: 2_000_00 }),
    ]);
    const rows = buildRmdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ year: 2041, rmdMet: 8000, rmdShortfall: 2000 });
  });

  it('drops rows past the integer death year', () => {
    const dd = drawdown([
      year({ year: 2040, rmdFloorCents: 5_000_00 }),
      year({ year: 2041, rmdFloorCents: 5_000_00 }),
      year({ year: 2042, rmdFloorCents: 5_000_00 }),
    ]);
    const rows = buildRmdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: 2041.9,
    });
    expect(rows.map((r) => r.year)).toEqual([2040, 2041]);
  });

  it('returns [] when there is no drawdown', () => {
    expect(
      buildRmdRows({ drawdown: null, basisDeflator: identityDeflator, lastDeathFractional: null }),
    ).toEqual([]);
  });

  it('populates rmdRetained from reinvested + held-as-cash cents, deflated', () => {
    const dd = drawdown([
      year({
        year: 2041,
        rmdFloorCents: 10_000_00,
        rmdReinvestedCents: 1_500_00,
        rmdOverflowToCashCents: 500_00,
      }),
    ]);
    const [row] = buildRmdRows({
      drawdown: dd,
      basisDeflator: () => 0.5,
      lastDeathFractional: null,
    });
    expect(row.rmdRetained).toBe(1000);
  });

  it('reports zero retained when a year keeps no surplus', () => {
    const dd = drawdown([
      year({ year: 2041, rmdFloorCents: 10_000_00, rmdShortfallCents: 0 }),
    ]);
    const [row] = buildRmdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
    });
    expect(row.rmdRetained).toBe(0);
  });

  it('clips the retained figure at the integer death year', () => {
    const dd = drawdown([
      year({ year: 2040, rmdFloorCents: 5_000_00, rmdReinvestedCents: 1_000_00 }),
      year({ year: 2041, rmdFloorCents: 5_000_00, rmdReinvestedCents: 2_000_00 }),
      year({ year: 2042, rmdFloorCents: 5_000_00, rmdReinvestedCents: 9_000_00 }),
    ]);
    const rows = buildRmdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: 2041,
    });
    expect(rows.map((r) => r.year)).toEqual([2040, 2041]);
    expect(rows.reduce((s, r) => s + r.rmdRetained, 0)).toBe(3000);
  });

  it('carries rmdRetained === 0 in a year with a shortfall', () => {
    // In a surplus year the portfolio funds the floor (shortfall === 0); the converse holds too, since no reinvested/overflow cents accrue when withdrawals fall short.
    const dd = drawdown([
      year({
        year: 2041,
        rmdFloorCents: 10_000_00,
        rmdShortfallCents: 4_000_00,
      }),
    ]);
    const [row] = buildRmdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
    });
    expect(row.rmdShortfall).toBeGreaterThan(0);
    expect(row.rmdRetained).toBe(0);
  });

  it('ties Σ rmdRetained out to the drawdown surplus under a year-varying deflator (deterministic shape)', () => {
    // A year-varying, non-identity deflator exercises per-year deflation.
    const deflator = (yr: number): number => 1 / (1 + (yr - 2040) * 0.03);
    const years = [
      year({ year: 2040, rmdFloorCents: 8_000_00, rmdReinvestedCents: 1_000_00 }),
      year({
        year: 2041,
        rmdFloorCents: 9_000_00,
        rmdReinvestedCents: 1_200_00,
        rmdOverflowToCashCents: 300_00,
      }),
      year({ year: 2042, rmdFloorCents: 9_500_00, rmdOverflowToCashCents: 700_00 }),
    ];
    const rows = buildRmdRows({
      drawdown: drawdown(years),
      basisDeflator: deflator,
      lastDeathFractional: null,
    });
    const rowSum = rows.reduce((s, r) => s + r.rmdRetained, 0);
    const refSum = years.reduce(
      (s, y) =>
        s +
        (((y.rmdReinvestedCents ?? 0) + (y.rmdOverflowToCashCents ?? 0)) / 100) *
          deflator(y.year),
      0,
    );
    expect(rowSum).toBeCloseTo(refSum, 6);
  });

  it('ties Σ rmdRetained out under an MC-shaped drawdown (accumulation years present)', () => {
    // MC-shaped: an accumulation year (no RMD floor) plus drawdown years; the builder skips the floor<=0 year and the surplus tie-out holds over the emitted years.
    const deflator = (yr: number): number => 1 / (1 + (yr - 2039) * 0.025);
    const years = [
      year({ year: 2039, rmdFloorCents: 0, rmdReinvestedCents: 50_00 }),
      year({ year: 2040, rmdFloorCents: 7_000_00, rmdReinvestedCents: 900_00 }),
      year({
        year: 2041,
        rmdFloorCents: 7_500_00,
        rmdReinvestedCents: 600_00,
        rmdOverflowToCashCents: 400_00,
      }),
    ];
    const rows = buildRmdRows({
      drawdown: drawdown(years),
      basisDeflator: deflator,
      lastDeathFractional: null,
    });
    const rowSum = rows.reduce((s, r) => s + r.rmdRetained, 0);
    const refSum = years
      .filter((y) => (y.rmdFloorCents ?? 0) > 0)
      .reduce(
        (s, y) =>
          s +
          (((y.rmdReinvestedCents ?? 0) + (y.rmdOverflowToCashCents ?? 0)) /
            100) *
            deflator(y.year),
        0,
      );
    expect(rowSum).toBeCloseTo(refSum, 6);
  });
});

describe('buildRothConversionsSeries', () => {
  it('skips years with a non-positive conversion', () => {
    const dd = drawdown([
      year({ year: 2040, rothConvertedCents: 0 }),
      year({ year: 2041, rothConvertedCents: 25_000_00 }),
    ]);
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: null,
    });
    expect(series).toEqual([{ year: 2041, dollars: 25_000 }]);
  });

  it('drops conversions past the integer death year', () => {
    const dd = drawdown([
      year({ year: 2040, rothConvertedCents: 10_000_00 }),
      year({ year: 2041, rothConvertedCents: 10_000_00 }),
      year({ year: 2042, rothConvertedCents: 10_000_00 }),
    ]);
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: 2041,
    });
    expect(series.map((r) => r.year)).toEqual([2040, 2041]);
  });

  it('returns [] when there is no drawdown', () => {
    expect(
      buildRothConversionsSeries({
        drawdown: null,
        lastDeathFractional: null,
      }),
    ).toEqual([]);
  });

  it('includes pre-retirement conversion years from preRetirementConversionCentsByYear', () => {
    const dd: DrawdownByMethodResult = {
      years: [year({ year: 2046, rothConvertedCents: 20_000_00 })],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
      preRetirementConversionCentsByYear: new Map([[2044, 10_000_00], [2045, 15_000_00]]),
    };
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: null,
    });
    expect(series.map((r) => r.year)).toEqual([2044, 2045, 2046]);
    expect(series.map((r) => r.dollars)).toEqual([10_000, 15_000, 20_000]);
  });

  it('reports the NOMINAL cents/100 for every bar (no basis deflation)', () => {
    const dd: DrawdownByMethodResult = {
      years: [year({ year: 2046, rothConvertedCents: 30_000_00 })],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
      preRetirementConversionCentsByYear: new Map([[2044, 20_000_00], [2045, 20_000_00]]),
    };
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: null,
    });
    expect(series).toEqual([
      { year: 2044, dollars: 20_000 },
      { year: 2045, dollars: 20_000 },
      { year: 2046, dollars: 30_000 },
    ]);
  });

  it('clips pre-retirement conversion years past the integer death year', () => {
    const dd: DrawdownByMethodResult = {
      years: [],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
      preRetirementConversionCentsByYear: new Map([[2044, 5_000_00], [2046, 8_000_00]]),
    };
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: 2045,
    });
    expect(series.map((r) => r.year)).toEqual([2044]);
  });

  it('skips pre-retirement years with zero or negative conversion cents', () => {
    const dd: DrawdownByMethodResult = {
      years: [],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
      preRetirementConversionCentsByYear: new Map([[2044, 0], [2045, -100]]),
    };
    const series = buildRothConversionsSeries({
      drawdown: dd,
      lastDeathFractional: null,
    });
    expect(series).toEqual([]);
  });
});

describe('buildQcdRows', () => {
  it('returns [] when drawdown is null', () => {
    expect(
      buildQcdRows({
        drawdown: null,
        basisDeflator: identityDeflator,
        lastDeathFractional: null,
        displayMode: 'today',
      }),
    ).toEqual([]);
  });

  it('skips years with zero or missing qcdCents', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 0, qcdInflationFactor: 1 }),
      year({ year: 2041, qcdCents: 10_000_00, qcdInflationFactor: 1 }),
    ]);
    const rows = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].year).toBe(2041);
  });

  it('drops rows past the integer death year', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 5_000_00, qcdInflationFactor: 1 }),
      year({ year: 2041, qcdCents: 5_000_00, qcdInflationFactor: 1 }),
      year({ year: 2042, qcdCents: 5_000_00, qcdInflationFactor: 1 }),
    ]);
    const rows = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: 2041.5,
      displayMode: 'today',
    });
    expect(rows.map((r) => r.year)).toEqual([2040, 2041]);
  });

  it('deflates qcdDollars by 1/qcdInflationFactor in today mode', () => {
    // qcdInflationFactor = 2 gives today's dollars = nominal / 2.
    const dd = drawdown([
      year({ year: 2040, qcdCents: 20_000_00, qcdInflationFactor: 2 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.qcdDollars).toBeCloseTo(10_000, 6);
  });

  it('does not deflate qcdDollars in future mode', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 20_000_00, qcdInflationFactor: 2 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'future',
    });
    expect(row.qcdDollars).toBeCloseTo(20_000, 6);
  });

  it('guards against a zero qcdInflationFactor by treating it as 1', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 10_000_00, qcdInflationFactor: 0 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    // factor=0 activates the guard (d=1), so no division by zero.
    expect(row.qcdDollars).toBeCloseTo(10_000, 6);
  });

  it('defaults to factor=1 (nominal, no deflation) when qcdInflationFactor is undefined', () => {
    const dd = drawdown([year({ year: 2040, qcdCents: 12_000_00 })]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.qcdDollars).toBe(12_000);
  });

  it('deflates netTaxableRmd using basisDeflator (year-end basis)', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 5_000_00, qcdInflationFactor: 1, netTaxableRmdCents: 8_000_00 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: () => 0.5,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.netTaxableRmd).toBeCloseTo(4_000, 6);
  });

  it('treats missing netTaxableRmdCents as zero', () => {
    const dd = drawdown([
      year({ year: 2040, qcdCents: 5_000_00, qcdInflationFactor: 1 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.netTaxableRmd).toBe(0);
  });

  it('sums qcdRmdOffsetCentsByOwner across owners and deflates on basisDeflator (RMD basis)', () => {
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 30_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 5_000_00,
        qcdRmdOffsetCentsByOwner: { a: 8_000_00, b: 12_000_00 },
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: () => 0.5, // RMD year-end basis, NOT the gift factor
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBeCloseTo(10_000, 6);
  });

  it('per-year invariant: rmdOffsetDollars + netTaxableRmd == gross IRA RMD each year', () => {
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 18_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 22_000_00,
        qcdRmdOffsetCentsByOwner: { a: 18_000_00 },
      }),
      year({
        year: 2041,
        qcdCents: 5_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 30_000_00,
        qcdRmdOffsetCentsByOwner: { a: 5_000_00 },
      }),
    ]);
    const rows = buildQcdRows({
      drawdown: dd,
      basisDeflator: () => 0.9,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(rows[0].rmdOffsetDollars + rows[0].netTaxableRmd).toBeCloseTo(
      (18_000 + 22_000) * 0.9,
      6,
    );
    expect(rows[1].rmdOffsetDollars + rows[1].netTaxableRmd).toBeCloseTo(
      (5_000 + 30_000) * 0.9,
      6,
    );
  });

  it('excess gift: the offset is the per-owner-capped min(gift, gross), never the full gift', () => {
    // The gift is $50k but the owner's gross IRA RMD is only $12k, so the engine caps the stamped offset at $12k; buildQcdRows reads the capped offset so the bar never exceeds the gross RMD.
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 50_000_00, // full gift (the standalone QCD chart's figure)
        qcdInflationFactor: 1,
        netTaxableRmdCents: 0, // gift ≥ gross → nothing taxable left
        qcdRmdOffsetCentsByOwner: { a: 12_000_00 }, // capped at gross
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBe(12_000); // capped, NOT the $50k gift
    expect(row.netTaxableRmd).toBe(0);
    expect(row.rmdOffsetDollars + row.netTaxableRmd).toBe(12_000);
    expect(row.qcdDollars).toBe(50_000); // the full gift still surfaces on qcdDollars
  });

  it('pre-RMD gift year: qcdCents > 0 but no gross RMD → offset 0 and net 0 (excluded downstream)', () => {
    // A gift before the RMD trigger age carries no offset map or net-taxable RMD, so both split slices are 0 (the memo filters `offset + net > 0` out).
    const dd = drawdown([
      year({ year: 2040, qcdCents: 10_000_00, qcdInflationFactor: 1 }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBe(0);
    expect(row.netTaxableRmd).toBe(0);
    expect(row.qcdDollars).toBe(10_000); // the pre-RMD gift still shows on qcdDollars
  });

  it('finite-guard: a non-finite basisDeflator yields 0 offset + 0 net (no NaN/Infinity)', () => {
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 10_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 8_000_00,
        qcdRmdOffsetCentsByOwner: { a: 10_000_00 },
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: () => Number.NaN,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(Number.isFinite(row.rmdOffsetDollars)).toBe(true);
    expect(Number.isFinite(row.netTaxableRmd)).toBe(true);
    expect(row.rmdOffsetDollars).toBe(0);
    expect(row.netTaxableRmd).toBe(0);
  });

  it('finite-guard: a NaN per-owner offset entry is treated as 0 (no NaN chart data)', () => {
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 10_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 8_000_00,
        qcdRmdOffsetCentsByOwner: { a: Number.NaN, b: 5_000_00 },
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBe(5_000);
  });

  it('treats a missing qcdRmdOffsetCentsByOwner map as a 0 offset', () => {
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 10_000_00,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 8_000_00,
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: identityDeflator,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBe(0);
  });

  it('rounding: a fractional-cent deflation rounds once via the shared dollar value', () => {
    // The row carries the raw dollar value (1_234_567 cents × a fractional deflator) so the tile/tooltip formatter rounds once, downstream.
    const dd = drawdown([
      year({
        year: 2040,
        qcdCents: 12_345_67,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 0,
        qcdRmdOffsetCentsByOwner: { a: 12_345_67 },
      }),
    ]);
    const [row] = buildQcdRows({
      drawdown: dd,
      basisDeflator: () => 0.837,
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(row.rmdOffsetDollars).toBeCloseTo(12_345.67 * 0.837, 6);
  });
});

describe('hasMedicaidRangeYear', () => {
  const fires = (fplPercentage?: number): boolean =>
    hasMedicaidRangeYear([year({ year: 2040, fplPercentage })]);

  it('fires at exactly 138 and stops a hair above', () => {
    expect(fires(138)).toBe(true);
    expect(fires(138.01)).toBe(false);
  });

  it('fires below the poverty line itself', () => {
    expect(fires(60)).toBe(true);
    expect(fires(0.5)).toBe(true);
  });

  it('does not fire for 0 ("not computed") or an absent field', () => {
    expect(fires(0)).toBe(false);
    expect(fires(undefined)).toBe(false);
    expect(hasMedicaidRangeYear([])).toBe(false);
  });
});
