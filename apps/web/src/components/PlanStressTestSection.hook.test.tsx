/** Hook-contract tests for `usePlanStressTestVm`. */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  usePlanStressTestVm,
  type DisplayMode,
} from './PlanStressTestSection';
import type { RunBalanceProjectionArgs } from '../lib/balance-projection-runner-types';
import type { CbpValidationResult } from '../lib/cbp-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import * as runner from '../lib/balance-projection-runner';
import type { MonteCarloInput } from '../lib/monte-carlo';
import { makeMonthlyExpenseBase } from '../lib/monte-carlo.test-helpers';

let mockResult: unknown = null;
// `runToCompletion` resolves with the same object it exposes as `result`, as the real provider does: the
// pair signature keys on that promise, not on `status`, which keeps serving the previous run's summary.
const runMock: Mock = vi.fn(async () => mockResult);
vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  useMonteCarlo: () => ({
    status: 'idle' as const,
    progressDone: 0,
    progressTotal: 0,
    result: mockResult,
    error: null,
    run: vi.fn(async () => undefined),
    runToCompletion: runMock,
    cancel: vi.fn(),
    setResult: vi.fn(),
  }),
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Each `createMcPool` call records a controllable pool so the forced-off sibling run and its disposal are observable.
interface MockPool {
  run: Mock;
  dispose: Mock;
  size: number;
}
const createdPools: MockPool[] = [];
let nextPoolReply: { kind: 'result'; summary: { successProbability: number } } | { kind: 'error'; message: string } | { kind: 'aborted' } = {
  kind: 'result',
  summary: { successProbability: 0.7 },
};

let poolRunNeverSettles = false;
const createMcPoolMock: Mock = vi.fn(() => {
  const pool: MockPool = {
    run: vi.fn(() =>
      poolRunNeverSettles ? new Promise(() => {}) : Promise.resolve(nextPoolReply),
    ),
    dispose: vi.fn(),
    size: 1,
  };
  createdPools.push(pool);
  return pool;
});
vi.mock('../monte-carlo/mc-worker-pool', () => ({
  createMcPool: (...args: unknown[]) => createMcPoolMock(...args),
}));
// Stub the worker import so the `?worker` import resolves under jsdom.
vi.mock('../workers/monte-carlo.worker.ts?worker', () => ({
  default: class {},
}));

// The sibling run is cache-first; mocking the cache keeps it off IndexedDB.
let nextCachedSibling: { successProbability: number } | null = null;
const getCachedMock: Mock = vi.fn(async () => nextCachedSibling);
const putCachedMock: Mock = vi.fn(async () => {});
vi.mock('../db/monte-carlo-cache', () => ({
  computeCacheKey: vi.fn(async () => 'sibling-test-key'),
  getCached: (...args: unknown[]) => getCachedMock(...args),
  putCached: (...args: unknown[]) => putCachedMock(...args),
}));

beforeEach(() => {
  // mockReset, not mockClear: a staged deferred completion must not leak into the next test.
  runMock.mockReset();
  runMock.mockImplementation(async () => mockResult);
  mockResult = null;
  createdPools.length = 0;
  createMcPoolMock.mockClear();
  nextPoolReply = { kind: 'result', summary: { successProbability: 0.7 } };
  poolRunNeverSettles = false;
  nextCachedSibling = null;
  getCachedMock.mockClear();
  putCachedMock.mockClear();
  vi.useRealTimers();
});

const okValidation: CbpValidationResult = {
  ok: true,
  unconfigured: [],
  annuityMissingStream: [],
  annuityDuplicateStream: [],
};

const failingValidation: CbpValidationResult = {
  ok: false,
  unconfigured: ['cbp-1'],
  annuityMissingStream: [],
  annuityDuplicateStream: [],
};

function stubLedger(portfolio: number): MonteCarloInput['accountMcLedger'] {
  const stepCount = (2086 - 2026 + 1) * 12;
  return [
    {
      id: 'stub-main',
      initialPre: 0,
      initialPost: portfolio,
      contribPre: new Float64Array(stepCount),
      contribPost: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
  ];
}

function buildRunArgs(
  overrides: Partial<RunBalanceProjectionArgs> = {},
): RunBalanceProjectionArgs {
  return {
    scenarioId: 'scn-1',
    scenarios: [],
    accounts: [],
    balances: [],
    members: [],
    ssBenefits: [],
    expenses: [],
    incomeStreams: [],
    todayYear: 2026,
    todayMonthIndex: 5,
    method: 'planned',
    ...overrides,
  };
}

describe('usePlanStressTestVm — hook contract', () => {
  it('CBP-unconfigured short-circuit: runner MC is not called, cbpValidation flows through', () => {
    const spy = vi.spyOn(runner, 'runBalanceProjectionMc');
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), failingValidation, 'today'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.cbpValidation).toEqual(failingValidation);

    expect(result.current.cbpValidation?.ok).toBe(false);
    spy.mockRestore();
  });

  it('null runArgs: VM reports hasNoAccounts, runner MC is not called', () => {
    const spy = vi.spyOn(runner, 'runBalanceProjectionMc');
    const { result } = renderHook(() =>
      usePlanStressTestVm(null, null, 'today'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.hasNoAccounts).toBe(true);
    spy.mockRestore();
  });

  it('Valid path: kicked run receives mcInput with PATH_COUNT 10_000 + signature-derived seed (not runner defaults)', async () => {
    const stubbedInput: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: stubLedger(500_000),
      annualContribution: 10_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(stubbedInput);

    vi.useFakeTimers();
    renderHook(
      (args: DisplayMode) =>
        usePlanStressTestVm(buildRunArgs(), okValidation, args),
      { initialProps: 'today' },
    );

    vi.advanceTimersByTime(900);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    const calledWith = runMock.mock.calls[0][0];

    expect(calledWith.pathCount).toBe(10_000);
    expect(calledWith.seed).not.toBe(1);
    expect(typeof calledWith.seed).toBe('number');
    expect(calledWith.portfolioToday).toBe(500_000);
    expect(calledWith.retirementYear).toBe(2046);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('recalculate() forces a run (force: true) with a fresh seed, bypassing the cache', async () => {
    const stubbedInput: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: stubLedger(500_000),
      annualContribution: 10_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(stubbedInput);

    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    vi.advanceTimersByTime(900);
    expect(runMock).toHaveBeenCalledTimes(1);
    const autoCall = runMock.mock.calls[0];
    const autoSeed = autoCall[0].seed;
    expect(autoCall[1]?.force).toBeUndefined();

    act(() => {
      result.current.recalculate();
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    const recalcCall = runMock.mock.calls[1];
    expect(recalcCall[0].pathCount).toBe(10_000);
    expect(recalcCall[1]?.force).toBe(true);
    expect(recalcCall[0].seed).not.toBe(autoSeed);

    act(() => {
      result.current.recalculate();
    });
    expect(runMock).toHaveBeenCalledTimes(3);
    expect(runMock.mock.calls[2][0].seed).not.toBe(recalcCall[0].seed);
    expect(runMock.mock.calls[2][1]?.force).toBe(true);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('hasNoAccounts is false when runArgs contains at least one active account', () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue({
        portfolioToday: 100,
        accountMcLedger: stubLedger(100),
        annualContribution: 0,
        firstYear: 2026,
        retirementYear: 2046,
        horizonYear: 2086,
        monthlyExpenseBase: makeMonthlyExpenseBase(0, (2086 - 2026 + 1) * 12),
        ssByYear: new Array<number>(2086 - 2026 + 1).fill(0),
        incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
        pathCount: 1000,
        seed: 1,
        strategyKind: 'taxEfficient',
        events: [],
      });
    const activeAccount: Aggregate<AccountPayload> = {
      id: 'acct-1',
      householdId: 'h',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: 'Brokerage',
        type: 'BROKERAGE',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'm1',
        institution: 'Vanguard',
        notes: '',
        planningReturnPct: 5,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
    const { result } = renderHook(() =>
      usePlanStressTestVm(
        buildRunArgs({ accounts: [activeAccount] }),
        okValidation,
        'today',
        {
          lifeMarkers: [],
          retirementFractionalYear: null,
          retirementLabel: null,
          accounts: [activeAccount],
          members: [],
          lastSurvivor: null,
        },
      ),
    );
    expect(result.current.hasNoAccounts).toBe(false);
    spy.mockRestore();
  });

  it('an unchanged plan re-assembled as a fresh object does not re-fire the primary run', async () => {
    const stable: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: stubLedger(500_000),
      annualContribution: 10_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };

    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => ({
        ...stable,
        accountMcLedger: stubLedger(500_000),
      }));

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      rerender({ runArgs: { ...buildRunArgs() } });
      vi.advanceTimersByTime(900);
    }
    expect(runMock.mock.calls.length).toBe(1);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('signature changes when mcInput shape changes even with same scenarioId', async () => {
    const inputA: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: stubLedger(500_000),
      annualContribution: 10_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const inputB: MonteCarloInput = {
      ...inputA,
      portfolioToday: 750_000,
      accountMcLedger: stubLedger(750_000),
    };

    let toggle = false;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => {
        toggle = !toggle;
        return toggle ? inputA : inputB;
      });

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    const firstRunCount = runMock.mock.calls.length;
    expect(firstRunCount).toBe(1);

    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('CBP flip from valid → unconfigured nulls vm.result + derived stats (no stale percentiles next to remediation banner) and runner MC is not re-called', () => {
    const fakeSummary = {
      engineVersion: 1,
      seed: 1,
      pathCount: 10_000,
      computedAt: 0,
      firstYear: 2026,
      horizonYears: 60,
      percentilesNominal: { p10: [1], p25: [2], p50: [3] },
      percentilesReal: { p10: [10], p25: [20], p50: [30] },
      successProbability: 0.92,
      medianDepletionYear: null,
      p10DepletionYear: null,
      p25DepletionYear: null,
      medianEndingBalanceNominal: 1_000_000,
      medianEndingBalanceReal: 800_000,
      p10EndingBalanceNominal: 200_000,
      p10EndingBalanceReal: 150_000,
      p25EndingBalanceNominal: 500_000,
      p25EndingBalanceReal: 400_000,
      failureYearHistogram: [],
      endingBalanceHistogramNominal: [],
      endingBalanceHistogramReal: [],
      plannedOverlay: [],
    };
    mockResult = fakeSummary;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue({
        portfolioToday: 100,
        accountMcLedger: stubLedger(100),
        annualContribution: 0,
        firstYear: 2026,
        retirementYear: 2046,
        horizonYear: 2086,
        monthlyExpenseBase: makeMonthlyExpenseBase(0, (2086 - 2026 + 1) * 12),
        ssByYear: new Array<number>(2086 - 2026 + 1).fill(0),
        incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
        pathCount: 1000,
        seed: 1,
        strategyKind: 'taxEfficient',
        events: [],
      });

    const { result: hook, rerender } = renderHook(
      (props: { cbp: CbpValidationResult }) =>
        usePlanStressTestVm(buildRunArgs(), props.cbp, 'today'),
      { initialProps: { cbp: okValidation } },
    );

    expect(hook.current.result).toBe(fakeSummary);
    expect(hook.current.successPct).toBe(92);
    expect(hook.current.endTypical).toBe(800_000);
    expect(hook.current.startTypical).not.toBeNull();
    const validRunnerCalls = spy.mock.calls.length;
    expect(validRunnerCalls).toBeGreaterThan(0);

    rerender({ cbp: failingValidation });
    expect(hook.current.result).toBeNull();
    expect(hook.current.successPct).toBeNull();
    expect(hook.current.endTypical).toBeNull();
    expect(hook.current.endPessimistic).toBeNull();
    expect(hook.current.endBadLuck).toBeNull();
    expect(hook.current.startTypical).toBeNull();
    expect(hook.current.startPessimistic).toBeNull();
    expect(hook.current.startBadLuck).toBeNull();
    expect(spy.mock.calls.length).toBe(validRunnerCalls);

    spy.mockRestore();
  });

  it('signature flips when per-account contribution routing changes (same annualContribution + events)', async () => {
    const stepCount = (2086 - 2026 + 1) * 12;
    const buildAccountA = (preMonthly: number): MonteCarloInput['accountMcLedger'][number] => {
      const contribPre = new Float64Array(stepCount);
      for (let i = 0; i < 240; i += 1) contribPre[i] = preMonthly;
      return {
        id: 'acct-a',
        initialPre: 250_000,
        initialPost: 0,
        contribPre,
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
      };
    };
    const buildAccountB = (preMonthly: number): MonteCarloInput['accountMcLedger'][number] => {
      const contribPre = new Float64Array(stepCount);
      for (let i = 0; i < 240; i += 1) contribPre[i] = preMonthly;
      return {
        id: 'acct-b',
        initialPre: 250_000,
        initialPost: 0,
        contribPre,
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
      };
    };
    const inputAllA: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: [buildAccountA(1000), buildAccountB(0)],
      annualContribution: 12_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const inputSplit: MonteCarloInput = {
      ...inputAllA,
      accountMcLedger: [buildAccountA(500), buildAccountB(500)],
    };
    let toggle = false;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => {
        toggle = !toggle;
        return toggle ? inputAllA : inputSplit;
      });

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    const firstRunCount = runMock.mock.calls.length;
    expect(firstRunCount).toBe(1);

    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('two same-length glide series whose old (sum,head,mid,tail) collapses produce different signatures and trigger a new run', async () => {
    const seriesA = [
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
      { stocksPct: 70, bondsPct: 20, cashPct: 10 }, // position 1: high stocks
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
      { stocksPct: 30, bondsPct: 40, cashPct: 30 }, // position 3: low stocks
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
    ];
    const seriesB = [
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
      { stocksPct: 30, bondsPct: 40, cashPct: 30 }, // position 1: low stocks (swapped)
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
      { stocksPct: 70, bondsPct: 20, cashPct: 10 }, // position 3: high stocks (swapped)
      { stocksPct: 50, bondsPct: 30, cashPct: 20 },
    ];

    const stepCount = (2086 - 2026 + 1) * 12;
    const buildLedgerWithShortSeries = (
      series: Array<{ stocksPct: number; bondsPct: number; cashPct: number }>,
    ): MonteCarloInput['accountMcLedger'] => [
      {
        id: 'stub-main',
        initialPre: 0,
        initialPost: 500_000,
        contribPre: new Float64Array(stepCount),
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 50, bondsPct: 30, cashPct: 20 },
        assetMixSeries: series,
        cbpPlanningReturnPct: null,
      },
    ];

    const inputA: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: buildLedgerWithShortSeries(seriesA),
      annualContribution: 12_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const inputB: MonteCarloInput = {
      ...inputA,
      accountMcLedger: buildLedgerWithShortSeries(seriesB),
    };

    let toggle = false;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => {
        toggle = !toggle;
        return toggle ? inputA : inputB;
      });

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    const firstRunCount = runMock.mock.calls.length;
    expect(firstRunCount).toBe(1);

    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('two different same-sum assetMixSeries produce different signatures and trigger a new run', async () => {
    const stepCount = (2086 - 2026 + 1) * 12;

    const seriesAscending = Array.from({ length: stepCount }, (_, i) => ({
      stocksPct: (i / stepCount) * 100,
      bondsPct: 0,
      cashPct: 100 - (i / stepCount) * 100,
    }));
    const seriesDescending = Array.from({ length: stepCount }, (_, i) => ({
      stocksPct: 100 - (i / stepCount) * 100,
      bondsPct: 0,
      cashPct: (i / stepCount) * 100,
    }));

    const buildLedgerWithSeries = (
      series: Array<{ stocksPct: number; bondsPct: number; cashPct: number }>,
    ): MonteCarloInput['accountMcLedger'] => [
      {
        id: 'stub-main',
        initialPre: 0,
        initialPost: 500_000,
        contribPre: new Float64Array(stepCount),
        contribPost: new Float64Array(stepCount),
        deposit: new Float64Array(stepCount),
        assetMix: { stocksPct: 50, bondsPct: 40, cashPct: 10 },
        assetMixSeries: series,
        cbpPlanningReturnPct: null,
      },
    ];

    const inputA: MonteCarloInput = {
      portfolioToday: 500_000,
      accountMcLedger: buildLedgerWithSeries(seriesAscending),
      annualContribution: 12_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, (2086 - 2026 + 1) * 12),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
    };
    const inputB: MonteCarloInput = {
      ...inputA,
      accountMcLedger: buildLedgerWithSeries(seriesDescending),
    };

    let toggle = false;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => {
        toggle = !toggle;
        return toggle ? inputA : inputB;
      });

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    const firstRunCount = runMock.mock.calls.length;
    expect(firstRunCount).toBe(1);

    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });
});

describe('usePlanStressTestVm — guardrail with/without comparison', () => {
  const DRAWDOWN_YEARS = 2086 - 2046 + 1;
  const STEP_COUNT = (2086 - 2026 + 1) * 12;

  function guardrailInput(enabled: boolean): MonteCarloInput {
    return {
      portfolioToday: 500_000,
      accountMcLedger: stubLedger(500_000),
      annualContribution: 10_000,
      firstYear: 2026,
      retirementYear: 2046,
      horizonYear: 2086,
      monthlyExpenseBase: makeMonthlyExpenseBase(50_000, STEP_COUNT),
      ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
        2026 + i >= 2046 ? 30_000 : 0,
      ),
      incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
      pathCount: 1000,
      seed: 1,
      strategyKind: 'taxEfficient',
      events: [],
      downturnGuardrails: {
        enabled,
        lowerBandPct: 85,
        upperBandPct: 115,
        stepPct: 10,
        maxRaisePct: 120,
      },
      guardrailBaselineRealNetNeedByYear: new Array<number>(DRAWDOWN_YEARS).fill(20_000),
      guardrailBaselineTotalRealByYear: new Array<number>(DRAWDOWN_YEARS).fill(50_000),
      guardrailEssentialRealByYear: new Array<number>(DRAWDOWN_YEARS).fill(25_000),
      guardrailEffectiveTaxRate: 0.15,
    };
  }

  function primarySummary(overrides: Record<string, unknown> = {}): unknown {
    return {
      engineVersion: 54,
      seed: 4242,
      pathCount: 10_000,
      computedAt: 0,
      firstYear: 2026,
      horizonYears: 60,
      percentilesNominal: { p10: [1], p25: [2], p50: [3] },
      percentilesReal: { p10: [10], p25: [20], p50: [30] },
      successProbability: 0.9,
      medianDepletionYear: null,
      p10DepletionYear: null,
      p25DepletionYear: null,
      medianEndingBalanceNominal: 0,
      medianEndingBalanceReal: 0,
      p10EndingBalanceNominal: 0,
      p10EndingBalanceReal: 0,
      p25EndingBalanceNominal: 0,
      p25EndingBalanceReal: 0,
      failureYearHistogram: [],
      endingBalanceHistogramNominal: [],
      endingBalanceHistogramReal: [],
      plannedOverlay: [],
      ...overrides,
    };
  }

  it('guardrails disabled → guardrailComparison is undefined + no sibling pool created', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(false));
    mockResult = primarySummary();
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.guardrailComparison).toBeUndefined();
    expect(createMcPoolMock).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → the forced-off sibling starts once (dedupe) and forces enabled:false with the primary seed', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 4242, successProbability: 0.9 });
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.8 } };
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    const pool = createdPools[0];
    expect(pool.run).toHaveBeenCalledTimes(1);
    const forcedOff = pool.run.mock.calls[0][0] as MonteCarloInput;

    expect(forcedOff.downturnGuardrails?.enabled).toBe(false);
    expect(forcedOff.seed).toBe(4242);
    expect(forcedOff.pathCount).toBe(10_000);

    rerender();
    await act(async () => {});
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(pool.run).toHaveBeenCalledTimes(1);

    expect(result.current.result).toBe(mockResult);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → a cache hit surfaces the without-run without creating a worker pool (no recompute on re-select)', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 4242, successProbability: 0.9 });
    nextCachedSibling = { successProbability: 0.55 };
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(getCachedMock).toHaveBeenCalled();
    expect(createMcPoolMock).not.toHaveBeenCalled();
    expect(putCachedMock).not.toHaveBeenCalled();
    const cmp = result.current.guardrailComparison!;
    expect(cmp.state).toBe('ready');
    expect(cmp.withPct).toBeCloseTo(0.9, 6);
    expect(cmp.withoutPct).toBeCloseTo(0.55, 6);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → sibling ready surfaces with/without/delta; a meaningful delta reads state ready', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ successProbability: 0.9 });
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.5 } };
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const cmp = result.current.guardrailComparison!;
    expect(cmp.state).toBe('ready');
    expect(cmp.withPct).toBeCloseTo(0.9, 6);
    expect(cmp.withoutPct).toBeCloseTo(0.5, 6);
    expect(cmp.deltaPct).toBeCloseTo(0.4, 6);
    expect(cmp.se).not.toBeNull();
    expect(Math.abs(cmp.deltaPct!)).toBeGreaterThan(cmp.se!);

    expect(putCachedMock).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → a pending sibling surfaces state=pending', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary();
    poolRunNeverSettles = true; // sibling never resolves → stays pending
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(result.current.guardrailComparison?.state).toBe('pending');
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → an mcInput identity churn (same signature/seed) does not re-fire the sibling or abort the in-flight run', async () => {
    // A fresh input object each render churns mcInput identity while the content signature and primary
    // seed stay fixed; the effect must key on those, so the in-flight run is never disposed or duplicated.
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => guardrailInput(true));
    mockResult = primarySummary({ seed: 4242, successProbability: 0.9 });
    poolRunNeverSettles = true;
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(result.current.guardrailComparison?.state).toBe('pending');
    const firstPool = createdPools[0];

    rerender();
    await act(async () => {});
    rerender();
    await act(async () => {});

    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(firstPool.dispose).not.toHaveBeenCalled();
    expect(result.current.guardrailComparison?.state).toBe('pending');
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → a worker error surfaces state=error', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary();
    nextPoolReply = { kind: 'error', message: 'boom' };
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.guardrailComparison?.state).toBe('error');
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('a request still pending through cache lookup AND worker execution withholds the pair signature while the OLD summary is on screen', async () => {
    // Settlement is this request completing, not the requested signature: the provider serves the previous
    // summary through its cache and worker window.
    const inputA = guardrailInput(true);
    const inputB: MonteCarloInput = {
      ...guardrailInput(true),
      portfolioToday: 750_000,
      accountMcLedger: stubLedger(750_000),
    };
    let currentInput = inputA;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => currentInput);

    const summaryA = primarySummary({ seed: 111 });
    const summaryB = primarySummary({ seed: 222 });
    mockResult = summaryA;

    const deferred: { settle: ((summary: unknown) => void) | null } = {
      settle: null,
    };
    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.settle = resolve;
        }),
    );

    vi.useFakeTimers();
    const { result: hook, rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(hook.current.stressPairSignature).toBeNull();
    expect(deferred.settle).not.toBeNull();
    await act(async () => {
      deferred.settle?.(summaryA);
    });
    await act(async () => {});
    const pairA = hook.current.stressPairSignature;
    expect(pairA).not.toBeNull();
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    createMcPoolMock.mockClear();

    currentInput = inputB;
    rerender({ runArgs: { ...buildRunArgs() } });
    expect(hook.current.stressPairSignature).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(hook.current.result).toBe(summaryA);
    expect(hook.current.stressPairSignature).toBeNull();
    expect(createMcPoolMock).not.toHaveBeenCalled();

    await act(async () => {});
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBeNull();
    expect(createMcPoolMock).not.toHaveBeenCalled();

    mockResult = summaryB;
    await act(async () => {
      deferred.settle?.(summaryB);
    });
    await act(async () => {});
    expect(hook.current.result).toBe(summaryB);
    expect(hook.current.stressPairSignature).not.toBeNull();
    expect(hook.current.stressPairSignature).not.toBe(pairA);
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    vi.useRealTimers();
  });

  function deferredRequest(): {
    settle: ((s: unknown) => void) | null;
    fail: ((e: unknown) => void) | null;
  } {
    return { settle: null, fail: null };
  }

  it('a Recalculate the user cancels keeps the settled pair and the guardrail comparison (the summary on screen is still the current plan’s)', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 111, successProbability: 0.9 });
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.5 } };
    const deferred = deferredRequest();
    vi.useFakeTimers();
    const { result: hook } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const pairA = hook.current.stressPairSignature;
    expect(pairA).not.toBeNull();
    expect(hook.current.guardrailComparison?.state).toBe('ready');
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);

    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.settle = resolve;
        }),
    );
    await act(async () => {
      hook.current.recalculate();
    });
    expect(runMock).toHaveBeenCalledTimes(2);

    expect(hook.current.stressPairSignature).toBe(pairA);

    await act(async () => {
      deferred.settle?.(null);
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBe(pairA);
    expect(hook.current.guardrailComparison?.state).toBe('ready');

    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('a Recalculate whose worker fails keeps the settled pair (the error banner is the surface, not a stuck comparison)', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 111, successProbability: 0.9 });
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.5 } };
    const deferred = deferredRequest();
    vi.useFakeTimers();
    const { result: hook } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const pairA = hook.current.stressPairSignature;
    expect(pairA).not.toBeNull();
    expect(hook.current.guardrailComparison?.state).toBe('ready');

    runMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          deferred.fail = reject;
        }),
    );
    await act(async () => {
      hook.current.recalculate();
    });
    await act(async () => {
      deferred.fail?.(new Error('worker exploded'));
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBe(pairA);
    expect(hook.current.guardrailComparison?.state).toBe('ready');
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('a cancelled run for an edited plan withholds the pair and is not restarted by the debounce', async () => {
    const inputA = guardrailInput(true);
    const inputB: MonteCarloInput = {
      ...guardrailInput(true),
      portfolioToday: 750_000,
      accountMcLedger: stubLedger(750_000),
    };
    let currentInput = inputA;
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockImplementation(() => currentInput);
    mockResult = primarySummary({ seed: 111, successProbability: 0.9 });
    const deferred = deferredRequest();
    vi.useFakeTimers();
    const { result: hook, rerender } = renderHook(
      (props: { runArgs: RunBalanceProjectionArgs }) =>
        usePlanStressTestVm(props.runArgs, okValidation, 'today'),
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(hook.current.stressPairSignature).not.toBeNull();

    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.settle = resolve;
        }),
    );
    expect(hook.current.runPending).toBe(false);
    currentInput = inputB;
    rerender({ runArgs: { ...buildRunArgs() } });
    expect(hook.current.runPending).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(hook.current.runPending).toBe(true);
    await act(async () => {
      deferred.settle?.(null);
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBeNull();

    expect(hook.current.runPending).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('two rapid Recalculates — only the newest request may settle the pair', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 111, successProbability: 0.9 });
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.5 } };
    vi.useFakeTimers();
    const { result: hook } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    const pairA = hook.current.stressPairSignature;
    expect(pairA).not.toBeNull();

    const older = deferredRequest();
    const newer = deferredRequest();
    let kicked = 0;
    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          kicked += 1;
          if (kicked === 1) older.settle = resolve;
          else newer.settle = resolve;
        }),
    );
    await act(async () => {
      hook.current.recalculate();
    });
    await act(async () => {
      hook.current.recalculate();
    });
    expect(kicked).toBe(2);

    const summaryNew = primarySummary({ seed: 333, successProbability: 0.6 });
    mockResult = summaryNew;
    await act(async () => {
      newer.settle?.(summaryNew);
    });
    await act(async () => {});
    const pairNew = hook.current.stressPairSignature;
    expect(hook.current.result).toBe(summaryNew);
    expect(pairNew).not.toBeNull();
    expect(pairNew).not.toBe(pairA);

    await act(async () => {
      older.settle?.(primarySummary({ seed: 222, successProbability: 0.2 }));
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBe(pairNew);
    expect(hook.current.guardrailComparison?.state).toBe('ready');

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails enabled → unmount disposes the sibling worker pool (no leaked worker)', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary();
    poolRunNeverSettles = true;
    vi.useFakeTimers();
    const { unmount } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    const pool = createdPools[0];
    expect(pool.dispose).not.toHaveBeenCalled();
    unmount();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    vi.useRealTimers();
  });
});

describe('usePlanStressTestVm — longevity anchor', () => {
  const anchorOf = (birthdates: ReadonlyArray<string | undefined>): number | null => {
    const members = birthdates.map((birthdate, i) => ({
      id: `m${i}`,
      payload: { birthdate },
    })) as unknown as Array<Aggregate<HouseholdMemberPayload>>;
    const { result } = renderHook(() =>
      usePlanStressTestVm(null, null, 'today', {
        lifeMarkers: [],
        retirementFractionalYear: null,
        retirementLabel: null,
        accounts: [],
        members,
        lastSurvivor: null,
      }),
    );
    return result.current.longestLivedBirthYear;
  };

  it('anchors on the youngest member, who is the one still alive at the end', () => {
    expect(anchorOf(['1958-04-02', '1971-11-30', '1965-01-01'])).toBe(1971);
  });

  // `9999-12-31` would win the max under a four-digit prefix parse and push the cap thousands of years out.
  it.each(['9999-12-31', '1968-99-99', '1968-02-30', '1967-02-29', '1968', '1968-11', '1968-11-3', '19-70-01', 'not-a-date'])(
    'ignores the malformed birthdate %s while a usable one remains',
    (malformed) => {
      expect(anchorOf(['1955-04-02', malformed])).toBe(1955);
    },
  );

  it('withholds an anchor when no birthdate is usable', () => {
    expect(anchorOf([])).toBeNull();
    expect(anchorOf(['', undefined, 'unknown', '1968', '9999-12-31', '1968-02-30'])).toBeNull();
  });
});
