/**
 * Tests for `buildSwrComparisonData`. Pure
 * builder — no React, no pipeline: params are hand-built directly so the
 * layer math, capping, degenerate states and both dollar modes can be
 * pinned precisely. Cross-tab agreement (gross withdrawal == Cash flow
 * band, tax == Taxes tab) is proved by construction — `buildSwrComparisonData`
 * reads `yearlyCashflowByYear`/`resolvedDrawdownYears` directly rather than
 * recomputing either, so the fixtures here assert the pass-through.
 */
import { describe, expect, it } from 'vitest';
import { buildSwrComparisonData, type BuildSwrComparisonDataParams } from './balance-projection-swr-derivation';
import {
  SAFE_WITHDRAWAL_RATE_BENGEN_PCT,
  SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT,
} from '../lib/safe-withdrawal-rate';
import { buildViewDeflator } from '../lib/view-deflator';
import type { CashflowMonthlyPoint } from '../components/CashflowProjectionChart';
import type { DrawdownYear } from '../lib/drawdown-engine';
import type { DrawdownByMethodResult, RepresentativeRun } from './balance-projection-page-data';

const IDENTITY = (): number => 1;

function cfRow(
  year: number,
  fields: Partial<CashflowMonthlyPoint> = {},
): CashflowMonthlyPoint {
  return {
    fractionalYear: year,
    year,
    month0: 0,
    essential: 0,
    discretionary: 0,
    taxes: 0,
    total: 0,
    earned: 0,
    withdrawal: 0,
    totalIncome: 0,
    shortfallBase: 0,
    shortfallHeight: 0,
    ...fields,
  };
}

function ddYear(year: number, fields: Partial<DrawdownYear> = {}): DrawdownYear {
  return {
    year,
    balance: 0,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    ...fields,
  };
}

function methodResult(netPortfolioAtRetirement: number): DrawdownByMethodResult {
  return {
    years: [],
    depletionYear: null,
    perMonthWithdrawal: new Float64Array(0),
    netPortfolioAtRetirement,
  };
}

/** Minimal always-valid params — a 2032-only window (single, full, funded
 *  year), Planned basis, deterministic. Each test overrides what it needs. */
function baseParams(
  overrides: Partial<BuildSwrComparisonDataParams> = {},
): BuildSwrComparisonDataParams {
  return {
    displayMode: 'today',
    activeMethod: 'planned',
    activeMcBasis: null,
    enabledCalculatedMethods: new Set(),
    primaryRetirementYear: 2031,
    cashflowFromYear: 2031,
    drawdownByMethod: { planned: methodResult(1_000_000), twr: null },
    activeRepresentativeRun: null,
    isMcBasisActive: false,
    viewDeflator: IDENTITY,
    realDeflator: IDENTITY,
    yearlyCashflowByYear: new Map([
      [2031, cfRow(2031, { withdrawal: 20_000, taxes: 5_000, total: 60_000 })],
      [2032, cfRow(2032, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
    ]),
    drawdownEndYear: 2032,
    depletionYear: null,
    resolvedDrawdownYears: [
      ddYear(2031, { federalTaxCents: 500_000 }),
      ddYear(2032, { federalTaxCents: 500_000 }),
    ],
    sourceSplitByYear: new Map(),
    primaryRetirementIso: '2031-06-01',
    ...overrides,
  };
}

describe('buildSwrComparisonData — degenerate states', () => {
  it('state 2: no retirement year', () => {
    const result = buildSwrComparisonData(baseParams({ primaryRetirementYear: null }));
    expect(result).toEqual({ state: 'no-retirement-year', bundle: null });
  });

  it('state 3: Historical selected but unavailable', () => {
    const result = buildSwrComparisonData(
      baseParams({ activeMethod: 'twr', enabledCalculatedMethods: new Set() }),
    );
    expect(result).toEqual({ state: 'historical-unavailable', bundle: null });
  });

  it('does NOT flag state 3 when Historical is enabled', () => {
    const result = buildSwrComparisonData(
      baseParams({
        activeMethod: 'twr',
        enabledCalculatedMethods: new Set(['twr']),
        drawdownByMethod: { planned: null, twr: methodResult(1_000_000) },
      }),
    );
    expect(result.state).toBe('ok');
  });

  it('state 1: no runner result for the active method', () => {
    const result = buildSwrComparisonData(
      baseParams({ drawdownByMethod: { planned: null, twr: null } }),
    );
    expect(result).toEqual({ state: 'no-runner-result', bundle: null });
  });

  it('state 4: MC tier active but no representative run', () => {
    const result = buildSwrComparisonData(
      baseParams({ activeMcBasis: 'mc-typical', isMcBasisActive: true, activeRepresentativeRun: null }),
    );
    expect(result).toEqual({ state: 'mc-run-unavailable', bundle: null });
  });

  it('state 6: MC index out of range (retiring now — run.firstYear === retirementYear)', () => {
    const run: RepresentativeRun = {
      firstYear: 2031,
      seed: 1,
      years: [ddYear(2031)],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(0),
      realBalanceByYear: [1_000_000],
      realGrowthByYear: [0],
      realFactorByYear: [1],
    };
    const result = buildSwrComparisonData(
      baseParams({
        activeMcBasis: 'mc-typical',
        isMcBasisActive: true,
        activeRepresentativeRun: run,
        primaryRetirementYear: 2031,
      }),
    );
    expect(result).toEqual({ state: 'mc-index-out-of-range', bundle: null });
  });

  it('no full retirement year: a mid-year retirement whose window ends in the transition year itself (life expectancy reached in the retirement year) is a distinct marker — never an `ok` bundle with a $0 anchor draw', () => {
    // Window [2031, 2031] with a June retirement: the anchor is 2032, which
    // the window never reaches. The single partial-year row carries a
    // positive draw, so an `ok` result here could only mean the anchor
    // scalar survived as its `0` initialiser.
    const result = buildSwrComparisonData(
      baseParams({
        primaryRetirementIso: '2031-06-15',
        primaryRetirementYear: 2031,
        cashflowFromYear: 2031,
        drawdownEndYear: 2031,
        yearlyCashflowByYear: new Map([[2031, cfRow(2031, { withdrawal: 20_000, taxes: 5_000, total: 60_000 })]]),
        resolvedDrawdownYears: [ddYear(2031, { federalTaxCents: 500_000 })],
      }),
    );
    expect(result).toEqual({ state: 'no-full-retirement-year', bundle: null });
  });

  it('no full retirement year: an empty window (the window closes before the transition year) is the same marker, for a mid-year AND a January-1 retirement', () => {
    for (const primaryRetirementIso of ['2031-06-15', '2031-01-01']) {
      const result = buildSwrComparisonData(
        baseParams({
          primaryRetirementIso,
          primaryRetirementYear: 2031,
          cashflowFromYear: 2031,
          drawdownEndYear: 2030,
          yearlyCashflowByYear: new Map(),
          resolvedDrawdownYears: [],
        }),
      );
      expect(result).toEqual({ state: 'no-full-retirement-year', bundle: null });
    }
  });

  it('state 5: no row in the window carries a tax figure — noTaxFigures true, tax layer zeroed, no throw', () => {
    const result = buildSwrComparisonData(
      baseParams({
        resolvedDrawdownYears: [ddYear(2031), ddYear(2032)], // no *Cents fields anywhere
      }),
    );
    expect(result.state).toBe('ok');
    expect(result.bundle!.noTaxFigures).toBe(true);
    for (const row of result.bundle!.rows) {
      expect(row.tax).toBe(0);
    }
  });
});

describe('buildSwrComparisonData — portfolio at retirement', () => {
  it('reads the runner net figure, not a raw sum, deflated by viewDeflator', () => {
    const viewDeflator = (year: number): number => (year === 2031 ? 0.9 : 1);
    const result = buildSwrComparisonData(
      baseParams({ drawdownByMethod: { planned: methodResult(700_000), twr: null }, viewDeflator }),
    );
    expect(result.state).toBe('ok');
    expect(result.bundle!.portfolioAtRetirement).toBeCloseTo(700_000 * 0.9, 6);
  });

  it('MC: today reads realBalanceByYear[idx]; future reads years[idx].balance — pinned to the accumulation/drawdown PHASE BOUNDARY (no accountBalances at idx, accountBalances at idx+1), with a materially different candidate at idx+1', () => {
    // retirementYear=2031, firstYear=2020 -> idx = 2031-2020-1 = 10. Rows
    // 0..10 (years 2020..2030) are the accumulation phase — no
    // `accountBalances`, steeply growing balance. Row 11 (2031, the
    // retirement year itself) is the first DRAWDOWN-phase row — it alone
    // carries `accountBalances` (the real phase discriminator the resolved-
    // drawdown adapter and this builder both key off) and its balance drops
    // sharply post-withdrawal, so reading idx+1 instead of idx would land on
    // a candidate an order of magnitude off, not a ~1.6% rounding difference.
    const run: RepresentativeRun = {
      firstYear: 2020,
      seed: 1,
      years: Array.from({ length: 12 }, (_, i) => {
        const year = 2020 + i;
        if (i <= 10) return ddYear(year, { balance: 100_000 + i * 50_000 });
        return ddYear(year, {
          balance: 60_000,
          accountBalances: new Map([
            ['a1', { balance: 60_000, preEnd: 0, postEnd: 60_000, withdrawn: 5_000, deposit: 0 }],
          ]),
        });
      }),
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(0),
      realBalanceByYear: Array.from({ length: 12 }, (_, i) => (i <= 10 ? 50_000 + i * 25_000 : 30_000)),
      realGrowthByYear: Array.from({ length: 12 }, () => 0),
      realFactorByYear: Array.from({ length: 12 }, () => 0.5),
    };
    // The discriminator: the chosen index carries no `accountBalances`, and
    // index + 1 does.
    expect(run.years[10].accountBalances).toBeUndefined();
    expect(run.years[11].accountBalances).toBeDefined();
    const today = buildSwrComparisonData(
      baseParams({
        activeMcBasis: 'mc-typical',
        isMcBasisActive: true,
        activeRepresentativeRun: run,
        displayMode: 'today',
      }),
    );
    const future = buildSwrComparisonData(
      baseParams({
        activeMcBasis: 'mc-typical',
        isMcBasisActive: true,
        activeRepresentativeRun: run,
        displayMode: 'future',
      }),
    );
    expect(today.state).toBe('ok');
    expect(future.state).toBe('ok');
    // idx = 10 -> realBalanceByYear[10] = 300_000, years[10].balance = 600_000.
    expect(today.bundle!.portfolioAtRetirement).toBe(300_000);
    expect(future.bundle!.portfolioAtRetirement).toBe(600_000);
    // NOT the retirement-year row itself (idx 11 -> 30_000 / 60_000) — 10x
    // off, so even a tolerance-based assertion would catch the off-by-one.
    expect(today.bundle!.portfolioAtRetirement).not.toBeCloseTo(30_000, -3);
    expect(future.bundle!.portfolioAtRetirement).not.toBeCloseTo(60_000, -3);
  });
});

describe('buildSwrComparisonData — the anchor is the first FULL retirement year', () => {
  it('a mid-year retirement flags the transition year partial (null rule values) and anchors one year later', () => {
    const result = buildSwrComparisonData(
      baseParams({
        primaryRetirementIso: '2031-06-01',
        primaryRetirementYear: 2031,
        cashflowFromYear: 2031,
        drawdownEndYear: 2032,
        yearlyCashflowByYear: new Map([
          // Transition year: small partial-year draw (would fail a "compared" check).
          [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
        ]),
      }),
    );
    expect(result.state).toBe('ok');
    const b = result.bundle!;
    expect(b.anchorYear).toBe(2032);
    expect(b.rows[0].isPartialYear).toBe(true);
    expect(b.rows[0].fourPercentRuleValue).toBeNull();
    expect(b.rows[0].fourPointFivePercentRuleValue).toBeNull();
    expect(b.rows[1].isPartialYear).toBe(false);
    expect(b.rows[1].fourPercentRuleValue).not.toBeNull();
    // Card scalar and the series value at the anchor year are the same number.
    expect(b.anchorAfterTaxDraw).toBe(b.rows[1].afterTaxDraw);
    expect(b.anchorAfterTaxDraw).toBe(40_000 - 5_000);
  });

  it('a January-1 retirement anchors at the transition year itself — not partial', () => {
    const result = buildSwrComparisonData(
      baseParams({
        primaryRetirementIso: '2031-01-01',
        cashflowFromYear: 2031,
        drawdownEndYear: 2031,
        yearlyCashflowByYear: new Map([[2031, cfRow(2031, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })]]),
      }),
    );
    expect(result.state).toBe('ok');
    expect(result.bundle!.anchorYear).toBe(2031);
    expect(result.bundle!.valuationOffsetYears).toBe(0);
    expect(result.bundle!.rows[0].isPartialYear).toBe(false);
    expect(result.bundle!.rows[0].fourPercentRuleValue).not.toBeNull();
  });

  it('MC: valuationOffsetYears reads the MC pre-drawdown instant (December of the year BEFORE retirement), not the deterministic Jan-1 test alone — 1 year for a Jan-1 MC retirement, 2 for a mid-year one', () => {
    const makeRun = (length: number): RepresentativeRun => ({
      firstYear: 2020,
      seed: 1,
      years: Array.from({ length }, (_, i) => ddYear(2020 + i, { balance: 500_000 })),
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(0),
      realBalanceByYear: Array.from({ length }, () => 500_000),
      realGrowthByYear: Array.from({ length }, () => 0),
      realFactorByYear: Array.from({ length }, () => 1),
    });

    // retirementYear=2030, firstYear=2020 -> idx=9 (December 2029 — a full
    // MC year before the deterministic case's "no offset").
    const janFirst = buildSwrComparisonData(
      baseParams({
        activeMcBasis: 'mc-typical',
        isMcBasisActive: true,
        activeRepresentativeRun: makeRun(11),
        primaryRetirementYear: 2030,
        cashflowFromYear: 2030,
        drawdownEndYear: 2030,
        primaryRetirementIso: '2030-01-01',
        yearlyCashflowByYear: new Map([[2030, cfRow(2030, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })]]),
      }),
    );
    expect(janFirst.state).toBe('ok');
    expect(janFirst.bundle!.anchorYear).toBe(2030);
    expect(janFirst.bundle!.valuationOffsetYears).toBe(1);

    const midYear = buildSwrComparisonData(
      baseParams({
        activeMcBasis: 'mc-typical',
        isMcBasisActive: true,
        activeRepresentativeRun: makeRun(12),
        primaryRetirementYear: 2030,
        cashflowFromYear: 2030,
        drawdownEndYear: 2031,
        primaryRetirementIso: '2030-07-01',
        yearlyCashflowByYear: new Map([
          [2030, cfRow(2030, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2031, cfRow(2031, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
        ]),
      }),
    );
    expect(midYear.state).toBe('ok');
    expect(midYear.bundle!.anchorYear).toBe(2031);
    expect(midYear.bundle!.valuationOffsetYears).toBe(2);
  });
});

describe('buildSwrComparisonData — the four-layer identity', () => {
  it('guaranteed + other + after-tax draw + tax == planned spend + tax, with part-time wages', () => {
    // need (=total) = 60_000 = plannedSpendOnly(55_000) + tax(5_000).
    // ss+pension = 20_000, partTime = 10_000, gross withdrawal (funded) =
    // need - earned = 60_000 - 30_000 = 30_000, after-tax draw = 25_000.
    const result = buildSwrComparisonData(
      baseParams({
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 30_000, taxes: 5_000, total: 60_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 15_000, pensionAnnuity: 5_000, partTime: 10_000, oneOff: 0 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    expect(row.guaranteedIncome).toBeCloseTo(20_000, 6);
    expect(row.otherIncome).toBeCloseTo(10_000, 6);
    expect(row.afterTaxDraw).toBeCloseTo(25_000, 6); // withdrawal(30k) - tax(5k)
    expect(row.tax).toBe(5_000);
    expect(row.guaranteedIncome + row.otherIncome + row.afterTaxDraw + row.tax).toBeCloseTo(
      60_000, // planned spend(55k) + tax(5k) == cfRow.total
      6,
    );
    // Other income never lands in the guaranteed layer.
    expect(row.guaranteedIncomeSplit.socialSecurity).toBeCloseTo(15_000, 6);
    expect(row.guaranteedIncomeSplit.pension).toBeCloseTo(5_000, 6);
  });

  it('holds with an untargeted one-off windfall instead of wages', () => {
    const result = buildSwrComparisonData(
      baseParams({
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 30_000, taxes: 5_000, total: 60_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 15_000, pensionAnnuity: 5_000, partTime: 0, oneOff: 10_000 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    expect(row.otherIncome).toBeCloseTo(10_000, 6);
    expect(row.guaranteedIncome + row.otherIncome + row.afterTaxDraw + row.tax).toBeCloseTo(60_000, 6);
  });

  it('a surplus-guaranteed-income year floors both portfolio layers at 0 and surfaces the surplus, never a negative segment', () => {
    // plannedSpendOnly = 30_000 (total 30k, tax 0); guaranteed = 50_000 (surplus 20_000).
    const result = buildSwrComparisonData(
      baseParams({
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 0, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 0, taxes: 0, total: 30_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 40_000, pensionAnnuity: 10_000, partTime: 0, oneOff: 0 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    expect(row.guaranteedIncome).toBe(30_000);
    expect(row.otherIncome).toBe(0);
    expect(row.afterTaxDraw).toBe(0);
    expect(row.guaranteedIncomeSurplus).toBe(20_000);
    for (const value of Object.values(row)) {
      if (typeof value === 'number') expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('guaranteedIncomeSurplus is measured against planned spend PLUS the tax the draw funds — a funded year with tax reports 0 surplus, not an overstated one', () => {
    // total=110_000, tax=10_000 -> plannedSpendOnly=100_000; guaranteed
    // (ss+pension)=105_000; the reconciled withdrawal is 5_000
    // (110_000 - 105_000) — the portfolio really was tapped that year, all
    // of it absorbed by the tax the draw funds, so the true surplus is 0.
    const result = buildSwrComparisonData(
      baseParams({
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 0, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 5_000, taxes: 10_000, total: 110_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 80_000, pensionAnnuity: 25_000, partTime: 0, oneOff: 0 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    // Display cap is unchanged: min(105_000, plannedSpendOnly 100_000).
    expect(row.guaranteedIncome).toBe(100_000);
    expect(row.afterTaxDraw).toBe(0); // max(0, 5_000 - 10_000)
    expect(row.tax).toBe(10_000);
    expect(row.guaranteedIncomeSurplus).toBe(0);
  });

  it('carries the depletion year through, unaltered', () => {
    const result = buildSwrComparisonData(baseParams({ depletionYear: 2070 }));
    expect(result.bundle!.depletionYear).toBe(2070);
  });

  it('guaranteed/other income layers scale by a non-identity viewDeflator — NOT the raw nominal split (today\'s-dollars)', () => {
    // f=0.8 at 2032 only: distinguishes "scaled by viewDeflator" from a
    // deleted `* f` (which would leave the nominal 20_000 / 10_000 instead).
    const viewDeflator = (year: number): number => (year === 2032 ? 0.8 : 1);
    const result = buildSwrComparisonData(
      baseParams({
        viewDeflator,
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 30_000, taxes: 5_000, total: 60_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 15_000, pensionAnnuity: 5_000, partTime: 10_000, oneOff: 0 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    // Nominal ss+pension = 20_000, partTime = 10_000 — both at the SAME f=0.8.
    expect(row.guaranteedIncome).toBeCloseTo(16_000, 6);
    expect(row.otherIncome).toBeCloseTo(8_000, 6);
    expect(row.guaranteedIncomeSplit.socialSecurity).toBeCloseTo(15_000 * 0.8, 6);
    expect(row.guaranteedIncomeSplit.pension).toBeCloseTo(5_000 * 0.8, 6);
  });

  it('holds under Future-dollars too — the other-income layer is pinned to the SAME deflator as the guaranteed layer, not left nominal', () => {
    const viewDeflator = (year: number): number => (year === 2032 ? 0.8 : 1);
    const result = buildSwrComparisonData(
      baseParams({
        displayMode: 'future',
        viewDeflator,
        realDeflator: IDENTITY,
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
          [2032, cfRow(2032, { withdrawal: 30_000, taxes: 5_000, total: 60_000 })],
        ]),
        sourceSplitByYear: new Map([[2032, { ss: 15_000, pensionAnnuity: 5_000, partTime: 10_000, oneOff: 0 }]]),
      }),
    );
    const row = result.bundle!.rows.find((r) => r.year === 2032)!;
    expect(row.guaranteedIncome).toBeCloseTo(16_000, 6);
    expect(row.otherIncome).toBeCloseTo(8_000, 6);
  });
});

describe('buildSwrComparisonData — both dollar modes', () => {
  it("today's-dollars: the rule figure is exactly rate x portfolio, flat across every compared year", () => {
    const result = buildSwrComparisonData(
      baseParams({
        primaryRetirementIso: '2031-01-01',
        cashflowFromYear: 2031,
        drawdownEndYear: 2033,
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
          [2032, cfRow(2032, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
          [2033, cfRow(2033, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
        ]),
        drawdownByMethod: { planned: methodResult(1_000_000), twr: null },
      }),
    );
    const expected4 = (SAFE_WITHDRAWAL_RATE_BENGEN_PCT / 100) * 1_000_000;
    const expected45 = (SAFE_WITHDRAWAL_RATE_BENGEN_REFINED_PCT / 100) * 1_000_000;
    for (const row of result.bundle!.rows) {
      expect(row.fourPercentRuleValue).toBeCloseTo(expected4, 6);
      expect(row.fourPointFivePercentRuleValue).toBeCloseTo(expected45, 6);
    }
  });

  it('future-dollars: the rule line is NOT flat nominal — it inflates year over year with the same factor the draw layer carries', () => {
    const anchor = { nowYear: 2026, nowMonthIndex: 5, inflationPct: 3 };
    const realDeflator = buildViewDeflator('today', anchor);
    // Under an ACTIVE future-dollars mode, viewDeflator is the identity —
    // the page's own convention (raw nominal-as-computed layers).
    const viewDeflator = (): number => 1;
    const result = buildSwrComparisonData(
      baseParams({
        displayMode: 'future',
        primaryRetirementIso: '2031-01-01',
        primaryRetirementYear: 2031,
        cashflowFromYear: 2031,
        drawdownEndYear: 2033,
        viewDeflator,
        realDeflator,
        yearlyCashflowByYear: new Map([
          [2031, cfRow(2031, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
          [2032, cfRow(2032, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
          [2033, cfRow(2033, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })],
        ]),
        drawdownByMethod: { planned: methodResult(1_000_000), twr: null },
      }),
    );
    const rows = result.bundle!.rows;
    // Not flat: each later year's nominal figure is strictly larger than the
    // last (the real rule constant re-inflated further forward each year).
    expect(rows[0].fourPercentRuleValue).not.toBeCloseTo(rows[2].fourPercentRuleValue!, 2);
    expect(rows[0].fourPercentRuleValue!).toBeLessThan(rows[1].fourPercentRuleValue!);
    expect(rows[1].fourPercentRuleValue!).toBeLessThan(rows[2].fourPercentRuleValue!);
    // At the retirement year itself, the two conversions (real portfolio's
    // OWN deflation, then re-inflating the rule value back at that same
    // year) cancel exactly, landing on the flat NOMINAL figure at that one
    // year — a robust, inflation-arithmetic-independent pin.
    expect(rows[0].fourPercentRuleValue).toBeCloseTo(
      (SAFE_WITHDRAWAL_RATE_BENGEN_PCT / 100) * 1_000_000,
      6,
    );
    // Every later year's value equals the SAME real figure re-expressed at
    // that year, relative to the retirement year's own deflation factor.
    const realAtRetirement =
      (SAFE_WITHDRAWAL_RATE_BENGEN_PCT / 100) * 1_000_000 * realDeflator(2031, 11);
    for (const row of rows) {
      const expected = realAtRetirement / realDeflator(row.year, 11);
      expect(row.fourPercentRuleValue).toBeCloseTo(expected, 2);
    }
  });

  it('rule-vs-draw delta keeps its sign across both dollar modes', () => {
    const anchor = { nowYear: 2026, nowMonthIndex: 5, inflationPct: 3 };
    const realDeflator = buildViewDeflator('today', anchor);
    const cashflow = new Map([
      [2031, cfRow(2031, { withdrawal: 5_000, taxes: 0, total: 5_000 })],
      // Draw well above the 4% rule figure (400_000*0.04 = 16_000).
      [2032, cfRow(2032, { withdrawal: 100_000, taxes: 0, total: 100_000 })],
    ]);
    const today = buildSwrComparisonData(
      baseParams({
        displayMode: 'today',
        cashflowFromYear: 2031,
        drawdownEndYear: 2032,
        yearlyCashflowByYear: cashflow,
        drawdownByMethod: { planned: methodResult(400_000), twr: null },
      }),
    );
    const future = buildSwrComparisonData(
      baseParams({
        displayMode: 'future',
        viewDeflator: () => 1,
        realDeflator,
        cashflowFromYear: 2031,
        drawdownEndYear: 2032,
        yearlyCashflowByYear: cashflow,
        drawdownByMethod: { planned: methodResult(400_000), twr: null },
      }),
    );
    const todayRow = today.bundle!.rows.find((r) => r.year === 2032)!;
    const futureRow = future.bundle!.rows.find((r) => r.year === 2032)!;
    expect(todayRow.afterTaxDraw - todayRow.fourPercentRuleValue!).toBeGreaterThan(0);
    expect(futureRow.afterTaxDraw - futureRow.fourPercentRuleValue!).toBeGreaterThan(0);
  });

  it("under Future-dollars, the bundle's fourPercentRule/fourPointFivePercentRule scalars agree with the anchor row's OWN fourPercentRuleValue and with anchorAfterTaxDraw — not left in the real (today's-dollars) figure `lib/safe-withdrawal-rate.ts` returns", () => {
    const anchor = { nowYear: 2026, nowMonthIndex: 5, inflationPct: 3 };
    const realDeflator = buildViewDeflator('today', anchor);
    const viewDeflator = (): number => 1;
    const result = buildSwrComparisonData(
      baseParams({
        displayMode: 'future',
        primaryRetirementIso: '2031-01-01',
        primaryRetirementYear: 2031,
        cashflowFromYear: 2031,
        drawdownEndYear: 2031,
        viewDeflator,
        realDeflator,
        yearlyCashflowByYear: new Map([[2031, cfRow(2031, { withdrawal: 40_000, taxes: 5_000, total: 60_000 })]]),
        drawdownByMethod: { planned: methodResult(1_000_000), twr: null },
      }),
    );
    const bundle = result.bundle!;
    const anchorRow = bundle.rows.find((r) => r.year === bundle.anchorYear)!;
    expect(bundle.fourPercentRule.impliedFirstYearAnnualSpend).toBeCloseTo(
      anchorRow.fourPercentRuleValue!,
      6,
    );
    expect(bundle.fourPointFivePercentRule.impliedFirstYearAnnualSpend).toBeCloseTo(
      anchorRow.fourPointFivePercentRuleValue!,
      6,
    );
    expect(bundle.fourPercentRule.plannedMinusRuleFirstYearDelta).toBeCloseTo(
      bundle.anchorAfterTaxDraw - bundle.fourPercentRule.impliedFirstYearAnnualSpend,
      6,
    );
    // At this one year the real->displayed round trip cancels exactly (the
    // same cancellation the earlier future-dollars test pins), so this also
    // confirms the bundle scalar isn't silently still the flat real figure.
    expect(bundle.fourPercentRule.impliedFirstYearAnnualSpend).toBeCloseTo(40_000, 2);
  });
});
