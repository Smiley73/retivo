// Annual Portfolio Flow withdrawal (`buildPortfolioFlowsByYear`) vs the budget Withdrawal (`reconcileYearlyCashflow`): flowCents = withdrawnCents − (rmdReinvestedCents + rmdOverflowToCashCents) and budgetCents = max(0, expenseBaseCents + taxNominalCents − earnedCents) differ by the within-year proration/timing residual.
// Asserted to the cent for a funded, non-depleted nominal year; a depleted year returns the engine `withdrawn` verbatim, so it is excluded.
import { describe, expect, it } from 'vitest';
import { buildPortfolioFlowsByYear } from './balance-projection-page-yearly-builders';
import { reconcileYearlyCashflow } from '../lib/yearly-cashflow-reconcile';
import type { DrawdownYear } from '../lib/drawdown-engine';
import type {
  ProjectionChartRow,
  ProjectionMethod,
} from '../components/ProjectionChart';
import type { PipelineData, DrawdownByMethodResult } from './balance-projection-page-data';
import type { CashflowSeriesPipelineResult } from './balance-projection-page-cashflow';

const IDENTITY_DEFLATOR = (): number => 1;
// Integer-cents tolerance ($1), the noise floor the cashflow series and year-by-year table apply.
const EPSILON_CENTS = 100;
const toCents = (dollars: number): number => Math.round(dollars * 100);

function chartRow(year: number): ProjectionChartRow {
  return {
    year,
    x: year,
    plannedSolid: 470_000,
    plannedDashed: null,
    twrSolid: null,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
  };
}

function drawdownYear(opts: {
  year: number;
  withdrawn: number;
  depleted?: boolean;
  rmdReinvestedCents?: number;
  rmdOverflowToCashCents?: number;
  qcdCents?: number;
  qcdInflationFactor?: number;
  growth?: number;
}): DrawdownYear {
  return {
    year: opts.year,
    balance: 100_000,
    withdrawn: opts.withdrawn,
    netNeed: opts.withdrawn,
    growth: opts.growth ?? 0,
    deposit: 0,
    depleted: opts.depleted ?? false,
    rmdReinvestedCents: opts.rmdReinvestedCents,
    rmdOverflowToCashCents: opts.rmdOverflowToCashCents,
    qcdCents: opts.qcdCents,
    qcdInflationFactor: opts.qcdInflationFactor,
  };
}

function pipelineData(): PipelineData {
  const out = {
    preTax: 0,
    postTax: 0,
    total: 0,
    yearlyTotals: [{ year: 2055, preTax: 0, postTax: 0, growth: 0, contributions: 0 }],
  };
  return { rows: [{ outputs: { planned: out } }] } as unknown as PipelineData;
}

function cashflowSeries(): CashflowSeriesPipelineResult {
  return {
    fromYear: 2055,
    chartEndYear: 2055,
    depositsByYear: new Map<number, number>(),
  } as unknown as CashflowSeriesPipelineResult;
}

// `displayMode` defaults to 'future' (identity deflation); the QCD round-trip test passes 'today' to exercise the stamped-factor reversal.
function flowRowFor(
  drawdown: DrawdownByMethodResult,
  displayMode: 'today' | 'future' = 'future',
): {
  contributions: number;
  gains: number;
  deposits: number;
  withdrawals: number;
  qcd: number;
  netChange: number;
} {
  const rows = buildPortfolioFlowsByYear({
    data: pipelineData(),
    cashflowSeries: cashflowSeries(),
    drawdownByMethod: { planned: drawdown, twr: null } as Record<
      ProjectionMethod,
      DrawdownByMethodResult | null
    >,
    activeMethod: 'planned',
    resolvedDrawdown: drawdown,
    displayRows: [chartRow(2055)],
    lastDeathFractional: null,
    viewDeflator: IDENTITY_DEFLATOR,
    basisDeflator: IDENTITY_DEFLATOR,
    displayMode,
  });
  expect(rows).not.toBeNull();
  return rows!.find((r) => r.year === 2055)!;
}

describe('Annual Portfolio Flow withdrawal vs budget Withdrawal — decomposition', () => {
  it('accounts for flow − budget withdrawal by named drivers (cents)', () => {
    // A funded RMD-over-draw year (nominal): the engine's annual draw exceeds the per-year budget net-need by a within-year proration/timing residual X, the only structural driver once the booked RMD surplus is netted out.
    const earned = 40_000; // SS + pension + part-time + one-off (per-year)
    const expenseBase = 156_631.07; // entered-real essential + discretionary
    const taxNominal = 12_000; // page Taxes band (fed + irmaaSurcharge − acaPtc)
    const rmdSurplus = 20_000; // forced over-draw, FULLY booked (reinvested)
    const budgetCents = Math.max(
      0,
      toCents(expenseBase) + toCents(taxNominal) - toCents(earned),
    );
    const prorationTimingCents = 2_831_69; // $2,831.69 (live 2055 nominal)

    const grossWithdrawn =
      (budgetCents + prorationTimingCents) / 100 + rmdSurplus;
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2055,
          withdrawn: grossWithdrawn,
          rmdReinvestedCents: toCents(rmdSurplus),
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };

    const flow = flowRowFor(drawdown);
    const flowCents = toCents(Math.abs(flow.withdrawals));

    const reconciled = reconcileYearlyCashflow({
      earned,
      expense: expenseBase + taxNominal,
      engineWithdrawn: grossWithdrawn,
      funded: true,
    });
    const reconciledBudgetCents = toCents(reconciled.withdrawal);
    expect(reconciledBudgetCents).toBe(budgetCents);

    // The decomposition ties out to the cent; the RMD surplus is already netted out of `flowCents`, so it does not appear (no double-count).
    const explainedDriverCents = prorationTimingCents;
    expect(
      Math.abs(flowCents - reconciledBudgetCents - explainedDriverCents),
    ).toBeLessThanOrEqual(EPSILON_CENTS);
  });

  it('excludes a depleted / unfunded year (returns engine withdrawn, not the budget plug)', () => {
    // Depleted year: the engine `withdrawn` is capped below net need and the reconcile returns it verbatim, not the budget plug, so this year is outside the equality; assert the reconcile keeps the engine-actual draw.
    const earned = 40_000;
    const expenseBase = 156_631.07;
    const taxNominal = 12_000;
    const cappedWithdrawn = 90_000; // below the (expense + tax − earned) need

    const reconciled = reconcileYearlyCashflow({
      earned,
      expense: expenseBase + taxNominal,
      engineWithdrawn: cappedWithdrawn,
      funded: false,
    });
    expect(reconciled.withdrawal).toBe(cappedWithdrawn);
    expect(reconciled.shortfall).toBeGreaterThan(0);
    const fundedPlug = Math.max(0, expenseBase + taxNominal - earned);
    expect(fundedPlug).toBeGreaterThan(cappedWithdrawn);
  });
});

describe('Annual Portfolio Flow — accumulation contribution growth reconciles (v35)', () => {
  // With contributions grown across accumulation steps, the pre-retirement Flow bar must still reconcile (contributions + gains, deflated, equals net change) in both view modes; only the deflator differs.
  const ACCUM_YEAR = 2040;
  const GROWN_CONTRIB = 13_310; // e.g. $10k base grown 3 years at 10%
  const PRE_RET_GAINS = 7_500;

  function accumPipelineData(): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: [
        {
          year: ACCUM_YEAR,
          preTax: 0,
          postTax: 0,
          growth: PRE_RET_GAINS,
          contributions: GROWN_CONTRIB,
        },
      ],
    };
    return { rows: [{ outputs: { planned: out } }] } as unknown as PipelineData;
  }

  function accumCashflowSeries(): CashflowSeriesPipelineResult {
    // Retirement starts after the accumulation year, so the year is purely accumulation-phase (sourced from yearlyTotals, no drawdown row).
    return {
      fromYear: 2050,
      chartEndYear: 2050,
      depositsByYear: new Map<number, number>(),
    } as unknown as CashflowSeriesPipelineResult;
  }

  function accumFlowRow(
    viewDeflator: (y: number, m?: number) => number,
    displayMode: 'today' | 'future' = 'future',
  ) {
    const rows = buildPortfolioFlowsByYear({
      data: accumPipelineData(),
      cashflowSeries: accumCashflowSeries(),
      drawdownByMethod: { planned: null, twr: null } as Record<
        ProjectionMethod,
        DrawdownByMethodResult | null
      >,
      activeMethod: 'planned',
      resolvedDrawdown: null,
      displayRows: [chartRow(ACCUM_YEAR)],
      lastDeathFractional: null,
      viewDeflator,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode,
    });
    return rows!.find((r) => r.year === ACCUM_YEAR)!;
  }

  it('Future-dollars (identity): contributions + gains === netChange, grown contribution intact', () => {
    const row = accumFlowRow(IDENTITY_DEFLATOR);
    expect(row.contributions).toBeCloseTo(GROWN_CONTRIB, 6);
    expect(row.gains).toBeCloseTo(PRE_RET_GAINS, 6);
    expect(row.netChange).toBeCloseTo(GROWN_CONTRIB + PRE_RET_GAINS, 6);
  });

  it("Today's-dollars: the same deflator scales the grown contribution + gains, still summing to netChange", () => {
    const inflationPct = 3;
    const asOfMonth = 2030 * 12 + 11;
    const deflator = (y: number, m = 11): number =>
      Math.pow(1 + inflationPct / 100, -(y * 12 + m - asOfMonth) / 12);
    const row = accumFlowRow(deflator, 'today');
    const f = deflator(ACCUM_YEAR, 11);
    expect(row.contributions).toBeCloseTo(GROWN_CONTRIB * f, 6);
    expect(row.gains).toBeCloseTo(PRE_RET_GAINS * f, 6);
    expect(row.netChange).toBeCloseTo(row.contributions + row.gains, 6);
  });
});

describe('Annual Portfolio Flow — QCD outflow reconciles into net change', () => {
  // The QCD pre-pass debits the source IRA directly and is not folded into the drawdown's `withdrawn`, so the gift must surface as its own below-zero `qcd` stripe and be subtracted from `netChange`, so net change ties to the actual portfolio balance delta.
  const GROWTH = 5_000;
  const NET_SPEND = 30_000; // gross draw with no RMD surplus → all spend
  const QCD = 8_000;

  function qcdDrawdown(
    qcdCents: number,
    qcdInflationFactor?: number,
  ): DrawdownByMethodResult {
    return {
      years: [
        drawdownYear({
          year: 2055,
          withdrawn: NET_SPEND,
          growth: GROWTH,
          qcdCents,
          qcdInflationFactor,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
  }

  it('QCD year: segments (incl. qcd) sum to netChange, and netChange drops by exactly the gift vs no-QCD', () => {
    const withQcd = flowRowFor(qcdDrawdown(toCents(QCD)));
    const noQcd = flowRowFor(qcdDrawdown(0));

    expect(withQcd.qcd).toBeLessThan(0);
    expect(Math.abs(withQcd.qcd)).toBeCloseTo(QCD, 6);

    expect(
      withQcd.contributions +
        withQcd.gains +
        withQcd.deposits +
        withQcd.withdrawals +
        withQcd.qcd,
    ).toBeCloseTo(withQcd.netChange, 6);

    // netChange drops by exactly the (identity-deflated) gift relative to the no-QCD baseline; before, the gift the engine already removed from the IRA was omitted and QCD years overstated net change. All other segments are identical.
    expect(withQcd.contributions).toBe(noQcd.contributions);
    expect(withQcd.gains).toBe(noQcd.gains);
    expect(withQcd.deposits).toBe(noQcd.deposits);
    expect(withQcd.withdrawals).toBe(noQcd.withdrawals);
    expect(noQcd.qcd).toBe(0);
    expect(noQcd.netChange - withQcd.netChange).toBeCloseTo(QCD, 6);
  });

  it('non-QCD year is byte-identical to a row with no qcd field (regression)', () => {
    // A drawdown with no `qcdCents` produces qcd === 0 and the same netChange as the pre-fix formula, so the QCD subtraction is inert.
    const row = flowRowFor(qcdDrawdown(0));
    expect(row.qcd).toBe(0);
    expect(row.netChange).toBeCloseTo(GROWTH - NET_SPEND, 6);
  });

  it("Today's-dollars: the stripe reverses the engine's exact stamped inflation factor so a REAL gift round-trips", () => {
    // The engine inflated an $8,000 real gift to nominal `qcdCents` with a stamped factor of 1.5 (exaggerated so the round trip is unmistakable); in Today's dollars the stripe divides that exact factor back out, not `nominal × display deflator`.
    const factor = 1.5;
    const nominalCents = toCents(QCD * factor); // engine `qcdCents`
    const row = flowRowFor(qcdDrawdown(nominalCents, factor), 'today');

    expect(Math.abs(row.qcd)).toBeCloseTo(QCD, 6);
    expect(Math.abs(row.qcd) * factor).toBeCloseTo(nominalCents / 100, 6);
    expect(
      row.contributions + row.gains + row.deposits + row.withdrawals + row.qcd,
    ).toBeCloseTo(row.netChange, 6);
  });

  it('Future-dollars: the stripe shows the nominal gift (no reversal), and netChange still reconciles', () => {
    // Future dollars: the stripe is the nominal `qcdCents` (above the real amount), and the segments still sum to netChange.
    const factor = 1.5;
    const nominalCents = toCents(QCD * factor);
    const row = flowRowFor(qcdDrawdown(nominalCents, factor), 'future');
    expect(Math.abs(row.qcd)).toBeCloseTo(QCD * factor, 6);
    expect(Math.abs(row.qcd)).toBeGreaterThan(QCD);
    expect(
      row.contributions + row.gains + row.deposits + row.withdrawals + row.qcd,
    ).toBeCloseTo(row.netChange, 6);
  });
});
