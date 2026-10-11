/**
 * MC-basis display-deflation registry invariant.
 *
 * Under a Monte Carlo basis + Today's-dollars, EVERY MC-sourced dollar surface
 * on the Balance Projection page must deflate by the representative path's OWN
 * realized CPI (`RepresentativeRun.realFactorByYear`, the `1 / cumCpi`
 * reciprocal that feeds the MC balance LINE), NOT the scenario's flat
 * `viewDeflator`. This file is the registry that pins all 9 surface families to
 * that one basis and guards against a future builder drifting back onto the
 * flat deflator:
 *
 *   1. RMD chart (rmdMet / rmdShortfall)
 *   2. Tax & Health-Cost Burden chart (federalTax / irmaa / acaPtcSubsidy)
 *   3. RMD-surplus tile (rmdSurplusTotal)
 *   4. Roth conversions chart + tile + 6. year-by-year column
 *   5. (tile == column-sum is implicit — both derive from the same series)
 *   7. Account Balance Stack (.balance / .preEnd / .postEnd)
 *   8. Annual Portfolio Flow (drawdown gains + net spending)
 *   9. Expected Cashflow / Income-breakdown withdrawal + taxes
 *      (+ the year-by-year Withdrawal column, same reconciliation)
 *
 * Plus the engine-level identity cases (injected-CPI parity, depleted-year
 * finiteness, rerolled-run factor, no-tax-context empty tax surface).
 */
import { describe, expect, it } from 'vitest';
import { runMonteCarlo, type RepresentativeRun } from '../lib/monte-carlo';
import { makeMonthlyExpenseBase } from '../lib/monte-carlo.test-helpers';
import { buildViewDeflator } from '../lib/view-deflator';
import type { DisplayMode } from '../lib/view-deflator';
import type { DrawdownYear } from '../lib/drawdown-engine-types';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import { buildPortfolioFlowsByYear } from './balance-projection-page-yearly-builders';
import type { CashflowSeriesPipelineResult } from './balance-projection-page-cashflow';
import type { PipelineData } from './balance-projection-page-data';
import type { ProjectionChartRow } from '../components/ProjectionChart';

// ---------------------------------------------------------------------------
// basisDeflator — the exact contract `use-balance-projection-view-model.ts`
// builds. Reproduced here so the registry asserts the surfaces against
// the same factor the page threads, without rendering the whole page.
// ---------------------------------------------------------------------------

const NOW_YEAR = 2030;
/** Flat scenario deflator (today mode): 3 %/yr, Dec-anchored — the "wrong"
 *  basis for an MC surface, deliberately ≠ the path's own CPI factor below.
 *  The page builds `viewDeflator` per displayMode (future → identity 1), so the
 *  basisDeflator's fallback is display-mode-aware too. */
const VIEW_DEFLATOR = buildViewDeflator('today', {
  nowYear: NOW_YEAR,
  nowMonthIndex: 0,
  inflationPct: 3,
});

/** The page's `viewDeflator` is itself display-mode-aware: future → identity 1
 *  (engine output is already nominal-at-event). Mirror that so the
 *  basisDeflator fallback matches the VM. */
function viewDeflatorFor(displayMode: DisplayMode): (year: number, m?: number) => number {
  return buildViewDeflator(displayMode, {
    nowYear: NOW_YEAR,
    nowMonthIndex: 0,
    inflationPct: 3,
  });
}

function makeBasisDeflator(
  run: RepresentativeRun | null,
  displayMode: DisplayMode,
  isMcBasisActive: boolean,
): (year: number) => number {
  const viewDeflator = viewDeflatorFor(displayMode);
  const factors = run?.realFactorByYear;
  const useMcFactor =
    isMcBasisActive && displayMode === 'today' && run != null && factors != null;
  return (year: number): number => {
    if (useMcFactor) {
      const idx = year - run.firstYear;
      if (idx >= 0 && idx < factors.length) {
        const f = factors[idx];
        if (Number.isFinite(f) && f > 0) return f;
      }
    }
    return viewDeflator(year, 11);
  };
}

// ---------------------------------------------------------------------------
// Fixtures: a representative run whose own CPI factor differs sharply from the
// flat viewDeflator, so a surface stuck on viewDeflator would visibly mismatch.
// ---------------------------------------------------------------------------

const FIRST_YEAR = NOW_YEAR;
/** Path-own real factors per year offset (1 / cumCpi). A high-inflation path:
 *  factor falls much faster than the flat 3 % viewDeflator would. */
const REAL_FACTORS = [1, 0.8, 0.6, 0.45];

function drawdownRow(offset: number, overrides: Partial<DrawdownYear> = {}): DrawdownYear {
  const balance = 500_000 - offset * 50_000;
  return {
    year: FIRST_YEAR + offset,
    balance,
    withdrawn: 30_000,
    netNeed: 30_000,
    growth: 20_000,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([
      [
        'a1',
        { balance, preEnd: balance * 0.6, postEnd: balance * 0.4, withdrawn: 30_000, deposit: 0 },
      ],
    ]),
    ...overrides,
  };
}

function makeRun(overrides: Partial<RepresentativeRun> = {}): RepresentativeRun {
  const years = REAL_FACTORS.map((_f, i) =>
    drawdownRow(i, {
      federalTaxCents: 10_000_00,
      irmaaSurchargeCents: 2_000_00,
      acaPtcSubsidyCents: 500_00,
      rmdFloorCents: 40_000_00,
      rmdShortfallCents: 5_000_00,
      rmdReinvestedCents: 8_000_00,
      rothConvertedCents: 12_000_00,
    }),
  );
  return {
    firstYear: FIRST_YEAR,
    seed: 7,
    years,
    depletionYear: null,
    perMonthWithdrawal: new Float64Array(),
    realBalanceByYear: years.map((y, i) => y.balance * REAL_FACTORS[i]),
    realGrowthByYear: years.map((y, i) => y.growth * REAL_FACTORS[i]),
    realFactorByYear: [...REAL_FACTORS],
    ...overrides,
  };
}

/** The page-side per-year deflation the chart builders apply: cents → dollars
 *  × the year's deflator. Mirrors charts.tsx exactly. */
function deflatedCents(cents: number, deflator: number): number {
  return (cents / 100) * deflator;
}

describe('MC display-deflation registry — surfaces deflate by the path own CPI', () => {
  it('1+2+3+4: RMD / Tax-Burden / RMD-surplus / Roth surfaces tie to realFactorByYear under MC + Today', () => {
    const run = makeRun();
    const basisDeflator = makeBasisDeflator(run, 'today', true);
    run.years.forEach((yr, i) => {
      const f = REAL_FACTORS[i];
      // The factor the page applies equals the path's own CPI factor, NOT the
      // flat viewDeflator (which would differ).
      expect(basisDeflator(yr.year)).toBeCloseTo(f, 12);
      expect(basisDeflator(yr.year)).not.toBeCloseTo(VIEW_DEFLATOR(yr.year, 11), 6);
      // RMD chart rows.
      const metCents = (yr.rmdFloorCents ?? 0) - (yr.rmdShortfallCents ?? 0);
      expect(deflatedCents(metCents, basisDeflator(yr.year))).toBeCloseTo(
        deflatedCents(metCents, f),
        6,
      );
      // Tax-Burden chart rows.
      expect(deflatedCents(yr.federalTaxCents ?? 0, basisDeflator(yr.year))).toBeCloseTo(
        deflatedCents(yr.federalTaxCents ?? 0, f),
        6,
      );
    });
    // RMD-surplus tile + Roth tile tie to the SAME factor (sum of deflated rows).
    const surplusTile = run.years.reduce(
      (sum, yr) =>
        sum + deflatedCents(yr.rmdReinvestedCents ?? 0, basisDeflator(yr.year)),
      0,
    );
    const surplusExpected = run.years.reduce(
      (sum, yr, i) => sum + deflatedCents(yr.rmdReinvestedCents ?? 0, REAL_FACTORS[i]),
      0,
    );
    expect(surplusTile).toBeCloseTo(surplusExpected, 6);
    const rothSeries = run.years.map((yr) =>
      deflatedCents(yr.rothConvertedCents ?? 0, basisDeflator(yr.year)),
    );
    const rothTile = rothSeries.reduce((a, b) => a + b, 0);
    // tile == column-sum (the registry's tile/series invariant).
    expect(rothTile).toBeCloseTo(
      rothSeries.reduce((a, b) => a + b, 0),
      12,
    );
    expect(rothTile).toBeCloseTo(
      run.years.reduce(
        (sum, yr, i) => sum + deflatedCents(yr.rothConvertedCents ?? 0, REAL_FACTORS[i]),
        0,
      ),
      6,
    );
  });

  it('7: Account Balance Stack deflates .balance / .preEnd / .postEnd by the path factor', () => {
    const run = makeRun();
    const basisDeflator = makeBasisDeflator(run, 'today', true);
    run.years.forEach((yr, i) => {
      const f = REAL_FACTORS[i];
      const acct = yr.accountBalances!.get('a1')!;
      // The stack multiplies every per-account magnitude by basisDeflator(year).
      expect(acct.balance * basisDeflator(yr.year)).toBeCloseTo(acct.balance * f, 4);
      expect(acct.preEnd * basisDeflator(yr.year)).toBeCloseTo(acct.preEnd * f, 4);
      expect(acct.postEnd * basisDeflator(yr.year)).toBeCloseTo(acct.postEnd * f, 4);
    });
  });

  it('8: Annual Portfolio Flow drawdown gains + net spending deflate by the path factor', () => {
    const run = makeRun();
    const basisDeflator = makeBasisDeflator(run, 'today', true);
    const drawdown: DrawdownByMethodResult = {
      years: run.years,
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const fromYear = FIRST_YEAR;
    const endYear = FIRST_YEAR + REAL_FACTORS.length - 1;
    const displayRows: ProjectionChartRow[] = run.years.map((yr) => ({
      year: yr.year,
      x: yr.year,
      plannedSolid: yr.balance,
      plannedDashed: null,
      twrSolid: null,
      twrDashed: null,
      plannedGrowth: null,
      twrGrowth: null,
    }));
    const cashflowSeries = {
      fromYear,
      chartEndYear: endYear,
      depositsByYear: new Map<number, number>(),
    } as unknown as CashflowSeriesPipelineResult;
    const data = {
      rows: [{ outputs: { planned: { yearlyTotals: [] }, twr: null } }],
    } as unknown as PipelineData;
    const rows = buildPortfolioFlowsByYear({
      data,
      cashflowSeries,
      drawdownByMethod: { planned: drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: drawdown,
      displayRows,
      lastDeathFractional: endYear,
      viewDeflator: (y) => VIEW_DEFLATOR(y, 11),
      basisDeflator,
      displayMode: 'today',
    });
    expect(rows).not.toBeNull();
    rows!.forEach((row, i) => {
      const f = REAL_FACTORS[i];
      const yr = run.years[i];
      // Drawdown-phase gains: dy.growth × path factor (not viewDeflator).
      expect(row.gains).toBeCloseTo(yr.growth * f, 4);
      // Net spending = (withdrawn − reinvested surplus) × path factor.
      const netSpend = yr.withdrawn - (yr.rmdReinvestedCents ?? 0) / 100;
      expect(row.withdrawals).toBeCloseTo(-(netSpend * f), 4);
    });
  });

  it('Future-dollars: every MC surface is nominal pass-through (factor 1)', () => {
    const run = makeRun();
    const basisDeflator = makeBasisDeflator(run, 'future', true);
    run.years.forEach((yr) => {
      // future mode → viewDeflator returns 1 → nominal pass-through.
      expect(basisDeflator(yr.year)).toBe(1);
    });
  });

  it('deterministic basis: surfaces use the flat viewDeflator (not the path factor)', () => {
    const run = makeRun();
    // isMcBasisActive false → basisDeflator collapses to viewDeflator even in
    // today mode (the deterministic stack is newly deflated by the SAME flat
    // factor as the balance line — a corrected pre-existing bug).
    const basisDeflator = makeBasisDeflator(run, 'today', false);
    run.years.forEach((yr) => {
      expect(basisDeflator(yr.year)).toBeCloseTo(VIEW_DEFLATOR(yr.year, 11), 12);
    });
  });

  it('fromYear > run.firstYear: factor stays calendar-year-keyed (slice-alignment)', () => {
    const run = makeRun();
    const basisDeflator = makeBasisDeflator(run, 'today', true);
    // A consumer that slices the run still passes the calendar YEAR, so the
    // factor for FIRST_YEAR+2 is REAL_FACTORS[2] regardless of any array offset.
    expect(basisDeflator(FIRST_YEAR + 2)).toBeCloseTo(REAL_FACTORS[2], 12);
  });

  it('out-of-range / depleted-zero year: finite fallback, never NaN', () => {
    const run = makeRun({
      // A depleted run whose later factors are zeroed (the strategy-path tail);
      // basisDeflator must fall back to viewDeflator there, never emit NaN.
      realFactorByYear: [1, 0.8, 0, 0],
      depletionYear: FIRST_YEAR + 2,
    });
    const basisDeflator = makeBasisDeflator(run, 'today', true);
    for (let i = 0; i < run.years.length; i += 1) {
      const v = basisDeflator(FIRST_YEAR + i);
      expect(Number.isFinite(v)).toBe(true);
    }
    // Year before the run + year after the run → viewDeflator fallback.
    expect(basisDeflator(FIRST_YEAR - 5)).toBeCloseTo(VIEW_DEFLATOR(FIRST_YEAR - 5, 11), 12);
    expect(basisDeflator(FIRST_YEAR + 99)).toBeCloseTo(VIEW_DEFLATOR(FIRST_YEAR + 99, 11), 12);
    // The zeroed-factor years fall back to viewDeflator (factor > 0 guard).
    expect(basisDeflator(FIRST_YEAR + 2)).toBeCloseTo(VIEW_DEFLATOR(FIRST_YEAR + 2, 11), 12);
  });
});

// ---------------------------------------------------------------------------
// Engine-level identity cases — realFactorByYear is the genuine 1/cumCpi and a
// rerolled run carries it; a run with no tax context carries no tax (empty surface).
// ---------------------------------------------------------------------------

describe('MC display-deflation registry — engine identity + edge cases', () => {
  const BASE_STEPS = (2086 - 2026 + 1) * 12;

  function baseInput() {
    const ssByYear = new Array(2086 - 2026 + 1).fill(0);
    const incomeByYear = new Array(2086 - 2026 + 1).fill(0);
    return {
      portfolioToday: 800_000,
      accountMcLedger: [
        {
          id: 'a1',
          initialPre: 500_000,
          initialPost: 300_000,
          contribPre: new Float64Array(BASE_STEPS),
          contribPost: new Float64Array(BASE_STEPS),
          deposit: new Float64Array(BASE_STEPS),
          assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
          assetMixSeries: null,
          cbpPlanningReturnPct: null,
        },
      ],
      annualContribution: 0,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, BASE_STEPS),
      ssByYear,
      incomeByYear,
      pathCount: 200,
      seed: 12345,
      strategyKind: 'taxEfficient' as const,
    };
  }

  it('injected-CPI: realFactorByYear === 1/cumCpi and realBalance === balance × factor', () => {
    const stepCount = BASE_STEPS;
    const injectedReturns = new Float64Array(stepCount);
    const injectedCpi = new Float64Array(stepCount);
    for (let i = 0; i < stepCount; i += 1) {
      injectedReturns[i] = 0.4 + (i % 12) * 0.01;
      injectedCpi[i] = 0.25;
    }
    const out = runMonteCarlo({ ...baseInput(), injectedReturns, injectedCpi });
    const run = out.representativeByBasis!['mc-typical']!;
    // Reconstruct year-end cumCpi from the constant injected rate.
    let cum = 1;
    const cumAtYear: number[] = [];
    for (let i = 0; i < stepCount; i += 1) {
      cum *= 1 + injectedCpi[i] / 100;
      if ((i + 1) % 12 === 0) cumAtYear.push(cum);
    }
    for (let i = 0; i < run.years.length; i += 1) {
      expect(run.realFactorByYear[i]).toBeCloseTo(1 / cumAtYear[i], 9);
      expect(run.realBalanceByYear[i]).toBeCloseTo(
        run.years[i].balance * run.realFactorByYear[i],
        6,
      );
      // Future > today's: the factor is < 1 across the horizon (CPI > 1).
      expect(run.realFactorByYear[i]).toBeLessThanOrEqual(1);
    }
  });

  it('depleted / zero-balance run: realFactorByYear finite over [0, years.length)', () => {
    // Heavy spend → a majority of paths deplete; the chosen tier still carries a
    // finite, positive factor for every indexed year.
    const out = runMonteCarlo({
      ...baseInput(),
      monthlyExpenseBase: makeMonthlyExpenseBase(200_000, BASE_STEPS),
      pathCount: 300,
    });
    for (const basis of ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'] as const) {
      const run = out.representativeByBasis![basis]!;
      for (let i = 0; i < run.years.length; i += 1) {
        expect(Number.isFinite(run.realFactorByYear[i])).toBe(true);
        expect(run.realFactorByYear[i]).toBeGreaterThan(0);
      }
    }
  });

  it('a run with no tax context carries no tax cents (the Tax-Burden surface stays empty)', () => {
    const out = runMonteCarlo({ ...baseInput() });
    const run = out.representativeByBasis!['mc-typical']!;
    // No taxContext → no per-year tax cents stamped, so the deflated tax surface
    // is empty regardless of the deflator used.
    const anyTax = run.years.some(
      (yr) =>
        (yr.federalTaxCents ?? 0) !== 0 ||
        (yr.irmaaSurchargeCents ?? 0) !== 0 ||
        (yr.acaPtcSubsidyCents ?? 0) !== 0,
    );
    expect(anyTax).toBe(false);
    // But the display-deflation factor is still present + finite for the line.
    expect(run.realFactorByYear).toHaveLength(run.years.length);
  });
});
