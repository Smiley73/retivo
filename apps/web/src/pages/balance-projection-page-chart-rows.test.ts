import { describe, expect, it } from 'vitest';
import type { ProjectionOutput } from '../lib/projection';
import type { BreakdownAccountRow } from './balance-projection-page-yearly';
import { buildYearlyChartRows } from './balance-projection-page-yearly';
import { deflateChartRows } from './balance-projection-page-drawdown';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { ProjectionChartRow } from '../components/ProjectionChart';

function projectionOutput(): ProjectionOutput {
  return {
    preTax: 0,
    postTax: 200,
    total: 200,
    yearlyTotals: [
      {
        year: 2041,
        preTax: 0,
        postTax: 100,
        growth: 10,
        contributions: 0,
      },
      {
        year: 2042,
        preTax: 0,
        postTax: 210,
        growth: 10,
        contributions: 0,
        retirementSnapshot: {
          preTax: 0,
          postTax: 200,
          fractionalYear: 2042 + 5.5 / 12,
        },
      },
    ],
  };
}

function breakdownRow(): BreakdownAccountRow {
  return {
    account: {} as BreakdownAccountRow['account'],
    ownerDisplay: 'Primary',
    ownerRetirementDate: '2042-06-15',
    latestBalance: 90,
    outputs: {
      planned: projectionOutput(),
      twr: null,
    },
    hasInsufficientHistory: false,
    ratePctByMethod: { planned: 5, twr: null },
    perMonthContribution: { preTax: 0, postTax: 0 },
  };
}

function chartRow(overrides: Partial<ProjectionChartRow>): ProjectionChartRow {
  return {
    year: 2041,
    x: 2042,
    plannedSolid: null,
    plannedDashed: null,
    twrSolid: null,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
    ...overrides,
  };
}

describe('buildYearlyChartRows', () => {
  it('anchors the synthesized retirement snapshot to the retirement month', () => {
    const rows = buildYearlyChartRows(
      [breakdownRow()],
      2042,
      2042 + 5.5 / 12,
    );

    const snapshot = rows.find((r) => r.x === 2042 + 5.5 / 12);
    const yearEnd = rows.find((r) => r.x === 2042);

    expect(snapshot?.valueMonthIndex).toBe(5);
    expect(snapshot?.plannedSolid).toBe(200);
    expect(snapshot?.plannedDashed).toBe(200);
    expect(yearEnd?.valueMonthIndex).toBeUndefined();
  });
});

describe('deflateChartRows', () => {
  it('uses fractional row month anchors while keeping drawdown rows December anchored', () => {
    const drawdown: Record<'planned' | 'twr', DrawdownByMethodResult | null> = {
      planned: {
        years: [
          {
            year: 2042,
            balance: 200,
            withdrawn: 0,
            netNeed: 0,
            growth: 0,
            deposit: 0,
            depleted: false,
          },
        ],
        depletionYear: null,
        perMonthWithdrawal: new Float64Array(),
      },
      twr: null,
    };
    const rows = deflateChartRows({
      chartRows: [
        chartRow({ year: 2041, x: 2042, plannedSolid: 100 }),
        chartRow({
          year: 2042,
          x: 2042.5,
          valueMonthIndex: 5,
          plannedSolid: 100,
          plannedDashed: 100,
        }),
        chartRow({ year: 2042, x: 2043, plannedDashed: 100 }),
      ],
      drawdownByMethod: drawdown,
      lastDeathYear: 2042,
      retirementYear: 2042,
      viewDeflator: (_year, monthIndex = 11) => monthIndex + 1,
    });

    expect(rows.find((r) => r.x === 2042)?.plannedSolid).toBe(1200);
    expect(rows.find((r) => r.x === 2042.5)?.plannedSolid).toBe(600);
    expect(rows.find((r) => r.x === 2042.5)?.plannedDashed).toBe(600);
    expect(rows.find((r) => r.x === 2043)?.plannedDashed).toBe(2400);
  });

  it('builds the mc channel from the representative run, path-CPI-deflated (not re-deflated by viewDeflator) in Today mode', () => {
    const drawdown: Record<'planned' | 'twr', DrawdownByMethodResult | null> = {
      planned: {
        years: [
          { year: 2041, balance: 100, withdrawn: 0, netNeed: 0, growth: 0, deposit: 0, depleted: false },
          { year: 2042, balance: 200, withdrawn: 0, netNeed: 0, growth: 0, deposit: 0, depleted: false },
        ],
        depletionYear: null,
        perMonthWithdrawal: new Float64Array(),
      },
      twr: null,
    };
    // Representative run: firstYear 2041 (pre-retirement), 2042 retirement year.
    const representativeRun = {
      firstYear: 2041,
      seed: 7,
      years: [
        { year: 2041, balance: 1_000, withdrawn: 0, netNeed: 0, growth: 50, deposit: 0, depleted: false },
        { year: 2042, balance: 900, withdrawn: 0, netNeed: 0, growth: 40, deposit: 0, depleted: false },
      ],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
      // Path's own real series — deliberately different from nominal so we can
      // prove the today-mode value comes from THESE, not `nominal * viewDeflator`.
      realBalanceByYear: [800, 700],
      realGrowthByYear: [42, 30],
      // Factor = realBalance / nominal balance, the identity the engine pins.
      realFactorByYear: [800 / 1_000, 700 / 900],
    };
    const rows = deflateChartRows({
      chartRows: [
        chartRow({ year: 2041, x: 2042, plannedSolid: 100 }),
        chartRow({ year: 2042, x: 2043, plannedDashed: 200 }),
      ],
      drawdownByMethod: drawdown,
      lastDeathYear: 2042,
      retirementYear: 2042,
      // A non-identity deflator — the mc channel must NOT pick this up in today mode.
      viewDeflator: () => 99,
      representativeRun,
      displayMode: 'today',
    });
    // 2041 < retirementYear (2042) → mc SOLID, real-deflated (800), NOT 1000*99.
    const y2041 = rows.find((r) => r.x === 2042);
    expect(y2041?.mcSolid).toBe(800);
    expect(y2041?.mcGrowth).toBe(42);
    // 2042 === retirementYear → mc DASHED carries the run's real balance (700).
    const y2042 = rows.find((r) => r.x === 2043);
    expect(y2042?.mcDashed).toBe(700);
  });
});
