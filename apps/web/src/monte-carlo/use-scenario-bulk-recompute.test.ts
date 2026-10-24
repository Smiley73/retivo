// The Scenarios "Recalculate all" worker-pool hook, driven through a fake `MinimalMcWorker` whose reply timing the test
// controls (same shape as `mc-worker-pool.test.ts`), with the real `fake-indexeddb` cache.
import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScenarioBulkRecompute } from './use-scenario-bulk-recompute';
import { type MinimalMcWorker } from './mc-worker-pool';
import { controlledWorker, type ControlledWorker } from './fake-worker.test-harness';
import {
  clearMonteCarloCache,
  getCached,
  mcCacheKey,
} from '../db/monte-carlo-cache';
import { ENGINE_VERSION } from '../lib/monte-carlo';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';

const DEFAULT_SEED = 42;

// Folded into `portfolioToday` so no two tests share a cache key: the hook's fire-and-forget cache write can land after the next test's clear, and `mcCacheKey` drops the seed.
let testRun = 0;
beforeEach(() => {
  testRun += 1;
});

/** A minimal `MonteCarloInput` keyed on `scenarioId` (and the current test) so
 *  each scenario hashes to a distinct cache entry; `seed` is set so
 *  seed-parity is observable. */
function inputFor(scenarioId: string, seed = DEFAULT_SEED): MonteCarloInput {
  return {
    portfolioToday: 100_000 + testRun,
    accountMcLedger: [{ id: scenarioId } as never],
    annualContribution: 0,
    firstYear: 2026,
    retirementYear: 2046,
    horizonYear: 2086,
    monthlyExpenseBase: [],
    ssByYear: [0],
    incomeByYear: [0],
    pathCount: MC_PATH_COUNT,
    seed,
    events: [],
  } as unknown as MonteCarloInput;
}

function summaryFor(successProbability: number): MonteCarloSummary {
  return {
    engineVersion: ENGINE_VERSION,
    seed: 1,
    pathCount: MC_PATH_COUNT,
    computedAt: Date.now(), // wall-clock — excluded from parity assertions
    firstYear: 2026,
    horizonYears: 60,
    percentilesNominal: { p10: [1], p25: [2], p50: [3] },
    percentilesReal: { p10: [1], p25: [2], p50: [3] },
    successProbability,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 100,
    medianEndingBalanceReal: 100,
    p10EndingBalanceNominal: 50,
    p10EndingBalanceReal: 50,
    p25EndingBalanceNominal: 70,
    p25EndingBalanceReal: 70,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  } as unknown as MonteCarloSummary;
}

type OnResultMock = ReturnType<
  typeof vi.fn<(id: string, summary: MonteCarloSummary) => void>
>;

interface Harness {
  readonly buildMcInput: (id: string) => MonteCarloInput | null;
  readonly onResult: OnResultMock;
  readonly built: ControlledWorker[];
  readonly factory: () => MinimalMcWorker;
}

function harness(seedById: Record<string, number> = {}): Harness {
  const built: ControlledWorker[] = [];
  return {
    buildMcInput: (id: string) => inputFor(id, seedById[id] ?? DEFAULT_SEED),
    onResult: vi.fn<(id: string, summary: MonteCarloSummary) => void>(),
    built,
    factory: () => {
      const w = controlledWorker();
      built.push(w);
      return w;
    },
  };
}

afterEach(async () => {
  // Flush pending microtasks (the hook's cache-write chains) before clearing so they cannot write after the clear.
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
  await clearMonteCarloCache();
  vi.clearAllMocks();
});

describe('useScenarioBulkRecompute', () => {
  it('should_run_each_scenario_then_patch_and_write_cache', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );

    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(2);
    const s = summaryFor(0.9);
    await act(async () => {
      h.built[0].resolveResult(s);
      h.built[1].resolveResult(s);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.onResult).toHaveBeenCalledTimes(2);
    expect(h.onResult.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    const keyA = await mcCacheKey(inputFor('a'));
    const keyB = await mcCacheKey(inputFor('b'));
    expect(await getCached(keyA)).not.toBeNull();
    expect(await getCached(keyB)).not.toBeNull();
  });

  it('should_patch_with_math_bearing_fields_matching_a_direct_reference', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 1,
      }),
    );
    const reference = summaryFor(0.73);
    await act(async () => {
      result.current.recalcAll(['a']);
      await Promise.resolve();
    });
    await act(async () => {
      h.built[0].resolveResult(reference);
      await Promise.resolve();
    });
    const patched = h.onResult.mock.calls[0][1] as MonteCarloSummary;
    // `computedAt` is wall-clock, not math-bearing, so it is excluded.
    expect(patched.successProbability).toBe(reference.successProbability);
    expect(patched.percentilesReal.p50).toEqual(reference.percentilesReal.p50);
    expect(patched.medianDepletionYear).toBe(reference.medianDepletionYear);
    expect(patched.medianEndingBalanceReal).toBe(reference.medianEndingBalanceReal);
    expect(patched.p25EndingBalanceReal).toBe(reference.p25EndingBalanceReal);
  });

  it('should_run_the_same_input_including_seed_the_page_built', async () => {
    const h = harness({ a: 7 });
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 1,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a']);
      await Promise.resolve();
    });
    // Seed parity is the basis for "no math change".
    expect(h.built[0].posted[0]).toEqual(inputFor('a', 7));
    expect((h.built[0].posted[0] as { seed: number }).seed).toBe(7);
  });

  it('should_be_independent_of_completion_order', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    await act(async () => {
      h.built[1].resolveResult(summaryFor(0.6));
      h.built[0].resolveResult(summaryFor(0.4));
      await Promise.resolve();
      await Promise.resolve();
    });
    const byId = new Map(h.onResult.mock.calls.map((c) => [c[0], c[1].successProbability]));
    expect(byId.get('a')).toBe(0.4);
    expect(byId.get('b')).toBe(0.6);
  });

  it('should_tolerate_a_mid_batch_error_without_patching_or_writing', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    await act(async () => {
      h.built[0].emitError('boom'); // 'a' fails
      h.built[1].resolveResult(summaryFor(0.9)); // 'b' succeeds
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.onResult).toHaveBeenCalledTimes(1);
    expect(h.onResult.mock.calls[0][0]).toBe('b');
    expect(await getCached(await mcCacheKey(inputFor('a')))).toBeNull();
    expect(await getCached(await mcCacheKey(inputFor('b')))).not.toBeNull();
    expect(result.current.coarse).toBeNull();
  });

  it('should_update_then_clear_the_per_card_progress_on_terminal_reply', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 1,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a']);
      await Promise.resolve();
    });
    await act(async () => {
      h.built[0].emitProgress(250, 1000);
      await Promise.resolve();
    });
    expect(result.current.progressById.get('a')).toEqual({ done: 250, total: 1000 });
    await act(async () => {
      h.built[0].resolveResult(summaryFor(0.9));
      await Promise.resolve();
    });
    expect(result.current.progressById.has('a')).toBe(false);
  });

  it('should_dispose_the_pool_and_keep_completed_cards_on_cancel', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b', 'c']); // 'c' queued behind the pool
      await Promise.resolve();
    });
    await act(async () => {
      h.built[0].resolveResult(summaryFor(0.9));
      await Promise.resolve();
    });
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    expect(h.built.every((w) => w.terminated)).toBe(true);
    expect(result.current.coarse).toBeNull();
    expect(result.current.progressById.size).toBe(0);
    expect(h.onResult.mock.calls.map((c) => c[0])).toEqual(['a']);
  });

  it('should_dispose_the_pool_on_unmount', async () => {
    const h = harness();
    const { result, unmount } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.some((w) => !w.terminated)).toBe(true);
    unmount();
    expect(h.built.every((w) => w.terminated)).toBe(true);
  });

  it('should_keep_at_most_pool_size_runs_in_flight', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b', 'c', 'd']); // 4 items, cap 2
      await Promise.resolve();
    });
    expect(h.built.length).toBe(2);
    const postedNow = h.built.reduce((n, w) => n + w.posted.length, 0);
    expect(postedNow).toBe(2);
    await act(async () => {
      h.built[0].resolveResult(summaryFor(0.9));
      h.built[1].resolveResult(summaryFor(0.9));
      await Promise.resolve();
      await Promise.resolve();
    });
    const postedAfter = h.built.reduce((n, w) => n + w.posted.length, 0);
    expect(postedAfter).toBe(4);
  });

  it('should_ignore_a_second_recalcAll_while_a_batch_is_in_flight', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b']); // 2 workers in flight, unresolved
      await Promise.resolve();
    });
    expect(h.built.length).toBe(2);
    const firstBatch = h.built.slice();
    const postedBefore = h.built.reduce((n, w) => n + w.posted.length, 0);
    await act(async () => {
      result.current.recalcAll(['c', 'd', 'e']);
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(2);
    expect(h.built).toEqual(firstBatch); // same instances, untouched
    expect(h.built.every((w) => !w.terminated)).toBe(true);
    expect(h.built.reduce((n, w) => n + w.posted.length, 0)).toBe(postedBefore);
    await act(async () => {
      h.built[0].resolveResult(summaryFor(0.9));
      h.built[1].resolveResult(summaryFor(0.9));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('should_suppress_a_stale_reply_arriving_after_cancel', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: h.buildMcInput,
        onResult: h.onResult,
        workerFactory: h.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    const inFlight = h.built.slice();
    expect(inFlight.length).toBe(2);
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    await act(async () => {
      inFlight[0].resolveResult(summaryFor(0.9));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.onResult).not.toHaveBeenCalled();
    expect(result.current.coarse).toBeNull();
    expect(await getCached(await mcCacheKey(inputFor('a')))).toBeNull();
  });

  it('should_no_op_on_empty_or_all_null_inputs', async () => {
    const h = harness();
    const nullBuild = { ...h, buildMcInput: () => null };
    const { result } = renderHook(() =>
      useScenarioBulkRecompute({
        buildMcInput: nullBuild.buildMcInput,
        onResult: nullBuild.onResult,
        workerFactory: nullBuild.factory,
        concurrency: 2,
      }),
    );
    await act(async () => {
      result.current.recalcAll([]);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(0);
    expect(result.current.coarse).toBeNull();
    expect(result.current.isRunning).toBe(false);
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(0);
    expect(result.current.coarse).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });
});
