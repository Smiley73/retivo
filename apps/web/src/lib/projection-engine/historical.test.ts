import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_MONTHLY,
  blendedReturnMonthly,
  drawMonthlySeries,
  drawOneMonth,
  historicalMonthlySummary,
  type BlendedReturnShock,
  type HistoricalColumns,
} from './historical';
import { makeRng } from '../sfc32';
import { buildPerAccountKernelInputs } from '../monte-carlo-per-account';
import type { MonteCarloAccountLedger } from '../monte-carlo-types';
import type { AssetMix } from '../../db/types';

describe('historical monthly dataset', () => {
  it('sampler window starts at 1950-01 and has no NaN/Infinity values', () => {
    expect(HISTORICAL_MONTHLY[0]?.date).toBe('1950-01');
    for (const r of HISTORICAL_MONTHLY) {
      expect(Number.isFinite(r.stockPct)).toBe(true);
      expect(Number.isFinite(r.bondPct)).toBe(true);
      expect(Number.isFinite(r.cashPct)).toBe(true);
      expect(Number.isFinite(r.cpiPct)).toBe(true);
    }
  });

  it('row count is ≥ 900 (covers 1950-01 through ~2026)', () => {
    expect(HISTORICAL_MONTHLY.length).toBeGreaterThanOrEqual(900);
  });

  it('first row cpiPct reflects the real prior-month change (1949-12 → 1950-01)', () => {
    expect(HISTORICAL_MONTHLY[0]?.cpiPct).toBeGreaterThan(-10);
    expect(HISTORICAL_MONTHLY[0]?.cpiPct).toBeLessThan(10);
  });

  it('stock annualised mean falls in the sanity band (7%-13%)', () => {
    const s = historicalMonthlySummary();
    const annual = s.stock.arithMeanPct * 12;
    expect(annual).toBeGreaterThanOrEqual(7);
    expect(annual).toBeLessThanOrEqual(13);
  });
});

describe('samplers', () => {
  it('drawOneMonth returns a valid row', () => {
    const rng = makeRng(42);
    const m = drawOneMonth(rng);
    expect(HISTORICAL_MONTHLY).toContain(m);
  });

  it('drawMonthlySeries returns the requested length', () => {
    const rng = makeRng(7);
    const series = drawMonthlySeries(rng, 100);
    expect(series).toHaveLength(100);
  });

  it('same seed → identical series (determinism)', () => {
    const a = drawMonthlySeries(makeRng(1234), 50);
    const b = drawMonthlySeries(makeRng(1234), 50);
    expect(a.map((m) => m.date)).toEqual(b.map((m) => m.date));
  });
});

describe('blendedReturnMonthly', () => {
  it('returns the mix-weighted average', () => {
    const m = {
      date: '2000-01',
      stockPct: 10,
      bondPct: 2,
      cashPct: 0.5,
      cpiPct: 0.2,
    };
    expect(
      blendedReturnMonthly({ stocksPct: 60, bondsPct: 30, cashPct: 10 }, m),
    ).toBeCloseTo(0.6 * 10 + 0.3 * 2 + 0.1 * 0.5, 9);
  });

  it('all-cash mix returns the cash leg only', () => {
    const m = {
      date: '2000-01',
      stockPct: 100,
      bondPct: 100,
      cashPct: 0.4,
      cpiPct: 0,
    };
    expect(
      blendedReturnMonthly({ stocksPct: 0, bondsPct: 0, cashPct: 100 }, m),
    ).toBeCloseTo(0.4, 9);
  });

  it('all-zero shock returns the gross blend unchanged', () => {
    const m = { date: '2000-01', stockPct: 8, bondPct: 3, cashPct: 1, cpiPct: 0.2 };
    const mix = { stocksPct: 60, bondsPct: 30, cashPct: 10 };
    const gross = blendedReturnMonthly(mix, m);
    expect(
      blendedReturnMonthly(mix, m, {
        annualInvestmentCostPct: 0,
        returnShock: { stocksPct: 0, bondsPct: 0, cashPct: 0 },
      }),
    ).toBe(gross);
  });
});

// Drift guard: `blendedReturnMonthly` is the REFERENCE shock definition;
// the MC per-account HOT PATH (`buildPerAccountReturnSeries`, reached via the
// exported `buildPerAccountKernelInputs` in monte-carlo-per-account.ts) INLINES
// the same `−cost/12 − blendedShock/12` mean-shift for speed rather than calling
// this. These tests drive the REAL hot path with fixed historical columns (both
// a flat asset mix and a multi-year gliding mix) and compare its output directly
// against `blendedReturnMonthly` for the SAME inputs — so a change to either
// copy's arithmetic fails the test. (Re-implementing the inlined formula inside
// the test would compare two independent copies and could not catch a hot-path
// drift.)
describe('per-account hot path ↔ blendedReturnMonthly reference (drift guard)', () => {
  // Fixed 4-row SoA dataset + a fixed sampled-index path into it.
  const columns: HistoricalColumns = {
    stockPct: new Float64Array([8, -4, 12, 2]),
    bondPct: new Float64Array([3, 5, -1, 2]),
    cashPct: new Float64Array([1, 1.2, 0.9, 0.4]),
    cpiPct: new Float64Array([0.2, 0.3, -0.1, 0.1]),
  };
  const stepCount = 6;
  const sampledIdx = new Int32Array([0, 1, 2, 3, 0, 2]);
  const flatMix: AssetMix = { stocksPct: 60, bondsPct: 30, cashPct: 10 };
  // A multi-year gliding mix (one entry per step) — stocks step down, bonds up.
  const glideSeries: AssetMix[] = [
    { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    { stocksPct: 66, bondsPct: 28, cashPct: 6 },
    { stocksPct: 60, bondsPct: 32, cashPct: 8 },
    { stocksPct: 54, bondsPct: 38, cashPct: 8 },
    { stocksPct: 48, bondsPct: 43, cashPct: 9 },
    { stocksPct: 40, bondsPct: 50, cashPct: 10 },
  ];

  const monthAt = (k: number) => ({
    date: '2000-01',
    stockPct: columns.stockPct[k],
    bondPct: columns.bondPct[k],
    cashPct: columns.cashPct[k],
    cpiPct: columns.cpiPct[k],
  });

  function ledgerEntry(
    id: string,
    mix: { assetMix?: AssetMix | null; assetMixSeries?: ReadonlyArray<AssetMix> | null },
  ): MonteCarloAccountLedger {
    const zeros = new Float64Array(stepCount);
    return {
      id,
      initialPre: 0,
      initialPost: 100_000,
      contribPre: zeros,
      contribPost: zeros,
      deposit: zeros,
      assetMix: mix.assetMix ?? null,
      assetMixSeries: mix.assetMixSeries ?? null,
      cbpPlanningReturnPct: null,
    };
  }

  // Run the REAL hot path for one ledger entry and return its per-step series.
  function realSeries(entry: MonteCarloAccountLedger, shock: BlendedReturnShock): Float64Array {
    const [account] = buildPerAccountKernelInputs({
      ledger: [entry],
      stepCount,
      sampledIdx,
      columns,
      injectedReturnPct: null,
      ...(shock.annualInvestmentCostPct !== undefined
        ? { annualInvestmentCostPct: shock.annualInvestmentCostPct }
        : {}),
      ...(shock.returnShock !== undefined ? { returnShock: shock.returnShock } : {}),
    });
    return account.returnPct;
  }

  it('cost-drag only (no return shock): the real hot path is BIT-IDENTICAL to the reference (flat + glide)', () => {
    const shock: BlendedReturnShock = { annualInvestmentCostPct: 0.9 };
    const flat = realSeries(ledgerEntry('flat', { assetMix: flatMix }), shock);
    const glide = realSeries(ledgerEntry('glide', { assetMixSeries: glideSeries }), shock);
    for (let i = 0; i < stepCount; i += 1) {
      const k = sampledIdx[i];
      // No returnShock → both compute `gross − cost/12` from the identical
      // weight-then-multiply gross, so they agree to the last bit. Exact
      // equality is the strongest drift guard.
      expect(flat[i]).toBe(blendedReturnMonthly(flatMix, monthAt(k), shock));
      expect(glide[i]).toBe(blendedReturnMonthly(glideSeries[i], monthAt(k), shock));
    }
  });

  it('cost + per-asset return shock: the real hot path matches the reference to full double precision (flat + glide)', () => {
    const shock: BlendedReturnShock = {
      annualInvestmentCostPct: 0.9,
      returnShock: { stocksPct: 2, bondsPct: 1, cashPct: 1 },
    };
    const flat = realSeries(ledgerEntry('flat', { assetMix: flatMix }), shock);
    const glide = realSeries(ledgerEntry('glide', { assetMixSeries: glideSeries }), shock);
    for (let i = 0; i < stepCount; i += 1) {
      const k = sampledIdx[i];
      // With a return shock the hot path hoists each asset's `shock/12`
      // (divide-then-weight) while the reference divides the summed blended
      // shock by 12 (weight-then-divide) — a benign FP reassociation, so they
      // agree to ~1e-12, not bit-for-bit. A real formula change would diverge
      // far beyond this tolerance and still be caught.
      expect(flat[i]).toBeCloseTo(blendedReturnMonthly(flatMix, monthAt(k), shock), 12);
      expect(glide[i]).toBeCloseTo(blendedReturnMonthly(glideSeries[i], monthAt(k), shock), 12);
    }
    // Prove the shock genuinely moved the return (guard against a no-op branch):
    // the shocked series sits below the un-shocked gross blend.
    const grossFlat = realSeries(ledgerEntry('flat', { assetMix: flatMix }), {});
    expect(flat[0]).toBeLessThan(grossFlat[0]);
  });
});
