/** Pure helpers for SsOptimizerPage: row shape, deterministic and MC dispatch loops, aggregate fan-out, soft-refresh and cache splice, and re-exports of the Apply helpers. */
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

export function allMethodsResolved(rows: ReadonlyArray<ScenarioRow>): boolean {
  return rows.every(
    (r) =>
      !r.methods ||
      (!r.methods.planned.loading && !r.methods.twr.loading),
  );
}

const DET_METHODS: ReadonlyArray<ProjectionMethod> = ['planned', 'twr'];

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

/** Content signature (id:version across all sets plus medical-category ids) that keeps the page's `aggregates` reference stable across no-op re-reads; a real edit changes it and invalidates the dependent runs and row cache. */
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
  // `cancelled` keeps result: null but flags the row so the table shows CancelledRow instead of the idle state.
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

/** Filters soft-deleted scenarios and sorts primary-first, then by name, so row order matches across metric switches. */
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

/** Seeds loading placeholders: two-method children (Planned + TWR) for 'balance', the single-row shape for 'mc'. */
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

/** Aggregate-change refresh: keeps existing results visible, adds new scenarios as loading placeholders and drops removed ones. */
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
    readonly medicalCategoryIds?: ReadonlyArray<string>;
  };
  readonly todayIso: string;
  readonly worker: Worker;
  readonly isCurrentRun: () => boolean;
  readonly onMethodResult: (
    scenarioId: string,
    method: ProjectionMethod,
    out: OptimizerWorkerOutbound,
  ) => void;
  readonly onProgress?: (tick: DetProgressTick) => void;
}

/** Runs each ordered scenario through the deterministic worker per method; isCurrentRun() lets the loop drop a stale write when a newer dispatch raced ahead. */
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
  readonly onScenarioResult: (
    scenarioId: string,
    outcome: OptimizerMcOutcome,
  ) => void;
  readonly onScenarioProgress: (
    scenarioId: string,
    progress: OptimizerMcScenarioProgress,
  ) => void;
}

/** Drives the MC orchestrator; returns the rows, or null when a newer run or metric switch superseded this one. */
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

