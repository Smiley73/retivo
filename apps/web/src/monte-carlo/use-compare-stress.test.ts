/**
 * Tests for the Compare tab's stress-test hook: the viewed side read from the
 * page's view model, the comparison side cache-first then one pool run, with
 * the run's lifecycle (start gate, abort, dispose, retry) pinned through a
 * fake worker whose replies the test controls. The IDB cache is the real
 * `fake-indexeddb` store; inputs come from the demo dataset through the same
 * builder the Projections page's cache key comes from.
 */
import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import { clearMonteCarloCache, getCached, mcCacheKey, putCached } from '../db/monte-carlo-cache';
import { loadDemoData } from '../lib/demo-data-loader';
import type { MonteCarloSummary } from '../lib/monte-carlo';
import {
  buildMonteCarloInputForScenario,
  MC_PATH_COUNT,
  type ScenarioMcInputs,
} from '../lib/monte-carlo-scenario-input';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { controlledWorker, fakeSummary, type ControlledWorker } from './fake-worker.test-harness';
import { useCompareStress, type CompareStressViewed } from './use-compare-stress';

const BASE = 'demo-scenario-base';
const EARLY = 'demo-scenario-early';
const DELAY = 'demo-scenario-delay';
const TODAY_YEAR = 2026;
const TODAY_MONTH = 4;
const WAIT = { timeout: 5_000 };

let scenarios: ReadonlyArray<ScenarioAggregate>;
let inputs: ScenarioMcInputs;

beforeAll(async () => {
  await clearAllStores();
  await loadDemoData({
    householdId: 'hh-compare-stress',
    email: 'demo@example.test',
    displayName: 'Demo User',
    todayYear: TODAY_YEAR,
  });
  const list = <T>(type: string) => listAggregates(type as never) as Promise<T[]>;
  scenarios = await list<ScenarioAggregate>('scenario');
  inputs = {
    members: await list('householdMember'),
    accounts: await list('account'),
    balances: await list('accountBalance'),
    expenses: await list('expense'),
    incomeStreams: await list('incomeStream'),
    ssBenefits: await list('socialSecurityBenefit'),
    categories: await list('expenseCategory'),
  };
});

afterAll(async () => {
  await clearAllStores();
  await clearMonteCarloCache();
});

beforeEach(async () => {
  await clearMonteCarloCache();
});

const expectedInput = (scenarioId: string) =>
  buildMonteCarloInputForScenario({
    scenarioId,
    scenarios,
    inputs,
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
  })!;

const keyFor = async (scenarioId: string): Promise<string> => mcCacheKey(expectedInput(scenarioId));

const summaryAt = (successProbability: number): MonteCarloSummary => ({
  ...fakeSummary(1),
  successProbability,
  pathCount: MC_PATH_COUNT,
});

/** A page stress view model whose run for the plan on screen has settled. */
const settled = (successProbability = 0.9): CompareStressViewed => ({
  isRunning: false,
  error: null,
  hasNoAccounts: false,
  cbpValidation: { ok: true },
  stressPairSignature: 'sig',
  runPending: false,
  result: summaryAt(successProbability),
  progressDone: 0,
  progressTotal: 0,
  recalculate: () => undefined,
});

interface Props {
  viewed: CompareStressViewed;
  comparisonId: string | null;
  viewedScenarioId?: string;
  isActive?: boolean;
}

function setup(initial: Props) {
  const built: ControlledWorker[] = [];
  const workerFactory = () => {
    const w = controlledWorker();
    built.push(w);
    return w;
  };
  const view = renderHook(
    (p: Props) =>
      useCompareStress({
        viewed: p.viewed,
        viewedScenarioId: p.viewedScenarioId ?? BASE,
        comparisonId: p.comparisonId,
        scenarios,
        inputs,
        nowYear: TODAY_YEAR,
        nowMonthIndex: TODAY_MONTH,
        isActive: p.isActive ?? true,
        workerFactory,
      }),
    { initialProps: initial },
  );
  return { built, ...view };
}

/** Let any pending idle slice, cache read and promise chain run. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 50));
  });
}

describe('useCompareStress — comparison side', () => {
  it('reads a cached result without constructing a worker', async () => {
    await putCached(await keyFor(EARLY), summaryAt(0.83));
    const { result, built } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(result.current.comparison.state).toBe('ready'), WAIT);
    expect(result.current.comparison.probability).toBe(0.83);
    expect(result.current.comparison.pathCount).toBe(MC_PATH_COUNT);
    expect(built).toHaveLength(0);
  });

  it('on a miss posts the builder input to one worker, forwards progress and caches the result', async () => {
    const { result, built } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    expect(built[0]!.posted).toEqual([expectedInput(EARLY)]);
    expect(built[0]!.posted[0]!.pathCount).toBe(MC_PATH_COUNT);
    await waitFor(() => expect(result.current.comparison.state).toBe('running'));

    act(() => built[0]!.emitProgress(2_500, 10_000));
    expect(result.current.comparison.progress).toEqual({ done: 2_500, total: 10_000 });
    expect(result.current.comparison.probability).toBeNull();

    act(() => built[0]!.resolveResult(summaryAt(0.77)));
    await waitFor(() => expect(result.current.comparison.state).toBe('ready'));
    expect(result.current.comparison.probability).toBe(0.77);
    expect(built[0]!.terminated).toBe(true);
    await waitFor(async () => {
      expect((await getCached(await keyFor(EARLY)))?.successProbability).toBe(0.77);
    });
    expect(built).toHaveLength(1);
  });

  it('starts no run while the page run is in flight or unsettled, and starts once it settles', async () => {
    const running: CompareStressViewed = {
      ...settled(),
      isRunning: true,
      stressPairSignature: null,
      result: null,
      progressDone: 100,
      progressTotal: 10_000,
    };
    const { result, built, rerender } = setup({ viewed: running, comparisonId: EARLY });
    await waitFor(() => expect(result.current.cacheKeys).not.toBeNull(), WAIT);
    await flush();
    expect(built).toHaveLength(0);
    expect(result.current.viewed).toMatchObject({
      state: 'running',
      progress: { done: 100, total: 10_000 },
    });

    // Not running, but a run is still to come (the page's own run is still
    // behind its debounce): the pool must keep waiting, or it would overlap it.
    rerender({ viewed: { ...running, isRunning: false, runPending: true }, comparisonId: EARLY });
    await flush();
    expect(built).toHaveLength(0);
    expect(result.current.viewed.state).toBe('pending');

    rerender({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
  });

  it('starts when the page run was cancelled (not running, none queued, no pair, no error)', async () => {
    const running: CompareStressViewed = {
      ...settled(),
      isRunning: true,
      runPending: true,
      stressPairSignature: null,
      result: null,
    };
    const { result, built, rerender } = setup({ viewed: running, comparisonId: EARLY });
    await waitFor(() => expect(result.current.cacheKeys).not.toBeNull(), WAIT);
    await flush();
    expect(built).toHaveLength(0);

    // The Cancel shape: the run ends, nothing settles, nothing is re-queued.
    rerender({ viewed: { ...running, isRunning: false, runPending: false }, comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    expect(built[0]!.posted).toEqual([expectedInput(EARLY)]);
    expect(result.current.viewed.state).toBe('stopped');
    expect(result.current.comparison.state).toBe('running');
  });

  it('disposes the pool and drops the late reply when the comparison scenario changes mid-run', async () => {
    const { result, built, rerender } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    const first = built[0]!;
    await waitFor(() => expect(result.current.comparison.state).toBe('running'));

    rerender({ viewed: settled(), comparisonId: DELAY });
    expect(first.terminated).toBe(true);
    act(() => first.resolveResult(summaryAt(0.5)));
    await waitFor(() => expect(built).toHaveLength(2), WAIT);
    expect(built[1]!.posted).toEqual([expectedInput(DELAY)]);
    expect(result.current.comparison.probability).toBeNull();
    await flush();
    expect(await getCached(await keyFor(EARLY))).toBeNull();
  });

  it('keeps a started run going when the tab is left, and still caches it', async () => {
    const { result, built, rerender } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    rerender({ viewed: settled(), comparisonId: EARLY, isActive: false });
    expect(built[0]!.terminated).toBe(false);
    act(() => built[0]!.resolveResult(summaryAt(0.6)));
    await waitFor(() => expect(result.current.comparison.state).toBe('ready'));
    await waitFor(async () => {
      expect(await getCached(await keyFor(EARLY))).not.toBeNull();
    });
  });

  it('does nothing before the tab is selected', async () => {
    const { result, built } = setup({ viewed: settled(), comparisonId: EARLY, isActive: false });
    await flush();
    expect(built).toHaveLength(0);
    expect(result.current.cacheKeys).toBeNull();
    expect(result.current.comparison.state).toBe('pending');
  });

  it('disposes the pool on unmount', async () => {
    const { built, unmount } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    unmount();
    expect(built[0]!.terminated).toBe(true);
  });

  it('reports a worker error, then runs again on retry and ignores the failed run', async () => {
    const { result, built } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(built).toHaveLength(1), WAIT);
    act(() => built[0]!.emitError('worker crashed'));
    await waitFor(() => expect(result.current.comparison.state).toBe('error'));
    expect(result.current.comparison.message).toEqual(expect.any(String));
    expect(result.current.viewed.state).toBe('ready');
    expect(built[0]!.terminated).toBe(true);

    act(() => result.current.retry());
    await waitFor(() => expect(built).toHaveLength(2), WAIT);
    expect(built[1]!.posted).toEqual([expectedInput(EARLY)]);
    act(() => built[0]!.resolveResult(summaryAt(0.1)));
    expect(result.current.comparison.state).toBe('running');
    act(() => built[1]!.resolveResult(summaryAt(0.66)));
    await waitFor(() => expect(result.current.comparison.probability).toBe(0.66));
  });

  it('never constructs a worker when both scenarios hash to the same key, and mirrors the viewed side', async () => {
    const { result, built } = setup({ viewed: settled(0.88), comparisonId: BASE });
    await waitFor(() => expect(result.current.cacheKeys).not.toBeNull(), WAIT);
    const { viewed, comparison } = result.current.cacheKeys!;
    expect(comparison).toBe(viewed);
    await flush();
    expect(built).toHaveLength(0);
    expect(result.current.comparison).toEqual(result.current.viewed);
    expect(result.current.comparison.probability).toBe(0.88);
    expect(result.current.verdict).toMatchObject({ kind: 'same' });
  });

  it('reads a comparison that cannot run the stress test as unavailable, with no worker', async () => {
    const { result, built } = setup({ viewed: settled(), comparisonId: 'no-such-scenario' });
    await waitFor(() => expect(result.current.comparison.state).toBe('unavailable'), WAIT);
    expect(result.current.cacheKeys?.comparison).toBeNull();
    expect(result.current.verdict).toBeNull();
    await flush();
    expect(built).toHaveLength(0);
  });

  it('is pending, not a stale value, while the keys are recomputed for a changed comparison', async () => {
    await putCached(await keyFor(EARLY), summaryAt(0.83));
    const { result, rerender } = setup({ viewed: settled(), comparisonId: EARLY });
    await waitFor(() => expect(result.current.comparison.state).toBe('ready'), WAIT);
    rerender({ viewed: settled(), comparisonId: DELAY });
    expect(result.current.comparison.state).toBe('pending');
    expect(result.current.comparison.probability).toBeNull();
    expect(result.current.cacheKeys).toBeNull();
  });
});

describe('useCompareStress — viewed side', () => {
  const base = settled();
  it.each([
    ['stopped when nothing is running or queued and no pair settled', { ...base, stressPairSignature: null, result: null }, 'stopped'],
    // A result is on screen but is not the settled pair for this plan: it may
    // belong to another scenario or an older plan, so it is never read.
    ['pending with a result but no settled signature', { ...base, runPending: true, stressPairSignature: null }, 'pending'],
    ['running', { ...base, stressPairSignature: null, isRunning: true }, 'running'],
    ['ready', base, 'ready'],
    ['an error', { ...base, error: 'boom', stressPairSignature: null }, 'error'],
    ['unavailable without accounts', { ...base, hasNoAccounts: true }, 'unavailable'],
    ['unavailable with an invalid setup', { ...base, cbpValidation: { ok: false } }, 'unavailable'],
  ] as const)('is %s', async (_label, viewed, state) => {
    const { result } = setup({ viewed, comparisonId: null });
    expect(result.current.viewed.state).toBe(state);
    expect(result.current.viewed.probability).toBe(state === 'ready' ? 0.9 : null);
  });

  it('reports the progress of a run in flight, and 0 total when none is reported', () => {
    const running = { ...base, stressPairSignature: null, isRunning: true, progressDone: 300, progressTotal: 10_000 };
    const { result, rerender } = setup({ viewed: running, comparisonId: null });
    expect(result.current.viewed.progress).toEqual({ done: 300, total: 10_000 });
    rerender({ viewed: { ...running, progressDone: 0, progressTotal: 0 }, comparisonId: null });
    expect(result.current.viewed.progress).toEqual({ done: 0, total: 0 });
  });
});
