/**
 * Integration tests for `useBalanceProjectionSwrData`
 * Mocks only `useBalanceProjectionData` (the raw
 * IndexedDB read) — `loadPageData`, `useBalanceProjectionViewModel` and this
 * new hook all run FOR REAL over hand-built canonical fixtures, so the
 * runner, the view model's deflators/drawdown resolution, and this hook's
 * own wiring are proven together rather than assumed. `runStressTest:
 * false` keeps every test off the Monte Carlo worker path — MC-basis math
 * (the pre-drawdown instant, degenerate states 4/6) is covered directly
 * against `buildSwrComparisonData` in `balance-projection-swr-derivation.test.ts`.
 */
import React, { useMemo } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ThemeProvider } from '../contexts/ThemeContext';
import { useBalanceProjectionViewModel } from './use-balance-projection-view-model';
import { useBalanceProjectionSwrData } from './use-balance-projection-swr-data';
import { loadPageData } from './balance-projection-page-pipeline';
import { buildTaxBurdenRows } from './balance-projection-burden-rows';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ProjectionMethod } from '../components/ProjectionChart';

const TODAY_YEAR = 2026;
const TODAY_MONTH = 5; // June (0-indexed)
const TODAY_DAY = 15;

let mockData: {
  scenarios: ScenarioAggregate[];
  selectedScenarioId: string | null;
  members: Aggregate<HouseholdMemberPayload>[];
  accounts: Aggregate<AccountPayload>[];
  balances: Aggregate<AccountBalancePayload>[];
  expenses: Aggregate<ExpensePayload>[];
  expenseCategories: never[];
  incomeStreams: Aggregate<IncomeStreamPayload>[];
  ssBenefits: Aggregate<SocialSecurityBenefitPayload>[];
  ready: boolean;
  error: string | null;
};
vi.mock('./use-balance-projection-data', () => ({
  useBalanceProjectionData: () => mockData,
}));

// `usePlanStressTestVm` calls `useMonteCarlo()` on mount regardless of
// `runStressTest` — stub the provider seam
// so mounting the vm never needs a
// real <MonteCarloProvider> and never reaches the worker/runner.
vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  useMonteCarlo: () => ({
    status: 'idle' as const,
    progressDone: 0,
    progressTotal: 0,
    result: null,
    error: null,
    run: vi.fn(async () => undefined),
    runToCompletion: vi.fn(async () => null),
    cancel: vi.fn(),
    setResult: vi.fn(),
  }),
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../workers/monte-carlo.worker.ts?worker', () => ({
  default: class {},
}));

function member(
  id: string,
  isPrimary: boolean,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: id,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function brokerage(id: string, ownerId: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

/** A PRE_TAX traditional IRA — withdrawing from it (unlike the POST_TAX
 *  brokerage `brokerage()` builds) generates ordinary-income federal tax, so
 *  a household holding one has a genuinely non-zero tax layer to assert
 *  against. */
function preTaxIra(id: string, ownerId: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type: 'RETIREMENT_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId,
      institution: 'X',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

function retirementStartExpense(amount: number): Aggregate<ExpensePayload> {
  return {
    id: 'e1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Living expenses',
      amount,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-general',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
    },
  } as unknown as Aggregate<ExpensePayload>;
}

function ssBenefit(memberId: string, pia = 0): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

function baseScenario(id: string, name: string, inflationRatePct = 0): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: inflationRatePct },
        lifeExpectancy: { primary: 90, secondary: 90 },
      },
    },
  };
}

function readyData(overrides: Partial<typeof mockData> = {}): typeof mockData {
  // Retirement date = birthdate + 67y = 2027-01-01 — AFTER "today"
  // (2026-06-15): the view model additionally nulls an already-past
  // retirement ISO, which a birth year landing exactly on "today" (as
  // `balance-projection-page-data.test.ts`'s lower-level `loadPageData`-only
  // fixture uses) would trip here.
  const primary = member('m1', true, TODAY_YEAR - 66);
  return {
    scenarios: [baseScenario('s', 'Base')],
    selectedScenarioId: 's',
    members: [primary],
    accounts: [brokerage('a1', 'm1')],
    balances: [balanceRow('a1', TODAY_YEAR - 1, 500_000)],
    expenses: [retirementStartExpense(2_000)],
    expenseCategories: [],
    incomeStreams: [],
    ssBenefits: [ssBenefit('m1')],
    ready: true,
    error: null,
    ...overrides,
  };
}

/** Mirrors the shape a page would mount: one `useBalanceProjectionViewModel`
 *  call, and this hook adapting it — never a second vm call. */
function useHarness(opts: {
  readonly displayMode?: 'today' | 'future';
  readonly activeMethod?: ProjectionMethod;
}) {
  const {
    scenarios,
    selectedScenarioId,
    members,
    accounts,
    balances,
    expenses,
    expenseCategories,
    incomeStreams,
    ssBenefits,
  } = mockData;
  const data = useMemo(() => {
    if (!selectedScenarioId) return null;
    return loadPageData({
      scenarios,
      selectedScenarioId,
      members,
      accounts,
      balances,
      expenses,
      incomeStreams,
      ssBenefits,
      categories: expenseCategories,
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
    });
  }, [scenarios, selectedScenarioId, members, accounts, balances, expenses, incomeStreams, ssBenefits, expenseCategories]);

  const vm = useBalanceProjectionViewModel({
    data,
    selectedScenarioId,
    canonicalBalances: balances,
    canonicalExpenses: expenses,
    expenseCategories,
    canonicalIncome: incomeStreams,
    ssBenefits,
    displayMode: opts.displayMode ?? 'today',
    cashflowGranularity: 'yearly',
    incomeBreakdownGranularity: 'yearly',
    activeMethod: opts.activeMethod ?? 'planned',
    setActiveMethod: () => {},
    activeMcBasis: null,
    setActiveMcBasis: () => {},
    runStressTest: false,
    nowYear: TODAY_YEAR,
    nowMonthIndex: TODAY_MONTH,
    nowDay: TODAY_DAY,
    resolvedTheme: 'light',
  });

  const swr = useBalanceProjectionSwrData({
    data,
    vm,
    selectedScenarioId,
    canonicalIncome: incomeStreams,
    canonicalExpenses: expenses,
    ssBenefits,
    displayMode: opts.displayMode ?? 'today',
    activeMethod: opts.activeMethod ?? 'planned',
    activeMcBasis: null,
    nowYear: TODAY_YEAR,
    nowMonthIndex: TODAY_MONTH,
  });

  return { vm, swr };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T00:00:00'));
  mockData = readyData();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useBalanceProjectionSwrData — end to end over the real pipeline', () => {
  it('resolves a positive portfolio and a non-empty row series for a fully configured household (Planned)', () => {
    const { result } = renderHook(() => useHarness({}), { wrapper });
    expect(result.current.swr.state).toBe('ok');
    expect(result.current.swr.bundle!.portfolioAtRetirement).toBeGreaterThan(0);
    expect(result.current.swr.bundle!.rows.length).toBeGreaterThan(0);
  });

  it('state "no-retirement-year" when no retirement age is configured', () => {
    const scenario = baseScenario('s', 'NoRetAge');
    mockData = readyData({
      scenarios: [{ ...scenario, payload: { ...scenario.payload, overrides: {} } }],
    });
    const { result } = renderHook(() => useHarness({}), { wrapper });
    expect(result.current.swr.state).toBe('no-retirement-year');
    expect(result.current.swr.bundle).toBeNull();
  });

  it('state "historical-unavailable" on Historical when no account has usable history', () => {
    // A single balance row (no prior-year history) leaves TWR unavailable —
    // the same guard the Basis selector's disabled Historical option reads.
    const { result } = renderHook(() => useHarness({ activeMethod: 'twr' }), { wrapper });
    expect(result.current.vm.enabledCalculatedMethods.has('twr')).toBe(false);
    expect(result.current.swr.state).toBe('historical-unavailable');
  });

  it('the tax layer matches the Taxes tab\'s OWN independent burden computation, and after-tax draw + tax sums to the SAME gross withdrawal `vm.incomeView` (the Cash flow band) reports for the anchor year', () => {
    // A PRE_TAX IRA (unlike the base fixture's POST_TAX-only brokerage)
    // generates real ordinary-income tax, so `row.tax` isn't plausibly 0 on
    // both sides of the comparison.
    // PRE_TAX-only (no brokerage): a tax-efficient withdrawal order drains
    // POST_TAX accounts first, which would leave the anchor year's tax at 0
    // for many years on a mixed portfolio — the IRA must fund the draw from
    // year one for `row.tax` to be genuinely non-zero here. A larger annual
    // draw ($72k) clears the (inflation-extrapolated) standard deduction.
    mockData = readyData({
      accounts: [preTaxIra('a1', 'm1')],
      balances: [balanceRow('a1', TODAY_YEAR - 1, 1_800_000)],
      expenses: [retirementStartExpense(6_000)],
    });
    const { result } = renderHook(() => useHarness({}), { wrapper });
    const { vm, swr } = result.current;
    expect(swr.state).toBe('ok');
    const anchorYear = swr.bundle!.anchorYear;
    const cfRow = vm.incomeView!.yearlyCashflowByYear.get(anchorYear)!;
    const row = swr.bundle!.rows.find((r) => r.year === anchorYear)!;
    expect(row.afterTaxDraw + row.tax).toBeCloseTo(cfRow.withdrawal, 6);

    // Independent recomputation: `buildTaxBurdenRows` derives the SAME
    // year's tax straight from `vm.resolvedDrawdown`'s raw *Cents fields
    // (federal + IRMAA − ACA PTC), never through the
    // `yearlyCashflowByYear` map this hook itself reads — so this fails if
    // the tax layer were sourced from the wrong field entirely, unlike an
    // identity check against the same map the builder read.
    const burdenRow = buildTaxBurdenRows({
      resolvedDrawdown: vm.resolvedDrawdown,
      basisDeflator: vm.basisDeflator,
      lastDeathFractional: vm.lastDeathFractional,
      isMcBasisActive: vm.isMcBasisActive,
    }).find((b) => b.year === anchorYear)!;
    expect(row.tax).toBeGreaterThan(0);
    expect(row.tax).toBeCloseTo(
      burdenRow.federalTax + burdenRow.irmaaSurcharge + burdenRow.acaPtcSubsidy,
      6,
    );
  });

  it('the hook\'s OWN second buildPageCashflowSeries call (sourceSplitByYear) agrees with `vm.incomeView`\'s own earned figure for the same year — proving the wiring, not just the arithmetic', () => {
    // pia > 0, but not so large SS alone fully covers the $2,000/mo
    // expense — a funded year where SS covers PART of spend, guaranteed/
    // other income no longer all-zero either way, and the portfolio still
    // draws (afterTaxDraw > 0).
    mockData = readyData({ ssBenefits: [ssBenefit('m1', 1_000)] });
    const { result } = renderHook(() => useHarness({}), { wrapper });
    const { vm, swr } = result.current;
    expect(swr.state).toBe('ok');
    const anchorYear = swr.bundle!.anchorYear;
    const row = swr.bundle!.rows.find((r) => r.year === anchorYear)!;
    const cfRow = vm.incomeView!.yearlyCashflowByYear.get(anchorYear)!;
    // Not a surplus year (draw > 0), so the coverage cap doesn't bind and the
    // hook's own split sums exactly to the vm's independently-built `earned`
    // stripe for the same year, at the same December-anchor deflator.
    expect(row.afterTaxDraw).toBeGreaterThan(0);
    expect(row.guaranteedIncome + row.otherIncome).toBeCloseTo(cfRow.earned, 6);
    expect(row.guaranteedIncome).toBeGreaterThan(0);
  });

  it('the future-dollars portfolio figure is the nominal runner figure and the today\'s-dollars figure is strictly smaller under non-zero inflation, with the anchor row\'s rule value differing between modes', () => {
    const scenario = baseScenario('s', 'Inflated', 3);
    mockData = readyData({ scenarios: [scenario] });
    const { result: todayResult } = renderHook(() => useHarness({ displayMode: 'today' }), { wrapper });
    const { result: futureResult } = renderHook(() => useHarness({ displayMode: 'future' }), { wrapper });
    expect(todayResult.current.swr.state).toBe('ok');
    expect(futureResult.current.swr.state).toBe('ok');
    const todayBundle = todayResult.current.swr.bundle!;
    const futureBundle = futureResult.current.swr.bundle!;
    const nominalNetFigure =
      futureResult.current.vm.drawdownByMethod?.planned?.netPortfolioAtRetirement;
    expect(nominalNetFigure).not.toBeUndefined();
    expect(futureBundle.portfolioAtRetirement).toBeCloseTo(nominalNetFigure!, 6);
    expect(todayBundle.portfolioAtRetirement).toBeLessThan(futureBundle.portfolioAtRetirement);
    const todayRow = todayBundle.rows.find((r) => r.year === todayBundle.anchorYear)!;
    const futureRow = futureBundle.rows.find((r) => r.year === futureBundle.anchorYear)!;
    expect(todayRow.fourPercentRuleValue).not.toBeNull();
    expect(futureRow.fourPercentRuleValue).not.toBeNull();
    expect(todayRow.fourPercentRuleValue).not.toBeCloseTo(futureRow.fourPercentRuleValue!, 2);
  });

  it('the portfolio figure is at most the plain summed total (never ADDS dollars back)', () => {
    const { result } = renderHook(() => useHarness({}), { wrapper });
    const { vm, swr } = result.current;
    expect(swr.state).toBe('ok');
    expect(swr.bundle!.portfolioAtRetirement).toBeLessThanOrEqual(
      vm.displayedTotals!.planned.total + 1e-6,
    );
  });
});
