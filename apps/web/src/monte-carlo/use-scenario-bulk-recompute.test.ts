/**
 * Tests for the Scenarios "Recalculate all" concurrent worker-pool hook.
 *
 * Drives the hook through a fake `MinimalMcWorker` whose reply timing the
 * test controls (same harness shape as `mc-worker-pool.test.ts`), so we can
 * assert: forced N runs each patch + write-cache; numeric parity vs a direct
 * reference summary; seed parity (the hook runs the input the page built);
 * order-independence; per-scenario error tolerance; per-card progress map
 * update + clear on terminal reply; cancel/dispose; unmount disposal; and the
 * concurrency cap. The IDB cache is the real `fake-indexeddb` store.
 */
import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScenarioBulkRecompute } from './use-scenario-bulk-recompute';
import { type MinimalMcWorker } from './mc-worker-pool';
import {
  clearMonteCarloCache,
  getCached,
  mcCacheKey,
} from '../db/monte-carlo-cache';
import { ENGINE_VERSION } from '../lib/monte-carlo';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';

const DEFAULT_SEED = 42;

/** Bumped before every test and folded into `portfolioToday`, so no two tests
 *  share a cache key. The hook's cache write is a fire-and-forget async chain;
 *  a write left over from one test can land after the next test's cache clear,
 *  and with a shared key it would show up as a hit in that test's "was never
 *  cached" assertion. The seed cannot do this job: `mcCacheKey` drops it, so
 *  the key has to differ in a field it does include. */
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

interface ControlledWorker extends MinimalMcWorker {
  resolveResult(summary: MonteCarloSummary): void;
  emitError(message: string): void;
  emitProgress(done: number, total: number): void;
  readonly posted: ReadonlyArray<MonteCarloInput>;
  readonly terminated: boolean;
}

function controlledWorker(): ControlledWorker {
  const listeners = new Set<(ev: MessageEvent) => void>();
  const posted: MonteCarloInput[] = [];
  let terminated = false;
  const emit = (data: unknown): void => {
    const ev = { data } as MessageEvent;
    listeners.forEach((fn) => fn(ev));
  };
  return {
    posted,
    get terminated() {
      return terminated;
    },
    addEventListener(t, fn) {
      // Only the pool's `message` listener drives this fake; the `error`
      // listener is never emitted here, so keep it out of the set.
      if (t !== 'error') listeners.add(fn);
    },
    removeEventListener(t, fn) {
      if (t !== 'error') listeners.delete(fn);
    },
    postMessage(msg: unknown) {
      const m = msg as { kind: 'run'; input: MonteCarloInput };
      posted.push(m.input);
    },
    terminate() {
      terminated = true;
    },
    resolveResult(summary: MonteCarloSummary) {
      emit({ kind: 'result', summary });
    },
    emitError(message: string) {
      emit({ kind: 'error', message });
    },
    emitProgress(done: number, total: number) {
      emit({ kind: 'progress', done, total });
    },
  };
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
  // Flush all pending microtasks (e.g., void cache-write chains in the hook)
  // before clearing so they cannot write after the clear and pollute later tests.
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
    // Two workers (concurrency 2, 2 items) each got one input.
    expect(h.built.length).toBe(2);
    const s = summaryFor(0.9);
    await act(async () => {
      h.built[0].resolveResult(s);
      h.built[1].resolveResult(s);
      await Promise.resolve();
      await Promise.resolve();
    });
    // Each scenario patched once from the in-hand summary.
    expect(h.onResult).toHaveBeenCalledTimes(2);
    expect(h.onResult.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    // … and write-cached under the shared key.
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
    // Math-bearing fields equal the reference (computedAt excluded — it is
    // wall-clock and not math-bearing).
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
    // The pool posted exactly the input the page's buildMcInput produced —
    // including its seed (seed parity is the basis for "no math change").
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
    // Resolve worker 1 (scenario 'b') BEFORE worker 0 ('a').
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
    // Only the successful sibling patched + wrote; the errored card untouched.
    expect(h.onResult).toHaveBeenCalledTimes(1);
    expect(h.onResult.mock.calls[0][0]).toBe('b');
    expect(await getCached(await mcCacheKey(inputFor('a')))).toBeNull();
    expect(await getCached(await mcCacheKey(inputFor('b')))).not.toBeNull();
    // The coarse counter still accounted both → batch completed (coarse null).
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
    // Terminal reply clears that scenario's fine bar.
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
    // Complete 'a', then cancel mid-flight.
    await act(async () => {
      h.built[0].resolveResult(summaryFor(0.9));
      await Promise.resolve();
    });
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    // Both built workers terminated; coarse + progress cleared.
    expect(h.built.every((w) => w.terminated)).toBe(true);
    expect(result.current.coarse).toBeNull();
    expect(result.current.progressById.size).toBe(0);
    // The completed card ('a') kept its fresh value; aborted/queued didn't fire.
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
    // Every worker terminated → no leaked worker.
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
    // Exactly two workers built; two inputs posted; 'c'/'d' wait in the queue.
    expect(h.built.length).toBe(2);
    const postedNow = h.built.reduce((n, w) => n + w.posted.length, 0);
    expect(postedNow).toBe(2);
    // Free both slots → the queued pair dispatches (still ≤ 2 in flight).
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
    // A second call while a run is active is a no-op: no new pool/workers.
    await act(async () => {
      result.current.recalcAll(['c', 'd', 'e']);
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(2);
    expect(h.built).toEqual(firstBatch); // same instances, untouched
    expect(h.built.every((w) => !w.terminated)).toBe(true);
    expect(h.built.reduce((n, w) => n + w.posted.length, 0)).toBe(postedBefore);
    // Resolve to drain the in-flight batch (clean up).
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
    // Cancel mid-flight, THEN a now-aborted worker delivers a late result.
    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });
    await act(async () => {
      inFlight[0].resolveResult(summaryFor(0.9));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The late reply is dropped: no patch, coarse stays null, no cache write.
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
    // Empty list → nothing runs.
    await act(async () => {
      result.current.recalcAll([]);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(0);
    expect(result.current.coarse).toBeNull();
    expect(result.current.isRunning).toBe(false);
    // All inputs build to null → still nothing runs.
    await act(async () => {
      result.current.recalcAll(['a', 'b']);
      await Promise.resolve();
    });
    expect(h.built.length).toBe(0);
    expect(result.current.coarse).toBeNull();
    expect(result.current.isRunning).toBe(false);
  });
});
