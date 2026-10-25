// Pure year-by-year builders: `buildUnifiedYearTableRows` and `buildPortfolioFlowsByYear` carry the cashflow-year gating (only years in `[retirementYear, chartEndYear]` are cashflow years, others carry null cashflow fields) and the gains crossover (pre-retirement years read accumulation `yearlyTotals.growth`, the retirement year onward the runner drawdown `growth` and withdrawals).
import { describe, expect, it } from 'vitest';
import {
  buildIncomeView,
  buildUnifiedYearTableRows,
  buildPortfolioFlowsByYear,
  type IncomeView,
} from './balance-projection-page-yearly-builders';
import type { CashflowMonthlyPoint } from '../components/CashflowProjectionChart';
import type {
  ProjectionChartRow,
  ProjectionMethod,
} from '../components/ProjectionChart';
import type { DrawdownYear } from '../lib/drawdown-engine';
import type {
  ExpenseCategoryYearPoint,
  ExpenseProjectionPoint,
} from '../lib/expense-projection';
import type { PipelineData, DrawdownByMethodResult } from './balance-projection-page-data';
import type { CashflowSeriesPipelineResult } from './balance-projection-page-cashflow';

const IDENTITY_DEFLATOR = (): number => 1;

function chartRow(opts: {
  year: number;
  planned: number | null;
  plannedGrowth: number | null;
}): ProjectionChartRow {
  return {
    year: opts.year,
    x: opts.year,
    plannedSolid: opts.planned,
    plannedDashed: null,
    twrSolid: null,
    twrDashed: null,
    plannedGrowth: opts.plannedGrowth,
    twrGrowth: null,
  };
}

function cashflowPoint(opts: {
  year: number;
  total: number;
  withdrawal: number;
  totalIncome: number;
}): CashflowMonthlyPoint {
  return {
    fractionalYear: opts.year,
    year: opts.year,
    month0: 11,
    essential: opts.total,
    discretionary: 0,
    taxes: 0,
    total: opts.total,
    earned: 0,
    withdrawal: opts.withdrawal,
    totalIncome: opts.totalIncome,
    shortfallBase: opts.totalIncome,
    shortfallHeight: 0,
  };
}

function drawdownYear(opts: {
  year: number;
  growth: number;
  withdrawn: number;
  federalTaxCents?: number;
  irmaaSurchargeCents?: number;
  acaPtcSubsidyCents?: number;
  acaCreditAppliedToPremiumsCents?: number;
  rmdReinvestedCents?: number;
  rmdOverflowToCashCents?: number;
  rothConvertedCents?: number;
}): DrawdownYear {
  return {
    year: opts.year,
    balance: 100_000,
    withdrawn: opts.withdrawn,
    netNeed: opts.withdrawn,
    growth: opts.growth,
    deposit: 0,
    depleted: false,
    federalTaxCents: opts.federalTaxCents,
    irmaaSurchargeCents: opts.irmaaSurchargeCents,
    acaPtcSubsidyCents: opts.acaPtcSubsidyCents,
    acaCreditAppliedToPremiumsCents: opts.acaCreditAppliedToPremiumsCents,
    rmdReinvestedCents: opts.rmdReinvestedCents,
    rmdOverflowToCashCents: opts.rmdOverflowToCashCents,
    rothConvertedCents: opts.rothConvertedCents,
  };
}

function cashflowSeries(opts: {
  fromYear: number;
  chartEndYear: number;
  depositsByYear?: Map<number, number>;
}): CashflowSeriesPipelineResult {
  return {
    fromYear: opts.fromYear,
    chartEndYear: opts.chartEndYear,
    depositsByYear: opts.depositsByYear ?? new Map(),
  } as unknown as CashflowSeriesPipelineResult;
}

describe('buildUnifiedYearTableRows — cashflow-year gating', () => {
  it('flags only years inside [retirementYear, chartEndYear] as cashflow years', () => {
    const displayRows = [
      chartRow({ year: 2030, planned: 500_000, plannedGrowth: 25_000 }),
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
      chartRow({ year: 2032, planned: 460_000, plannedGrowth: null }),
      chartRow({ year: 2033, planned: 0, plannedGrowth: null }),
    ];
    const incomeView: IncomeView = {
      method: 'planned',
      fromYear: 2031,
      chartEndYear: 2032,
      drawdownEndYear: 2032,
      yearlyCashflowByYear: new Map<number, CashflowMonthlyPoint>([
        [2031, cashflowPoint({ year: 2031, total: 40_000, withdrawal: 30_000, totalIncome: 35_000 })],
        [2032, cashflowPoint({ year: 2032, total: 41_000, withdrawal: 31_000, totalIncome: 36_000 })],
      ]),
      growthByYear: new Map([
        [2031, 12_000],
        [2032, 11_000],
      ]),
      bucketGainByYear: new Map(),
      cashflowChartRows: [],
      breakdownChartRows: [],
      depletionYear: null,
    };

    const rows = buildUnifiedYearTableRows({
      displayRows,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2032 }),
      incomeView,
      drawdownByMethod: null,
      activeMethod: 'planned',
      activeMcBasis: null,
      resolvedDrawdown: null,
      lastDeathFractional: null,
      basisDeflator: IDENTITY_DEFLATOR,
    });

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2030)?.isCashflowYear).toBe(false);
    expect(byYear.get(2030)?.withdrawal).toBeNull();
    expect(byYear.get(2030)?.expenses).toBeNull();
    expect(byYear.get(2033)?.isCashflowYear).toBe(false);

    expect(byYear.get(2031)?.isCashflowYear).toBe(true);
    expect(byYear.get(2031)?.withdrawal).toBe(30_000);
    expect(byYear.get(2031)?.expenses).toBe(40_000);
    expect(byYear.get(2032)?.isCashflowYear).toBe(true);
    expect(byYear.get(2032)?.withdrawal).toBe(31_000);
  });

  it('sources gains from accumulation pre-retirement and from drawdown growth in-window', () => {
    const displayRows = [
      chartRow({ year: 2030, planned: 500_000, plannedGrowth: 25_000 }),
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
    ];
    const incomeView: IncomeView = {
      method: 'planned',
      fromYear: 2031,
      chartEndYear: 2031,
      drawdownEndYear: 2031,
      yearlyCashflowByYear: new Map([
        [2031, cashflowPoint({ year: 2031, total: 40_000, withdrawal: 30_000, totalIncome: 35_000 })],
      ]),
      growthByYear: new Map([[2031, 12_000]]),
      bucketGainByYear: new Map(),
      cashflowChartRows: [],
      breakdownChartRows: [],
      depletionYear: null,
    };

    const rows = buildUnifiedYearTableRows({
      displayRows,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2031 }),
      incomeView,
      drawdownByMethod: null,
      activeMethod: 'planned',
      activeMcBasis: null,
      resolvedDrawdown: null,
      lastDeathFractional: null,
      basisDeflator: IDENTITY_DEFLATOR,
    });

    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2030)?.gains).toBe(25_000);
    expect(byYear.get(2031)?.gains).toBe(12_000);
  });

  it('reads the Balance column + pre-ret Gains from the mc channel when a Monte Carlo basis is active', () => {
    // Two pre-retirement rows carry both a deterministic balance and a distinct `mc` channel; with an MC basis active the table must read the mc channel so it reconciles with the representative line, not `plannedSolid`.
    const displayRows: ProjectionChartRow[] = [
      {
        year: 2030,
        x: 2030,
        plannedSolid: 500_000,
        plannedDashed: null,
        twrSolid: null,
        twrDashed: null,
        plannedGrowth: 25_000,
        twrGrowth: null,
        mcSolid: 640_000,
        mcDashed: null,
        mcGrowth: 31_000,
      },
    ];
    const representativeRun: DrawdownByMethodResult = {
      years: [drawdownYear({ year: 2030, growth: 0, withdrawn: 0 })],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const rows = buildUnifiedYearTableRows({
      displayRows,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2031 }),
      incomeView: null,
      drawdownByMethod: null,
      activeMethod: 'planned',
      activeMcBasis: 'mc-pessimistic',
      resolvedDrawdown: representativeRun,
      lastDeathFractional: null,
      basisDeflator: IDENTITY_DEFLATOR,
    });
    const row2030 = rows.find((r) => r.year === 2030);
    // The builder routes the mc balance into both deterministic slots while a basis is active.
    expect(row2030?.balanceByMethod.planned).toBe(640_000);
    expect(row2030?.gains).toBe(31_000);
  });

  it('wires per-year Roth converted (cents → deflated dollars) from the resolved drawdown', () => {
    const displayRows = [
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
      chartRow({ year: 2032, planned: 460_000, plannedGrowth: null }),
    ];
    const resolvedDrawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({ year: 2031, growth: 0, withdrawn: 0, rothConvertedCents: 1_500_000 }),
        drawdownYear({ year: 2032, growth: 0, withdrawn: 0 }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const rows = buildUnifiedYearTableRows({
      displayRows,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2032 }),
      incomeView: null,
      drawdownByMethod: null,
      activeMethod: 'planned',
      activeMcBasis: null,
      resolvedDrawdown,
      lastDeathFractional: null,
      // Deflate 2031 to 90% of nominal so the column is proven deflated. A deterministic basis routes the Roth column through `basisDeflator`.
      basisDeflator: (year) => (year === 2031 ? 0.9 : 1),
    });
    const byYear = new Map(rows.map((r) => [r.year, r]));
    expect(byYear.get(2031)?.rothConverted).toBe(13_500);
    expect(byYear.get(2032)?.rothConverted).toBe(0);
  });
});

describe('buildPortfolioFlowsByYear — pre/post-retirement gains crossover', () => {
  function pipelineData(opts: {
    activeMethod: ProjectionMethod;
    yearlyTotals: ReadonlyArray<{ year: number; growth: number; contributions: number }>;
  }): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: opts.yearlyTotals.map((t) => ({
        year: t.year,
        preTax: 0,
        postTax: 0,
        growth: t.growth,
        contributions: t.contributions,
      })),
    };
    return {
      rows: [{ outputs: { [opts.activeMethod]: out } }],
    } as unknown as PipelineData;
  }

  it('reads accumulation growth before retirement and drawdown growth after', () => {
    const data = pipelineData({
      activeMethod: 'planned',
      yearlyTotals: [
        { year: 2030, growth: 25_000, contributions: 10_000 },
        { year: 2031, growth: 99_999, contributions: 0 },
        { year: 2032, growth: 99_999, contributions: 0 },
      ],
    });
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({ year: 2031, growth: 12_000, withdrawn: 30_000 }),
        drawdownYear({ year: 2032, growth: 11_000, withdrawn: 31_000 }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const drawdownByMethod: Record<ProjectionMethod, DrawdownByMethodResult | null> = {
      planned: drawdown,
      twr: null,
    };
    const displayRows = [
      chartRow({ year: 2030, planned: 500_000, plannedGrowth: 25_000 }),
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
      chartRow({ year: 2032, planned: 460_000, plannedGrowth: null }),
    ];

    const rows = buildPortfolioFlowsByYear({
      data,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2032 }),
      drawdownByMethod,
      activeMethod: 'planned',
      resolvedDrawdown: drawdownByMethod.planned,
      displayRows,
      lastDeathFractional: null,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });

    expect(rows).not.toBeNull();
    const byYear = new Map(rows!.map((r) => [r.year, r]));
    expect(byYear.get(2030)?.contributions).toBe(10_000);
    expect(byYear.get(2030)?.gains).toBe(25_000);
    expect(byYear.get(2030)?.withdrawals).toBeCloseTo(0, 10);
    expect(byYear.get(2031)?.gains).toBe(12_000);
    expect(byYear.get(2031)?.withdrawals).toBe(-30_000);
    expect(byYear.get(2032)?.gains).toBe(11_000);
    expect(byYear.get(2032)?.withdrawals).toBe(-31_000);
  });
});

describe('buildPortfolioFlowsByYear — net spending withdrawal excludes RMD surplus', () => {
  function pipelineData(): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: [{ year: 2031, preTax: 0, postTax: 0, growth: 0, contributions: 0 }],
    };
    return { rows: [{ outputs: { planned: out } }] } as unknown as PipelineData;
  }

  // Build the single in-window flow row for a one-year drawdown with the given surplus disposition. The gross withdrawal is the full forced RMD; the surplus round-trips back into the portfolio (reinvested or held as cash), so the bar shows only the net spend.
  function flowRow(surplus: { reinvestedCents?: number; overflowCents?: number }) {
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 50_000, // full forced RMD (gross)
          rmdReinvestedCents: surplus.reinvestedCents,
          rmdOverflowToCashCents: surplus.overflowCents,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const rows = buildPortfolioFlowsByYear({
      data: pipelineData(),
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2031 }),
      drawdownByMethod: { planned: drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: drawdown,
      displayRows: [chartRow({ year: 2031, planned: 470_000, plannedGrowth: null })],
      lastDeathFractional: null,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });
    expect(rows).not.toBeNull();
    return rows!.find((r) => r.year === 2031)!;
  }

  it('reinvest-disposition household: bar shows net spend, surplus excluded', () => {
    const r = flowRow({ reinvestedCents: 20_000 * 100 });
    // The withdrawal bar is the spending portion only (matches the income breakdown); the 20k forced-RMD excess never appears.
    expect(r.withdrawals).toBe(-30_000);
    expect(r.netChange).toBe(-30_000);
    expect(r.netChange).toBe(
      r.contributions + r.gains + r.deposits + r.withdrawals,
    );
  });

  it('held-as-cash household: bar shows net spend, surplus excluded', () => {
    const r = flowRow({ overflowCents: 20_000 * 100 });
    expect(r.withdrawals).toBe(-30_000);
    expect(r.netChange).toBe(-30_000);
    expect(r.netChange).toBe(
      r.contributions + r.gains + r.deposits + r.withdrawals,
    );
  });

  it('no-surplus year: full gross is the spend and netChange reconciles', () => {
    const r = flowRow({});
    expect(r.withdrawals).toBe(-50_000);
    expect(r.netChange).toBe(-50_000);
  });

  it('a Roth conversion is NOT a Portfolio Flow inflow and does not move netChange', () => {
    // Internal transfer (pre-tax → Roth): it must not appear as an inflow or shift netChange.
    const withConv: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 50_000,
          rothConvertedCents: 25_000 * 100,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const rows = buildPortfolioFlowsByYear({
      data: pipelineData(),
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2031 }),
      drawdownByMethod: { planned: withConv, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: withConv,
      displayRows: [chartRow({ year: 2031, planned: 470_000, plannedGrowth: null })],
      lastDeathFractional: null,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });
    const r = rows!.find((row) => row.year === 2031)!;
    expect((r as unknown as Record<string, unknown>).rothConverted).toBeUndefined();
    expect(r.withdrawals).toBe(-50_000);
    expect(r.netChange).toBe(-50_000);
  });
});

describe('buildPortfolioFlowsByYear — full death-year terminal bar (no proration)', () => {
  function pipelineData(opts: {
    activeMethod: ProjectionMethod;
    yearlyTotals: ReadonlyArray<{ year: number; growth: number; contributions: number }>;
  }): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: opts.yearlyTotals.map((t) => ({
        year: t.year,
        preTax: 0,
        postTax: 0,
        growth: t.growth,
        contributions: t.contributions,
      })),
    };
    return {
      rows: [{ outputs: { [opts.activeMethod]: out } }],
    } as unknown as PipelineData;
  }

  function setup(lastDeathFractional: number | null) {
    const data = pipelineData({
      activeMethod: 'planned',
      yearlyTotals: [
        { year: 2030, growth: 25_000, contributions: 10_000 },
        { year: 2031, growth: 99_999, contributions: 0 },
        { year: 2032, growth: 99_999, contributions: 0 },
      ],
    });
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({ year: 2031, growth: 12_000, withdrawn: 30_000 }),
        drawdownYear({ year: 2032, growth: 11_000, withdrawn: 31_000 }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const displayRows = [
      chartRow({ year: 2030, planned: 500_000, plannedGrowth: 25_000 }),
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
      chartRow({ year: 2032, planned: 460_000, plannedGrowth: null }),
    ];
    return buildPortfolioFlowsByYear({
      data,
      cashflowSeries: cashflowSeries({
        fromYear: 2031,
        chartEndYear: 2032,
        depositsByYear: new Map([[2032, 4_000]]),
      }),
      drawdownByMethod: { planned: drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: drawdown,
      displayRows,
      lastDeathFractional,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });
  }

  it('the death-year bar carries full annual flows (no proration) at its integer year', () => {
    // Death is Dec 31 of `deathYear`; `lastDeathFractional` is the integer death year, so the death-year bar is a full bar: no scaling and no fractional terminal x.
    const rows = setup(2032)!;
    expect(rows.map((r) => r.year)).toEqual([2030, 2031, 2032]);
    const death = rows.find((r) => r.year === 2032)!;
    expect(death.fractionalYear).toBeUndefined();
    expect(death.gains).toBe(11_000);
    expect(death.withdrawals).toBe(-31_000);
    expect(death.deposits).toBe(4_000);
    expect(death.netChange).toBeCloseTo(
      death.contributions + death.gains + death.deposits + death.withdrawals,
      6,
    );
    const y2031 = rows.find((r) => r.year === 2031)!;
    expect(y2031.fractionalYear).toBeUndefined();
    expect(y2031.gains).toBe(12_000);
  });

  it('drops rows past the death year (clip at the integer death year)', () => {
    const rows = setup(2031)!;
    expect(rows.map((r) => r.year)).toEqual([2030, 2031]);
    const death = rows.find((r) => r.year === 2031)!;
    expect(death.fractionalYear).toBeUndefined();
    expect(death.gains).toBe(12_000);
  });

  it('null lastDeathFractional → unchanged whole-year rows', () => {
    const rows = setup(null)!;
    const death = rows.find((r) => r.year === 2032)!;
    expect(death.fractionalYear).toBeUndefined();
    expect(death.gains).toBe(11_000);
  });
});

describe('buildPortfolioFlowsByYear — MC full-horizon alignment', () => {
  // With an MC basis active, `use-balance-projection-view-model.ts` slices `RepresentativeRun.years` so `resolvedDrawdown.years[0]` corresponds to `fromYear`. Without the slice, `buildPortfolioFlowsByYear` indexes with `y - retirementYear` and hits the wrong (pre-retirement) row when `run.firstYear < retirementYear`.
  function pipelineData(opts: {
    activeMethod: ProjectionMethod;
    yearlyTotals: ReadonlyArray<{ year: number; growth: number; contributions: number }>;
  }): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: opts.yearlyTotals.map((t) => ({
        year: t.year,
        preTax: 0,
        postTax: 0,
        growth: t.growth,
        contributions: t.contributions,
      })),
    };
    return {
      rows: [{ outputs: { [opts.activeMethod]: out } }],
    } as unknown as PipelineData;
  }

  it('reads correct drawdown row when years[0] aligns with retirementYear', () => {
    // Retirement is 2031 and the simulation started in 2026, but the adapted drawdown (sliced to start from 2031) is passed, as the view model produces.
    const data = pipelineData({
      activeMethod: 'planned',
      yearlyTotals: [
        { year: 2028, growth: 10_000, contributions: 5_000 },
        { year: 2029, growth: 10_000, contributions: 5_000 },
        { year: 2030, growth: 10_000, contributions: 5_000 },
        { year: 2031, growth: 99_999, contributions: 0 }, // overridden by drawdown
        { year: 2032, growth: 99_999, contributions: 0 }, // overridden by drawdown
      ],
    });
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({ year: 2031, growth: 12_000, withdrawn: 30_000 }),
        drawdownYear({ year: 2032, growth: 11_000, withdrawn: 28_000 }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array([2500]),
    };
    const displayRows = [
      chartRow({ year: 2028, planned: 200_000, plannedGrowth: 10_000 }),
      chartRow({ year: 2029, planned: 215_000, plannedGrowth: 10_000 }),
      chartRow({ year: 2030, planned: 230_000, plannedGrowth: 10_000 }),
      chartRow({ year: 2031, planned: 480_000, plannedGrowth: null }),
      chartRow({ year: 2032, planned: 460_000, plannedGrowth: null }),
    ];
    const rows = buildPortfolioFlowsByYear({
      data,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2032 }),
      drawdownByMethod: { planned: drawdown, twr: null },
      resolvedDrawdown: drawdown,
      activeMethod: 'planned',
      displayRows,
      lastDeathFractional: 2032,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });
    expect(rows).not.toBeNull();
    const byYear = new Map(rows!.map((r) => [r.year, r]));
    expect(byYear.get(2028)?.gains).toBe(10_000);
    expect(byYear.get(2031)?.gains).toBe(12_000);
    expect(byYear.get(2031)?.withdrawals).toBe(-30_000);
    expect(byYear.get(2032)?.gains).toBe(11_000);
    expect(byYear.get(2032)?.withdrawals).toBe(-28_000);
  });

  it('would read wrong row if full-horizon unadapted drawdown were passed (regression characterization)', () => {
    // Characterizes the pre-fix behaviour: the unadapted RepresentativeRun (firstYear=2026) passed without slicing makes years[0] the 2026 row, which the builder reads for retirementYear=2031.
    const data = pipelineData({
      activeMethod: 'planned',
      yearlyTotals: [{ year: 2031, growth: 99_999, contributions: 0 }],
    });
    const unadaptedDrawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({ year: 2026, growth: 5_000, withdrawn: 0 }), // pre-retirement
        drawdownYear({ year: 2027, growth: 5_100, withdrawn: 0 }),
        drawdownYear({ year: 2028, growth: 5_200, withdrawn: 0 }),
        drawdownYear({ year: 2029, growth: 5_300, withdrawn: 0 }),
        drawdownYear({ year: 2030, growth: 5_400, withdrawn: 0 }),
        drawdownYear({ year: 2031, growth: 12_000, withdrawn: 30_000 }), // idx=5
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array([2500]),
    };
    const displayRows = [chartRow({ year: 2031, planned: 480_000, plannedGrowth: null })];
    const rows = buildPortfolioFlowsByYear({
      data,
      cashflowSeries: cashflowSeries({ fromYear: 2031, chartEndYear: 2031 }),
      drawdownByMethod: { planned: unadaptedDrawdown, twr: null },
      resolvedDrawdown: unadaptedDrawdown,
      activeMethod: 'planned',
      displayRows,
      lastDeathFractional: 2031,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      displayMode: 'future',
    });
    const byYear = new Map(rows!.map((r) => [r.year, r]));
    // BUG: reads years[0] (2026 row, growth=5_000) instead of years[5] (2031 row, growth=12_000); slicing at fromYear removes the misread.
    expect(byYear.get(2031)?.gains).toBe(5_000); // Wrong! This is the 2026 pre-retirement row.
    expect(byYear.get(2031)?.gains).not.toBe(12_000); // The correct 2031 value is NOT read.
  });
});

describe('buildPortfolioFlowsByYear — display deflator (Today\'s vs Future dollars)', () => {
  function pipelineData(): PipelineData {
    const out = {
      preTax: 0,
      postTax: 0,
      total: 0,
      yearlyTotals: [{ year: 2031, preTax: 0, postTax: 0, growth: 0, contributions: 0 }],
    };
    return { rows: [{ outputs: { planned: out } }] } as unknown as PipelineData;
  }

  // One in-window flow row with gains, a deposit and a gross withdrawal whose forced-RMD surplus round-trips back in, built under the supplied view deflator.
  function flowRow(
    viewDeflator: (year: number, monthIndex?: number) => number,
    displayMode: 'today' | 'future' = 'future',
  ) {
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 40_000,
          withdrawn: 50_000,
          rmdReinvestedCents: 20_000 * 100,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const rows = buildPortfolioFlowsByYear({
      data: pipelineData(),
      cashflowSeries: cashflowSeries({
        fromYear: 2031,
        chartEndYear: 2031,
        depositsByYear: new Map([[2031, 8_000]]),
      }),
      drawdownByMethod: { planned: drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: drawdown,
      displayRows: [chartRow({ year: 2031, planned: 470_000, plannedGrowth: null })],
      lastDeathFractional: null,
      viewDeflator,
      // Deterministic basis: `basisDeflator` collapses to `viewDeflator`, so drawdown gains and net spend deflate by the same flat factor.
      basisDeflator: (year) => viewDeflator(year, 11),
      displayMode,
    });
    expect(rows).not.toBeNull();
    return rows!.find((r) => r.year === 2031)!;
  }

  it('Future dollars (identity deflator) leaves every series nominal', () => {
    const r = flowRow(() => 1);
    expect(r.gains).toBe(40_000);
    expect(r.deposits).toBe(8_000);
    expect(r.withdrawals).toBe(-30_000);
    expect(r.netChange).toBe(40_000 + 8_000 - 30_000);
  });

  it("Today's dollars deflates every series by viewDeflator(y, 11)", () => {
    // 2031 deflated to 50%: every flow halves with signs preserved, so the withdrawal bar reads in today's dollars and ties out with the year-by-year table's deflated Withdrawal column.
    const r = flowRow((year) => (year === 2031 ? 0.5 : 1), 'today');
    expect(r.gains).toBe(20_000);
    expect(r.deposits).toBe(4_000);
    expect(r.withdrawals).toBe(-15_000);
    expect(r.netChange).toBe((40_000 + 8_000 - 30_000) * 0.5);
    expect(r.netChange).toBe(
      r.contributions + r.gains + r.deposits + r.withdrawals,
    );
  });
});

describe('buildIncomeView — Taxes band cash (funded for every basis)', () => {
  // An essential-only expense row gives the cashflow row a nonzero `total` so it survives the trailing-zero trim; 'future' mode reads nominal fields times a deflator of 1.
  function expenseRow(year: number, essential: number): ExpenseProjectionPoint {
    return {
      year,
      essential,
      discretionary: 0,
      total: essential,
      essentialBase: essential,
      discretionaryBase: 0,
      totalBase: essential,
    };
  }

  // Minimal cashflow series with exactly the fields `buildIncomeView` destructures: the year window, empty income split and deposits, per-year expense rows, and a null `monthlySeries` (Yearly path only).
  function incomeViewCashflowSeries(opts: {
    fromYear: number;
    drawdownEndYear: number;
    expenseRows: ExpenseProjectionPoint[];
    socialSecurity?: number;
  }): CashflowSeriesPipelineResult {
    const sourceSplitByYear = new Map<number, { ss: number; pensionAnnuity: number; partTime: number; oneOff: number }>();
    for (let y = opts.fromYear; y <= opts.drawdownEndYear; y += 1) {
      sourceSplitByYear.set(y, { ss: opts.socialSecurity ?? 0, pensionAnnuity: 0, partTime: 0, oneOff: 0 });
    }
    return {
      fromYear: opts.fromYear,
      chartEndYear: opts.drawdownEndYear,
      drawdownEndYear: opts.drawdownEndYear,
      depositsByYear: new Map(),
      sourceSplitByYear,
      extendedExpenseRows: opts.expenseRows,
      monthlySeries: null,
    } as unknown as CashflowSeriesPipelineResult;
  }

  function run(opts: {
    drawdown: DrawdownByMethodResult;
    expenseRows: ExpenseProjectionPoint[];
    fromYear: number;
    drawdownEndYear: number;
    socialSecurity?: number;
  }): IncomeView | null {
    return buildIncomeView({
      cashflowSeries: incomeViewCashflowSeries({
        fromYear: opts.fromYear,
        drawdownEndYear: opts.drawdownEndYear,
        expenseRows: opts.expenseRows,
        socialSecurity: opts.socialSecurity,
      }),
      drawdownByMethod: { planned: opts.drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: opts.drawdown,
      displayMode: 'future',
      cashflowGranularity: 'yearly',
      incomeBreakdownGranularity: 'yearly',
      lastDeathFractional: null,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      categoryMeta: [],
    });
  }

  it('(a) funds the Taxes band for a named-strategy MC run (suppression guard removed)', () => {
    // Named-strategy MC funds tax per path, so the band lights up from the resolved representative row's tax cents.
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 40_000,
          federalTaxCents: 5_000_00,
          irmaaSurchargeCents: 1_000_00,
          acaPtcSubsidyCents: 0,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const view = run({
      drawdown,
      expenseRows: [expenseRow(2031, 40_000)],
      fromYear: 2031,
      drawdownEndYear: 2031,
    });
    expect(view).not.toBeNull();
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.taxes).toBe(6_000);
  });

  it('(b) funds the Taxes band from any tax-funded MC representative row', () => {
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 40_000,
          federalTaxCents: 5_000_00,
          irmaaSurchargeCents: 1_000_00,
          acaPtcSubsidyCents: 0,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const view = run({
      drawdown,
      expenseRows: [expenseRow(2031, 40_000)],
      fromYear: 2031,
      drawdownEndYear: 2031,
    });
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.taxes).toBe(6_000);
  });

  it('(c) funds the Taxes band on a deterministic basis', () => {
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 40_000,
          federalTaxCents: 4_000_00,
          irmaaSurchargeCents: 500_00,
          acaPtcSubsidyCents: 0,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const view = run({
      drawdown,
      expenseRows: [expenseRow(2031, 40_000)],
      fromYear: 2031,
      drawdownEndYear: 2031,
    });
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.taxes).toBe(4_500);
  });

  it('(d) clamps the Taxes band to 0 when the ACA subsidy exceeds tax + IRMAA', () => {
    // acaPtcSubsidy > federalTax + irmaa makes the raw value negative; the builder's Math.max(0, …) clamps the band to 0.
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 40_000,
          federalTaxCents: 1_000_00,
          irmaaSurchargeCents: 0,
          acaPtcSubsidyCents: 3_000_00,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const view = run({
      drawdown,
      expenseRows: [expenseRow(2031, 40_000)],
      fromYear: 2031,
      drawdownEndYear: 2031,
    });
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.taxes).toBe(0);
  });

  it('(e) a year that applies credit to premiums shows the lowered draw and still ties out', () => {
    // $71,200 of spending, $31,300 of Social Security, no federal tax and a $5,134.20 credit that all goes to premiums: the engine draws 34,765.80 (39,900 less the line). The band shows that draw, with the line netted in the Taxes band, so income meets expenses and no shortfall appears.
    const drawdown: DrawdownByMethodResult = {
      years: [
        drawdownYear({
          year: 2031,
          growth: 0,
          withdrawn: 34_765.8,
          federalTaxCents: 0,
          irmaaSurchargeCents: 0,
          acaPtcSubsidyCents: 5_134_20,
          acaCreditAppliedToPremiumsCents: 5_134_20,
        }),
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const view = run({
      drawdown,
      expenseRows: [expenseRow(2031, 71_200)],
      fromYear: 2031,
      drawdownEndYear: 2031,
      socialSecurity: 31_300,
    });
    const row = view!.cashflowChartRows.find((r) => r.year === 2031)!;
    expect(row.withdrawal).toBeCloseTo(34_765.8, 2);
    expect(row.taxes).toBeCloseTo(-5_134.2, 2);
    expect(row.totalIncome).toBeCloseTo(row.total, 2);
    expect(row.shortfallHeight).toBe(0);
  });
});

describe('buildIncomeView — category band-basis branch (today→*Base vs future→*Nominal)', () => {
  // Two categories whose share ratios differ between the *Base and *Nominal maps make the `displayMode === 'today' ? *Base : *Nominal` selection in `buildIncomeView` observable; swapping the branches would change which ratio surfaces.
  const CAT_A = 'cat-a';
  const CAT_B = 'cat-b';
  const ESSENTIAL = 30_000;

  // `essentialBase === essential`, so the displayed band total is the same 30k in both modes; only the per-category ratios differ, isolating the band-basis branch.
  function expenseRow(year: number): ExpenseProjectionPoint {
    return {
      year,
      essential: ESSENTIAL,
      discretionary: 0,
      total: ESSENTIAL,
      essentialBase: ESSENTIAL,
      discretionaryBase: 0,
      totalBase: ESSENTIAL,
    };
  }

  function catYear(
    year: number,
    a: number,
    b: number,
  ): ExpenseCategoryYearPoint {
    return {
      year,
      byCategoryId: { [CAT_A]: a, [CAT_B]: b },
      total: a + b,
    };
  }

  // Category maps with distinct ratios: *Base A:B = 3:1, *Nominal A:B = 1:3. Only the yearly maps are read (monthlySeries is null, so the Yearly path).
  function categoryCashflowSeries(opts: {
    fromYear: number;
    drawdownEndYear: number;
  }): CashflowSeriesPipelineResult {
    const sourceSplitByYear = new Map<
      number,
      { ss: number; pensionAnnuity: number; partTime: number; oneOff: number }
    >();
    const expenseRows: ExpenseProjectionPoint[] = [];
    const categoryYearlyBase: ExpenseCategoryYearPoint[] = [];
    const categoryYearlyNominal: ExpenseCategoryYearPoint[] = [];
    for (let y = opts.fromYear; y <= opts.drawdownEndYear; y += 1) {
      sourceSplitByYear.set(y, { ss: 0, pensionAnnuity: 0, partTime: 0, oneOff: 0 });
      expenseRows.push(expenseRow(y));
      categoryYearlyBase.push(catYear(y, 30_000, 10_000)); // 3:1
      categoryYearlyNominal.push(catYear(y, 10_000, 30_000)); // 1:3
    }
    return {
      fromYear: opts.fromYear,
      chartEndYear: opts.drawdownEndYear,
      drawdownEndYear: opts.drawdownEndYear,
      depositsByYear: new Map(),
      sourceSplitByYear,
      extendedExpenseRows: expenseRows,
      monthlySeries: null,
      categoryMonthlyNominal: [],
      categoryYearlyNominal,
      categoryMonthlyBase: [],
      categoryYearlyBase,
    } as unknown as CashflowSeriesPipelineResult;
  }

  function run(displayMode: 'today' | 'future'): IncomeView | null {
    const drawdown: DrawdownByMethodResult = {
      years: [drawdownYear({ year: 2031, growth: 0, withdrawn: 30_000 })],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    return buildIncomeView({
      cashflowSeries: categoryCashflowSeries({ fromYear: 2031, drawdownEndYear: 2031 }),
      drawdownByMethod: { planned: drawdown, twr: null },
      activeMethod: 'planned',
      resolvedDrawdown: drawdown,
      displayMode,
      cashflowGranularity: 'yearly',
      incomeBreakdownGranularity: 'yearly',
      lastDeathFractional: null,
      viewDeflator: IDENTITY_DEFLATOR,
      basisDeflator: IDENTITY_DEFLATOR,
      categoryMeta: [
        { id: CAT_A, name: 'A', color: '#000' },
        { id: CAT_B, name: 'B', color: '#111' },
      ],
    });
  }

  it("'today' uses the *Base category maps (A:B share 3:1)", () => {
    const view = run('today');
    expect(view).not.toBeNull();
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.byCategory?.[CAT_A]).toBe(22_500);
    expect(row?.byCategory?.[CAT_B]).toBe(7_500);
  });

  it("'future' uses the *Nominal category maps (A:B share 1:3)", () => {
    const view = run('future');
    expect(view).not.toBeNull();
    const row = view!.cashflowChartRows.find((r) => r.year === 2031);
    expect(row?.byCategory?.[CAT_A]).toBe(7_500);
    expect(row?.byCategory?.[CAT_B]).toBe(22_500);
  });
});
