/** Scenarios index: a tree of the household's scenarios with cached plan success and per-card Recalculate / Recalculate all (a concurrent worker pool via useScenarioBulkRecompute). The active scenario is switched from the sidebar picker. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshIcon } from '../components/icons';
import { PlusIcon } from '../components/icons';
import { useAuth } from '../auth/AuthContext';
import { readSelectedScenario } from '../db/store';
import { PageHeader } from '../components/PageHeader';
import { Muted } from '../components/Muted';
import { useConfirm } from '../components/ConfirmDialog';
import { useSync } from '../sync/SyncContext';
import { deleteScenarioCascade, switchSelectedScenario } from '../lib/scenario-mutations';
import { useAggregates } from '../lib/use-aggregates';
import { useSelectedScenarioRevision } from '../lib/use-selected-scenario-revision';
import { descendantIds } from '../lib/scenario-resolution';
import type { Aggregate, ScenarioPayload } from '../db/types';
import { compareDeepLink } from './balance-projection-page-constants';
import { errorTextClass } from './scenarios-page-chrome';
import { ScenariosPageRow } from './ScenariosPageRow';
import { useScenarioCardMetrics } from './scenarios-page-metrics';
import { CreateScenarioModal } from './scenarios-create-modal';
import { McProgressBar } from '../components/McProgressBar';
import { useMonteCarlo } from '../monte-carlo/MonteCarloProvider';
import { useScenarioBulkRecompute } from '../monte-carlo/use-scenario-bulk-recompute';
import { btnSecondarySmClass } from '../components/dialog-chrome';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

interface TreeNode {
  scenario: ScenarioAggregate;
  children: TreeNode[];
  pendingMutationCount: number;
}

function buildTree(scenarios: ScenarioAggregate[]): TreeNode | null {
  const base = scenarios.find((s) => s.payload.isPrimary);
  if (!base) return null;
  const childrenByParent = new Map<string, ScenarioAggregate[]>();
  for (const s of scenarios) {
    const parent = s.payload.parentScenarioId;
    if (parent === null) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(s);
    childrenByParent.set(parent, list);
  }
  function walk(node: ScenarioAggregate): TreeNode {
    const children = (childrenByParent.get(node.id) ?? [])
      .slice()
      .sort((a, b) => a.payload.name.localeCompare(b.payload.name))
      .map(walk);
    return { scenario: node, children, pendingMutationCount: 0 };
  }
  return walk(base);
}

export const ScenariosPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  const navigate = useNavigate();
  const scenarioQuery = useAggregates('scenario');
  const selectedScenarioRevision = useSelectedScenarioRevision();
  const scenarios = scenarioQuery.aggregates as ReadonlyArray<
    Aggregate<ScenarioPayload>
  > as ScenarioAggregate[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Gate the tree on the selection pointer's first read so the active highlight is present on first paint.
  const [selectionResolved, setSelectionResolved] = useState(false);
  const loading = !scenarioQuery.ready || !selectionResolved;
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    metrics: metricsById,
    buildMcInput,
    refreshPlanSuccess,
    applyPlanSuccess,
    recalcableScenarioIds,
  } = useScenarioCardMetrics(scenarios);

  // Per-card recalc uses the provider's single worker, kept mutually exclusive with the bulk pool by the guards below.
  const { runToCompletion, progressDone, progressTotal } = useMonteCarlo();
  const [activeRecalcId, setActiveRecalcId] = useState<string | null>(null);

  // Each bulk result patches its card directly from the in-hand summary (no cache re-read).
  const {
    coarse: bulkRecalc,
    progressById: bulkProgressById,
    isRunning: bulkRunning,
    recalcAll,
    cancel: cancelBulk,
  } = useScenarioBulkRecompute({
    buildMcInput,
    onResult: applyPlanSuccess,
  });

  const recalcOne = useCallback(
    async (scenarioId: string): Promise<void> => {
      const input = buildMcInput(scenarioId);
      if (!input) return;
      setActiveRecalcId(scenarioId);
      try {
        await runToCompletion(input, { force: true });
        await refreshPlanSuccess(scenarioId);
      } catch {
      } finally {
        setActiveRecalcId(null);
      }
    },
    [buildMcInput, runToCompletion, refreshPlanSuccess],
  );

  const onRecalcCard = useCallback(
    (scenarioId: string): void => {
      if (bulkRunning) return;
      void recalcOne(scenarioId);
    },
    [bulkRunning, recalcOne],
  );

  const onRecalcAll = useCallback((): void => {
    if (activeRecalcId !== null) return;
    recalcAll(recalcableScenarioIds);
  }, [activeRecalcId, recalcAll, recalcableScenarioIds]);

  const onCancelRecalcAll = useCallback((): void => {
    cancelBulk();
  }, [cancelBulk]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const selected = await readSelectedScenario();
      if (!active) return;
      const base = scenarios.find((s) => s.payload.isPrimary);
      const validId =
        selected && scenarios.some((s) => s.id === selected.scenarioId)
          ? selected.scenarioId
          : (base?.id ?? null);
      setSelectedId(validId);
      setSelectionResolved(true);
    })();
    return () => {
      active = false;
    };
  }, [scenarios, selectedScenarioRevision]);

  const tree = useMemo(() => buildTree(scenarios), [scenarios]);

  const deleteScenario = useCallback(
    async (scenario: ScenarioAggregate): Promise<void> => {
      if (!householdId || scenario.payload.isPrimary) return;
      const descendantCount = descendantIds(scenario.id, scenarios).size - 1;
      const ok = await confirm(
        `Delete "${scenario.payload.name}"?`,
        descendantCount === 0 ? (
          <>This cannot be undone.</>
        ) : (
          <>
            <strong>{scenario.payload.name}</strong> and its {descendantCount}{' '}
            child scenario{descendantCount === 1 ? '' : 's'} will be permanently
            deleted. This cannot be undone.
          </>
        ),
        { confirmLabel: 'Delete' },
      );
      if (!ok) return;
      setActionError(null);
      try {
        await deleteScenarioCascade(scenario.id, scenarios, householdId);
        notifyPending();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Delete failed.');
      }
    },
    [householdId, scenarios, confirm, notifyPending],
  );

  // Navigating before the pointer write lands would open the tab on the wrong pair.
  const compareWithParent = useCallback(
    async (scenario: ScenarioAggregate, parentId: string): Promise<void> => {
      setActionError(null);
      try {
        await switchSelectedScenario(scenario.id);
      } catch (e) {
        setActionError(
          e instanceof Error ? e.message : 'Could not switch the active scenario.',
        );
        return;
      }
      navigate(compareDeepLink(parentId));
    },
    [navigate],
  );

  return (
    <>
      <PageHeader
        title="Scenarios"
        subtitle={
          '"What if?" retirement plans. The base holds your starting ' +
          'assumptions; child scenarios branch off and inherit every ' +
          'change — only your overrides stay fixed.'
        }
        action={{
          label: 'Create scenario',
          onClick: () => setCreateModalOpen(true),
        }}
        actionIcon={<PlusIcon />}
      />

      {!loading && tree && recalcableScenarioIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {bulkRecalc ? (
            <>
              <div className="min-w-48" role="status" aria-live="polite" aria-atomic="true">
                {/* Counts scenarios, not paths: the unit override stops the shared bar announcing "0 of 5 paths". */}
                <McProgressBar
                  done={bulkRecalc.done}
                  total={bulkRecalc.total}
                  label="Recalculating scenarios"
                  unit="done"
                />
              </div>
              <button
                type="button"
                className={btnSecondarySmClass}
                onClick={onCancelRecalcAll}
                aria-label="Cancel recalculating all scenarios"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${btnSecondarySmClass} gap-1.5`}
              onClick={onRecalcAll}
              disabled={activeRecalcId !== null}
              aria-label="Recalculate plan success for all scenarios"
            >
              <RefreshIcon />
              Recalculate all
            </button>
          )}
        </div>
      )}

      {loading && <Muted as="p">Loading scenarios…</Muted>}

      {!loading && !tree && (
        <Muted as="p">No base scenario found. The first sign-in sets one up automatically.</Muted>
      )}

      {actionError && (
        <p className={errorTextClass} role="alert">
          {actionError}
        </p>
      )}

      {!loading && tree && (
        <section aria-labelledby="scenarios-heading">
          <h2 id="scenarios-heading" className="sr-only">Scenario tree</h2>
          <div className="scenario-tree">
            {flattenTree(tree, []).map(({ node, ancestorIsLast }) => {
              const s = node.scenario;
              const isActive = selectedId === s.id;
              const cardMetrics = metricsById.get(s.id);
              // A bulk run drives this card's fine bar from the pool's per-scenario progress map.
              const bulkProgress = bulkProgressById.get(s.id);
              const isRecalculating =
                activeRecalcId === s.id || bulkProgress !== undefined;
              const recalcDone =
                activeRecalcId === s.id ? progressDone : (bulkProgress?.done ?? 0);
              const recalcTotal =
                activeRecalcId === s.id ? progressTotal : (bulkProgress?.total ?? 0);
              const canRecalc =
                cardMetrics?.canRunMc === true &&
                cardMetrics.planSuccessState === 'missing';
              const parent = scenarios.find(
                (p) => p.id === s.payload.parentScenarioId,
              );
              return (
                <ScenariosPageRow
                  key={s.id}
                  scenario={s}
                  ancestorIsLast={ancestorIsLast}
                  isSelected={isActive}
                  metrics={cardMetrics}
                  onDelete={
                    isActive || s.payload.isPrimary
                      ? null
                      : () => void deleteScenario(s)
                  }
                  onRecalc={canRecalc ? () => onRecalcCard(s.id) : null}
                  isRecalculating={isRecalculating}
                  recalcDone={recalcDone}
                  recalcTotal={recalcTotal}
                  compareWithParent={
                    parent
                      ? {
                          parentName: parent.payload.name,
                          onActivate: () => void compareWithParent(s, parent.id),
                        }
                      : null
                  }
                />
              );
            })}
          </div>
        </section>
      )}

      {dialog}

      {householdId && createModalOpen && (
        <CreateScenarioModal
          open={createModalOpen}
          householdId={householdId}
          scenarios={scenarios}
          onClose={() => setCreateModalOpen(false)}
          onCreated={() => {
            setCreateModalOpen(false);
            notifyPending();
          }}
        />
      )}
    </>
  );
};

interface FlatRow {
  node: TreeNode;
  ancestorIsLast: boolean[];
}

// Flattens the tree DFS so every row is a direct child of .scenario-tree (the connector CSS needs consecutive sibling rows for continuous rails); `ancestorIsLast[i]` records whether the depth-(i+1) ancestor is its parent's last child, choosing rail, elbow or blank slots.
function flattenTree(node: TreeNode, ancestorIsLast: boolean[]): FlatRow[] {
  const rows: FlatRow[] = [{ node, ancestorIsLast }];
  node.children.forEach((child, idx, arr) => {
    const childIsLast = idx === arr.length - 1;
    rows.push(...flattenTree(child, [...ancestorIsLast, childIsLast]));
  });
  return rows;
}
