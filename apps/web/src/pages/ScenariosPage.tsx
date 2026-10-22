/**
 * Scenarios index page. Tree view of the household's scenarios with
 * the base at the root and alternates beneath. Parent/child links are
 * drawn as pure-CSS connector rails between rows (see "Scenarios tree
 * connectors" in styles.css). Each row shows an "Active" badge for the
 * currently-selected scenario and the row-level "Edit" link. The base
 * scenario is always the topmost row, so
 * the position itself communicates that — no separate "Base" badge.
 * The "Create scenario" button surfaces a modal with name + parent
 * picker (uniqueness-validated; cycle-prevented). Switching the
 * active scenario is done from the sidebar's Active Scenario picker —
 * the index reflects the selection but does not change it.
 *
 * Each card shows a cached Monte Carlo "plan success" percent
 * (read-only — see scenarios-page-metrics.ts). A per-card "Recalculate"
 * runs MC for one scenario on demand (the provider's single worker), and a
 * header "Recalculate all" runs every scenario CONCURRENTLY across a worker
 * pool (cores − 1) via `useScenarioBulkRecompute`, with a coarse progress
 * bar + Cancel and a per-card fine bar — see the recalc orchestration below.
 */
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
  // Reactive scenario list: re-reads on any `scenario`-store write (add/edit/
  // delete, sync bootstrap, demo bulk fill). The active-scenario highlight
  // tracks the local selection pointer via the narrow revision below.
  const scenarioQuery = useAggregates('scenario');
  const selectedScenarioRevision = useSelectedScenarioRevision();
  const scenarios = scenarioQuery.aggregates as ReadonlyArray<
    Aggregate<ScenarioPayload>
  > as ScenarioAggregate[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Gate the tree until the selection pointer's first read settles, so the
  // active-scenario highlight is present on first paint (no flash of an
  // un-highlighted base while the async pointer read is in flight).
  const [selectionResolved, setSelectionResolved] = useState(false);
  const loading = !scenarioQuery.ready || !selectionResolved;
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Lazy per-scenario metrics: deterministic ending-balance + sparkline
  // PLUS a cache-read Monte Carlo plan-success (read-only — see
  // scenarios-page-metrics.ts). Cards render immediately with placeholders;
  // the map fills in as each scenario settles. `buildMcInput` /
  // `refreshPlanSuccess` / `recalcableScenarioIds` drive on-demand recompute.
  const {
    metrics: metricsById,
    buildMcInput,
    refreshPlanSuccess,
    applyPlanSuccess,
    recalcableScenarioIds,
  } = useScenarioCardMetrics(scenarios);

  // Per-card recalc stays on the provider's single worker (already mutually
  // exclusive with bulk via the guards below). "Recalculate all" runs on a
  // SEPARATE concurrent worker pool owned by `useScenarioBulkRecompute`.
  const { runToCompletion, progressDone, progressTotal } = useMonteCarlo();
  // The scenario whose per-card MC run is currently in flight.
  const [activeRecalcId, setActiveRecalcId] = useState<string | null>(null);

  // "Recalculate all": concurrent pool recompute. Each result patches the
  // card DIRECTLY from the in-hand summary (no cache re-read) via
  // `applyPlanSuccess`; the hook also write-caches it for warm-cache.
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

  // Run MC for ONE scenario (forced fresh sample), then re-read its cache.
  const recalcOne = useCallback(
    async (scenarioId: string): Promise<void> => {
      const input = buildMcInput(scenarioId);
      if (!input) return;
      setActiveRecalcId(scenarioId);
      try {
        await runToCompletion(input, { force: true });
        await refreshPlanSuccess(scenarioId);
      } catch {
        // Worker error — leave the card on its prior "—"/cached value.
      } finally {
        setActiveRecalcId(null);
      }
    },
    [buildMcInput, runToCompletion, refreshPlanSuccess],
  );

  // Per-card recalc (single scenario). No-op while a bulk run is active so
  // the two stay mutually exclusive.
  const onRecalcCard = useCallback(
    (scenarioId: string): void => {
      if (bulkRunning) return;
      void recalcOne(scenarioId);
    },
    [bulkRunning, recalcOne],
  );

  // "Recalculate all": fan every recalcable scenario across the pool. No-op
  // while a per-card recalc is in flight (mutual exclusion).
  const onRecalcAll = useCallback((): void => {
    if (activeRecalcId !== null) return;
    recalcAll(recalcableScenarioIds);
  }, [activeRecalcId, recalcAll, recalcableScenarioIds]);

  const onCancelRecalcAll = useCallback((): void => {
    cancelBulk();
  }, [cancelBulk]);

  // Resolve the active-scenario highlight from the local selection pointer:
  // the stored pick if it still names a live scenario, else the base. Re-runs
  // when the reactive scenario list changes (add/edit/delete, sync seeding)
  // and when the sidebar switches the active scenario.
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

  // Delete — the exact flow the scenario detail page uses: an accessible
  // confirm (cascade-aware copy) followed by `deleteScenarioCascade`.
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
        // The cascade writes `scenario` tombstones, so the reactive
        // `useAggregates('scenario')` read re-runs and drops the rows — no
        // manual reload needed.
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

      {/* Recalculate-all toolbar: runs MC for every scenario concurrently
          across a worker pool with a coarse progress bar + Cancel. Hidden
          while loading / when no scenario can run MC. */}
      {!loading && tree && recalcableScenarioIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {bulkRecalc ? (
            <>
              <div className="min-w-48" role="status" aria-live="polite" aria-atomic="true">
                {/* Counts SCENARIOS, not paths — without the unit override
                    the shared bar announced "…: 0 of 5 paths" for a number
                    that is nothing of the kind. */}
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
              // Per-card progress comes from the provider's single worker; a
              // bulk run drives this card's fine bar from the pool's
              // per-scenario progress map instead.
              const bulkProgress = bulkProgressById.get(s.id);
              const isRecalculating =
                activeRecalcId === s.id || bulkProgress !== undefined;
              const recalcDone =
                activeRecalcId === s.id ? progressDone : (bulkProgress?.done ?? 0);
              const recalcTotal =
                activeRecalcId === s.id ? progressTotal : (bulkProgress?.total ?? 0);
              // Per-card "Recalculate" only when MC can run AND there's no
              // cached hit yet (a hit shows the number, not the control).
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
                  // Delete is hidden on the active card and the base scenario.
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
            // `createScenario` writes a `scenario` row, so the reactive read
            // re-runs and the new card appears without a manual reload.
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

/**
 * DFS-flatten the tree so every row renders as a direct child of the
 * `.scenario-tree` container. The connector CSS relies on consecutive
 * sibling `.scenario-tree__row` elements to make the vertical rails
 * appear continuous; nesting rows inside their parent's wrapper would
 * break the column gap and visually fragment the rails.
 *
 * `ancestorIsLast[i]` records whether the path's depth-(i+1) ancestor
 * is the last child of its parent. Used by the row renderer to decide
 * which slots are rails (`false`), elbow connectors, or blanks
 * (`true` for ancestors whose branch has already ended).
 */
function flattenTree(node: TreeNode, ancestorIsLast: boolean[]): FlatRow[] {
  const rows: FlatRow[] = [{ node, ancestorIsLast }];
  node.children.forEach((child, idx, arr) => {
    const childIsLast = idx === arr.length - 1;
    rows.push(...flattenTree(child, [...ancestorIsLast, childIsLast]));
  });
  return rows;
}
