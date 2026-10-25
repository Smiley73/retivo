// View-model `categoryMeta` stability across the Today's/Future toggle: the active-category set (and legend membership) comes only from the display-basis-independent `categoryMonthlyNominal`, never the display-dependent `*Base` maps, so flipping `displayMode` must leave `categoryMeta` ids identical.
// Drives `useBalanceProjectionViewModel` with a mocked `buildPageCashflowSeries` whose nominal and base maps carry different active id sets.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ThemeProvider } from '../contexts/ThemeContext';
import type { DisplayMode } from '../lib/view-deflator';
import type { ExpenseCategoryMonthlyPoint } from '../lib/expense-projection';

// The view model reads chart tokens via `useChartColors()`, which needs the ThemeProvider context.
function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// The CBP validation memo runs real scenario-chain resolution before the `categoryMeta` memo; stub it so the minimal `data` stub need not carry full override payloads.
vi.mock('../lib/cbp-resolution', () => ({
  validateCbpResolution: () => ({
    ok: true,
    unconfigured: [],
    annuityMissingStream: [],
    annuityDuplicateStream: [],
  }),
}));

// Stub the MC stress vm so the hook never runs the real worker.
vi.mock('../components/PlanStressTestSection', () => ({
  usePlanStressTestVm: () => ({
    result: null,
    replayPath: vi.fn(),
    hasNoAccounts: false,
    isRunning: false,
    isStale: false,
    error: null,
  }),
}));

// Mock the cashflow-series builder to control the per-category maps: `categoryMonthlyNominal` (the active-id source) carries A + B, `categoryMonthlyBase` a different set (B + C), so sourcing the active set from the base maps would make the modes diverge.
const CAT_A = 'cat-a';
const CAT_B = 'cat-b';
const CAT_C = 'cat-c';

function catMonth(by: Record<string, number>): ExpenseCategoryMonthlyPoint {
  return {
    fractionalYear: 2031,
    year: 2031,
    month0: 0,
    byCategoryId: by,
    total: Object.values(by).reduce((a, b) => a + b, 0),
    recurringByCategoryId: by,
    oneOffByCategoryId: {},
  };
}

vi.mock('./balance-projection-page-cashflow', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./balance-projection-page-cashflow')>();
  return {
    ...actual,
    buildPageCashflowSeries: vi.fn(() => ({
      fromYear: 2031,
      chartEndYear: 2031,
      drawdownEndYear: 2031,
      depositsByYear: new Map(),
      sourceSplitByYear: new Map(),
      extendedExpenseRows: [],
      monthlySeries: null,
      categoryMonthlyNominal: [catMonth({ [CAT_A]: 100, [CAT_B]: 200 })],
      categoryYearlyNominal: [],
      categoryMonthlyBase: [catMonth({ [CAT_B]: 200, [CAT_C]: 300 })],
      categoryYearlyBase: [],
    })),
  };
});

import { useBalanceProjectionViewModel } from './use-balance-projection-view-model';
import type { PipelineData } from './balance-projection-page-data';

// Minimal `PipelineData` stub: a primary member with a future retirement ISO so `cashflowChartEndYear` resolves (gating the cashflowSeries memo), and no death markers (`lastDeathFractional` null, so chartEndYear == retirement year).
function makeData(): PipelineData {
  const primaryMember = {
    id: 'm1',
    payload: {
      isPrimary: true,
      firstName: 'Primary',
      birthdate: '1980-01-01',
    },
  };
  return {
    // One self-rooted scenario so `scenarioChain('s', …)` resolves (the CBP validation memo walks it; with empty accounts/streams it is a no-op).
    scenarios: [{ id: 's', payload: { parentScenarioId: null } }],
    selectedScenarioId: 's',
    resolved: {},
    members: [primaryMember],
    primaryMember,
    memberRetirementById: new Map([['m1', '2031-06-01']]),
    rows: [],
    accounts: [],
    pageResult: {
      planned: null,
      twr: null,
      sharedCtx: { methodAvailable: false, fallbackAccounts: [] },
    },
  } as unknown as PipelineData;
}

function expenseCategories() {
  return [
    { id: CAT_A, payload: { name: 'Alpha' } },
    { id: CAT_B, payload: { name: 'Bravo' } },
    { id: CAT_C, payload: { name: 'Charlie' } },
  ] as unknown as Parameters<
    typeof useBalanceProjectionViewModel
  >[0]['expenseCategories'];
}

const baseInput = {
  data: makeData(),
  selectedScenarioId: 's',
  canonicalBalances: [],
  canonicalExpenses: [],
  expenseCategories: expenseCategories(),
  canonicalIncome: [],
  ssBenefits: [],
  cashflowGranularity: 'yearly' as const,
  incomeBreakdownGranularity: 'yearly' as const,
  activeMethod: 'planned' as const,
  setActiveMethod: () => {},
  activeMcBasis: null,
  setActiveMcBasis: () => {},
  nowYear: 2026,
  nowMonthIndex: 4,
  nowDay: 1,
  resolvedTheme: 'light' as const,
};

function categoryIds(displayMode: DisplayMode): string[] {
  const { result } = renderHook(
    () => useBalanceProjectionViewModel({ ...baseInput, displayMode }),
    { wrapper },
  );
  return result.current.categoryMeta.map((c) => c.id);
}

describe('useBalanceProjectionViewModel — categoryMeta stable across displayMode', () => {
  it('derives the active set from categoryMonthlyNominal regardless of displayMode', () => {
    const todayIds = categoryIds('today');
    const futureIds = categoryIds('future');

    // The active set is the nominal map's ids (A + B), sorted by name; the base map's distinct set (B + C) is never read.
    expect(futureIds).toEqual([CAT_A, CAT_B]);
    expect(todayIds).toEqual([CAT_A, CAT_B]);
    expect(todayIds).toEqual(futureIds);
    expect(todayIds).not.toContain(CAT_C);
    expect(futureIds).not.toContain(CAT_C);
  });
});
