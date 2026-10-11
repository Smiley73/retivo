/**
 * Hook-contract tests for `usePlanStressTestVm`. Covers the
 * MC input-builder unification, the prop boundary (no legacy
 * `bundle` prop), the call-site override (`pathCount: 10_000` +
 * signature-derived seed stamped on top of the runner's `{1000, 1}`
 * defaults), and the CBP-unconfigured short-circuit (banner renders +
 * runner MC NOT called).
 *
 * The MonteCarloProvider is mocked so we can introspect the
 * `MonteCarloInput` handed to `useMonteCarlo().run()` without spinning
 * up a worker.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  longestLivedBirthYearOf,
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

// Tests can inject a fake `result` to simulate a prior
// successful MC run still held in the provider after the input flips.
// Default is `null`.
let mockResult: unknown = null;
// Mock the MonteCarloProvider so we can inspect the input passed to
// runToCompletion(). The hook drives the provider through `runToCompletion`
// because that promise IS the request's completion signal — the pair identity
// the market-stress comparison keys on must not be inferred from the shared
// `status` / `result`, which keep serving the PREVIOUS run's summary through
// the whole cache-lookup + worker window. The mock therefore resolves with the
// same object it exposes as `result`, which is what the real provider does
// (one worker reply feeds both).
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

// Mock the worker pool so the forced-off guardrail sibling run can be
// driven deterministically (no real Worker) and its lifecycle asserted. Each
// `createMcPool` call records a controllable pool: `run()` resolves with the
// staged reply; `dispose()` is a spy so unmount / input-change cleanup is
// observable.
interface MockPool {
  run: Mock;
  dispose: Mock;
  size: number;
}
const createdPools: MockPool[] = [];
// The reply the NEXT pool.run() resolves with; tests stage it before the run.
let nextPoolReply: { kind: 'result'; summary: { successProbability: number } } | { kind: 'error'; message: string } | { kind: 'aborted' } = {
  kind: 'result',
  summary: { successProbability: 0.7 },
};
// When true, pool.run() returns a never-settling promise so the sibling stays
// in the `pending` state (for the pending-state assertion).
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
// The worker constructor is imported for the pool factory; stub it so the
// `?worker` import resolves under jsdom (the mocked pool never calls it).
vi.mock('../workers/monte-carlo.worker.ts?worker', () => ({
  default: class {},
}));

// The forced-off sibling run is now cache-first (mirrors the primary run). Mock
// the MC cache so it never touches IndexedDB: `getCached` returns
// `nextCachedSibling` (null = miss → the pool runs; a summary = hit → the pool
// is NOT created), `computeCacheKey` is a stable stub, `putCached` a spy.
let nextCachedSibling: { successProbability: number } | null = null;
const getCachedMock: Mock = vi.fn(async () => nextCachedSibling);
const putCachedMock: Mock = vi.fn(async () => {});
vi.mock('../db/monte-carlo-cache', () => ({
  computeCacheKey: vi.fn(async () => 'sibling-test-key'),
  getCached: (...args: unknown[]) => getCachedMock(...args),
  putCached: (...args: unknown[]) => putCachedMock(...args),
}));

beforeEach(() => {
  // `mockReset` (not `mockClear`) so a test that stages a deferred completion
  // cannot leak its implementation into the next one.
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

/** Build a minimal per-account MC ledger matching the legacy
 *  single-blended-mix stub fixtures (one account, 70/25/5). The hook
 *  tests don't exercise per-account math directly — they just need a
 *  ledger that conforms to the new `MonteCarloInput` shape. */
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

// Minimal runArgs literal. Empty aggregates short-circuit the runner —
// we don't need a fully-populated household here, only enough to drive
// the cache-key derivation + the early-return paths. The CBP-OK path
// uses `vi.spyOn(runner, 'runBalanceProjectionMc')` to stub the runner
// return without exercising the real pipeline.
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
  it('CBP-unconfigured short-circuit: runner MC is NOT called, cbpValidation flows through', () => {
    const spy = vi.spyOn(runner, 'runBalanceProjectionMc');
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), failingValidation, 'today'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.cbpValidation).toEqual(failingValidation);
    // Sanity: the VM exposes the validation so PlanStressTestChart can
    // render the remediation banner.
    expect(result.current.cbpValidation?.ok).toBe(false);
    spy.mockRestore();
  });

  it('null runArgs: VM reports hasNoAccounts, runner MC is NOT called', () => {
    const spy = vi.spyOn(runner, 'runBalanceProjectionMc');
    const { result } = renderHook(() =>
      usePlanStressTestVm(null, null, 'today'),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.hasNoAccounts).toBe(true);
    spy.mockRestore();
  });

  it('Valid path: kicked run receives mcInput with PATH_COUNT 10_000 + signature-derived seed (NOT runner defaults)', async () => {
    // Stub runBalanceProjectionMc to return a minimal MonteCarloInput
    // with the runner-default `{ pathCount: 1000, seed: 1 }` so we can
    // assert the call site overrides them.
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

    // The effect kicks `run()` after an 800ms debounce.
    vi.advanceTimersByTime(900);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    const calledWith = runMock.mock.calls[0][0];
    // The call site stamps PATH_COUNT (10_000) + a derived seed
    // on top of the runner's `{1000, 1}` defaults.
    expect(calledWith.pathCount).toBe(10_000);
    expect(calledWith.seed).not.toBe(1);
    expect(typeof calledWith.seed).toBe('number');
    // Other fields preserved verbatim from the runner.
    expect(calledWith.portfolioToday).toBe(500_000);
    expect(calledWith.retirementYear).toBe(2046);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('recalculate() forces a run (force: true) with a fresh seed, bypassing the cache', async () => {
    // Regression for the manual "Recalculate" control: vm.recalculate()
    // must call run() with `{ force: true }` (skips the cache
    // short-circuit) and a seed distinct from the deterministic auto-run
    // seed so the user gets a genuinely new sample.
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
    // Let the debounced auto-run fire so we can compare its seed.
    vi.advanceTimersByTime(900);
    expect(runMock).toHaveBeenCalledTimes(1);
    const autoCall = runMock.mock.calls[0];
    const autoSeed = autoCall[0].seed;
    // Auto-run does NOT force.
    expect(autoCall[1]?.force).toBeUndefined();

    // Force a manual recalc.
    act(() => {
      result.current.recalculate();
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    const recalcCall = runMock.mock.calls[1];
    expect(recalcCall[0].pathCount).toBe(10_000);
    expect(recalcCall[1]?.force).toBe(true);
    // Fresh sample: the seed differs from the deterministic auto-run seed.
    expect(recalcCall[0].seed).not.toBe(autoSeed);

    // A second recalc yields yet another distinct seed (monotonic salt).
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
    // Regression test: `hasNoAccounts` must read `a.payload.active`.
    // `isActive` does not exist on `AccountPayload`, so reading it always
    // evaluated to `undefined` — the MC card never rendered for normal
    // households, every one of which tripped the empty-state branch.
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

  it('an unchanged plan re-assembled as a fresh object does NOT re-fire the primary run', async () => {
    // The other half of the `currentSignature` contract, and the direction that
    // costs real work when it regresses: the shape-change test below proves a
    // genuine shape change DOES re-run, but nothing else here pins that pure identity churn
    // does NOT. `mcInput` is rebuilt on every `runArgs` reference change, so an
    // ordinary re-render hands the effect a brand-new object with identical
    // CONTENT; if the signature ever keyed off identity rather than content,
    // every such re-render would launch another 10,000-path run.
    //
    // This was previously covered only incidentally, by the first half of a
    // test that also drove a base investment cost through the signature. That
    // setting is gone, so the assertion is restated here on its own terms.
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
    // A FRESH object each call, structurally identical — including a rebuilt
    // ledger, so no array is shared by reference between assemblies.
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

    // Three rounds of identity churn on an unchanged plan: still one run.
    for (let i = 0; i < 3; i += 1) {
      rerender({ runArgs: { ...buildRunArgs() } });
      vi.advanceTimersByTime(900);
    }
    expect(runMock.mock.calls.length).toBe(1);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('signature changes when mcInput shape changes even with same scenarioId', async () => {
    // Regression test: `currentSignature` must not derive from
    // `runArgs.scenarioId` alone — same-scenario edits (balance /
    // expense / income / claim-age) reshape `mcInput` but leave
    // `scenarioId` fixed, so a stale cached run would survive the change.
    // `hashMcInput` hashes the built input so a balance change
    // produces a new signature → the effect kicks a fresh run.
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
    // Each call to `runBalanceProjectionMc` returns the next input
    // shape. React's useMemo rebuilds mcInput on each runArgs reference
    // change, so passing a fresh args object triggers a new build.
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
      // Fresh args ref each render via spread.
      { initialProps: { runArgs: { ...buildRunArgs() } } },
    );
    vi.advanceTimersByTime(900);
    const firstRunCount = runMock.mock.calls.length;
    expect(firstRunCount).toBe(1);

    // Fresh args reference (mock returns inputB this time) — the cache
    // signature MUST flip because the hashed mcInput now reflects the
    // different portfolioToday, so the effect re-kicks the run.
    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('CBP flip from valid → unconfigured nulls vm.result + derived stats (no stale percentiles next to remediation banner) and runner MC is NOT re-called', () => {
    // Regression test: when CBP flips valid → invalid the
    // hook nulls `mcInput`, but the prior successful `useMonteCarlo()`
    // result would leak through to the success / at-retirement /
    // at-horizon cards (those cards don't gate on the remediation
    // banner). The hook locally nulls `result` when `mcInput === null`
    // and keeps the cache signature non-null so `isStale` compares
    // cleanly against the last successful signature.
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

    // Valid path: the prior successful MC result threads through.
    expect(hook.current.result).toBe(fakeSummary);
    expect(hook.current.successPct).toBe(92);
    expect(hook.current.endTypical).toBe(800_000);
    expect(hook.current.startTypical).not.toBeNull();
    const validRunnerCalls = spy.mock.calls.length;
    expect(validRunnerCalls).toBeGreaterThan(0);

    // Flip CBP to failing — the prior successful percentiles MUST NOT
    // surface next to the remediation banner, and the runner MC MUST
    // NOT be invoked again (the chart side renders the banner only;
    // the cards must read `—`).
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
    // Regression test: `hashMcInput` must cover the Float64Array
    // contents on each ledger entry. Otherwise two scenarios
    // with identical `annualContribution` + events but DIFFERENT
    // per-account contribution routing produce the same signature —
    // stale cached MC results would survive the change. The
    // ledger-entry fingerprint hashes (length, sum, head, mid, tail)
    // of each `contribPre` / `contribPost` / `deposit` array so a
    // change to per-account routing flips the signature even when
    // aggregate totals stay constant.
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
    // Routing 1: $1000/mo all to A, $0 to B.
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
    // Routing 2: $500/mo to each — same aggregate annualContribution.
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

    // Same aggregate annualContribution + events; only per-account
    // contribution routing differs. Pre-fix this would not have
    // flipped the signature; post-fix it does, so the effect rebuilds
    // + re-kicks the run.
    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('CBP flip from valid → unconfigured: runner MC stops being called', () => {
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

    const { rerender } = renderHook(
      (props: {
        cbp: CbpValidationResult;
      }) => usePlanStressTestVm(buildRunArgs(), props.cbp, 'today'),
      { initialProps: { cbp: okValidation } },
    );
    // The valid path called the runner.
    const validCallCount = spy.mock.calls.length;
    expect(validCallCount).toBeGreaterThan(0);

    // Flip to failing validation — runner MC stops being invoked.
    rerender({ cbp: failingValidation });
    expect(spy.mock.calls.length).toBe(validCallCount);
    spy.mockRestore();
  });

  it('two same-length glide series whose old (sum,head,mid,tail) collapses produce different signatures and trigger a new run', async () => {
    // Regression test: a sample-based fingerprint
    // (length + sums + stocksHead + stocksMid + stocksTail + bondsHead)
    // is too coarse for the piecewise-constant + linear-segment shaped
    // assetMixSeries. Two distinct glide configs can produce the same
    // 7-field fingerprint while yielding different yearly series —
    // stale stress-test results then survive a real retirementAllocation
    // edit because `currentSignature` doesn't change → `kickRun` skipped.
    //
    // Constructed collision pair for such a sample-based fingerprint (n=5):
    //   Both have: stocksSum=250, bondsSum=150, cashSum=100,
    //              stocksHead=50, stocksMid=50 (index 2), stocksTail=50, bondsHead=30.
    //   But they DIFFER at positions 1 and 3 (swapped) — a fact a
    //   sampler misses entirely (only positions 0, 2=mid, 4=tail, bondsHead).
    //
    // The rolling hash folds every element in index order (djb2-style),
    // so any pointwise difference — including the position-1/3 swap — flips
    // the hash. Result: different signatures → kickRun fires on the change.
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
    // Both series have identical: length=5, stocksSum=250, bondsSum=150,
    // cashSum=100, stocksHead=50, stocksMid=50 (index 2), stocksTail=50,
    // bondsHead=30 — the old fingerprint was blind to the position-1/3 swap.

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
      // Year-indexed nominal arrays carry the SS/income fields.
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

    // Second render returns inputB (position-1/3 swapped vs inputA).
    // Old fingerprint was blind to this; new rolling hash detects it →
    // signature differs → kickRun fires → run count increases.
    rerender({ runArgs: { ...buildRunArgs() } });
    vi.advanceTimersByTime(900);
    expect(runMock.mock.calls.length).toBeGreaterThan(firstRunCount);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('two different same-sum assetMixSeries produce different signatures and trigger a new run', async () => {
    // Regression test: `arrayOfMixesFingerprint` must not only
    // sum stocksPct/bondsPct/cashPct across the series, or two glide
    // curves with the same element totals but different per-step orderings
    // (e.g., ascending vs descending) produce identical cache keys —
    // stale MC results would survive the allocation change. Head/mid/tail
    // samples are included so different orderings flip the
    // signature even when sums are equal.
    const stepCount = (2086 - 2026 + 1) * 12;

    // Two series: same length + same per-element sum (each entry sums to
    // 100), but inverted stock/cash trajectory — ascending vs descending.
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
      // Year-indexed nominal arrays carry the SS/income fields.
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

    // Trigger a second render — runner returns inputB (descending series).
    // Same sums but different head/mid/tail → signature differs → new run.
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

  /** A guardrail-ENABLED MC input with the per-year baseline series present. */
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

  /** A primary-run summary the mocked provider returns. `successProbability`
   *  is the WITH-guardrails value; `seed` is the primary run's actual seed. */
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

  it('guardrails DISABLED → guardrailComparison is undefined + no sibling pool created', async () => {
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

  it('guardrails ENABLED → the forced-off sibling starts once (dedupe) and forces enabled:false with the primary seed', async () => {
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
    // Sibling started exactly once.
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    const pool = createdPools[0];
    expect(pool.run).toHaveBeenCalledTimes(1);
    const forcedOff = pool.run.mock.calls[0][0] as MonteCarloInput;
    // The sibling is the forced-OFF (enabled:false) input, seeded with the
    // PRIMARY run's actual seed (seed-paired).
    expect(forcedOff.downturnGuardrails?.enabled).toBe(false);
    expect(forcedOff.seed).toBe(4242);
    expect(forcedOff.pathCount).toBe(10_000);

    // Re-render (no input change) must NOT start a second run (dedupe).
    rerender();
    await act(async () => {});
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(pool.run).toHaveBeenCalledTimes(1);

    // The primary run's result is untouched by the sibling.
    expect(result.current.result).toBe(mockResult);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails ENABLED → a cache HIT surfaces the without-run WITHOUT creating a worker pool (no recompute on re-select)', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ seed: 4242, successProbability: 0.9 });
    // Stage a cached sibling summary → the effect must read it and NOT run a pool.
    nextCachedSibling = { successProbability: 0.55 };
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      usePlanStressTestVm(buildRunArgs(), okValidation, 'today'),
    );
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    // Cache-first: the without-run is served from cache, so NO worker pool is
    // created and nothing is written back — this is what stops the sibling from
    // recomputing on every scenario selection.
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

  it('guardrails ENABLED → sibling ready surfaces with/without/delta; a meaningful delta reads state ready', async () => {
    const spy = vi
      .spyOn(runner, 'runBalanceProjectionMc')
      .mockReturnValue(guardrailInput(true));
    mockResult = primarySummary({ successProbability: 0.9 });
    // A large gap (0.9 vs 0.5) → delta 0.4 >> the SE bound → ready signal.
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
    // Miss → run → write-through: the freshly-computed sibling is cached so a
    // later re-select of the SAME scenario hits (no recompute).
    expect(putCachedMock).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails ENABLED → a pending sibling surfaces state=pending', async () => {
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

  it('guardrails ENABLED → an mcInput identity churn (same signature/seed) does NOT re-fire the sibling or abort the in-flight run', async () => {
    // `mockImplementation` returns a FRESH input object each render, so every
    // re-render churns `mcInput` identity while its content-hash signature (and
    // the primary seed) — and thus pairKey — stay fixed. The effect reads mcInput
    // via a ref and depends on pairKey, NOT mcInput identity, so the churn does
    // not re-fire it: the in-flight run keeps running (never disposed → never
    // stranded on the pending bar), and repeated churns never spawn extra pools.
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

    // Churn mcInput identity repeatedly (same pairKey) while the run is pending.
    rerender();
    await act(async () => {});
    rerender();
    await act(async () => {});
    // The effect never re-fired: exactly ONE pool (no loop), the original run was
    // NOT aborted (still pending, will surface its result), no strand.
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    expect(firstPool.dispose).not.toHaveBeenCalled();
    expect(result.current.guardrailComparison?.state).toBe('pending');
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails ENABLED → a worker error surfaces state=error', async () => {
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
    // The PRODUCER side of the stale-base pairing. `MonteCarloProvider` hashes a
    // cache key and reads IndexedDB BEFORE it moves `status` to `running`, and
    // keeps serving the PREVIOUS summary as `result` for the whole request —
    // cache work and worker execution alike. A pair identity derived from "the
    // signature we last ASKED to run" therefore went live the instant the
    // debounce fired, so the market-stress comparison could difference the NEW
    // plan's stress runs against the OLD plan's base summary and publish
    // cross-plan dollars. Settlement has to be THIS request completing.
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

    // A deferred completion stands in for the provider's pre-`running` cache
    // work PLUS the worker run: the request stays outstanding — and `result`
    // stays on the previous summary — until the test resolves it.
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
    // Plan A's own run is still outstanding → there is nothing to pair against.
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

    // The user edits the plan; the provider keeps serving plan A's summary.
    currentInput = inputB;
    rerender({ runArgs: { ...buildRunArgs() } });
    expect(hook.current.stressPairSignature).toBeNull();

    // The debounce fires. THIS is the window the defect lived in: the requested
    // signature is now plan B's while the displayed summary is still plan A's.
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(hook.current.result).toBe(summaryA);
    expect(hook.current.stressPairSignature).toBeNull();
    expect(createMcPoolMock).not.toHaveBeenCalled();

    // Still withheld across the provider's asynchronous cache-key + cache-read
    // awaits (flushed here) and on through worker execution.
    await act(async () => {});
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBeNull();
    expect(createMcPoolMock).not.toHaveBeenCalled();

    // Only THIS request completing opens the pair — against plan B's summary.
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

  /** Settlement handles for a request the test holds open. `runToCompletion`
   *  has THREE terminal paths — a summary, `null` (cancelled), and a rejection
   *  (worker error) — and the regressions below cover the two that produce no
   *  summary. */
  function deferredRequest(): {
    settle: ((s: unknown) => void) | null;
    fail: ((e: unknown) => void) | null;
  } {
    return { settle: null, fail: null };
  }

  it('a Recalculate the user CANCELS keeps the settled pair and the guardrail comparison (the summary on screen is still the current plan’s)', async () => {
    // Cancel resolves the awaiter with `null` (MonteCarloProvider's
    // `resetInFlight`) — the provider does NOT clear `result`, and a recalc
    // leaves the signature alone, so the summary on screen is still the right
    // one for the plan on screen. A request identity that erases the last
    // SETTLED run when a new one is kicked therefore stranded both consumers:
    // the guardrail with/without callout sat on its indeterminate "comparing…"
    // bar forever, and the market-stress panel withheld Compare while claiming
    // the plan had changed.
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

    // Recalculate → the request stays outstanding until the user cancels it.
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
    // The plan did not change, so the displayed run is still pairable while the
    // recalc is in flight — exactly as it was before the request identity existed.
    expect(hook.current.stressPairSignature).toBe(pairA);

    // Cancel: the provider settles the awaiter with `null`.
    await act(async () => {
      deferred.settle?.(null);
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBe(pairA);
    expect(hook.current.guardrailComparison?.state).toBe('ready');
    // Nothing changed, so neither the sibling nor the primary re-runs — a cancel
    // must be durable, not silently restarted by the auto-run debounce.
    expect(createMcPoolMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('a Recalculate whose worker FAILS keeps the settled pair (the error banner is the surface, not a stuck comparison)', async () => {
    // The third terminal path: `runToCompletion` REJECTS. The provider surfaces
    // the failure through `error` (and the retry button), and keeps serving the
    // last good summary — so, as with a cancel, the run on screen stays pairable.
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

  it('a cancelled run for an EDITED plan withholds the pair and is NOT restarted by the debounce', async () => {
    // The other half of the terminal-path contract: what a cancel must NOT do.
    // "The signature we last ASKED to run" stays recorded even when that request
    // ends without a summary, so (a) the pair stays withheld — the settled run
    // belongs to the PREVIOUS plan — and (b) the auto-run debounce does not
    // treat the edit as un-run and quietly restart the run the user cancelled.
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

    // Edit the plan; its run is kicked by the debounce and then cancelled.
    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.settle = resolve;
        }),
    );
    currentInput = inputB;
    rerender({ runArgs: { ...buildRunArgs() } });
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      deferred.settle?.(null);
    });
    await act(async () => {});
    // The settled run belongs to plan A; plan B is on screen → nothing to pair.
    expect(hook.current.stressPairSignature).toBeNull();
    // And the cancelled run stays cancelled.
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(runMock).toHaveBeenCalledTimes(2);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('two rapid Recalculates — only the NEWEST request may settle the pair', async () => {
    // "Recalculate" stays enabled while a request is still in its provider-side
    // preflight, so the user can queue a second one before the first has even
    // reached a worker, and the two can finish in either order. The provider
    // half of the contract is that only the newest request publishes
    // (`MonteCarloProvider.preflight-order.test.tsx`); this is the consumer
    // half — handed an OLDER request's completion, the hook must refuse it
    // rather than settle the pair on a summary that is not the one on screen.
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

    // Two Recalculates back to back; both requests are held open.
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

    // The NEWER request completes and publishes its summary.
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

    // The OLDER request completes last, still carrying its own summary. Settling
    // on it would pair the plan on screen with a sample that is NOT on screen —
    // and, because that summary can never equal the provider's `result`, would
    // withhold both comparisons from then on with no run left to re-open them.
    await act(async () => {
      older.settle?.(primarySummary({ seed: 222, successProbability: 0.2 }));
    });
    await act(async () => {});
    expect(hook.current.stressPairSignature).toBe(pairNew);
    expect(hook.current.guardrailComparison?.state).toBe('ready');

    spy.mockRestore();
    vi.useRealTimers();
  });

  it('guardrails ENABLED → unmount disposes the sibling worker pool (no leaked worker)', async () => {
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

// ---------------------------------------------------------------------------
// The longevity cap's birth-year anchor
// ---------------------------------------------------------------------------

describe('longestLivedBirthYearOf — the age-105 anchor', () => {
  const member = (
    id: string,
    birthdate: string | undefined,
  ): Aggregate<HouseholdMemberPayload> =>
    ({ id, payload: { birthdate } }) as unknown as Aggregate<HouseholdMemberPayload>;

  it('picks the YOUNGEST member across several usable birthdates', () => {
    // `birthYear + 105` is largest for the youngest member, who is also the one
    // still alive at the end — the cap has to be anchored on them.
    expect(
      longestLivedBirthYearOf([
        member('m1', '1958-04-02'),
        member('m2', '1971-11-30'),
        member('m3', '1965-01-01'),
      ]),
    ).toBe(1971);
  });

  it('ignores unusable birthdates while a usable sibling remains', () => {
    // A blank birthdate is the trap: `Number(''.slice(0, 4))` is 0, not NaN, so
    // an unguarded derivation treats it as the year 0 — and `Math.max` would
    // still return 1971 here, hiding the bug. The single-member case below is
    // what exposes it.
    expect(
      longestLivedBirthYearOf([
        member('m1', '1971-11-30'),
        member('m2', ''),
        member('m3', undefined),
        member('m4', 'not-a-date'),
      ]),
    ).toBe(1971);
  });

  it('withholds an anchor rather than guessing when NO birthdate is usable', () => {
    // Every one of these would have produced a number (0 or NaN) from an
    // unguarded `Number(...)`, handing the longevity stress a nonsense age-105
    // year instead of withholding the comparison.
    expect(longestLivedBirthYearOf([member('m1', '')])).toBeNull();
    expect(longestLivedBirthYearOf([member('m1', undefined)])).toBeNull();
    expect(longestLivedBirthYearOf([member('m1', 'unknown')])).toBeNull();
    expect(longestLivedBirthYearOf([member('m1', '19-70-01')])).toBeNull();
    expect(longestLivedBirthYearOf([])).toBeNull();
  });
});
