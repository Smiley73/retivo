/**
 * Guardrails page — colocated view-model hook.
 *
 * Computes TODAY's funded ratio for the sidebar-selected scenario off the user's
 * actual account balances and classifies where it falls relative to the selected
 * range (below / within / above — internal `cut` / `hold` / `raise` type values),
 * then owns the on-demand, bounded, cancelable, uncached Monte Carlo run that
 * surfaces the true modeled success rate as context.
 *
 * Two layers, deliberately separate:
 *  1. A SYNCHRONOUS funded-ratio read (no worker) that runs on load. It reuses the
 *     engine's OWN baseline-series math through the `buildMonteCarloInputForScenario`
 *     override — there is exactly one implementation of "net need by year", so
 *     the live ratio can never drift from the projection-time guardrail. `fundedRatio`
 *     (`lib/guardrails.ts`) does the arithmetic; the verdict is a direct, UNIT-
 *     CONVERTED band comparison, never `applyGuardrailStep` (no per-path state
 *     to carry).
 *  2. A "Check now" bounded fresh MC: `AbortController` + timeout +
 *     `createMcPool`, no cache read/write, fixed seed, disposed on unmount / supersede
 *     / settle. The verdict is tempered by that run's PoS: a "raise" with a
 *     thin PoS downgrades to "hold". The PoS run uses the scenario's REAL config, NOT
 *     the forced-on override the ratio read uses.
 *
 * The advisory is scoped to already-retired (drawdown-phase) scenarios: a
 * pre-retirement household gets a defined "not yet retired" state with no MC assembly
 * attempted. Every not-fully-configured case degrades to a defined empty state, never
 * a crash or a NaN/∞.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBalanceProjectionData } from './use-balance-projection-data';
import {
  buildMonteCarloInputForScenario,
  type ScenarioMcInputs,
} from '../lib/monte-carlo-scenario-input';
import { computePortfolioSummary } from '../lib/balance-calc';
import {
  resolveScenario,
  resolveDownturnGuardrailsForScenario,
} from '../lib/scenario-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import {
  fundedRatio,
  DEFAULT_GUARDRAIL_CONFIG,
  type GuardrailConfig,
} from '../lib/guardrails';
import { GUARDRAILS_LIVE_MC_SEED } from '../lib/balance-projection-runner-mc';
import { createMcPool, type McPool } from '../monte-carlo/mc-worker-pool';
import MCWorker from '../workers/monte-carlo.worker.ts?worker';

/** Bound on the "Check now" fresh MC run. Generous — a normal 10,000-path
 *  run on a slow device still completes — while a genuinely hung worker still
 *  resolves the page (as a "timed out" state) instead of spinning forever. */
export const GUARDRAILS_LIVE_MC_TIMEOUT_MS = 20_000;

/** PoS-temper threshold: a "raise" verdict with a fresh-run probability-of-
 *  success below this is downgraded to "hold". A "cut" verdict stands regardless. */
const GUARDRAILS_POS_TEMPER_THRESHOLD_PCT = 80;

/** Funded-ratio band-edge tolerance — mirrors `applyGuardrailStep`'s `EDGE_EPS`
 *  (guardrails.ts) so a ratio configured to land exactly ON a band reads as
 *  at-or-past it, matching the projection-time rule's inclusive edges. */
const EDGE_EPS = 1e-9;

/** Funded-ratio verdict. `covered` = net need ≤ 0 (guaranteed income already funds
 *  all remaining spending, `ratio === null`) — a distinct message, never a
 *  bare "hold". */
export type GuardrailVerdict = 'cut' | 'hold' | 'raise' | 'covered';

/** Config shown in the page summary — all 5 tunables + `enabled`. */
export interface GuardrailsConfigView {
  readonly enabled: boolean;
  readonly lowerBandPct: number;
  readonly upperBandPct: number;
  readonly stepPct: number;
  readonly maxRaisePct: number;
  readonly discretionaryFloorPct: number;
  /** True when NO scenario in the chain configured guardrails — the bands shown
   *  are `DEFAULT_GUARDRAIL_CONFIG`, and the page labels them as defaults. */
  readonly usingDefaults: boolean;
}

/** State of the on-demand "Check now" probability-of-success run. */
export type PosRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly successProbabilityPct: number }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'error' };

export type GuardrailsVm =
  | { readonly status: 'loading' }
  | { readonly status: 'no-accounts' }
  | { readonly status: 'not-yet-retired'; readonly retirementYear: number }
  | { readonly status: 'scenario-not-configured' }
  | {
      readonly status: 'ready';
      readonly scenarioId: string;
      readonly config: GuardrailsConfigView;
      /** Portfolio total the ratio is computed from (today's dollars). */
      readonly portfolioNominal: number;
      /** Funded ratio as a plain decimal (e.g. `1.10` = 110%); `null` when net
       *  need ≤ 0 (suppressed). */
      readonly ratio: number | null;
      /** The funded-ratio verdict BEFORE the PoS temper. */
      readonly verdict: GuardrailVerdict;
      /** The verdict AFTER the PoS temper: `raise` + PoS < threshold →
       *  `hold`. Equals `verdict` until a PoS run has settled. */
      readonly temperedVerdict: GuardrailVerdict;
      readonly pos: PosRunState;
      /** Paths completed / total for the in-flight "Check now" run — drives the
       *  determinate `McProgressBar` while `pos.kind === 'pending'`. `0`/`0`
       *  otherwise. */
      readonly posProgressDone: number;
      readonly posProgressTotal: number;
      /** Trigger the bounded fresh MC run. */
      readonly checkNow: () => void;
    };

/** Direct, unit-converted band classification. `fundedRatio` returns a
 *  DECIMAL, the bands are PERCENTAGES — compare `ratio * 100` against the bands
 *  (mirroring `applyGuardrailStep`'s own `pct = ratio * 100`), never the raw
 *  decimal, or a healthy `1.10` would misread as `≤ 85` and misclassify as a cut. */
function classifyVerdict(
  ratio: number | null,
  config: { lowerBandPct: number; upperBandPct: number },
): GuardrailVerdict {
  if (ratio === null) return 'covered';
  const pct = ratio * 100;
  if (pct <= config.lowerBandPct + EDGE_EPS) return 'cut';
  if (pct >= config.upperBandPct - EDGE_EPS) return 'raise';
  return 'hold';
}

/** The PoS-tempered verdict. Only a `raise` can be downgraded, and only once
 *  a fresh-run PoS is in hand and below the threshold. A `cut` stands regardless. */
function temperVerdict(verdict: GuardrailVerdict, pos: PosRunState): GuardrailVerdict {
  if (
    verdict === 'raise' &&
    pos.kind === 'ready' &&
    pos.successProbabilityPct < GUARDRAILS_POS_TEMPER_THRESHOLD_PCT
  ) {
    return 'hold';
  }
  return verdict;
}

/** The synchronous core of the vm — everything computable without a worker. */
type GuardrailsCore =
  | { readonly status: 'loading' }
  | { readonly status: 'no-accounts' }
  | { readonly status: 'not-yet-retired'; readonly retirementYear: number }
  | { readonly status: 'scenario-not-configured' }
  | {
      readonly status: 'ready';
      readonly scenarioId: string;
      readonly config: GuardrailsConfigView;
      readonly portfolioNominal: number;
      readonly ratio: number | null;
      readonly verdict: GuardrailVerdict;
    };

export function useGuardrailsVm(): GuardrailsVm {
  const data = useBalanceProjectionData();
  const { ready, selectedScenarioId } = data;

  const now = new Date();
  const todayYear = now.getFullYear();
  const todayMonthIndex = now.getMonth(); // 0-based.

  const core = useMemo<GuardrailsCore>(() => {
    if (!ready || !selectedScenarioId) return { status: 'loading' };
    if (!data.scenarios.some((s) => s.id === selectedScenarioId)) {
      return { status: 'loading' };
    }

    // Pre-gate — resolve the scenario for its retirement date BEFORE any MC
    // assembly. A resolve-throw or a null/absent primary ISO is the same
    // "scenario not fully configured yet" state, checked before any `.slice()`.
    let resolved;
    try {
      resolved = resolveScenario(selectedScenarioId, [...data.scenarios]);
    } catch {
      return { status: 'scenario-not-configured' };
    }
    if (!resolved.retirementAge) return { status: 'scenario-not-configured' };

    const primaryMember = data.members.find((m) => m.payload.isPrimary) ?? null;
    if (!primaryMember) return { status: 'scenario-not-configured' };

    const retirementById = resolveMemberRetirementDates(
      resolved.retirementAge,
      data.members.map((m) => ({
        id: m.id,
        isPrimary: m.payload.isPrimary,
        birthdate: m.payload.birthdate,
      })),
    );
    const primaryIso = retirementById.get(primaryMember.id) ?? null;
    if (!primaryIso) return { status: 'scenario-not-configured' };

    // Convert to an absolute month index the SAME way the engine does
    // (balance-projection-runner-context.ts). Year-only is NOT sufficient — a
    // November retiree is still working (and earned-income-funded) through
    // October of the same year.
    const retirementYear = Number(primaryIso.slice(0, 4));
    const retirementMonth0 = Number(primaryIso.slice(5, 7)) - 1;
    const retirementAbsMonth = retirementYear * 12 + retirementMonth0;
    const todayAbsMonth = todayYear * 12 + todayMonthIndex;
    if (retirementAbsMonth > todayAbsMonth) {
      return { status: 'not-yet-retired', retirementYear };
    }

    const activeAccounts = data.accounts.filter((a) => a.payload.active);
    if (activeAccounts.length === 0) return { status: 'no-accounts' };

    const inputs: ScenarioMcInputs = {
      members: data.members,
      accounts: data.accounts,
      balances: data.balances,
      expenses: data.expenses,
      incomeStreams: data.incomeStreams,
      ssBenefits: data.ssBenefits,
      categories: data.expenseCategories,
    };

    // Bands: the scenario's own config, or the defaults when nothing in the chain
    // configured guardrails. The forced `enabled: true` in the override
    // makes the engine compute the baseline series regardless of the stored bit.
    const resolvedGuardrails = resolveDownturnGuardrailsForScenario(
      selectedScenarioId,
      [...data.scenarios],
    );
    const usingDefaults = resolvedGuardrails === undefined;
    const baseConfig = resolvedGuardrails ?? DEFAULT_GUARDRAIL_CONFIG;
    const overrideConfig: GuardrailConfig = { ...baseConfig, enabled: true };

    const ratioInput = buildMonteCarloInputForScenario({
      scenarioId: selectedScenarioId,
      scenarios: data.scenarios,
      inputs,
      todayYear,
      todayMonthIndex,
      guardrailOverrideConfig: overrideConfig,
    });
    // `null` = the scenario can't be projected (no primary retirement /
    // unconfigured CBP) — the runner's own guard degrades gracefully.
    if (ratioInput === null) return { status: 'scenario-not-configured' };

    const netNeed = ratioInput.guardrailBaselineRealNetNeedByYear;
    const effectiveTaxRate = ratioInput.guardrailEffectiveTaxRate;
    // The override bypasses the `enabled` gate but NOT the horizon check —
    // an exhausted horizon (`drawdownYearCount === 0`) returns a non-null input
    // with the flat guardrail fields absent. Treat it as not-configured rather
    // than reading `.length` off `undefined` (which would throw, not NaN).
    if (netNeed === undefined || effectiveTaxRate === undefined) {
      return { status: 'scenario-not-configured' };
    }

    // Index 0 is the CURRENT drawdown year. The engine's per-path MC sums it in
    // full (annual granularity — correct for that projection-time consumer).
    // But the live advisory pairs this liability with TODAY's actual balance, and
    // by mid-year the January→today portion of year 0's net need is already spent,
    // not still owed. Prorate ONLY index 0 by the fraction of the year remaining
    // (`(12 − todayMonthIndex) / 12`); every later year is untouched. In January
    // the factor is 1, so this is a no-op. Reuses the `todayMonthIndex`.
    const yearFractionRemaining = (12 - todayMonthIndex) / 12;
    const proratedNetNeed = netNeed.map((value, index) =>
      index === 0 ? value * yearFractionRemaining : value,
    );

    // The numerator must share the projection/PoS asset basis — ACTIVE accounts
    // only (both the projection and the "Check now" MC filter to active). Using
    // the full list (incl. inactive) would overstate the numerator against an
    // active-only denominator and bias the verdict toward hold/raise.
    const portfolioNominal = computePortfolioSummary(
      activeAccounts.map((account) => ({ account, ownerDisplayName: '' })),
      [...data.balances],
    ).summary.totalCurrentBalance;

    // The baseline net-need series is already REAL (today's dollars), so pair it
    // with an all-1 CPI series — `cumCpiByYear.length` MUST equal the net-need
    // length or `fundedRatio` silently drops liability years and overstates the
    // ratio. `portfolioCumCpi: 1` deflates the already-today's-dollar total
    // by 1.
    const ratio = fundedRatio({
      portfolioNominal,
      portfolioCumCpi: 1,
      netNeedNominalByYear: proratedNetNeed,
      cumCpiByYear: new Array(proratedNetNeed.length).fill(1),
      effectiveTaxRate,
    });

    const config: GuardrailsConfigView = {
      enabled: baseConfig.enabled,
      lowerBandPct: baseConfig.lowerBandPct,
      upperBandPct: baseConfig.upperBandPct,
      stepPct: baseConfig.stepPct,
      maxRaisePct: baseConfig.maxRaisePct,
      discretionaryFloorPct: baseConfig.discretionaryFloorPct ?? 50,
      usingDefaults,
    };

    return {
      status: 'ready',
      scenarioId: selectedScenarioId,
      config,
      portfolioNominal,
      ratio,
      verdict: classifyVerdict(ratio, baseConfig),
    };
  }, [
    ready,
    selectedScenarioId,
    data.scenarios,
    data.members,
    data.accounts,
    data.balances,
    data.expenses,
    data.expenseCategories,
    data.incomeStreams,
    data.ssBenefits,
    todayYear,
    todayMonthIndex,
  ]);

  // --- "Check now" bounded fresh-MC lifecycle --------------------------
  const [pos, setPos] = useState<PosRunState>({ kind: 'idle' });
  // Path-level progress for the in-flight run's determinate `McProgressBar`
  // (matches `MonteCarloProvider`'s `progressDone`/`progressTotal` pattern).
  // Reset to 0/0 whenever there is no in-flight run.
  const [posProgressDone, setPosProgressDone] = useState(0);
  const [posProgressTotal, setPosProgressTotal] = useState(0);

  // The in-flight run, so unmount / supersede can dispose it. `dispose()` is the
  // only teardown (`McPool` has no `.abort()`); it also settles the pending run
  // as `{ kind: 'aborted' }`.
  const runRef = useRef<{
    pool: McPool;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);

  const teardownRun = useCallback((): void => {
    const run = runRef.current;
    if (!run) return;
    runRef.current = null;
    clearTimeout(run.timeout);
    run.pool.dispose();
    setPosProgressDone(0);
    setPosProgressTotal(0);
  }, []);

  // Latest base MC input builder (NO override — the scenario's REAL config),
  // read at click time so "Check now" always runs today's actual plan.
  const buildPosInputRef = useRef<() => ReturnType<typeof buildMonteCarloInputForScenario>>(
    () => null,
  );
  buildPosInputRef.current = () => {
    if (core.status !== 'ready') return null;
    return buildMonteCarloInputForScenario({
      scenarioId: core.scenarioId,
      scenarios: data.scenarios,
      inputs: {
        members: data.members,
        accounts: data.accounts,
        balances: data.balances,
        expenses: data.expenses,
        incomeStreams: data.incomeStreams,
        ssBenefits: data.ssBenefits,
        categories: data.expenseCategories,
      },
      todayYear,
      todayMonthIndex,
    });
  };

  const checkNow = useCallback((): void => {
    const built = buildPosInputRef.current();
    // Supersede any in-flight run cleanly before starting a new one.
    teardownRun();
    if (built === null) {
      setPos({ kind: 'error' });
      return;
    }
    const controller = new AbortController();
    const pool = createMcPool({
      factory: () => new MCWorker(),
      size: 1,
      signal: controller.signal,
    });
    const timeout = setTimeout(
      () => controller.abort(),
      GUARDRAILS_LIVE_MC_TIMEOUT_MS,
    );
    const run = { pool, timeout };
    runRef.current = run;
    setPos({ kind: 'pending' });
    // Seed the bar with the known path count immediately (built.pathCount is
    // available synchronously) so it renders determinate from the first paint
    // instead of starting at indeterminate then jumping once the worker's
    // first progress message arrives.
    setPosProgressDone(0);
    setPosProgressTotal(built.pathCount);
    // Fixed seed so repeated clicks on unchanged inputs return the same PoS; no
    // cache read/write — today's balances change daily.
    void pool
      .run(
        { ...built, seed: GUARDRAILS_LIVE_MC_SEED },
        (done, total) => {
          // Stale progress from a superseded/torn-down run — drop it.
          if (runRef.current !== run) return;
          setPosProgressDone(done);
          setPosProgressTotal(total);
        },
      )
      .then((reply) => {
        // A newer run (or an unmount) has taken over — drop this stale reply.
        if (runRef.current !== run) return;
        runRef.current = null;
        clearTimeout(timeout);
        pool.dispose();
        setPosProgressDone(0);
        setPosProgressTotal(0);
        if (reply.kind === 'result') {
          setPos({
            kind: 'ready',
            successProbabilityPct: reply.summary.successProbability * 100,
          });
        } else if (reply.kind === 'aborted') {
          setPos({ kind: 'timed-out' });
        } else {
          setPos({ kind: 'error' });
        }
      });
  }, [teardownRun]);

  // Reset the PoS + tear down any in-flight run whenever the funded-ratio `core`
  // recomputes — i.e. on ANY of the same reactive inputs it derives from (the
  // scenario pick, but also account balances, guardrail config, expenses,
  // income, members, or Social Security benefits), not just `selectedScenarioId`.
  // Keying off the memoized `core` reference (the stable signature of exactly
  // that recompute surface) guarantees a settled "Check now" PoS can never linger
  // and temper a freshly recomputed verdict against inputs it no longer reflects.
  // Cleanup disposes on unmount / this same recompute so no worker leaks.
  useEffect(() => {
    setPos({ kind: 'idle' });
    teardownRun();
    return () => teardownRun();
  }, [core, teardownRun]);

  if (core.status !== 'ready') return core;
  return {
    status: 'ready',
    scenarioId: core.scenarioId,
    config: core.config,
    portfolioNominal: core.portfolioNominal,
    ratio: core.ratio,
    verdict: core.verdict,
    temperedVerdict: temperVerdict(core.verdict, pos),
    pos,
    posProgressDone,
    posProgressTotal,
    checkNow,
  };
}
