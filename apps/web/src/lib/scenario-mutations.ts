/**
 * Scenario mutation helpers and the promotion cascade: every edit is a single `update` via `saveScenario`; `deleteScenarioCascade` and `promoteScenario` queue several mutations together.
 * A `promotionInProgress` localStorage marker brackets the promotion so bootstrap can run `reconcileScenarios` if it was interrupted. The storage flag stays `isPrimary`; the user-facing term is "base".
 */
import {
  listAggregates,
  withBatchedStoreSignals,
  writeSelectedScenario,
  type Batch,
} from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import type { Aggregate, ScenarioPayload } from '../db/types';

// UI paths block duplicate names inline; this guard catches programmatic callers.
class DuplicateScenarioNameError extends Error {
  readonly code = 'DUPLICATE_SCENARIO_NAME' as const;
  constructor(name: string) {
    super(`A scenario named "${name}" already exists in this household.`);
    this.name = 'DuplicateScenarioNameError';
  }
}

async function ensureNameUnique(
  name: string,
  excludingId: string | null,
): Promise<void> {
  const lower = name.trim().toLocaleLowerCase();
  if (lower.length === 0) return;
  const all = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
  const collides = all.some(
    (s) =>
      s.id !== excludingId &&
      (s.payload.name ?? '').trim().toLocaleLowerCase() === lower,
  );
  if (collides) {
    throw new DuplicateScenarioNameError(name.trim());
  }
}

const PROMOTION_MARKER_KEY = 'retivo.scenarios.promotionInProgress';

/**
 * Fired after any local scenario aggregate change so listeners can refresh without polling; the
 * caller dispatches after `queueLocalMutation` resolves.
 */
export const SCENARIOS_CHANGED_EVENT = 'retivo.scenarios.changed';

export function notifyScenariosChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SCENARIOS_CHANGED_EVENT));
}

/**
 * Fired when the user switches the active scenario; selection changes touch no aggregate, so pages
 * deriving from it need this separate hook.
 */
export const SELECTED_SCENARIO_CHANGED_EVENT = 'retivo.scenarios.selected-changed';

export function notifySelectedScenarioChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
}

/**
 * Switch the active scenario: write the per-device pointer, then notify; resolves after the write
 * lands so a following navigation reads the new pointer.
 */
export async function switchSelectedScenario(scenarioId: string): Promise<void> {
  await writeSelectedScenario({
    scenarioId,
    updatedAt: new Date().toISOString(),
  });
  notifySelectedScenarioChanged();
}

interface PromotionMarker {
  scenarioId: string;
  startedAt: string;
  expectedSurvivorIds: string[];
}

export function readPromotionMarker(): PromotionMarker | null {
  try {
    const raw = localStorage.getItem(PROMOTION_MARKER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PromotionMarker;
  } catch {
    return null;
  }
}

function writePromotionMarker(marker: PromotionMarker): void {
  localStorage.setItem(PROMOTION_MARKER_KEY, JSON.stringify(marker));
}

export function clearPromotionMarker(): void {
  localStorage.removeItem(PROMOTION_MARKER_KEY);
}

export interface SaveScenarioInput {
  scenario: ScenarioAggregate;
  payload: ScenarioPayload;
  householdId: string;
  /**
   * When present, the fine `scenario` store signal is recorded on this batch, so cascades collapse
   * many saves into one flush on the {@link withBatchedStoreSignals} scope's exit.
   */
  batch?: Batch;
}

/**
 * Queue an `update` for an existing scenario; throws DuplicateScenarioNameError on a case-folded,
 * trimmed name collision.
 */
export async function saveScenario({
  scenario,
  payload,
  householdId,
  batch,
}: SaveScenarioInput): Promise<void> {
  if (payload.name !== scenario.payload.name) {
    await ensureNameUnique(payload.name, scenario.id);
  }
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: scenario.id,
    householdId,
    operation: 'update',
    expectedVersion: scenario.version,
    payload,
  }, batch);
  notifyScenariosChanged();
}

export interface CreateScenarioInput {
  id: string;
  name: string;
  description?: string;
  parentScenarioId: string;
  notes?: string;
  householdId: string;
}

/**
 * Queue a `create` for a non-primary scenario; throws DuplicateScenarioNameError on a name
 * collision.
 */
export async function createScenario({
  id,
  name,
  description,
  parentScenarioId,
  notes,
  householdId,
}: CreateScenarioInput): Promise<void> {
  await ensureNameUnique(name, null);
  const payload: ScenarioPayload = {
    name,
    description: description ?? '',
    parentScenarioId,
    isPrimary: false,
    notes: notes ?? '',
    overrides: {},
  };
  await queueLocalMutation<ScenarioPayload>({
    type: 'scenario',
    aggregateId: id,
    householdId,
    operation: 'create',
    expectedVersion: 0,
    payload,
  });
  notifyScenariosChanged();
}

/**
 * Delete `targetId` and every transitive descendant, queued leaf-first so no scenario ever points
 * at a deleted parent. The caller verifies the target is not the base.
 */
export async function deleteScenarioCascade(
  targetId: string,
  allScenarios: ScenarioAggregate[],
  householdId: string,
): Promise<void> {
  const target = allScenarios.find((s) => s.id === targetId);
  if (!target) throw new Error(`deleteScenarioCascade: unknown scenario ${targetId}`);
  if (target.payload.isPrimary) {
    throw new Error('Cannot delete the base scenario.');
  }

  const childrenByParent = new Map<string, ScenarioAggregate[]>();
  for (const s of allScenarios) {
    const parent = s.payload.parentScenarioId;
    if (parent === null) continue;
    const list = childrenByParent.get(parent) ?? [];
    list.push(s);
    childrenByParent.set(parent, list);
  }

  const ordered: ScenarioAggregate[] = [];
  const walk = (node: ScenarioAggregate): void => {
    for (const child of childrenByParent.get(node.id) ?? []) {
      walk(child);
    }
    ordered.push(node);
  };
  walk(target);

  // One flush for the cascade's fine `scenario` signals.
  await withBatchedStoreSignals(async (batch) => {
    for (const node of ordered) {
      await queueLocalMutation<ScenarioPayload>({
        type: 'scenario',
        aggregateId: node.id,
        householdId,
        operation: 'delete',
        expectedVersion: node.version,
        payload: node.payload,
      }, batch);
    }
  });
  notifyScenariosChanged();
}

/**
 * Promote a scenario to base: flatten its resolved values into it, delete the old base and
 * re-parent the survivors. The caller owns the confirm dialog.
 */
export async function promoteScenario(
  promotedId: string,
  allScenarios: ScenarioAggregate[],
  householdId: string,
): Promise<void> {
  const promoted = allScenarios.find((s) => s.id === promotedId);
  if (!promoted) throw new Error(`promoteScenario: unknown scenario ${promotedId}`);
  if (promoted.payload.isPrimary) {
    throw new Error('promoteScenario called on the base scenario.');
  }
  const oldBase = allScenarios.find((s) => s.payload.isPrimary);
  if (!oldBase) {
    throw new Error('promoteScenario: no base scenario found.');
  }

  const resolved = resolveScenario(promotedId, allScenarios);
  const survivors = allScenarios.filter(
    (s) => s.id !== promotedId && s.id !== oldBase.id,
  );

  writePromotionMarker({
    scenarioId: promotedId,
    startedAt: new Date().toISOString(),
    expectedSurvivorIds: survivors.map((s) => s.id),
  });

  try {
    await withBatchedStoreSignals(async (batch) => {
      // Step 1: promote the chosen scenario into the new base.
      await saveScenario({
        scenario: promoted,
        payload: {
          ...promoted.payload,
          isPrimary: true,
          parentScenarioId: null,
          overrides: resolved,
        },
        householdId,
        batch,
      });

      // Step 2: delete old base scenario.
      await queueLocalMutation<ScenarioPayload>({
        type: 'scenario',
        aggregateId: oldBase.id,
        householdId,
        operation: 'delete',
        expectedVersion: oldBase.version,
        payload: oldBase.payload,
      }, batch);

      // Step 3: re-parent every survivor under the new base.
      for (const survivor of survivors) {
        await saveScenario({
          scenario: survivor,
          payload: { ...survivor.payload, parentScenarioId: promotedId },
          householdId,
          batch,
        });
      }
    });
  } finally {
    clearPromotionMarker();
    notifyScenariosChanged();
  }
}

/** Counts from one `reconcileScenarios` pass. */
export interface ReconciliationSummary {
  ranBecauseOfMarker: boolean;
  duplicatePrimariesDemoted: number;
  danglingParentsRehomed: number;
}

// Cross-tab lock: two tabs reconciling at once queue identical loser updates, one hits a version
// conflict, and the user sees "Refresh needed". A tab holding the lock past 5 s is presumed crashed
// and may be stolen.
const RECONCILIATION_LOCK_KEY = 'retivo.scenarios.reconcileLock';
const RECONCILIATION_LOCK_STALE_MS = 5_000;

function acquireReconciliationLock(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const raw = localStorage.getItem(RECONCILIATION_LOCK_KEY);
  if (raw !== null) {
    const heldAt = Number(raw);
    if (Number.isFinite(heldAt) && Date.now() - heldAt < RECONCILIATION_LOCK_STALE_MS) {
      return false;
    }
  }
  localStorage.setItem(RECONCILIATION_LOCK_KEY, String(Date.now()));
  return true;
}

function releaseReconciliationLock(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(RECONCILIATION_LOCK_KEY);
}

/**
 * Bootstrap-time sweep that demotes duplicate bases and re-homes dangling parents left by an
 * interrupted promotion or a multi-device race; idempotent. Returns a summary for `console.warn`.
 */
export async function reconcileScenarios(
  allScenarios: ScenarioAggregate[],
  householdId: string,
): Promise<ReconciliationSummary> {
  const marker = readPromotionMarker();
  const summary: ReconciliationSummary = {
    ranBecauseOfMarker: marker !== null,
    duplicatePrimariesDemoted: 0,
    danglingParentsRehomed: 0,
  };

  // Skip when another tab is already sweeping; the eventual pull aligns this tab.
  if (!acquireReconciliationLock()) {
    return summary;
  }

  try {
    // No coarse tail: readers are woken by the batched fine `scenario` flush on scope exit
    // (load-bearing, as with `applyImport`).
    await withBatchedStoreSignals(async (batch) => {
      // Resolve dual bases first so survivors re-parent to the winning base.
      const bases = allScenarios.filter((s) => s.payload.isPrimary);
      if (bases.length > 1) {
        const winner = pickReconciliationWinner(bases);
        for (const loser of bases) {
          if (loser.id === winner.id) continue;
          await saveScenario({
            scenario: loser,
            payload: { ...loser.payload, isPrimary: false, parentScenarioId: winner.id },
            householdId,
            batch,
          });
          summary.duplicatePrimariesDemoted += 1;
        }
      }

      // pickReconciliationWinner is deterministic, so this matches the demotion loop although
      // `bases` is a pre-demotion snapshot.
      const currentBase = bases.length > 1
        ? pickReconciliationWinner(bases)
        : (bases[0] ?? null);

      if (currentBase) {
        const validIds = new Set(allScenarios.map((s) => s.id));
        for (const s of allScenarios) {
          if (s.payload.isPrimary) continue;
          const parentId = s.payload.parentScenarioId;
          if (parentId !== null && !validIds.has(parentId)) {
            await saveScenario({
              scenario: s,
              payload: { ...s.payload, parentScenarioId: currentBase.id },
              householdId,
              batch,
            });
            summary.danglingParentsRehomed += 1;
          }
        }
      }
    });

    if (marker !== null) {
      clearPromotionMarker();
    }

    if (
      summary.duplicatePrimariesDemoted > 0 ||
      summary.danglingParentsRehomed > 0
    ) {
      console.warn('[scenarios] reconciliation ran', summary);
    }

    return summary;
  } finally {
    releaseReconciliationLock();
  }
}

// Most-recently-updated wins, ties by ascending id: two tabs that seeded a base at the same
// millisecond could otherwise pick different winners.
function pickReconciliationWinner(bases: ScenarioAggregate[]): ScenarioAggregate {
  return [...bases].sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return a.id.localeCompare(b.id);
  })[0];
}
