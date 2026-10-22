/**
 * Compare tab — the "Plan success" figures for the two scenarios.
 *
 * The viewed side is read from the page's own stress view model (the provider
 * is single-slot; a second run would supersede the page's) and shown only once
 * `stressPairSignature` is non-null. The comparison side is cache-first under
 * the key the Projections page writes, else one `pool.run` on a worker pool
 * this hook owns, token-guarded and cached on success. The pool run waits
 * until nothing of the page's own run is in flight or queued (a cancelled page
 * run never settles, so waiting for a settled pair would strand it). Leaving
 * the tab does not abort a run; unmount, a changed comparison scenario or a
 * changed cache key does. Equal keys run nothing: the comparison side is the
 * viewed side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCached, mcCacheKey, putCached } from '../db/monte-carlo-cache';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import {
  buildMonteCarloInputForScenario,
  MC_PATH_COUNT,
  type ScenarioMcInputs,
} from '../lib/monte-carlo-scenario-input';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  successDeltaVerdict,
  type SuccessDeltaVerdict,
  type SuccessSample,
} from '../lib/success-delta-noise';
import { yieldToIdle } from '../lib/yield-to-idle';
import { createMcPool, type McPool, type MinimalMcWorker } from './mc-worker-pool';
import MCWorker from '../workers/monte-carlo.worker.ts?worker';

/** The slice of the page's stress-test view model this hook reads. */
export interface CompareStressViewed {
  readonly isRunning: boolean;
  readonly error: string | null;
  readonly hasNoAccounts: boolean;
  readonly cbpValidation: { readonly ok: boolean } | null;
  /** Non-null only once a completed run for the plan on screen produced `result`. */
  readonly stressPairSignature: string | null;
  /** A run for the plan on screen is queued or in flight; false after a cancel. */
  readonly runPending: boolean;
  readonly result: MonteCarloSummary | null;
  readonly progressDone: number;
  readonly progressTotal: number;
  /** Start the page's own run again (the controls strip's Recalculate). */
  readonly recalculate: () => void;
}

/** `stopped`: the page's run is not running, nothing is queued, and it never
 *  produced a result for the plan on screen (cancelled or superseded). */
type CompareStressState = 'pending' | 'running' | 'ready' | 'error' | 'unavailable' | 'stopped';

export interface CompareStressSide {
  readonly state: CompareStressState;
  /** 0..1; non-null only when `state` is `ready`. */
  readonly probability: number | null;
  /** Paths behind `probability`; non-null only when `state` is `ready`. */
  readonly pathCount: number | null;
  /** Path progress while `running`; `total` 0 reads as indeterminate. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** The failure sentence of a comparison-side `error`; null otherwise. */
  readonly message: string | null;
}

export interface CompareStressVm {
  readonly viewed: CompareStressSide;
  readonly comparison: CompareStressSide;
  /** The noise gate's verdict for `viewed - comparison`; null until both sides are ready. */
  readonly verdict: SuccessDeltaVerdict | null;
  /** Null until computed for the current inputs; a side that cannot run has a null key. */
  readonly cacheKeys: { readonly viewed: string | null; readonly comparison: string | null } | null;
  /** Re-run a failed comparison side. */
  readonly retry: () => void;
  /** Start the viewed scenario's stress test again (a `stopped` viewed side). */
  readonly runViewed: () => void;
}

export interface UseCompareStressArgs {
  readonly viewed: CompareStressViewed;
  readonly viewedScenarioId: string;
  readonly comparisonId: string | null;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  /** The page's slices, categories included (they change the key); memoised. */
  readonly inputs: ScenarioMcInputs;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
  /** True while the Compare tab is the selected view. */
  readonly isActive: boolean;
  /** Injected for tests to bypass the real `?worker` import. */
  readonly workerFactory?: () => MinimalMcWorker;
}

interface Prepared {
  /** The inputs this was computed for; stale once any of them changes. */
  readonly deps: ReadonlyArray<unknown>;
  /** `null` when the comparison scenario cannot run the stress test. */
  readonly comparisonInput: MonteCarloInput | null;
  readonly viewedKey: string | null;
  readonly comparisonKey: string | null;
}

type ComparisonRun =
  | { readonly key: string; readonly phase: 'miss' }
  | { readonly key: string; readonly phase: 'running'; readonly done: number; readonly total: number }
  | { readonly key: string; readonly phase: 'ready'; readonly summary: MonteCarloSummary }
  | { readonly key: string; readonly phase: 'error'; readonly message: string };

const RUN_FAILED_MESSAGE = "Couldn't calculate the stress test for this scenario.";

const PENDING: CompareStressSide = side('pending');

function side(
  state: CompareStressState,
  extra: Partial<Omit<CompareStressSide, 'state'>> = {},
): CompareStressSide {
  return { state, probability: null, pathCount: null, progress: null, message: null, ...extra };
}

function readySide(summary: MonteCarloSummary): CompareStressSide {
  return side('ready', {
    probability: summary.successProbability,
    pathCount: summary.pathCount > 0 ? summary.pathCount : MC_PATH_COUNT,
  });
}

function sameDeps(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function defaultWorker(): MinimalMcWorker {
  return new MCWorker() as unknown as MinimalMcWorker;
}

/** The viewed side, from the page's view model. */
function viewedSide(v: CompareStressViewed): CompareStressSide {
  if (v.hasNoAccounts || v.cbpValidation?.ok === false) return side('unavailable');
  if (v.error !== null) return side('error', { message: v.error });
  if (v.stressPairSignature !== null && v.result !== null) return readySide(v.result);
  if (v.isRunning) {
    return side('running', { progress: { done: v.progressDone, total: v.progressTotal } });
  }
  return v.runPending ? PENDING : side('stopped');
}

function sample(s: CompareStressSide): SuccessSample | null {
  return s.state === 'ready' && s.probability !== null && s.pathCount !== null
    ? { probability: s.probability, pathCount: s.pathCount }
    : null;
}

export function useCompareStress(args: UseCompareStressArgs): CompareStressVm {
  const {
    viewed,
    viewedScenarioId,
    comparisonId,
    scenarios,
    inputs,
    nowYear,
    nowMonthIndex,
    isActive,
  } = args;
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [run, setRun] = useState<ComparisonRun | null>(null);

  const poolRef = useRef<McPool | null>(null);
  // Bumped on every dispose, so a late reply from a torn-down pool is ignored.
  const runTokenRef = useRef(0);
  const workerFactoryRef = useRef(args.workerFactory);
  workerFactoryRef.current = args.workerFactory;

  const deps = useMemo(
    () => [viewedScenarioId, comparisonId, scenarios, inputs, nowYear, nowMonthIndex],
    [viewedScenarioId, comparisonId, scenarios, inputs, nowYear, nowMonthIndex],
  );
  const live = prepared !== null && sameDeps(prepared.deps, deps) ? prepared : null;
  const current = live !== null;

  const disposePool = useCallback((): void => {
    runTokenRef.current += 1;
    poolRef.current?.dispose();
    poolRef.current = null;
  }, []);

  // 1. Inputs and cache keys, once the tab is selected; kept across tab switches.
  useEffect(() => {
    if (!isActive || comparisonId === null || current) return;
    let cancelled = false;
    const cancelIdle = yieldToIdle(() => {
      const build = (scenarioId: string): MonteCarloInput | null =>
        buildMonteCarloInputForScenario({
          scenarioId,
          scenarios,
          inputs,
          todayYear: nowYear,
          todayMonthIndex: nowMonthIndex,
        });
      const comparisonInput = build(comparisonId);
      const viewedInput = build(viewedScenarioId);
      const key = (input: MonteCarloInput | null): Promise<string | null> =>
        input === null ? Promise.resolve(null) : mcCacheKey(input);
      void Promise.all([key(viewedInput), key(comparisonInput)])
        .then(([viewedKey, comparisonKey]) => {
          if (!cancelled) setPrepared({ deps, comparisonInput, viewedKey, comparisonKey });
        })
        .catch((e: unknown) => {
          console.warn('[compare-stress] cache key failed', e);
          if (!cancelled) {
            setPrepared({ deps, comparisonInput: null, viewedKey: null, comparisonKey: null });
          }
        });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [isActive, comparisonId, current, deps, scenarios, inputs, nowYear, nowMonthIndex, viewedScenarioId]);

  // A stale `prepared` still names the key of a run in flight: that run is
  // aborted when the key changes, not whenever an unrelated input re-reads.
  const comparisonKey = prepared?.comparisonKey ?? null;
  const sameKey =
    live !== null && live.comparisonKey !== null && live.comparisonKey === live.viewedKey;
  const targetKey = live !== null && !sameKey ? live.comparisonKey : null;

  // 2. Cache first.
  useEffect(() => {
    if (targetKey === null || poolRef.current !== null) return;
    let cancelled = false;
    void getCached(targetKey)
      .catch((e: unknown) => {
        console.warn('[compare-stress] cache read failed', e);
        return null;
      })
      .then((summary) => {
        if (cancelled) return;
        setRun(
          summary
            ? { key: targetKey, phase: 'ready', summary }
            : { key: targetKey, phase: 'miss' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [targetKey]);

  // 3. A miss runs on the pool once the page's own run is neither in flight nor queued.
  const viewedState = viewedSide(viewed);
  const viewedSettled = !viewed.isRunning && !viewed.runPending;
  const comparisonInput = live?.comparisonInput ?? null;
  useEffect(() => {
    if (!isActive || targetKey === null || comparisonInput === null) return;
    if (run === null || run.key !== targetKey || run.phase !== 'miss') return;
    if (!viewedSettled || poolRef.current !== null) return;

    disposePool();
    const token = runTokenRef.current;
    const pool = createMcPool({ factory: workerFactoryRef.current ?? defaultWorker, size: 1 });
    poolRef.current = pool;
    const key = targetKey;
    setRun({ key, phase: 'running', done: 0, total: 0 });
    const finish = (next: ComparisonRun): void => {
      if (runTokenRef.current !== token) return;
      disposePool();
      setRun(next);
    };
    void pool
      .run(comparisonInput, (done, total) => {
        if (runTokenRef.current !== token) return;
        setRun((prev) =>
          prev !== null && prev.key === key && prev.phase === 'running'
            ? { key, phase: 'running', done, total }
            : prev,
        );
      })
      .then((reply) => {
        if (runTokenRef.current !== token) return;
        if (reply.kind === 'result') {
          void putCached(key, reply.summary).catch((e: unknown) => {
            console.warn('[compare-stress] cache write failed', e);
          });
          finish({ key, phase: 'ready', summary: reply.summary });
        } else if (reply.kind === 'error') {
          finish({ key, phase: 'error', message: RUN_FAILED_MESSAGE });
        }
      })
      .catch((e: unknown) => {
        console.warn('[compare-stress] run failed', e);
        finish({ key, phase: 'error', message: RUN_FAILED_MESSAGE });
      });
  }, [isActive, targetKey, comparisonInput, run, viewedSettled, disposePool]);

  useEffect(() => disposePool, [comparisonId, comparisonKey, disposePool]);

  const retry = useCallback((): void => {
    setRun((prev) =>
      prev !== null && prev.phase === 'error' ? { key: prev.key, phase: 'miss' } : prev,
    );
  }, []);

  let comparison: CompareStressSide = PENDING;
  if (live !== null) {
    if (live.comparisonInput === null) {
      comparison = side('unavailable');
    } else if (sameKey) {
      comparison = viewedState;
    } else if (run !== null && run.key === targetKey) {
      if (run.phase === 'ready') comparison = readySide(run.summary);
      else if (run.phase === 'running') {
        comparison = side('running', { progress: { done: run.done, total: run.total } });
      } else if (run.phase === 'error') comparison = side('error', { message: run.message });
    }
  }

  // Stable identity across the many renders a running stress test causes.
  const liveViewedKey = live?.viewedKey ?? null;
  const liveComparisonKey = live?.comparisonKey ?? null;
  const hasLive = live !== null;
  const cacheKeys = useMemo(
    () => (hasLive ? { viewed: liveViewedKey, comparison: liveComparisonKey } : null),
    [hasLive, liveViewedKey, liveComparisonKey],
  );

  return {
    viewed: viewedState,
    comparison,
    verdict: successDeltaVerdict(sample(viewedState), sample(comparison)),
    cacheKeys,
    retry,
    runViewed: viewed.recalculate,
  };
}
