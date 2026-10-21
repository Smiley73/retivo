/**
 * Pure helpers for `SsOptimizerPage.tsx` — row shape, dispatch loops
 * (deterministic + MC), aggregate fan-out, soft-refresh + cache splice
 * primitives, and re-exports of the Apply-flow helpers. Extracted so
 * the page stays under the ≤400-ln shape cap.
 */
import { dispatchToOptimizerWorker } from '../lib/optimizer-worker-dispatch';
import { idVersionSignature } from '../lib/aggregate-signature';
import { listAggregates } from '../db/store';
import { medicalCategoryIdsFrom } from '../lib/expense-category-resolvers';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';
import type {
  OptimizerMcOutcome,
  OptimizerMcProgress,
  OptimizerMcResult,
  OptimizerMcScenarioProgress,
  RunOptimizerMonteCarloArgs,
} from '../lib/optimizer-mc-runner';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type {
  OptimizerWorkerInput,
  OptimizerWorkerOutbound,
} from '../workers/claim-age-optimizer.worker';
import type {
  OptimizerAggregates,
  ScenarioRow,
} from './ss-optimizer-page-chrome';
export {
  buildApplyConfirmArgs,
  applyMergedOverride,
} from './ss-optimizer-apply-helpers';

/**
 * Pure splice: returns the row array with the (scenarioId, method)
 * child slot populated. Exposed so the page effect's `onMethodResult`
 * callback stays a one-liner.
 */
export function spliceMethodResult(
  rows: ReadonlyArray<ScenarioRow>,
  scenarioId: string,
  method: ProjectionMethod,
  out: OptimizerWorkerOutbound,
): ScenarioRow[] {
  return rows.map((row) => {
    if (row.scenario.id !== scenarioId || !row.methods) return row;
    const nextMethods = {
      ...row.methods,
      [method]: { loading: false, result: out },
    };
    const stillLoading =
      nextMethods.planned.loading || nextMethods.twr.loading;
    return { ...row, methods: nextMethods, loading: stillLoading };
  });
}

/** Pure predicate: all deterministic children have resolved. */
export function allMethodsResolved(rows: ReadonlyArray<ScenarioRow>): boolean {
  return rows.every(
    (r) =>
      !r.methods ||
      (!r.methods.planned.loading && !r.methods.twr.loading),
  );
}

/** Methods the deterministic dispatch loop covers — one worker post
 *  per (scenario, method). Defined once so the orchestrator + progress
 *  totals share one source of truth. */
const DET_METHODS: ReadonlyArray<ProjectionMethod> = ['planned', 'twr'];

/** Parallel `listAggregates` fan-out — every aggregate type the
 *  optimizer reads. Lives here so the page stays under the ≤400-ln
 *  shape limit. */
export async function loadOptimizerAggregates(): Promise<OptimizerAggregates> {
  const [
    scenarios,
    members,
    accounts,
    balances,
    ssBenefits,
    expenses,
    incomeStreams,
    categories,
  ] = (await Promise.all([
    listAggregates('scenario'),
    listAggregates('householdMember'),
    listAggregates('account'),
    listAggregates('accountBalance'),
    listAggregates('socialSecurityBenefit'),
    listAggregates('expense'),
    listAggregates('incomeStream'),
    listAggregates('expenseCategory'),
  ])) as [
    ScenarioAggregate[],
    Aggregate<HouseholdMemberPayload>[],
    Aggregate<AccountPayload>[],
    Aggregate<AccountBalancePayload>[],
    Aggregate<SocialSecurityBenefitPayload>[],
    Aggregate<ExpensePayload>[],
    Aggregate<IncomeStreamPayload>[],
    Aggregate<ExpenseCategoryPayload>[],
  ];
  return {
    scenarios,
    members,
    accounts,
    balances,
    ssBenefits,
    expenses,
    incomeStreams,
    medicalCategoryIds: medicalCategoryIdsFrom(categories),
  };
}

/**
 * Cheap content signature of a loaded optimizer batch — every aggregate's
 * `id:version` across all sets plus the resolved medical-category ids. The
 * page uses it to keep the `aggregates` state reference stable across
 * no-op re-reads (each `useAggregates` subscription settles its array once
 * on mount and on every store write); a real edit changes a version / set
 * membership and so changes the signature, restarting the dependent runs +
 * invalidating the row cache.
 */
export function optimizerAggregatesSignature(
  aggregates: OptimizerAggregates,
): string {
  return [
    idVersionSignature(aggregates.scenarios),
    idVersionSignature(aggregates.members),
    idVersionSignature(aggregates.accounts),
    idVersionSignature(aggregates.balances),
    idVersionSignature(aggregates.ssBenefits),
    idVersionSignature(aggregates.expenses),
    idVersionSignature(aggregates.incomeStreams),
    [...aggregates.medicalCategoryIds].sort().join(','),
  ].join('|');
}

export function mcRowFromOutcome(
  scenario: ScenarioAggregate,
  outcome: OptimizerMcOutcome | undefined,
  scenarios: ReadonlyArray<ScenarioAggregate>,
): ScenarioRow {
  // Map each MC outcome kind to the worker-equivalent payload so the
  // page's row-view derivation handles MC + deterministic uniformly.
  // `cancelled` keeps `result: null` but flags the row so the table
  // routes it to `CancelledRow` (em-dashes + "Cancelled") instead of
  // the pre-run idle state.
  if (!outcome || outcome.kind === 'cancelled') {
    return {
      scenario,
      parentName: parentNameOf(scenario, scenarios),
      result: null,
      loading: false,
      cancelled: outcome?.kind === 'cancelled',
    };
  }
  let result: OptimizerWorkerOutbound;
  switch (outcome.kind) {
    case 'result':
      result = {
        kind: 'result',
        runId: '',
        scenarioId: scenario.id,
        winner: outcome.winner
          ? {
              primaryAgeYears: outcome.winner.primaryAgeYears,
              ...(outcome.winner.primaryAgeMonths !== undefined
                ? { primaryAgeMonths: outcome.winner.primaryAgeMonths }
                : {}),
              secondaryAgeYears: outcome.winner.secondaryAgeYears,
              ...(outcome.winner.secondaryAgeMonths !== undefined
                ? { secondaryAgeMonths: outcome.winner.secondaryAgeMonths }
                : {}),
              metricValue: outcome.winner.metricValue,
              alreadyAtOptimum: outcome.alreadyAtOptimum,
            }
          : null,
        partial: outcome.partial,
        missingPiaMembers: outcome.missingPiaMembers,
        baselineMetricValue: outcome.baselineMetricValue,
        ...(outcome.assumedDeathAge !== undefined
          ? { assumedDeathAge: outcome.assumedDeathAge }
          : {}),
      };
      break;
    case 'empty':
      result = {
        kind: 'empty',
        runId: '',
        scenarioId: scenario.id,
        reason: outcome.reason,
      };
      break;
    case 'unsupported':
      result = {
        kind: 'unsupported',
        runId: '',
        scenarioId: scenario.id,
        reason: outcome.reason,
      };
      break;
    case 'error':
      result = {
        kind: 'error',
        runId: '',
        scenarioId: scenario.id,
        message: outcome.message,
      };
      break;
  }
  return {
    scenario,
    parentName: parentNameOf(scenario, scenarios),
    result,
    loading: false,
  };
}

function parentNameOf(
  scenario: ScenarioAggregate,
  all: ReadonlyArray<ScenarioAggregate>,
): string | null {
  const parentId = scenario.payload.parentScenarioId;
  if (!parentId) return null;
  const parent = all.find((s) => s.id === parentId);
  return parent?.payload.name ?? null;
}

/**
 * Filter out soft-deleted scenarios and sort primary-first, then by
 * `name`. Used by both the deterministic + MC dispatch paths so row
 * order matches across metric switches.
 */
export function orderScenarios(
  scenarios: ReadonlyArray<ScenarioAggregate>,
): ScenarioAggregate[] {
  const nonDeleted = scenarios.filter((s) => !s.deletedAt);
  return [...nonDeleted].sort((a, b) =>
    a.payload.isPrimary === b.payload.isPrimary
      ? a.payload.name.localeCompare(b.payload.name)
      : a.payload.isPrimary
        ? -1
        : 1,
  );
}

/**
 * Seed the per-scenario row array with `loading: true` placeholders.
 *  - `metric === 'balance'` → seeds two-method children (Planned + TWR)
 *    so the deterministic table renders parent + 2 child rows from
 *    first paint.
 *  - `metric === 'mc'` → seeds the legacy single-row shape (MC path
 *    unchanged).
 */
export function buildInitialRows(
  ordered: ReadonlyArray<ScenarioAggregate>,
  allScenarios: ReadonlyArray<ScenarioAggregate>,
  metric: 'balance' | 'mc' = 'mc',
): ScenarioRow[] {
  return ordered.map((s) => {
    const base = {
      scenario: s,
      parentName: parentNameOf(s, allScenarios),
      result: null,
      loading: true,
    };
    if (metric === 'balance') {
      return {
        ...base,
        methods: {
          planned: { loading: true, result: null },
          twr: { loading: true, result: null },
        },
      };
    }
    return base;
  });
}

/** Aggregate-change refresh: keep existing results visible (worker
 *  overwrites them in place), add new scenarios as loading
 *  placeholders, drop removed ones. Preserves both deterministic
 *  children when present. */
export function softRefreshRows(
  current: ReadonlyArray<ScenarioRow>,
  ordered: ReadonlyArray<ScenarioAggregate>,
  allScenarios: ReadonlyArray<ScenarioAggregate>,
  metric: 'balance' | 'mc' = 'mc',
): ScenarioRow[] {
  const byId = new Map(current.map((r) => [r.scenario.id, r]));
  return ordered.map((s) => {
    const existing = byId.get(s.id);
    const parentName = parentNameOf(s, allScenarios);
    if (existing) return { ...existing, scenario: s, parentName };
    const seed: ScenarioRow = {
      scenario: s,
      parentName,
      result: null,
      loading: true,
    };
    if (metric === 'balance') {
      return {
        ...seed,
        methods: {
          planned: { loading: true, result: null },
          twr: { loading: true, result: null },
        },
      };
    }
    return seed;
  });
}

export interface DetProgressTick {
  readonly scenarioIdx: number;
  readonly method: ProjectionMethod;
  readonly cumulativeIdx: number;
  readonly totalTicks: number;
  readonly scenarios: number;
}

export interface DeterministicRunArgs {
  readonly ordered: ReadonlyArray<ScenarioAggregate>;
  readonly aggregates: {
    readonly scenarios: ReadonlyArray<ScenarioAggregate>;
    readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
    readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
    readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
    readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
    readonly expenses: ReadonlyArray<Aggregate<ExpensePayload>>;
    readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
    /** Flag-derived medical category ids — threaded into both the
     *  deterministic worker input and the MC run args so the optimizer's
     *  +2pp medical-inflation default follows the `isMedical` flag. */
    readonly medicalCategoryIds?: ReadonlyArray<string>;
  };
  readonly todayIso: string;
  readonly worker: Worker;
  readonly isCurrentRun: () => boolean;
  /** Per-method reply for one scenario. Page splices into the row's
   *  `methods[method]` child slot. */
  readonly onMethodResult: (
    scenarioId: string,
    method: ProjectionMethod,
    out: OptimizerWorkerOutbound,
  ) => void;
  /** Fires on each (scenario, method) tick BEFORE the worker dispatch
   *  so the progress bar shows the in-flight pair. */
  readonly onProgress?: (tick: DetProgressTick) => void;
}

/**
 * Dispatch each ordered scenario through the deterministic worker
 * twice — once per method (Planned + TWR). The caller owns the
 * `runIdRef`; `isCurrentRun()` lets the loop drop a stale write
 * whenever a newer dispatch / metric switch raced ahead. Each
 * (scenario, method) reply is forwarded to `onMethodResult`, and a
 * progress tick fires before each dispatch.
 */
export async function runDeterministicOptimizer(
  args: DeterministicRunArgs,
): Promise<void> {
  const totalTicks = args.ordered.length * DET_METHODS.length;
  let cumulativeIdx = 0;
  for (let scenarioIdx = 0; scenarioIdx < args.ordered.length; scenarioIdx += 1) {
    const scenario = args.ordered[scenarioIdx];
    for (const method of DET_METHODS) {
      cumulativeIdx += 1;
      args.onProgress?.({
        scenarioIdx: scenarioIdx + 1,
        method,
        cumulativeIdx,
        totalTicks,
        scenarios: args.ordered.length,
      });
      if (!args.isCurrentRun()) return;
      const input: OptimizerWorkerInput = {
        scenarioId: scenario.id,
        scenarios: args.aggregates.scenarios,
        accounts: args.aggregates.accounts,
        balances: args.aggregates.balances,
        members: args.aggregates.members,
        ssBenefits: args.aggregates.ssBenefits,
        expenses: args.aggregates.expenses,
        incomeStreams: args.aggregates.incomeStreams,
        medicalCategoryIds: args.aggregates.medicalCategoryIds,
        todayIso: args.todayIso,
        projectionMethod: method,
      };
      const out = await dispatchToOptimizerWorker(args.worker, input);
      if (!args.isCurrentRun()) return;
      args.onMethodResult(scenario.id, method, out);
    }
  }
}

export interface McDispatchArgs {
  readonly ordered: ReadonlyArray<ScenarioAggregate>;
  readonly aggregates: DeterministicRunArgs['aggregates'];
  readonly today: Date;
  readonly signal: AbortSignal;
  readonly pathCount: number;
  readonly isCurrentRun: () => boolean;
  readonly runMc: (
    a: RunOptimizerMonteCarloArgs,
  ) => Promise<OptimizerMcResult>;
  readonly onProgress: (p: OptimizerMcProgress) => void;
  /** Per-scenario reply — fires as each scenario's grid resolves so the
   *  page can splice that one row in before the whole sweep finishes. */
  readonly onScenarioResult: (
    scenarioId: string,
    outcome: OptimizerMcOutcome,
  ) => void;
  /** Smooth per-scenario path progress — drives the in-flight row's bar. */
  readonly onScenarioProgress: (
    scenarioId: string,
    progress: OptimizerMcScenarioProgress,
  ) => void;
}

/**
 * Drive the MC orchestrator. Returns the populated rows on a fresh
 * run, or `null` when a newer run / metric switch superseded this
 * one (the page drops the write in that case).
 */
export async function dispatchMcRun(
  args: McDispatchArgs,
): Promise<ScenarioRow[] | null> {
  const outcomes = await args.runMc({
    scenarios: args.aggregates.scenarios,
    accounts: args.aggregates.accounts,
    balances: args.aggregates.balances,
    members: args.aggregates.members,
    ssBenefits: args.aggregates.ssBenefits,
    expenses: args.aggregates.expenses,
    incomeStreams: args.aggregates.incomeStreams,
    medicalCategoryIds: args.aggregates.medicalCategoryIds,
    today: args.today,
    signal: args.signal,
    pathCount: args.pathCount,
    onProgress: (p) => {
      if (!args.isCurrentRun()) return;
      args.onProgress(p);
    },
    onScenarioResult: (scenarioId, outcome) => {
      if (!args.isCurrentRun()) return;
      args.onScenarioResult(scenarioId, outcome);
    },
    onScenarioProgress: (scenarioId, progress) => {
      if (!args.isCurrentRun()) return;
      args.onScenarioProgress(scenarioId, progress);
    },
  });
  if (!args.isCurrentRun()) return null;
  return args.ordered.map((s) =>
    mcRowFromOutcome(s, outcomes.get(s.id), args.aggregates.scenarios),
  );
}

