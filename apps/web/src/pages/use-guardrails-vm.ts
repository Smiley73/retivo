/** Guardrails view model: today's funded ratio and verdict for the selected scenario, plus the bounded, cancelable "Check now" Monte Carlo run. */
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

/** Bound on the "Check now" run: a hung worker resolves the page as timed out instead of spinning forever. */
const GUARDRAILS_LIVE_MC_TIMEOUT_MS = 20_000;

const GUARDRAILS_POS_TEMPER_THRESHOLD_PCT = 80;

// Mirrors applyGuardrailStep's EDGE_EPS so a ratio configured exactly on a band reads as at-or-past it.
const EDGE_EPS = 1e-9;

/** `covered` = net need ≤ 0 (ratio null): guaranteed income already funds all spending. */
export type GuardrailVerdict = 'cut' | 'hold' | 'raise' | 'covered';

export interface GuardrailsConfigView {
  readonly enabled: boolean;
  readonly lowerBandPct: number;
  readonly upperBandPct: number;
  readonly stepPct: number;
  readonly maxRaisePct: number;
  readonly discretionaryFloorPct: number;
  readonly usingDefaults: boolean;
}

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
      readonly portfolioNominal: number;
      readonly ratio: number | null;
      readonly verdict: GuardrailVerdict;
      readonly temperedVerdict: GuardrailVerdict;
      readonly pos: PosRunState;
      readonly posProgressDone: number;
      readonly posProgressTotal: number;
      readonly checkNow: () => void;
    };

// fundedRatio returns a decimal but the bands are percentages: compare ratio * 100, or a healthy 1.10 would read as ≤ 85 and misclassify as a cut.
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

    // Resolve the scenario before any MC assembly: a throw or a missing primary ISO means "not fully configured yet".
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

    // Convert to an absolute month index like the engine does: a November retiree is still working through October of the same year.
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

    // The forced enabled: true override makes the engine compute the baseline series regardless of the stored bit.
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
    if (ratioInput === null) return { status: 'scenario-not-configured' };

    const netNeed = ratioInput.guardrailBaselineRealNetNeedByYear;
    const effectiveTaxRate = ratioInput.guardrailEffectiveTaxRate;
    // The override bypasses the enabled gate but not the horizon check: an exhausted horizon omits the flat fields, so treat it as not configured rather than throwing on undefined.
    if (netNeed === undefined || effectiveTaxRate === undefined) {
      return { status: 'scenario-not-configured' };
    }

    // Prorate only year 0 by the fraction of the year remaining: its January-to-today net need is already spent. A no-op in January.
    const yearFractionRemaining = (12 - todayMonthIndex) / 12;
    const proratedNetNeed = netNeed.map((value, index) =>
      index === 0 ? value * yearFractionRemaining : value,
    );

    // Active accounts only, matching the projection and "Check now" MC; including inactive ones would bias the verdict toward hold/raise.
    const portfolioNominal = computePortfolioSummary(
      activeAccounts.map((account) => ({ account, ownerDisplayName: '' })),
      [...data.balances],
    ).summary.totalCurrentBalance;

    // The net-need series is already real, so pair it with an all-1 CPI series; cumCpiByYear.length must equal the net-need length or fundedRatio silently drops liability years.
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

  const [pos, setPos] = useState<PosRunState>({ kind: 'idle' });
  const [posProgressDone, setPosProgressDone] = useState(0);
  const [posProgressTotal, setPosProgressTotal] = useState(0);

  // dispose() is the only teardown (McPool has no abort()) and settles the pending run as aborted.
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

  // Read at click time so "Check now" runs today's actual plan, with no override.
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
    setPosProgressDone(0);
    setPosProgressTotal(built.pathCount);
    // Fixed seed so repeated clicks on unchanged inputs return the same PoS; no cache, since today's balances change daily.
    void pool
      .run(
        { ...built, seed: GUARDRAILS_LIVE_MC_SEED },
        (done, total) => {
          if (runRef.current !== run) return;
          setPosProgressDone(done);
          setPosProgressTotal(total);
        },
      )
      .then((reply) => {
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

  // Keyed off the memoized core so a settled "Check now" PoS can never linger and temper a freshly recomputed verdict; cleanup disposes any in-flight run.
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
