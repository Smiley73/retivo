/** Social Security claim-age comparison page: per scenario, the claim age per member that maximizes a chosen metric (end-of-plan balance or Monte Carlo plan success). Read-only except the confirmed per-row Apply, which merges into the SS override and preserves benefitReductionPct and colaPct. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon } from '../components/icons';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { LoadingState } from '../components/Skeleton';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { useConfirm } from '../components/ConfirmDialog';
import { useAggregates } from '../lib/use-aggregates';
import { saveScenario } from '../lib/scenario-mutations';
import { valueNegativeClass } from './accounts-page-chrome';
import OptimizerWorker from '../workers/claim-age-optimizer.worker.ts?worker';
import {
  OptimizerDetToolbar,
  OptimizerDisclaimerCard,
  OptimizerMcToolbar,
  OptimizerResultsTable,
  OptimizerRunningNotice,
  type Metric,
  type OptimizerAggregates,
  type RowProgress,
  type ScenarioRow,
} from './ss-optimizer-page-chrome';
import {
  runOptimizerMonteCarlo,
  OPTIMIZER_MC_DEFAULT_PATH_COUNT,
} from '../lib/optimizer-mc-runner';
import {
  allMethodsResolved,
  applyMergedOverride,
  buildApplyConfirmArgs,
  buildInitialRows,
  dispatchMcRun,
  loadOptimizerAggregates,
  optimizerAggregatesSignature,
  mcRowFromOutcome,
  orderScenarios,
  runDeterministicOptimizer,
  softRefreshRows,
  spliceMethodResult,
  type DetProgressTick,
} from './ss-optimizer-page-helpers';
import {
  isValidPathCount,
  readPathCountFromStorage,
  writePathCountToStorage,
} from './ss-optimizer-path-count';
import type { ProjectionMethod } from '../lib/balance-projection-runner-types';

/** Page-local UI pref under the `retivo.*` namespace so the clear-data nuke and storage audit cover it. */
export const METRIC_STORAGE_KEY = 'retivo.optimizer.metric';

export const PROGRESS_LABEL_FORMAT = (
  scenarioIdx: number,
  pairIdx: number,
  total: { scenarios: number; pairs: number },
): string =>
  `scenario ${scenarioIdx} / ${total.scenarios}, pair ${pairIdx} / ${total.pairs}`;

const METRIC_OPTIONS = [
  { value: 'balance' as const, label: 'End-of-plan balance' },
  { value: 'mc' as const, label: 'Plan success %' },
];

function readMetricFromStorage(): Metric {
  try {
    const v = window.localStorage.getItem(METRIC_STORAGE_KEY);
    if (v === 'mc' || v === 'balance') return v;
  } catch {
    /* localStorage unavailable. */
  }
  return 'balance';
}


interface RowCache { aggregates: OptimizerAggregates; rows: ScenarioRow[] }
interface McProgressState {
  scenarioIdx: number; pairIdx: number;
  scenarios: number; pairs: number;
  cumulativeIdx: number; totalPairs: number;
}
interface DetProgressState {
  scenarioIdx: number;
  method: ProjectionMethod;
  cumulativeIdx: number;
  totalTicks: number;
  scenarios: number;
}

export const SsOptimizerPage: React.FC = () => {
  const { householdId } = useAuth();
  // The inputs come from an imperative multi-aggregate batch load, so subscribe to every store the batch reads (8 types) and re-fetch when any `aggregates` array changes identity.
  const scenarioRevision = useAggregates('scenario').aggregates;
  const memberRevision = useAggregates('householdMember').aggregates;
  const accountRevision = useAggregates('account').aggregates;
  const balanceRevision = useAggregates('accountBalance').aggregates;
  const ssBenefitRevision = useAggregates('socialSecurityBenefit').aggregates;
  const expenseRevision = useAggregates('expense').aggregates;
  const incomeRevision = useAggregates('incomeStream').aggregates;
  const categoryRevision = useAggregates('expenseCategory').aggregates;
  const [metric, setMetric] = useState<Metric>(() => readMetricFromStorage());
  const [aggregates, setAggregates] = useState<OptimizerAggregates | null>(null);
  const [rows, setRows] = useState<ScenarioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const runIdRef = useRef(0);
  const prevMetricRef = useRef<Metric>(metric);
  const balanceCacheRef = useRef<RowCache | null>(null);
  const mcCacheRef = useRef<RowCache | null>(null);
  const [pathCount, setPathCount] = useState<number>(
    () => readPathCountFromStorage(OPTIMIZER_MC_DEFAULT_PATH_COUNT),
  );
  const [mcProgress, setMcProgress] = useState<McProgressState | null>(null);
  const [mcRowProgress, setMcRowProgress] = useState<Map<string, RowProgress>>(
    () => new Map(),
  );
  const mcAbortRef = useRef<AbortController | null>(null);
  const mcRunAggregatesRef = useRef<OptimizerAggregates | null>(null);
  const mcRunIdRef = useRef(0);
  const [mcRunning, setMcRunning] = useState(false);
  const [detRunning, setDetRunning] = useState(false);
  const [detProgress, setDetProgress] = useState<DetProgressState | null>(null);
  const workerRef = useRef<Worker | null>(null);
  // The full-page LoadingState gates the first load only, so a revision-driven re-read doesn't flash the skeleton or re-run the optimizer.
  const hasLoadedRef = useRef(false);
  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      mcRunIdRef.current += 1;
      mcAbortRef.current?.abort();
      mcAbortRef.current = null;
    },
    [],
  );
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) workerRef.current = new OptimizerWorker();
    return workerRef.current;
  }, []);

  // Each subscribed hook settles its array on mount and on every write; swapping state only on a changed signature keeps the reference stable across no-op re-reads, which would otherwise restart the aggregates-keyed MC/Det run.
  const aggregatesSignatureRef = useRef<string | null>(null);
  const reload = useCallback(async () => {
    setError(null);
    const loaded = await loadOptimizerAggregates();
    const signature = optimizerAggregatesSignature(loaded);
    if (signature === aggregatesSignatureRef.current) return;
    aggregatesSignatureRef.current = signature;
    setAggregates(loaded);
  }, []);

  useEffect(() => {
    let active = true;
    if (!hasLoadedRef.current) setLoading(true);
    reload()
      .catch(() => {
        if (active) setError('Failed to load comparison inputs.');
      })
      .finally(() => {
        if (active) setLoading(false);
        hasLoadedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [
    reload,
    scenarioRevision,
    memberRevision,
    accountRevision,
    balanceRevision,
    ssBenefitRevision,
    expenseRevision,
    incomeRevision,
    categoryRevision,
  ]);

  useEffect(() => {
    if (!aggregates) return;
    const metricChanged = prevMetricRef.current !== metric;
    prevMetricRef.current = metric;
    runIdRef.current += 1;
    // Supersede an in-flight MC run only when its inputs or the metric changed: the first-load effect can flush after an early Run click, and aborting then would drop the run with nothing to re-dispatch.
    if (metricChanged || mcRunAggregatesRef.current !== aggregates) {
      mcRunIdRef.current += 1;
      mcAbortRef.current?.abort();
    }
    // Clear the deterministic flag: a stale balance run's guarded finally no-ops (stale runId) and would otherwise strand detRunning true, keeping MC Apply disabled.
    setDetRunning(false);
    const cache =
      metric === 'balance' ? balanceCacheRef.current : mcCacheRef.current;
    if (cache && cache.aggregates === aggregates) {
      setRows(cache.rows);
      if (metric !== 'balance') setMcProgress(null);
      else setDetProgress(null);
      return;
    }
    if (metric !== 'balance') {
      if (metricChanged) {
        setRows([]);
        setMcProgress(null);
      }
      return;
    }
    const ordered = orderScenarios(aggregates.scenarios);
    setRows((current) =>
      current.length === 0 || metricChanged
        ? buildInitialRows(ordered, aggregates.scenarios, 'balance')
        : softRefreshRows(current, ordered, aggregates.scenarios, 'balance'),
    );
    const myRunId = runIdRef.current;
    setDetRunning(true);
    setDetProgress(null);
    void runDeterministicOptimizer({
      ordered,
      aggregates,
      todayIso: new Date().toISOString(),
      worker: getWorker(),
      isCurrentRun: () => myRunId === runIdRef.current,
      onProgress: (tick: DetProgressTick) => {
        if (myRunId !== runIdRef.current) return;
        setDetProgress(tick);
      },
      onMethodResult: (scenarioId, method, out) =>
        setRows((current) => {
          const updated = spliceMethodResult(current, scenarioId, method, out);
          if (allMethodsResolved(updated)) {
            balanceCacheRef.current = { aggregates, rows: updated };
          }
          return updated;
        }),
    }).finally(() => {
      if (myRunId === runIdRef.current) {
        setDetRunning(false);
        setDetProgress(null);
      }
    });
  }, [aggregates, metric, getWorker]);

  const onMetricChange = useCallback((next: Metric): void => {
    if (next !== 'balance' && next !== 'mc') return;
    setMetric(next);
    try {
      window.localStorage.setItem(METRIC_STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable — selection is per-session only. */
    }
  }, []);

  const onRunMc = useCallback(async (): Promise<void> => {
    if (!aggregates) return;
    const ordered = orderScenarios(aggregates.scenarios);
    setRows(buildInitialRows(ordered, aggregates.scenarios, 'mc'));
    const controller = new AbortController();
    mcAbortRef.current = controller;
    mcRunAggregatesRef.current = aggregates;
    const myRunId = ++mcRunIdRef.current;
    setMcRunning(true);
    setMcProgress(null);
    setMcRowProgress(new Map());
    try {
      const populated = await dispatchMcRun({
        ordered,
        aggregates,
        today: new Date(),
        signal: controller.signal,
        pathCount,
        isCurrentRun: () => myRunId === mcRunIdRef.current,
        runMc: runOptimizerMonteCarlo,
        onProgress: ({ scenarioIdx, pairIdx, cumulativeIdx, totals }) =>
          setMcProgress({
            scenarioIdx, pairIdx, cumulativeIdx,
            scenarios: totals.scenarios,
            pairs: totals.pairs,
            totalPairs: totals.totalPairs,
          }),
        onScenarioResult: (scenarioId, outcome) => {
          setRows((current) =>
            current.map((row) =>
              row.scenario.id === scenarioId
                ? mcRowFromOutcome(row.scenario, outcome, aggregates.scenarios)
                : row,
            ),
          );
          setMcRowProgress((current) => {
            if (!current.has(scenarioId)) return current;
            const next = new Map(current);
            next.delete(scenarioId);
            return next;
          });
        },
        onScenarioProgress: (scenarioId, progress) =>
          setMcRowProgress((current) => {
            const next = new Map(current);
            next.set(scenarioId, progress);
            return next;
          }),
      });
      if (populated) {
        setRows(populated);
        if (myRunId === mcRunIdRef.current) {
          mcCacheRef.current = { aggregates, rows: populated };
        }
      }
    } finally {
      // Unconditional so a mid-run mc→balance switch doesn't strand the toolbar on Cancel.
      setMcRunning(false);
      if (myRunId === mcRunIdRef.current) mcAbortRef.current = null;
    }
  }, [aggregates, pathCount]);

  const onCancelMc = useCallback((): void => {
    mcAbortRef.current?.abort();
  }, []);

  const onPathCountChange = useCallback((next: number): void => {
    if (!isValidPathCount(next)) return;
    setPathCount(next);
    writePathCountToStorage(next);
    mcCacheRef.current = null;
  }, []);

  const onApply = useCallback(
    async (row: ScenarioRow, method?: ProjectionMethod): Promise<void> => {
      if (!householdId || !aggregates) return;
      const built = buildApplyConfirmArgs({
        row,
        members: aggregates.members,
        scenarios: aggregates.scenarios,
        method,
      });
      if (!built) return;
      const ok = await confirm('Save claim ages to scenario', built.message, {
        confirmLabel: 'Save',
        confirmIcon: <CheckIcon />,
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      const payload = applyMergedOverride({
        row,
        winner: built.winner,
        hasSecondary: built.hasSecondary,
        secondaryPastWindow: built.secondaryPastWindow,
        scenarios: aggregates.scenarios,
      });
      try {
        await saveScenario({ scenario: row.scenario, payload, householdId });
      } catch (e) {
        setError((e as Error).message ?? "Couldn't save the claim ages to this scenario.");
      }
    },
    [aggregates, confirm, householdId],
  );

  return (
    <>
      <PageHeader
        title="Social Security claim-age comparison"
        subtitle="For each scenario, compares a fixed set of Social Security claim ages per household member (each eligible whole year, plus the age already set on the scenario) at one assumed death age, the scenario's Life expectancy setting, under the selected goal. It shows the option with the highest modeled result, not a proven best age. Save to scenario writes a result into that scenario's Social Security override."
      />
      <OptimizerDisclaimerCard />
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <SegmentedRadioGroup
          ariaLabel="Comparison metric"
          options={METRIC_OPTIONS}
          value={metric}
          onChange={onMetricChange}
        />
        {metric === 'mc' && (
          <OptimizerMcToolbar
            mcRunning={mcRunning}
            canRun={!!aggregates}
            pathCount={pathCount}
            onPathCountChange={onPathCountChange}
            progress={mcProgress}
            progressLabel={PROGRESS_LABEL_FORMAT}
            onRun={() => {
              void onRunMc();
            }}
            onCancel={onCancelMc}
          />
        )}
        {metric === 'balance' && (
          <OptimizerDetToolbar detRunning={detRunning} progress={detProgress} />
        )}
      </div>
      {metric === 'mc' && mcRunning && <OptimizerRunningNotice />}
      {metric === 'mc' && rows.length === 0 && !mcRunning && (
        <EmptyState>
          Pick a number of scenarios above and select Run to estimate how
          often each scenario&apos;s money lasts, testing thousands of randomized
          market-return sequences. More scenarios give a steadier estimate but take
          longer to run.
        </EmptyState>
      )}
      {error && (
        <Card>
          <p className={valueNegativeClass}>{error}</p>
        </Card>
      )}
      {loading ? (
        <LoadingState label="Loading comparison results…" variant="table" />
      ) : (
        (metric === 'balance' || rows.length > 0) && (
          <OptimizerResultsTable
            rows={rows}
            aggregates={aggregates}
            metric={metric}
            onApply={onApply}
            rowProgress={mcRowProgress}
            running={mcRunning || detRunning}
          />
        )
      )}
      {dialog}
    </>
  );
};

