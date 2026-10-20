/**
 * Lazy per-scenario deterministic metrics for the Scenarios index cards.
 *
 * The Graphite Spectrum scenario cards show an **at-horizon** number plus
 * a **balance sparkline** per scenario,
 * both from the DETERMINISTIC ("planned") projection only,
 * AND MC summary metrics read from the PERSISTED Monte Carlo cache.
 *
 * The plan-success read is NOT a Monte Carlo run — it never spawns a
 * worker. For each scenario we assemble the same `MonteCarloInput` the
 * Balance Projection page feeds the worker (via the shared
 * `buildMonteCarloInputForScenario` helper — identical assembly, identical
 * `pathCount`, so the `computeCacheKey` matches the BPP page's entry), then
 * `getCached(key)`. A hit shows the cached Typical / Pessimistic
 * at-horizon balances plus `successProbability`; a miss shows "—" plus a
 * per-card "Recalculate" affordance (the card runs MC for that one
 * scenario on demand). Running MC in bulk on render is still a perf
 * non-starter and is never done here.
 *
 * Even the deterministic projection (`runBalanceProjectionForPage` via
 * `loadPageData`) is CPU-bound, so we never run all scenarios synchronously
 * on render: the cards paint immediately with a placeholder, then this hook
 * fills each scenario's metrics one at a time, yielding to the event loop
 * between scenarios (`requestIdleCallback`, falling back to `setTimeout`).
 * The persona has only a handful of scenarios, so a short serial drip keeps
 * the list responsive without a worker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { idVersionSignature } from '../lib/aggregate-signature';
import type { MonteCarloInput, MonteCarloSummary } from '../lib/monte-carlo';
import { loadPageData } from './balance-projection-page-data';
import { loadProjectionInputs, type ProjectionInputs } from '../lib/projection-inputs';
import { useAggregates } from '../lib/use-aggregates';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { buildMonteCarloInputForScenario } from '../lib/monte-carlo-scenario-input';
import { getCached, mcCacheKey } from '../db/monte-carlo-cache';
import { realDeflatorAt } from '../lib/projection-context';
import type { RunBalanceProjectionPageResult } from '../lib/balance-projection-runner';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';

/** Plan-success state for a card: a cache `hit` carries the percent;
 *  `missing` means no cached MC run exists for this scenario's current
 *  inputs (the card offers a per-card "Recalculate"). */
type PlanSuccessState = 'hit' | 'missing';

/** Resolved deterministic metrics + the cached plan-success for one card. */
export interface ScenarioCardMetrics {
  /** Planned deterministic at-horizon portfolio balance in today's dollars.
   *  `null` when the projection could not run (no primary retirement /
   *  no accounts). */
  readonly endingBalance: number | null;
  /** Per-year planned deterministic portfolio balances in today's dollars
   *  (sparkline series). Empty when the projection could not run. */
  readonly series: ReadonlyArray<number>;
  /** Historical (TWR) deterministic at-horizon portfolio balance in today's dollars.
   *  `null` when TWR is unavailable (no 2yr balance history) or projection failed. */
  readonly historicalEndingBalance: number | null;
  /** Per-year Historical (TWR) deterministic portfolio balances in today's dollars
   *  (sparkline series). Empty when TWR is unavailable or projection failed. */
  readonly historicalSeries: ReadonlyArray<number>;
  /** Cached Monte Carlo plan-success percent (0–100) when an entry exists
   *  for this scenario's current inputs; `null` on a miss or when the
   *  scenario can't run MC at all (no primary retirement / no accounts). */
  readonly planSuccessPct: number | null;
  /** Cached Monte Carlo P50 at-horizon balance in today's dollars. */
  readonly typicalAtHorizon: number | null;
  /** Cached Monte Carlo per-year P50 ("Typical") portfolio balances in
   *  today's dollars — the sparkline beside the `typicalAtHorizon` value.
   *  Spans the cached run's firstYear..horizon (longer than the
   *  deterministic `series`, which starts at retirement); the card tail-
   *  aligns it to the deterministic window before plotting. Empty on a
   *  cache miss / when MC can't run. */
  readonly typicalSeries: ReadonlyArray<number>;
  /** Cached Monte Carlo per-year P25 ("Pessimistic") portfolio balances in
   *  today's dollars — the sparkline beside the `pessimisticAtHorizon`
   *  value. Same firstYear..horizon span + tail-alignment as
   *  `typicalSeries`. Empty on a cache miss / when MC can't run. */
  readonly pessimisticSeries: ReadonlyArray<number>;
  /** Cached Monte Carlo P25 at-horizon balance in today's dollars. */
  readonly pessimisticAtHorizon: number | null;
  /** Whether a cached MC entry was found. `missing` → the card shows "—"
   *  plus a "Recalculate" affordance (only when the scenario CAN run MC). */
  readonly planSuccessState: PlanSuccessState;
  /** True when MC is runnable for this scenario (a `MonteCarloInput` could
   *  be assembled). When false the card shows "—" with NO recalc control —
   *  there is nothing to run (e.g. no primary retirement / no accounts). */
  readonly canRunMc: boolean;
  /** User-facing explanation when the deterministic projection failed for a
   *  recognised, fixable configuration clash (currently: a per-account
   *  withdrawal strategy combined with a retirementAllocation override). The
   *  card shows this instead of silently blank metrics. Absent otherwise. */
  readonly configError?: string;
}

/** The subset of card fields derived from a Monte Carlo summary (a cache
 *  hit OR an in-hand pool reply). The shared `planSuccessFromSummary` mapper
 *  produces these so the bulk-recompute card render is byte-equal to the
 *  cache-read render. */
type PlanSuccessMetrics = Pick<
  ScenarioCardMetrics,
  | 'planSuccessPct'
  | 'typicalAtHorizon'
  | 'pessimisticAtHorizon'
  | 'typicalSeries'
  | 'pessimisticSeries'
  | 'planSuccessState'
  | 'canRunMc'
>;

/** Per-scenario metric state: `undefined` while pending (placeholder), a
 *  resolved value once the deterministic projection settles. */
type ScenarioMetricsById = ReadonlyMap<string, ScenarioCardMetrics>;

/** Hook result: the per-card metrics map plus the helpers the page needs to
 *  drive on-demand MC recompute. */
export interface ScenarioCardMetricsResult {
  /** Deterministic at-horizon + sparkline + cached MC metrics, keyed by
   *  scenario id. A scenario absent from the map is still pending. */
  readonly metrics: ScenarioMetricsById;
  /** Build the `MonteCarloInput` for a scenario (same assembly + pathCount
   *  the BPP page uses), or `null` when MC can't run / inputs not loaded
   *  yet. Pure + synchronous; the page hands the result to the provider. */
  readonly buildMcInput: (scenarioId: string) => MonteCarloInput | null;
  /** Re-read the persisted MC cache for one scenario and patch its cached
   *  MC metrics into the metrics map. Called after a recompute completes so
   *  the card fills in without re-running the deterministic projection. */
  readonly refreshPlanSuccess: (scenarioId: string) => Promise<void>;
  /** Patch one scenario's plan-success card fields DIRECTLY from an in-hand
   *  `MonteCarloSummary` (no cache re-read). The bulk-recompute hook calls
   *  this from each pool reply so a freshly-computed card never depends on
   *  surviving a concurrent IDB-cache eviction. */
  readonly applyPlanSuccess: (
    scenarioId: string,
    summary: MonteCarloSummary,
  ) => void;
  /** All scenario ids that can run MC (for "Recalculate all" to queue). */
  readonly recalcableScenarioIds: ReadonlyArray<string>;
}

/** Idle-yield shim: prefer `requestIdleCallback`, fall back to a macrotask. */
function yieldToIdle(run: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(run);
    const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void })
      .cancelIdleCallback;
    return () => cancel?.(id);
  }
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
}

/**
 * Compute the deterministic at-horizon balance + sparkline series for every
 * scenario, lazily and serially. Returns a map keyed by scenario id; a
 * scenario absent from the map is still pending (the card shows a
 * placeholder). Recomputes when the scenario set changes or an aggregate
 * edit fires the scenario-mutation channels.
 */
export function useScenarioCardMetrics(
  scenarios: ReadonlyArray<ScenarioAggregate>,
): ScenarioCardMetricsResult {
  const [metrics, setMetrics] = useState<ScenarioMetricsById>(new Map());
  // Reactive revision signal (revision-signal substitution
  // only). The deterministic metrics come from an imperative multi-aggregate
  // batch load (`loadProjectionInputs`), which `useAggregates` row arrays
  // can't replace; instead we subscribe to every store the batch reads and
  // recompute when any of their `aggregates` arrays change identity (a single
  // write, a bulk fill, or a scenario edit/delete). The subscribed set is the
  // exact superset of every `listAggregates` type in `loadProjectionInputs`
  // (7 types). Scenario rows themselves arrive via the `scenarios` prop's
  // `signature`, so this set deliberately omits the `scenario` store — the
  // cards' output does not depend on which scenario is "selected" in the
  // sidebar, only on the data the projection consumes.
  const memberRevision = useAggregates('householdMember').aggregates;
  const accountRevision = useAggregates('account').aggregates;
  const balanceRevision = useAggregates('accountBalance').aggregates;
  const expenseRevision = useAggregates('expense').aggregates;
  const incomeRevision = useAggregates('incomeStream').aggregates;
  const ssBenefitRevision = useAggregates('socialSecurityBenefit').aggregates;
  const categoryRevision = useAggregates('expenseCategory').aggregates;
  // The loaded aggregate batch + render clock for the current pass. Kept in
  // a ref so the page's on-demand recompute helpers can re-assemble a
  // scenario's `MonteCarloInput` synchronously without re-reading IDB.
  const passRef = useRef<{
    inputs: ProjectionInputs;
    todayYear: number;
    todayMonthIndex: number;
    scenarios: ReadonlyArray<ScenarioAggregate>;
  } | null>(null);

  // Stable signature of the scenario set so the effect only re-runs when
  // the membership / payload actually changes (not on every render).
  const signature = idVersionSignature(scenarios);

  const cancelRef = useRef<(() => void) | null>(null);

  // Committed loaded batch for the current pass. The load effect reads the
  // batch on every reactive settle but only swaps in a fresh object when the
  // content signature changed — so a no-op re-read keeps the SAME `loaded`
  // reference and the drip effect below (keyed on it) does not re-fire. This
  // mirrors `SsOptimizerPage`'s `aggregatesSignatureRef` bail-early, kept in
  // state (not a ref-only short-circuit) so the gate survives the React
  // double-invoke on mount instead of swallowing the first drip.
  interface LoadedPass {
    readonly inputs: ProjectionInputs;
    readonly signature: string;
    readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  }
  const [loaded, setLoaded] = useState<LoadedPass | null>(null);
  const loadedSignatureRef = useRef<string | null>(null);

  // Load effect: re-read the batch on mount + every subscribed store's
  // revision signal, and commit it only when the content signature (scenario
  // set + ids/versions across all seven projection stores) actually changed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const inputs = await loadProjectionInputs();
      if (cancelled) return;
      const passSignature = `${signature}#${projectionInputsSignature(inputs)}`;
      if (passSignature === loadedSignatureRef.current) return;
      loadedSignatureRef.current = passSignature;
      setLoaded({ inputs, signature: passSignature, scenarios });
    })();
    return () => {
      cancelled = true;
    };
    // `signature` captures the meaningful scenario-set identity; `scenarios`
    // is read inside but its identity churns every render, so we key on the
    // signature + each subscribed store's `aggregates` array (the reactive
    // bulk-fill / edit signal — see the revision-signal note above).
  }, [
    signature,
    memberRevision,
    accountRevision,
    balanceRevision,
    expenseRevision,
    incomeRevision,
    ssBenefitRevision,
    categoryRevision,
  ]);

  // Drip effect: clear the cards + serially fill each scenario's metrics from
  // the committed batch. Re-runs only when `loaded` swaps to a new object — a
  // no-op re-read leaves `loaded` referentially stable, so the cards are never
  // reset to placeholders nor re-dripped for unchanged data.
  useEffect(() => {
    if (!loaded) return;
    const { inputs, scenarios: passScenarios } = loaded;
    let cancelled = false;
    cancelRef.current?.();
    // Fresh map for this pass — cards drop back to placeholders while the
    // recompute drips in (rare: only after a real edit).
    setMetrics(new Map());
    const renderNow = new Date();
    const todayYear = renderNow.getFullYear();
    const todayMonthIndex = renderNow.getMonth();
    passRef.current = { inputs, todayYear, todayMonthIndex, scenarios: passScenarios };
    const queue = [...passScenarios];

    const step = (): void => {
      if (cancelled) return;
      const next = queue.shift();
      if (!next) return;
      // Deterministic metrics are synchronous; the plan-success cache
      // read is async (crypto.subtle + IDB). Compute the deterministic
      // half first, set it, then patch in the cache read when it lands —
      // both stay on the lazy/idle drip so the list never blocks.
      void computeScenarioMetrics({
        scenarioId: next.id,
        scenarios: passScenarios,
        inputs,
        todayYear,
        todayMonthIndex,
      }).then((computed) => {
        if (cancelled) return;
        setMetrics((prev) => {
          const merged = new Map(prev);
          merged.set(next.id, computed);
          return merged;
        });
      });
      if (queue.length > 0) {
        cancelRef.current = yieldToIdle(step);
      }
    };
    cancelRef.current = yieldToIdle(step);
    return () => {
      cancelled = true;
      cancelRef.current?.();
    };
  }, [loaded]);

  const buildMcInput = useCallback(
    (scenarioId: string): MonteCarloInput | null => {
      const pass = passRef.current;
      if (!pass) return null;
      return buildMonteCarloInputForScenario({
        scenarioId,
        scenarios: pass.scenarios,
        inputs: pass.inputs,
        todayYear: pass.todayYear,
        todayMonthIndex: pass.todayMonthIndex,
      });
    },
    [],
  );

  const refreshPlanSuccess = useCallback(
    async (scenarioId: string): Promise<void> => {
      const input = buildMcInput(scenarioId);
      const read = await readCachedPlanSuccess(input);
      setMetrics((prev) => {
        const existing = prev.get(scenarioId);
        if (!existing) return prev;
        const merged = new Map(prev);
        merged.set(scenarioId, { ...existing, ...read });
        return merged;
      });
    },
    [buildMcInput],
  );

  const applyPlanSuccess = useCallback(
    (scenarioId: string, summary: MonteCarloSummary): void => {
      const read = planSuccessFromSummary(summary);
      setMetrics((prev) => {
        const existing = prev.get(scenarioId);
        if (!existing) return prev;
        const merged = new Map(prev);
        merged.set(scenarioId, { ...existing, ...read });
        return merged;
      });
    },
    [],
  );

  const recalcableScenarioIds = useMemo(
    () =>
      scenarios
        .map((s) => s.id)
        .filter((id) => metrics.get(id)?.canRunMc === true),
    // Recompute the recalcable set as cards resolve (canRunMc fills in).
    [scenarios, metrics],
  );

  return {
    metrics,
    buildMcInput,
    refreshPlanSuccess,
    applyPlanSuccess,
    recalcableScenarioIds,
  };
}

/**
 * Cheap content signature of a loaded projection batch — every aggregate's
 * `id:version` across all seven sets. The hook uses it to skip the
 * card-clearing re-drip on a no-op re-read: each subscribed `useAggregates`
 * hook settles its array once on mount and again on every store write, so a
 * naive recompute on each settle would reset every card to a placeholder and
 * re-run the full lazy deterministic drip for identical data. A real edit
 * (new version / added / removed row) changes the signature and so still
 * recomputes. Mirrors `optimizerAggregatesSignature` (DRY via
 * `idVersionSignature`).
 */
function projectionInputsSignature(inputs: ProjectionInputs): string {
  return [
    idVersionSignature(inputs.members),
    idVersionSignature(inputs.accounts),
    idVersionSignature(inputs.balances),
    idVersionSignature(inputs.expenses),
    idVersionSignature(inputs.incomeStreams),
    idVersionSignature(inputs.ssBenefits),
    idVersionSignature(inputs.categories),
  ].join('|');
}

/**
 * Run the deterministic ("planned") projection for one scenario, pull out
 * the at-horizon balance + per-year balance series, AND read the persisted MC
 * cache for the plan-success percent (no worker — a pure IDB read keyed by
 * the SAME `MonteCarloInput` the BPP page uses). Wrapped in try/catch: a
 * scenario whose context can't build (no primary retirement, no active
 * accounts, CBP unconfigured) resolves to an empty metric — the card shows
 * the placeholder rather than crashing the whole list.
 */
async function computeScenarioMetrics(opts: {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly inputs: ProjectionInputs;
  readonly todayYear: number;
  readonly todayMonthIndex: number;
}): Promise<ScenarioCardMetrics> {
  // Deterministic ending-balance + sparkline (synchronous).
  let endingBalance: number | null = null;
  let series: ReadonlyArray<number> = [];
  let historicalEndingBalance: number | null = null;
  let historicalSeries: ReadonlyArray<number> = [];
  let configError: string | undefined;
  try {
    const data = loadPageData({
      scenarios: opts.scenarios,
      selectedScenarioId: opts.scenarioId,
      members: opts.inputs.members,
      accounts: opts.inputs.accounts,
      balances: opts.inputs.balances,
      expenses: opts.inputs.expenses,
      incomeStreams: opts.inputs.incomeStreams,
      ssBenefits: opts.inputs.ssBenefits,
      categories: opts.inputs.categories,
      todayYear: opts.todayYear,
      todayMonthIndex: opts.todayMonthIndex,
    });
    ({ endingBalance, series, historicalEndingBalance, historicalSeries } =
      deriveScenarioDeterministicMetrics(data.pageResult));
  } catch (e) {
    // Leave deterministic metrics at their empty defaults — but surface a
    // recognised, fixable config clash so the card can explain itself.
    configError = friendlyProjectionErrorMessage(e) ?? undefined;
  }

  // Cache-read MC metrics (async, read-only — never runs MC).
  const mcInput = buildMonteCarloInputForScenario({
    scenarioId: opts.scenarioId,
    scenarios: opts.scenarios,
    inputs: opts.inputs,
    todayYear: opts.todayYear,
    todayMonthIndex: opts.todayMonthIndex,
  });
  const planSuccess = await readCachedPlanSuccess(mcInput);

  return {
    endingBalance,
    series,
    historicalEndingBalance,
    historicalSeries,
    ...planSuccess,
    ...(configError ? { configError } : {}),
  };
}

export function deriveScenarioDeterministicMetrics(
  pageResult: RunBalanceProjectionPageResult | null,
): Pick<
  ScenarioCardMetrics,
  'endingBalance' | 'series' | 'historicalEndingBalance' | 'historicalSeries'
> {
  if (!pageResult) {
    return {
      endingBalance: null,
      series: [],
      historicalEndingBalance: null,
      historicalSeries: [],
    };
  }
  const ctx = pageResult.sharedCtx.ctx;
  const planned = pageResult.planned;
  // Historical = the already-computed deterministic TWR slice (same shared
  // pass; null-safe when TWR's 2yr-history gate isn't met). Today's-dollar
  // deflation mirrors the planned path off the same ctx. Derived independently
  // of planned so a planned-only calibration failure (`MissingCustomDrawdownOrderError`
  // / `MagiCapCalibrationError` swallowed by `runDrawdownForMethodSafe`) does
  // not suppress Historical when twr is still populated.
  const twr = pageResult.twr ?? null;
  const deflate = (
    years: ReadonlyArray<{ year: number; balance: number }>,
  ): ReadonlyArray<number> =>
    years.map((y) => y.balance * realDeflatorAt(ctx, y.year, 11));
  // Both branches require a non-empty `years` slice: a non-null result with
  // `years: []` (reachable on the `horizon <= retirement` edge) still carries
  // a synthetic `atHorizonTodayDollars`, which we suppress so the value and
  // the sparkline blank together rather than showing a number with no line.
  const hasPlanned = !!planned && planned.years.length > 0;
  const hasTwr = !!twr && twr.years.length > 0;
  return {
    endingBalance: hasPlanned ? planned.atHorizonTodayDollars : null,
    series: hasPlanned ? deflate(planned.years) : [],
    historicalEndingBalance: hasTwr ? twr.atHorizonTodayDollars : null,
    historicalSeries: hasTwr ? deflate(twr.years) : [],
  };
}

/**
 * Map a `MonteCarloSummary` (a cache hit OR an in-hand pool reply) into the
 * card's plan-success fields. Single owner so the bulk-recompute card render
 * (patched from the returned summary) is byte-equal to the cache-read render.
 */
function planSuccessFromSummary(
  summary: MonteCarloSummary,
): PlanSuccessMetrics {
  return {
    planSuccessPct: summary.successProbability * 100,
    typicalAtHorizon: summary.medianEndingBalanceReal,
    pessimisticAtHorizon: summary.p25EndingBalanceReal,
    // Per-year P50 / P25 real balances — already today's dollars, same
    // units as the deterministic series. The card tail-aligns these to
    // the deterministic (retirement..horizon) window before plotting.
    typicalSeries: summary.percentilesReal.p50,
    pessimisticSeries: summary.percentilesReal.p25,
    planSuccessState: 'hit',
    canRunMc: true,
  };
}

/** Plan-success fields for a scenario that has no cached run (a miss).
 *  `canRunMc` is true when an input could be assembled; false when MC can't
 *  run for this scenario at all (no recalc affordance). */
function planSuccessMiss(canRunMc: boolean): PlanSuccessMetrics {
  return {
    planSuccessPct: null,
    typicalAtHorizon: null,
    pessimisticAtHorizon: null,
    typicalSeries: [],
    pessimisticSeries: [],
    planSuccessState: 'missing',
    canRunMc,
  };
}

/**
 * Read the persisted MC cache for a scenario's `MonteCarloInput` (the shared
 * `mcCacheKey` derivation: full input, `seed` + `onProgress` excluded). A
 * `null` input means MC can't run for this scenario (no recalc affordance).
 * Failures degrade to a miss. Reuses `planSuccessFromSummary` on a hit.
 */
async function readCachedPlanSuccess(
  mcInput: MonteCarloInput | null,
): Promise<PlanSuccessMetrics> {
  if (!mcInput) {
    return planSuccessMiss(false);
  }
  try {
    const key = await mcCacheKey(mcInput);
    const cached = await getCached(key);
    if (cached) {
      return planSuccessFromSummary(cached);
    }
    return planSuccessMiss(true);
  } catch {
    return planSuccessMiss(true);
  }
}
