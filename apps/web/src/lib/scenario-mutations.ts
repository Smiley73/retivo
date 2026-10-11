/**
 * Scenario-aggregate mutation helpers + the promotion cascade.
 *
 * Every individual edit (rename, parent change, overrides edit, notes
 * edit, per-section reset, reset-all) is a single `update` mutation
 * via {@link saveScenario}. Two compound operations need multiple
 * mutations queued atomically locally:
 *
 * - {@link deleteScenarioCascade} recursively deletes the scenario
 *   and every transitive descendant. Children are deleted leaf-first
 *   so the parent-pointer chain stays valid throughout the cascade.
 *   The base scenario cannot be deleted.
 *
 * - {@link promoteScenario} flattens the resolved values of the
 *   promoted scenario into the new base, deletes the old base, and
 *   re-parents every surviving scenario as a direct child of the new
 *   base. A `promotionInProgress` marker (localStorage) is written
 *   before any mutations queue and cleared once the cascade queues
 *   successfully — bootstrap reads the marker and runs
 *   {@link reconcileScenarios} if the local state ends up
 *   inconsistent (dual base scenarios, dangling parents).
 *
 * Note: the storage flag stays `isPrimary: boolean` — only the
 * user-facing role term renames to "base."
 */
import { listAggregates, withBatchedStoreSignals, type Batch } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { resolveScenario, type ScenarioAggregate } from './scenario-resolution';
import type { Aggregate, ScenarioPayload } from '../db/types';

/** Defense-in-depth duplicate-name check at the lib layer. UI paths
 *  (ScenariosPage create modal, ScenarioDetailPage edit) already block
 *  duplicates inline; this guard catches programmatic callers that
 *  forget. Throws DuplicateScenarioNameError on collision so the UI
 *  can render a clear inline message. Empty / whitespace-only names
 *  pass through (the page-level required-field check handles that). */
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

/** Fired after any local scenario aggregate change so listeners (e.g. the
 *  sidebar picker) can refresh without polling. Caller is responsible
 *  for dispatching after `queueLocalMutation` resolves. */
export const SCENARIOS_CHANGED_EVENT = 'retivo.scenarios.changed';

export function notifyScenariosChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SCENARIOS_CHANGED_EVENT));
}

/** Fired by the sidebar picker when the user switches the active
 *  scenario. Distinct from `SCENARIOS_CHANGED_EVENT` (aggregate
 *  add/edit/delete) — selection changes don't touch any aggregate, so
 *  pages that re-derive from the active scenario need this hook. */
export const SELECTED_SCENARIO_CHANGED_EVENT = 'retivo.scenarios.selected-changed';

export function notifySelectedScenarioChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
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
  /** When present, the fine `scenario`-store signal is recorded on this
   *  batch instead of firing per call — the multi-row cascades thread it so
   *  their many `saveScenario` writes collapse to one fine `scenario` flush
   *  on the wrapping {@link withBatchedStoreSignals} scope's exit. A lone
   *  page-form save passes none and emits immediately, as today. The
   *  per-call coarse `notifyScenariosChanged()` is unchanged either way. */
  batch?: Batch;
}

/** Queues a single `update` mutation for an existing scenario.
 *  Throws DuplicateScenarioNameError if the new name collides with
 *  another scenario in the household (case-folded, trimmed). */
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

/** Queues a `create` mutation for a non-primary scenario.
 *  Throws DuplicateScenarioNameError if the name collides with
 *  another scenario in the household (case-folded, trimmed). */
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
 * Recursively delete `targetId` and every transitive descendant.
 * Mutations are queued leaf-first (deepest descendants first, target
 * last) so the parent pointer chain stays valid throughout the
 * cascade — at no point is a non-base scenario left pointing at a
 * deleted parent. Caller must have already verified
 * `target.isPrimary === false`.
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

  // Post-order DFS: deepest descendants accumulate first, target last.
  const ordered: ScenarioAggregate[] = [];
  const walk = (node: ScenarioAggregate): void => {
    for (const child of childrenByParent.get(node.id) ?? []) {
      walk(child);
    }
    ordered.push(node);
  };
  walk(target);

  // Batch the cascade's per-row fine `scenario` signals into one flush on
  // scope exit (the coarse `notifyScenariosChanged()` tail is unchanged).
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
 * Multi-mutation promotion cascade. Caller is responsible for the
 * confirm dialog UX before calling. After this resolves, every
 * mutation is queued locally and IndexedDB reflects the post-promotion
 * state; the cloud converges as the queue drains.
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
    // Batch every step's fine `scenario` signal into one flush on scope exit
    // (the coarse `notifyScenariosChanged()` in `finally` is unchanged).
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

      // Step 3: re-parent every survivor as a direct child of the new
      // base. Overrides + notes preserved verbatim.
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

/**
 * Bootstrap-time reconciliation. Scans `allScenarios` for
 * inconsistencies introduced by an interrupted promotion or a
 * multi-device race, and queues local fixups to converge on the
 * invariant. Idempotent. Returns a summary suitable for `console.warn`
 * telemetry; the caller should NOT surface a toast in v1 (likelihood
 * of any user observing inconsistency is essentially zero).
 */
export interface ReconciliationSummary {
  ranBecauseOfMarker: boolean;
  duplicatePrimariesDemoted: number;
  danglingParentsRehomed: number;
}

/**
 * Cross-tab serialization for `reconcileScenarios`. Two tabs running
 * the bootstrap effect concurrently would both observe the same
 * dual-base state, both pick the same deterministic winner (good — see
 * `pickReconciliationWinner`), and both queue identical `update`
 * mutations on the loser. The server applies one, rejects the other
 * with a version conflict, and the user sees "Refresh needed" right
 * after a clean demo load.
 *
 * The lock is held in localStorage with a wall-clock timestamp value.
 * `LOCK_STALE_MS` bounds how long a tab can hold the lock before
 * another tab is allowed to steal it — a crashed tab won't strand
 * future reconciliations. The window is generous because the work is
 * mutation-queue I/O, not network: 5 s is comfortably longer than any
 * realistic reconciliation pass.
 */
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

  // Skip the sweep entirely when another tab is already running it —
  // the other tab's mutations will land, the eventual pull will bring
  // this tab's local state into alignment, and on the next page
  // navigation either tab's defensive picker-sweep covers what's left.
  if (!acquireReconciliationLock()) {
    return summary;
  }

  try {
    // No coarse tail here — `useAggregates('scenario')` readers are woken by
    // the batched fine `scenario` flush on scope exit (load-bearing, as with
    // `applyImport`). The per-call coarse `notifyScenariosChanged()` inside
    // `saveScenario` still fires per fixup.
    await withBatchedStoreSignals(async (batch) => {
      // Resolve dual base scenarios first so survivors re-parent to the
      // *winning* base, not an arbitrary one.
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

      // Re-resolve current base after potential demotions. `pickReconciliationWinner`
      // is deterministic, so this picks the same row as the demotion loop above
      // even though `bases` still holds the pre-demotion snapshot.
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

/**
 * Pick the deterministic survivor among multiple `isPrimary` scenarios.
 * Most-recently-updated wins; ties break by ascending `id`. The id
 * tiebreaker matters when two tabs seeded a base simultaneously and
 * both rows carry the exact same `updatedAt` to the millisecond — then
 * a pure timestamp sort is unstable and different tabs could pick
 * different winners, leaving the loser undemoted on every device.
 */
function pickReconciliationWinner(bases: ScenarioAggregate[]): ScenarioAggregate {
  return [...bases].sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return a.id.localeCompare(b.id);
  })[0];
}
