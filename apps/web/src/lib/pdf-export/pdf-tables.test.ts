import { describe, expect, it } from 'vitest';
import {
  aggregateByYear,
  buildAccountBalancesByAccountTableSpec,
  buildAccountBalancesByTypeTableSpec,
  buildBalanceTableSpec,
  buildCashflowTableSpec,
  buildExpensesByCategoryTableSpec,
  buildExpensesTotalTableSpec,
  buildIncomeBreakdownTableSpec,
  buildPortfolioFlowsTableSpec,
  buildQcdTableSpec,
  buildReportExpensesTableSpec,
  buildReportIncomeTableSpec,
  buildRmdTableSpec,
  buildRothConversionsTableSpec,
  buildRothTaxFreeTableSpec,
  buildStressTestTableSpec,
  buildTaxBurdenTableSpec,
  buildYearByYearTableSpec,
  buildWithdrawalGuidanceTableSpec,
  buildWithdrawalGuidanceSectionSpec,
  buildGuidanceNoteSpec,
  WITHDRAWAL_GUIDANCE_MC_NOTE,
  WITHDRAWAL_GUIDANCE_EMPTY_NOTE,
  formatDollars,
  formatPercent,
  type StackTableAccount,
} from './pdf-tables';
import {
  deflateGuidanceRows,
  type GuidanceYearRow,
} from '../../pages/withdrawal-guidance-data';
import type { RmdAggregationGroup } from '../rmd-aggregation-groups';
import type { YearlyTableRow } from '../../pages/balance-projection-page-yearly';
import type { PortfolioFlowYear } from '../../pages/balance-projection-page-yearly-builders';
import type { ProjectionChartRow } from '../../components/ProjectionChart';
import type { StackBandYear } from '../account-balance-stack-timeline';
import { stackTypeBucketsForYear } from '../../pages/balance-projection-page-account-balance-stack';
import {
  projectExpensesByCategoryYear,
  projectExpensesByYear,
  type ExpenseCategoryYearPoint,
  type ExpenseProjectionPoint,
  type ProjectionContext,
} from '../expense-projection';
import type { ResolvedExpense } from '../expense-resolution';
import type { ExpensePayload } from '../../db/types';
import type {
  ReportExpense,
  ReportIncomeStream,
} from '../report-data';

function yearRow(over: Partial<YearlyTableRow> = {}): YearlyTableRow {
  return {
    year: 2040,
    isCashflowYear: true,
    balanceByMethod: { planned: 1000, twr: 2000 },
    earned: 0,
    withdrawal: 40000,
    totalIncome: 50000,
    expenses: 60000,
    shortfall: 0,
    gains: 12345,
    gainsBreakdown: null,
    ...over,
  };
}

describe('formatPercent', () => {
  it('formats a percent value to one decimal with a % suffix', () => {
    expect(formatPercent(6.5)).toBe('6.5%');
  });

  it('renders null as an em dash', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('buildYearByYearTableSpec', () => {
  it('returns a { head, body } shape with one body row per input row', () => {
    const spec = buildYearByYearTableSpec([yearRow(), yearRow({ year: 2041 })], 'planned');
    expect(spec.head[0][0]).toBe('Year');
    expect(spec.body).toHaveLength(2);
    expect(spec.body[0][0]).toBe('2040');
    expect(spec.body[1][0]).toBe('2041');
  });

  it('reads the ALREADY-deflated balance for the active method — no re-deflation', () => {
    // The balance cells must be the VM's stored values verbatim. A high-CPI MC
    // path stores its own path-CPI-deflated balance upstream; the adapter must
    // emit exactly that, never re-scale it.
    const planned = buildYearByYearTableSpec(
      [yearRow({ balanceByMethod: { planned: 777, twr: 999 } })],
      'planned',
    );
    expect(planned.body[0][1]).toBe(formatDollars(777));

    const twr = buildYearByYearTableSpec(
      [yearRow({ balanceByMethod: { planned: 777, twr: 999 } })],
      'twr',
    );
    expect(twr.body[0][1]).toBe(formatDollars(999));
  });

  it('emits today’s-dollar Gains from the VM verbatim', () => {
    // Two rows with the SAME nominal source would diverge if the adapter
    // re-deflated; here we assert it passes the already-display value through.
    const spec = buildYearByYearTableSpec(
      [yearRow({ gains: 12345 })],
      'planned',
    );
    expect(spec.body[0][6]).toBe(formatDollars(12345));
  });

  it('empty rows → empty body, no crash', () => {
    const spec = buildYearByYearTableSpec([], 'planned');
    expect(spec.body).toEqual([]);
    expect(spec.head).toHaveLength(1);
  });

  it('renders null cells as an em dash', () => {
    const spec = buildYearByYearTableSpec(
      [yearRow({ balanceByMethod: { planned: null, twr: null }, withdrawal: null })],
      'planned',
    );
    expect(spec.body[0][1]).toBe('—');
    expect(spec.body[0][3]).toBe('—');
  });
});

describe('buildPortfolioFlowsTableSpec', () => {
  const flow: PortfolioFlowYear = {
    year: 2041,
    contributions: 1000,
    gains: 2000,
    deposits: 500,
    withdrawals: -3000,
    qcd: 0,
    netChange: 500,
  };

  it('passes already-deflated flow values straight through', () => {
    const spec = buildPortfolioFlowsTableSpec([flow]);
    expect(spec.head[0]).toEqual([
      'Year',
      'Contributions',
      'Gains',
      'Deposits',
      'Withdrawals',
      'Charitable (QCD)',
      'Net change',
    ]);
    expect(spec.body[0]).toEqual([
      '2041',
      formatDollars(1000),
      formatDollars(2000),
      formatDollars(500),
      formatDollars(-3000),
      formatDollars(0),
      formatDollars(500),
    ]);
  });

  it('includes the QCD outflow column, reconciling into net change', () => {
    // QCD year: the gift left the portfolio, so it is its own below-zero
    // column and is already subtracted from `netChange` upstream.
    const qcdFlow: PortfolioFlowYear = {
      year: 2050,
      contributions: 0,
      gains: 2000,
      deposits: 0,
      withdrawals: -4000,
      qcd: -1000,
      netChange: -3000, // gains − spend − qcd = 2000 − 4000 − 1000
    };
    const spec = buildPortfolioFlowsTableSpec([qcdFlow]);
    expect(spec.body[0]).toEqual([
      '2050',
      formatDollars(0),
      formatDollars(2000),
      formatDollars(0),
      formatDollars(-4000),
      formatDollars(-1000),
      formatDollars(-3000),
    ]);
    // The charted columns reconcile to the net-change column.
    expect(
      qcdFlow.contributions +
        qcdFlow.gains +
        qcdFlow.deposits +
        qcdFlow.withdrawals +
        qcdFlow.qcd,
    ).toBe(qcdFlow.netChange);
  });

  it('empty rows → empty body', () => {
    expect(buildPortfolioFlowsTableSpec([]).body).toEqual([]);
  });
});

describe('report inventory adapters', () => {
  const expense: ReportExpense = {
    id: 'e1',
    name: 'Housing',
    categoryName: 'Home',
    classification: 'essential',
    frequency: 'monthly',
    annualAmount: 36000,
    effectiveStartMonth: 24_360,
    effectiveEndMonth: 24_372,
    startLabel: 'Now',
    endLabel: 'Lifetime',
    glideSummary: null,
  };
  const income: ReportIncomeStream = {
    id: 'i1',
    name: 'Pension',
    kind: 'pension',
    memberName: 'Pat',
    ownerSortRank: 0,
    annualAmount: 24000,
    scheduleLabel: 'From age 65',
    colaPct: 2,
    tracksInflation: false,
  };

  it('expenses adapter passes classification, annual amount + labels through', () => {
    const spec = buildReportExpensesTableSpec([expense]);
    expect(spec.body[0][0]).toBe('Housing');
    expect(spec.body[0][2]).toBe('Essential');
    expect(spec.body[0][3]).toBe(formatDollars(36000));
    expect(spec.body[0][5]).toBe('Lifetime');
  });

  it('income adapter passes annual amount, schedule + COLA through', () => {
    const spec = buildReportIncomeTableSpec([income]);
    expect(spec.body[0][0]).toBe('Pension');
    expect(spec.body[0][2]).toBe(formatDollars(24000));
    expect(spec.body[0][3]).toBe('From age 65');
    expect(spec.body[0][4]).toBe('2% COLA');
  });

  it('all inventory adapters handle empty input', () => {
    expect(buildReportExpensesTableSpec([]).body).toEqual([]);
    expect(buildReportIncomeTableSpec([]).body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-chart data tables
// ---------------------------------------------------------------------------

describe('aggregateByYear', () => {
  it('sums the selected fields per calendar year, preserving first-seen order', () => {
    const rows = [
      { year: 2041, a: 10, b: 1 },
      { year: 2040, a: 100, b: 2 },
      { year: 2040, a: 50, b: 3 },
      { year: 2041, a: 20, b: 4 },
    ];
    const out = aggregateByYear(rows, ['a', 'b']);
    expect(out.map((r) => r.year)).toEqual([2041, 2040]);
    expect(out[0]).toEqual({ year: 2041, a: 30, b: 5 });
    expect(out[1]).toEqual({ year: 2040, a: 150, b: 5 });
  });

  it('passes one-per-year rows through with their lone value', () => {
    const out = aggregateByYear([{ year: 2040, v: 7 }], ['v']);
    expect(out).toEqual([{ year: 2040, v: 7 }]);
  });
});

function chartRow(over: Partial<ProjectionChartRow> = {}): ProjectionChartRow {
  return {
    year: 2040,
    x: 2041,
    plannedSolid: 1000,
    plannedDashed: null,
    twrSolid: 2000,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
    ...over,
  };
}

describe('buildBalanceTableSpec', () => {
  it('coalesces each method Solid/Dashed to one value per year', () => {
    const spec = buildBalanceTableSpec(
      [chartRow({ plannedSolid: null, plannedDashed: 1234 })],
      new Set(),
      false,
    );
    expect(spec.head[0]).toEqual(['Year', 'Planned']);
    expect(spec.body[0]).toEqual(['2040', formatDollars(1234)]);
  });

  it('includes the Historical column only when TWR is enabled', () => {
    const off = buildBalanceTableSpec([chartRow()], new Set(), false);
    expect(off.head[0]).toEqual(['Year', 'Planned']);
    const on = buildBalanceTableSpec([chartRow()], new Set(['twr']), false);
    expect(on.head[0]).toEqual(['Year', 'Planned', 'Historical']);
    expect(on.body[0][2]).toBe(formatDollars(2000));
  });

  it('includes the Monte Carlo column only when an MC basis is active', () => {
    const spec = buildBalanceTableSpec(
      [chartRow({ mcSolid: 4242, mcDashed: null })],
      new Set(),
      true,
    );
    expect(spec.head[0]).toEqual(['Year', 'Planned', 'Monte Carlo']);
    expect(spec.body[0][2]).toBe(formatDollars(4242));
  });

  it('emits an em dash when a method has no value that year', () => {
    const spec = buildBalanceTableSpec(
      [chartRow({ twrSolid: null, twrDashed: null })],
      new Set(['twr']),
      false,
    );
    expect(spec.body[0][2]).toBe('—');
  });
});

describe('buildStressTestTableSpec', () => {
  it('maps the percentile triple to Bad-luck / Pessimistic / Typical', () => {
    const spec = buildStressTestTableSpec([
      { year: 2040, badLuck: 10, pessimistic: 20, typical: 30 },
    ]);
    expect(spec.head[0]).toEqual(['Year', 'Bad-luck', 'Pessimistic', 'Typical']);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(10),
      formatDollars(20),
      formatDollars(30),
    ]);
  });
});

describe('buildCashflowTableSpec', () => {
  it('aggregates monthly samples to annual essential/discretionary/taxes/income/shortfall', () => {
    const point = (year: number, essential: number) => ({
      fractionalYear: year,
      year,
      month0: 0,
      essential,
      discretionary: 5,
      taxes: 1,
      total: essential + 6,
      earned: 0,
      withdrawal: 0,
      totalIncome: 50,
      shortfallBase: 0,
      shortfallHeight: 2,
    });
    const spec = buildCashflowTableSpec([point(2040, 10), point(2040, 20)]);
    expect(spec.head[0]).toEqual([
      'Year',
      'Essential',
      'Discretionary',
      'Taxes',
      'Total income',
      'Shortfall',
    ]);
    expect(spec.body).toHaveLength(1);
    expect(spec.body[0][1]).toBe(formatDollars(30));
    expect(spec.body[0][2]).toBe(formatDollars(10));
    expect(spec.body[0][5]).toBe(formatDollars(4));
  });
});

describe('buildIncomeBreakdownTableSpec', () => {
  const point = (over: Record<string, number>) => ({
    fractionalYear: 2040,
    year: 2040,
    month0: 0,
    ss: 0,
    pensionAnnuity: 0,
    partTime: 0,
    oneOff: 0,
    portfolioAdd: 0,
    withdrawal: 0,
    total: 0,
    expenses: 0,
    ...over,
  });

  it('omits an all-zero stripe column and aggregates the rest to annual', () => {
    const spec = buildIncomeBreakdownTableSpec([
      point({ ss: 100, withdrawal: 50 }),
      point({ ss: 100, withdrawal: 50 }),
    ]);
    // ss + withdrawal are non-zero; the other four stripes are dropped.
    expect(spec.head[0]).toEqual(['Year', 'Social Security', 'Withdrawal']);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(200),
      formatDollars(100),
    ]);
  });
});

describe('buildTaxBurdenTableSpec', () => {
  it('flips the negative ACA-PTC into a positive credit column', () => {
    const spec = buildTaxBurdenTableSpec([
      { year: 2040, federalTax: 1000, irmaaSurcharge: 200, acaPtcSubsidy: -300 },
    ]);
    expect(spec.head[0]).toEqual([
      'Year',
      'Federal tax',
      'IRMAA surcharge',
      'ACA premium tax credit',
    ]);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(1000),
      formatDollars(200),
      formatDollars(300),
    ]);
  });
});

describe('buildRmdTableSpec', () => {
  it('emits Year / RMD met / Shortfall when no year retains surplus', () => {
    const spec = buildRmdTableSpec([
      { year: 2040, rmdMet: 5000, rmdShortfall: 250, rmdRetained: 0 },
    ]);
    expect(spec.head[0]).toEqual(['Year', 'RMD met', 'Shortfall']);
    expect(spec.body[0]).toEqual(['2040', formatDollars(5000), formatDollars(250)]);
  });

  it('inserts an of-which-surplus column when a year retains surplus', () => {
    const spec = buildRmdTableSpec([
      { year: 2040, rmdMet: 5000, rmdShortfall: 0, rmdRetained: 1200 },
      { year: 2041, rmdMet: 6000, rmdShortfall: 0, rmdRetained: 0 },
    ]);
    expect(spec.head[0]).toEqual([
      'Year',
      'RMD met',
      'of which surplus',
      'Shortfall',
    ]);
    // The surplus cell sits BETWEEN RMD met and Shortfall.
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(5000),
      formatDollars(1200),
      formatDollars(0),
    ]);
    expect(spec.body[1]).toEqual([
      '2041',
      formatDollars(6000),
      formatDollars(0),
      formatDollars(0),
    ]);
  });

  it('clamps the of-which-surplus cell to RMD met (no overshoot)', () => {
    const spec = buildRmdTableSpec([
      { year: 2040, rmdMet: 5000, rmdShortfall: 0, rmdRetained: 5000.01 },
    ]);
    expect(spec.body[0][2]).toEqual(formatDollars(5000));
  });
});

describe('buildRothConversionsTableSpec', () => {
  it('emits Year / Converted', () => {
    const spec = buildRothConversionsTableSpec([{ year: 2040, dollars: 12000 }]);
    expect(spec.head[0]).toEqual(['Year', 'Converted']);
    expect(spec.body[0]).toEqual(['2040', formatDollars(12000)]);
  });
});

describe('buildRothTaxFreeTableSpec', () => {
  it('emits the Person or account / What this amount is / Amount header', () => {
    const spec = buildRothTaxFreeTableSpec([]);
    expect(spec.head[0]).toEqual(['Person or account', 'What this amount is', 'Amount']);
  });

  it('formats a person row and an employer row with their own descriptions', () => {
    const spec = buildRothTaxFreeTableSpec([
      { id: 'p', kind: 'person', label: 'Alex', amount: 45_000 },
      { id: 'e', kind: 'employer', label: '401k', amount: 12_000 },
    ]);
    expect(spec.body).toEqual([
      ['Alex', expect.any(String), formatDollars(45_000)],
      ['401k', expect.any(String), formatDollars(12_000)],
    ]);
    // The employer description must state the OPPOSITE of withdrawable
    // tax-free (positive form, not just the absence of one literal phrase)...
    expect(spec.body[0][1]).not.toBe(spec.body[1][1]);
    expect(spec.body[1][1]).toMatch(/\bnot tax-free\b/i);
    // ...and no header cell or the employer body cell may pair "withdraw" with
    // an UNNEGATED "tax-free" within ~20 characters, in either order — that
    // pairing is exactly what the binding constraint forbids. A "not tax-free"
    // occurrence is excluded so the legitimate disclaimer above doesn't
    // self-trip the guard it exists to satisfy.
    const withdrawTaxFreeProximity =
      /(withdraw\w*[^.]{0,20}(?<!not )tax-free|(?<!not )tax-free[^.]{0,20}withdraw\w*)/i;
    for (const cell of [...spec.head[0], spec.body[1][1]]) {
      expect(cell).not.toMatch(withdrawTaxFreeProximity);
    }
  });

  it('every GENERATED cell is ASCII (em dash only)', () => {
    const spec = buildRothTaxFreeTableSpec([
      { id: 'p', kind: 'person', label: "José's Roth IRA", amount: 45_000 },
      { id: 'e', kind: 'employer', label: '401k', amount: 12_000 },
    ]);
    const nonAscii = /[^\x00-\x7F—]/;
    // The generated description + amount cells stay ASCII (em dash only); the
    // user-supplied label passes through verbatim (checked separately below).
    for (const row of [...spec.head, ...spec.body]) {
      for (const cell of row.slice(1)) expect(cell).not.toMatch(nonAscii);
    }
    expect(spec.body[0][0]).toBe("José's Roth IRA");
  });
});

describe('buildQcdTableSpec', () => {
  it('emits the three-column header', () => {
    const spec = buildQcdTableSpec([]);
    expect(spec.head[0]).toEqual(['Year', 'QCD distributed', 'Net taxable IRA RMD']);
  });

  it('formats each row with year + both dollar columns', () => {
    const spec = buildQcdTableSpec([
      { year: 2040, qcdDollars: 5000, netTaxableRmd: 8000, rmdOffsetDollars: 5000 },
    ]);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(5000),
      formatDollars(8000),
    ]);
  });

  it('empty rows → empty body', () => {
    expect(buildQcdTableSpec([]).body).toEqual([]);
  });

  it('formats zero netTaxableRmd as $0 (not em dash)', () => {
    const spec = buildQcdTableSpec([
      { year: 2040, qcdDollars: 3000, netTaxableRmd: 0, rmdOffsetDollars: 0 },
    ]);
    expect(spec.body[0][2]).toBe(formatDollars(0));
    expect(spec.body[0][2]).not.toBe('—');
  });

  it('produces one body row per input element', () => {
    const rows = [
      { year: 2040, qcdDollars: 1000, netTaxableRmd: 2000, rmdOffsetDollars: 1000 },
      { year: 2041, qcdDollars: 1500, netTaxableRmd: 2500, rmdOffsetDollars: 1500 },
      { year: 2042, qcdDollars: 2000, netTaxableRmd: 3000, rmdOffsetDollars: 2000 },
    ];
    expect(buildQcdTableSpec(rows).body).toHaveLength(3);
  });
});

function stackYear(
  year: number,
  balances: Record<string, number>,
): StackBandYear {
  const accountBalances = new Map(
    Object.entries(balances).map(([id, balance]) => [
      id,
      { balance, preEnd: balance, postEnd: 0, carriedForward: false },
    ]),
  );
  return { year, accountBalances, zone: 'projected' };
}

describe('buildAccountBalancesByTypeTableSpec', () => {
  const accounts: StackTableAccount[] = [
    { id: 'a', name: '401k', ownerDisplayName: 'Alex', type: 'RETIREMENT_401K' },
    { id: 'b', name: 'Brokerage', ownerDisplayName: 'Alex', type: 'BROKERAGE' },
  ];

  it('reuses the band grouping helper and omits all-zero type columns', () => {
    const rows = [
      stackYear(2040, { a: 100, b: 200 }),
      stackYear(2041, { a: 150, b: 250 }),
    ];
    const spec = buildAccountBalancesByTypeTableSpec(
      rows,
      accounts,
      stackTypeBucketsForYear,
    );
    // Only Tax-deferred (401k) + Taxable (brokerage) are non-zero.
    expect(spec.head[0]).toEqual(['Year', 'Tax-deferred', 'Taxable']);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(100),
      formatDollars(200),
    ]);
    expect(spec.body[1][0]).toBe('2041');
  });
});

describe('buildAccountBalancesByAccountTableSpec', () => {
  it('emits one column per account, defaulting a missing account-year to zero', () => {
    const accounts: StackTableAccount[] = [
      { id: 'a', name: '401k', ownerDisplayName: 'Alex', type: 'RETIREMENT_401K' },
      { id: 'b', name: 'Roth', ownerDisplayName: 'Alex', type: 'RETIREMENT_ROTH_IRA' },
    ];
    const rows = [stackYear(2040, { a: 100 })];
    const spec = buildAccountBalancesByAccountTableSpec(rows, accounts);
    expect(spec.head[0]).toEqual(['Year', '401k', 'Roth']);
    expect(spec.body[0]).toEqual(['2040', formatDollars(100), formatDollars(0)]);
  });
});

// The expense PDF tables source their annual figures straight from the
// headline annual engine (`projectExpensesByYear` /
// `projectExpensesByCategoryYear`) for the SAME resolved expenses / context /
// display basis the monthly chart rows are built from. These tests lock that
// contract: the builder formats the annual rows it is handed verbatim, and a
// future-dollars PARTIAL (mid-year-start) year ties out to the engine exactly —
// a monthly run-rate rollup would diverge there (mean-of-active-months ≠
// mean-of-all-12 when inflation ≠ 0).
const expenseCtx = (
  overrides: Partial<ProjectionContext> = {},
): ProjectionContext => ({
  todayYear: 2026,
  retirementYear: 2030,
  primary: { birthdate: '1965-03-12' }, // age 65 → March 2030
  secondary: { birthdate: '1968-09-03' },
  inflation: { ratePct: 0 },
  ...overrides,
});

const resolvedExpense = (
  id: string,
  payload: Partial<ExpensePayload>,
): ResolvedExpense => ({
  id,
  source: 'canonical',
  payload: {
    name: id,
    amount: 0,
    frequency: 'monthly',
    classification: 'essential',
    categoryId: 'cat-x',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
    ...payload,
  },
});

describe('buildExpensesTotalTableSpec', () => {
  const annualPoint = (
    year: number,
    essential: number,
    discretionary: number,
  ): ExpenseProjectionPoint => ({
    year,
    essential,
    discretionary,
    total: essential + discretionary,
    essentialBase: essential,
    discretionaryBase: discretionary,
    totalBase: essential + discretionary,
  });

  it('formats the annual essential/discretionary totals verbatim (full year, today dollars)', () => {
    const spec = buildExpensesTotalTableSpec([
      annualPoint(2040, 60_000, 24_000),
    ]);
    expect(spec.head[0]).toEqual(['Year', 'Essential', 'Discretionary']);
    expect(spec.body[0]).toEqual([
      '2040',
      formatDollars(60_000),
      formatDollars(24_000),
    ]);
  });

  it('ties out to projectExpensesByYear for a future-dollars mid-year-start partial year', () => {
    // Mid-year (March) age-65 start in 2030 → a PARTIAL year, with 3% future
    // inflation on. A monthly mean-of-active-months rollup would diverge from
    // the engine's active-months × year-mean-factor here; sourcing the table
    // from the engine ties it out exactly.
    const exp = resolvedExpense('e', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = expenseCtx({ inflation: { ratePct: 3 } });
    const annual = projectExpensesByYear([exp], ctx, { from: 2030, to: 2031 });
    const partial = annual.find((r) => r.year === 2030)!;
    // Sanity: the start month really makes 2030 a partial year (< full year).
    const full = annual.find((r) => r.year === 2031)!;
    expect(partial.essential).toBeGreaterThan(0);
    expect(partial.essential).toBeLessThan(full.essential);

    const spec = buildExpensesTotalTableSpec(annual);
    const partialRow = spec.body.find((r) => r[0] === '2030')!;
    expect(partialRow).toEqual([
      '2030',
      formatDollars(partial.essential),
      formatDollars(partial.discretionary),
    ]);
  });
});

describe('buildExpensesByCategoryTableSpec', () => {
  const annualCat = (
    year: number,
    byCategoryId: Record<string, number>,
  ): ExpenseCategoryYearPoint => ({
    year,
    byCategoryId,
    total: Object.values(byCategoryId).reduce((s, v) => s + v, 0),
  });

  it('emits one column per non-all-zero category, formatting the annual totals verbatim', () => {
    const meta = [
      { id: 'h', name: 'Housing' },
      { id: 'm', name: 'Medical' },
    ];
    const spec = buildExpensesByCategoryTableSpec(
      [annualCat(2040, { h: 30_000, m: 0 })],
      meta,
    );
    // Medical is all-zero → dropped.
    expect(spec.head[0]).toEqual(['Year', 'Housing']);
    expect(spec.body[0]).toEqual(['2040', formatDollars(30_000)]);
  });

  it('ties out to projectExpensesByCategoryYear for a future-dollars mid-year-start partial year', () => {
    const exp = resolvedExpense('e', {
      amount: 1000,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'h',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
    const ctx = expenseCtx({ inflation: { ratePct: 3 } });
    const annual = projectExpensesByCategoryYear([exp], ctx, {
      from: 2030,
      to: 2031,
    });
    const partial = annual.find((r) => r.year === 2030)!;
    const full = annual.find((r) => r.year === 2031)!;
    expect(partial.byCategoryId.h).toBeGreaterThan(0);
    expect(partial.byCategoryId.h).toBeLessThan(full.byCategoryId.h);

    const spec = buildExpensesByCategoryTableSpec(annual, [
      { id: 'h', name: 'Housing' },
    ]);
    const partialRow = spec.body.find((r) => r[0] === '2030')!;
    expect(partialRow).toEqual(['2030', formatDollars(partial.byCategoryId.h)]);
  });
});

// ---------------------------------------------------------------------------
// Projected withdrawals (the PDF's final section).
// ---------------------------------------------------------------------------

/** Build a minimal `GuidanceYearRow` for the withdrawal-guidance tests. */
function guidanceYear(
  partial: Partial<GuidanceYearRow> & { year: number },
): GuidanceYearRow {
  return {
    year: partial.year,
    totalWithdrawnDollars: partial.totalWithdrawnDollars ?? 0,
    taxAndMedicareDollars: partial.taxAndMedicareDollars ?? 0,
    spendableDollars: partial.spendableDollars ?? 0,
    hasWithdrawal: partial.hasWithdrawal ?? false,
    rmdGroups: partial.rmdGroups ?? [],
    hasRmdShortfall: partial.hasRmdShortfall ?? false,
    rmdDisclosures: partial.rmdDisclosures ?? [],
    accounts: partial.accounts ?? [],
  };
}

const EXPECTED_GUIDANCE_HEAD = [
  'Year / Account',
  'Withdrawn',
  'Ending balance',
  'Required min.',
  'Tax & Medicare',
  'After-tax spendable',
];

const NO_OWNERS: ReadonlyMap<string, string> = new Map();

describe('buildWithdrawalGuidanceTableSpec', () => {
  it('emits the six-column header', () => {
    const spec = buildWithdrawalGuidanceTableSpec([], NO_OWNERS);
    expect(spec.head).toEqual([EXPECTED_GUIDANCE_HEAD]);
  });

  it('one year + one plain account → summary row then one indented sub-row', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          totalWithdrawnDollars: 40000,
          taxAndMedicareDollars: 5000,
          spendableDollars: 34000,
          hasWithdrawal: true,
          accounts: [
            {
              accountId: 'a1',
              accountName: 'Brokerage',
              withdrawnDollars: 40000,
              endingBalanceDollars: 500000,
              rmdDollars: 0,
            },
          ],
        }),
      ],
      NO_OWNERS,
    );
    // Two body rows precede the two trailing notes.
    const content = spec.body.slice(0, -2);
    expect(content).toHaveLength(2);
    // Summary row: cross-level cells are em dashes.
    expect(content[0]).toEqual([
      '2040',
      formatDollars(40000),
      '—',
      '—',
      formatDollars(5000),
      formatDollars(34000),
    ]);
    // Account sub-row: indented; RMD 0 → em dash; tax/spendable columns dashed.
    expect(content[1]).toEqual([
      '    Brokerage',
      formatDollars(40000),
      formatDollars(500000),
      '—',
      '—',
      '—',
    ]);
    // Every body row has the six-column width.
    for (const row of spec.body) expect(row).toHaveLength(6);
  });

  it('orders body as [y1 summary, y1 groups, y1 accounts, y2 …] then notes last', () => {
    const group: RmdAggregationGroup = {
      key: 'm1:aggregatable:RETIREMENT_IRA',
      ownerId: 'm1',
      kind: 'aggregatable',
      accountType: 'RETIREMENT_IRA',
      requiredCents: 100000,
      accounts: [{ id: 'ira1', name: 'IRA One', requiredCents: 100000 }],
    };
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          hasWithdrawal: true,
          rmdGroups: [group],
          accounts: [
            {
              accountId: 'ira1',
              accountName: 'IRA One',
              withdrawnDollars: 1000,
              endingBalanceDollars: 9000,
              rmdDollars: 1000,
            },
          ],
        }),
        guidanceYear({ year: 2041, hasWithdrawal: true, totalWithdrawnDollars: 5 }),
      ],
      NO_OWNERS,
    );
    const firstCells = spec.body.map((r) => r[0]);
    expect(firstCells[0]).toBe('2040');
    expect(firstCells[1]).toContain('Required minimum: projected from any of');
    expect(firstCells[2]).toBe('    IRA One');
    expect(firstCells[3]).toBe('2041');
    // Trailing notes are the final two rows.
    expect(firstCells[firstCells.length - 2]).toContain('Required min. shown per account');
    expect(firstCells[firstCells.length - 1]).toContain('After-tax spendable already nets');
  });

  it('marks the RMD-shortfall suffix on the year cell only when flagged', () => {
    const shortfall = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2040, hasWithdrawal: true, hasRmdShortfall: true })],
      NO_OWNERS,
    );
    expect(shortfall.body[0][0]).toBe('2040 — RMD shortfall');
    const ok = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2040, hasWithdrawal: true, hasRmdShortfall: false })],
      NO_OWNERS,
    );
    expect(ok.body[0][0]).toBe('2040');
  });

  it('renders HSA medical/reserve, MIXED split, and MIXED unavailable parentheticals', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          hasWithdrawal: true,
          accounts: [
            {
              accountId: 'hsa',
              accountName: 'HSA',
              withdrawnDollars: 3000,
              endingBalanceDollars: 0,
              rmdDollars: 0,
              hsaMedicalQualifiedDollars: 2000,
              hsaEmergencyReserveDollars: 1000,
            },
            {
              accountId: 'mix',
              accountName: 'Mixed 401k',
              withdrawnDollars: 5000,
              endingBalanceDollars: 0,
              rmdDollars: 0,
              isMixed: true,
              preTaxWithdrawnDollars: 3000,
              postWithdrawnDollars: 2000,
              postLabel: 'Roth',
            },
            {
              accountId: 'mix2',
              accountName: 'Mixed Other',
              withdrawnDollars: 1000,
              endingBalanceDollars: 0,
              rmdDollars: 0,
              isMixed: true,
            },
          ],
        }),
      ],
      NO_OWNERS,
    );
    const cells = spec.body.map((r) => r[0]);
    expect(cells).toContain(
      `    HSA (medical ${formatDollars(2000)}; reserve ${formatDollars(1000)})`,
    );
    expect(cells).toContain(
      `    Mixed 401k (pre-tax ${formatDollars(3000)}; Roth ${formatDollars(2000)})`,
    );
    expect(cells).toContain('    Mixed Other (mixed; split unavailable)');
  });

  it('per-account Required min. renders 0 → em dash, > 0 → formatted', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          hasWithdrawal: true,
          accounts: [
            {
              accountId: 'a',
              accountName: 'A',
              withdrawnDollars: 10,
              endingBalanceDollars: 0,
              rmdDollars: 0,
            },
            {
              accountId: 'b',
              accountName: 'B',
              withdrawnDollars: 20,
              endingBalanceDollars: 0,
              rmdDollars: 1500,
            },
          ],
        }),
      ],
      NO_OWNERS,
    );
    const aRow = spec.body.find((r) => r[0] === '    A')!;
    const bRow = spec.body.find((r) => r[0] === '    B')!;
    expect(aRow[3]).toBe('—');
    expect(bRow[3]).toBe(formatDollars(1500));
  });

  it('renders aggregatable + per-plan group instructions with the group required amount', () => {
    const owners = new Map([
      ['m1', 'Alex'],
      ['m2', 'Bo'],
    ]);
    const aggGroup: RmdAggregationGroup = {
      key: 'm1:aggregatable:RETIREMENT_IRA',
      ownerId: 'm1',
      kind: 'aggregatable',
      accountType: 'RETIREMENT_IRA',
      requiredCents: 250000,
      accounts: [
        { id: 'ira1', name: 'IRA One', requiredCents: 150000 },
        { id: 'ira2', name: 'IRA Two', requiredCents: 100000 },
      ],
    };
    const perPlanGroup: RmdAggregationGroup = {
      key: 'm2:per-plan:k1',
      ownerId: 'm2',
      kind: 'per-plan',
      accountType: 'RETIREMENT_401K',
      requiredCents: 90000,
      accounts: [{ id: 'k1', name: 'Bo 401k', requiredCents: 90000 }],
    };
    const spec = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2040, hasWithdrawal: true, rmdGroups: [aggGroup, perPlanGroup] })],
      owners,
    );
    const aggRow = spec.body.find((r) => r[0].includes('projected from any of'))!;
    expect(aggRow[0]).toBe(
      "  Required minimum: projected from any of Alex's Traditional IRAs (IRA One, IRA Two)",
    );
    expect(aggRow[3]).toBe(formatDollars(2500));
    const planRow = spec.body.find((r) => r[0].includes('must come from'))!;
    expect(planRow[0]).toBe(
      "  Required minimum: projected from Bo's Bo 401k (401(k) — required minimum must come from this account)",
    );
    expect(planRow[3]).toBe(formatDollars(900));
    // Two distinct owners → two distinct group rows.
    const groupRows = spec.body.filter((r) => r[0].includes('Required minimum:'));
    expect(groupRows).toHaveLength(2);
  });

  it('aggregatable group with empty accounts emits no parenthetical', () => {
    const group: RmdAggregationGroup = {
      key: 'm1:aggregatable:RETIREMENT_IRA',
      ownerId: 'm1',
      kind: 'aggregatable',
      accountType: 'RETIREMENT_IRA',
      requiredCents: 10000,
      accounts: [],
    };
    const spec = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2030, hasWithdrawal: true, rmdGroups: [group] })],
      new Map([['m1', 'Alice']]),
    );
    const instructionRow = spec.body.find((r) => r[0].includes('projected from any of'));
    expect(instructionRow?.[0]).toBe(
      "  Required minimum: projected from any of Alice's Traditional IRAs",
    );
  });

  it('per-plan group with empty accounts falls back to type label', () => {
    const group: RmdAggregationGroup = {
      key: 'm1:per-plan:RETIREMENT_401K',
      ownerId: 'm1',
      kind: 'per-plan',
      accountType: 'RETIREMENT_401K',
      requiredCents: 5000,
      accounts: [],
    };
    const spec = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2030, hasWithdrawal: true, rmdGroups: [group] })],
      new Map([['m1', 'Bob']]),
    );
    const instructionRow = spec.body.find((r) => r[0].includes('must come from'));
    expect(instructionRow?.[0]).toBe(
      "  Required minimum: projected from Bob's 401(k) (401(k) — required minimum must come from this account)",
    );
  });

  it('emits no group rows when a year has no rmdGroups', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2040, hasWithdrawal: true })],
      NO_OWNERS,
    );
    expect(spec.body.some((r) => r[0].includes('Required minimum:'))).toBe(false);
  });

  it('always appends the two trailing clarifying note rows', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [guidanceYear({ year: 2040, hasWithdrawal: true })],
      NO_OWNERS,
    );
    const notes = spec.body.slice(-2);
    expect(notes[0][0]).toContain('the binding amount is the "Required minimum" instruction row');
    expect(notes[1][0]).toContain('it is not Withdrawn minus Tax & Medicare');
    // The note rows pad the remaining cells with empty strings.
    expect(notes[0].slice(1)).toEqual(['', '', '', '', '']);
  });

  it('every GENERATED cell is ASCII (em dash only) for an HSA+MIXED+shortfall+group spec', () => {
    const group: RmdAggregationGroup = {
      key: 'm1:per-plan:k1',
      ownerId: 'm1',
      kind: 'per-plan',
      accountType: 'RETIREMENT_457B',
      requiredCents: 12345,
      accounts: [{ id: 'k1', name: 'Plan', requiredCents: 12345 }],
    };
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          totalWithdrawnDollars: 9999,
          taxAndMedicareDollars: 111,
          spendableDollars: 8000,
          hasWithdrawal: true,
          hasRmdShortfall: true,
          rmdGroups: [group],
          accounts: [
            {
              accountId: 'hsa',
              accountName: 'HSA',
              withdrawnDollars: 100,
              endingBalanceDollars: 0,
              rmdDollars: 0,
              hsaMedicalQualifiedDollars: 60,
              hsaEmergencyReserveDollars: 40,
            },
            {
              accountId: 'mix',
              accountName: 'Mixed',
              withdrawnDollars: 200,
              endingBalanceDollars: 0,
              rmdDollars: 0,
              isMixed: true,
              preTaxWithdrawnDollars: 120,
              postWithdrawnDollars: 80,
              postLabel: 'after-tax contributions (gains taxable)',
            },
          ],
        }),
      ],
      new Map([['m1', 'Owner']]),
    );
    // Only the em dash is allowed outside the ASCII range in generated text.
    const nonAscii = /[^\x00-\x7F—]/;
    for (const row of [...spec.head, ...spec.body]) {
      for (const cell of row) expect(cell).not.toMatch(nonAscii);
    }
  });

  it('passes a non-ASCII account name through verbatim (generated scaffolding stays ASCII)', () => {
    const spec = buildWithdrawalGuidanceTableSpec(
      [
        guidanceYear({
          year: 2040,
          hasWithdrawal: true,
          accounts: [
            {
              accountId: 'a',
              accountName: "José's IRA",
              withdrawnDollars: 10,
              endingBalanceDollars: 0,
              rmdDollars: 0,
            },
          ],
        }),
      ],
      NO_OWNERS,
    );
    const accountRow = spec.body.find((r) => r[0].includes('IRA'))!;
    expect(accountRow[0]).toBe("    José's IRA");
  });
});

describe('deflateGuidanceRows', () => {
  it('scales each year by its own factor across all dollar fields incl. rmdGroups cents', () => {
    const group: RmdAggregationGroup = {
      key: 'm1:aggregatable:RETIREMENT_IRA',
      ownerId: 'm1',
      kind: 'aggregatable',
      accountType: 'RETIREMENT_IRA',
      requiredCents: 100000,
      accounts: [{ id: 'ira1', name: 'IRA', requiredCents: 100000 }],
    };
    const rows: GuidanceYearRow[] = [
      guidanceYear({
        year: 2040,
        totalWithdrawnDollars: 1000,
        taxAndMedicareDollars: 200,
        spendableDollars: 800,
        hasWithdrawal: true,
        rmdGroups: [group],
        accounts: [
          {
            accountId: 'ira1',
            accountName: 'IRA',
            withdrawnDollars: 1000,
            endingBalanceDollars: 5000,
            rmdDollars: 1000,
            hsaMedicalQualifiedDollars: 100,
            hsaEmergencyReserveDollars: 50,
            isMixed: true,
            preTaxWithdrawnDollars: 600,
            postWithdrawnDollars: 400,
            postLabel: 'Roth',
          },
        ],
      }),
      guidanceYear({ year: 2041, totalWithdrawnDollars: 1000, hasWithdrawal: true }),
    ];
    const deflated = deflateGuidanceRows(rows, (y) => (y === 2040 ? 0.5 : 1));
    const y40 = deflated[0];
    expect(y40.totalWithdrawnDollars).toBe(500);
    expect(y40.taxAndMedicareDollars).toBe(100);
    expect(y40.spendableDollars).toBe(400);
    expect(y40.rmdGroups[0].requiredCents).toBe(50000);
    expect(y40.rmdGroups[0].accounts[0].requiredCents).toBe(50000);
    const acc = y40.accounts[0];
    expect(acc.withdrawnDollars).toBe(500);
    expect(acc.endingBalanceDollars).toBe(2500);
    expect(acc.rmdDollars).toBe(500);
    expect(acc.hsaMedicalQualifiedDollars).toBe(50);
    expect(acc.hsaEmergencyReserveDollars).toBe(25);
    expect(acc.preTaxWithdrawnDollars).toBe(300);
    expect(acc.postWithdrawnDollars).toBe(200);
    // Residual structure preserved: labels/ids/booleans untouched.
    expect(acc.accountName).toBe('IRA');
    expect(acc.isMixed).toBe(true);
    expect(acc.postLabel).toBe('Roth');
    // The 2041 row keeps its (×1) value.
    expect(deflated[1].totalWithdrawnDollars).toBe(1000);
  });

  it('leaves absent optional fields absent (no $NaN downstream)', () => {
    const rows: GuidanceYearRow[] = [
      guidanceYear({
        year: 2040,
        hasWithdrawal: true,
        accounts: [
          {
            accountId: 'a',
            accountName: 'A',
            withdrawnDollars: 10,
            endingBalanceDollars: 0,
            rmdDollars: 0,
          },
        ],
      }),
    ];
    const acc = deflateGuidanceRows(rows, () => 2)[0].accounts[0];
    expect(acc.hsaMedicalQualifiedDollars).toBeUndefined();
    expect(acc.preTaxWithdrawnDollars).toBeUndefined();
    expect(acc.postWithdrawnDollars).toBeUndefined();
  });
});

describe('buildWithdrawalGuidanceSectionSpec', () => {
  const withdrawalRow = guidanceYear({
    year: 2040,
    totalWithdrawnDollars: 1000,
    hasWithdrawal: true,
    accounts: [
      {
        accountId: 'a',
        accountName: 'A',
        withdrawnDollars: 1000,
        endingBalanceDollars: 0,
        rmdDollars: 0,
      },
    ],
  });

  // Pin the note spec's head to the literal section name independently of the
  // function's own output, so a future accidental divergence between the note
  // header and the manifest's `table-withdrawal-guidance` title is caught (the
  // header now derives from the manifest, but this locks the displayed string).
  it('note spec head is the literal "Projected withdrawals" section title', () => {
    expect(buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_MC_NOTE).head).toEqual([
      ['Projected withdrawals'],
    ]);
  });

  it('MC basis active → the MC note spec', () => {
    const spec = buildWithdrawalGuidanceSectionSpec({
      isMcBasisActive: true,
      displayRows: [withdrawalRow],
      ownerNameById: NO_OWNERS,
    });
    expect(spec).toEqual(buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_MC_NOTE));
  });

  it('no-withdrawal predicate true → the empty note spec', () => {
    const spec = buildWithdrawalGuidanceSectionSpec({
      isMcBasisActive: false,
      displayRows: [guidanceYear({ year: 2040 })],
      ownerNameById: NO_OWNERS,
    });
    expect(spec).toEqual(buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_EMPTY_NOTE));
  });

  it('empty rows → the empty note spec', () => {
    const spec = buildWithdrawalGuidanceSectionSpec({
      isMcBasisActive: false,
      displayRows: [],
      ownerNameById: NO_OWNERS,
    });
    expect(spec).toEqual(buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_EMPTY_NOTE));
  });

  it('deterministic basis with withdrawals → the full table', () => {
    const spec = buildWithdrawalGuidanceSectionSpec({
      isMcBasisActive: false,
      displayRows: [withdrawalRow],
      ownerNameById: NO_OWNERS,
    });
    expect(spec.head).toEqual([EXPECTED_GUIDANCE_HEAD]);
    expect(spec.body[0][0]).toBe('2040');
  });

  it('MC active AND zero rows → the MC note (precedence over empty)', () => {
    const spec = buildWithdrawalGuidanceSectionSpec({
      isMcBasisActive: true,
      displayRows: [],
      ownerNameById: NO_OWNERS,
    });
    expect(spec).toEqual(buildGuidanceNoteSpec(WITHDRAWAL_GUIDANCE_MC_NOTE));
  });
});
