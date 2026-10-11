/**
 * Lazy default-categories seeding. Mirrors `ensureBaseScenario`: on
 * first post-bootstrap render, if no ExpenseCategory rows exist for the
 * household, queue eight `create` mutations seeded from
 * DEFAULT_EXPENSE_CATEGORIES. After this runs every consumer (Expense
 * form, scenario expense overrides, demo loader) can assume at least
 * one category exists.
 *
 * IDs are deterministic (`DEFAULT_EXPENSE_CATEGORY_IDS`) so the demo
 * loader's later upsert collides on the same id and updates in place
 * instead of creating a second copy. Without this, a fresh sign-up
 * (bootstrap creates 8 categories) followed by Load-Demo-Data
 * (creates 8 more) leaves 16 categories.
 */
import {
  listAggregates,
  listAggregatesIncludingDeleted,
  withBatchedStoreSignals,
} from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  type Aggregate,
  type ExpenseCategoryPayload,
} from '../db/types';
import { notifyWorkspaceChanged } from './workspace-events';

/**
 * Stable id per default category name. Shared with the demo loader so
 * both seeding paths target the same aggregate id and a duplicate
 * cannot be created.
 */
export const DEFAULT_EXPENSE_CATEGORY_IDS: Readonly<Record<string, string>> = {
  Entertainment: 'cat-entertainment',
  Food: 'cat-food',
  Housing: 'cat-housing',
  Insurance: 'cat-insurance',
  Medical: 'cat-medical',
  Other: 'cat-other',
  Transportation: 'cat-transportation',
  Utilities: 'cat-utilities',
};

const ensuringByHousehold = new Set<string>();
const backfillingByHousehold = new Set<string>();

/**
 * No-op if any non-deleted ExpenseCategory already exists for the
 * household; otherwise queues a `create` per default name. Idempotent
 * across concurrent calls within a single tab via a module-level set.
 *
 * Returns the number of categories actually queued (8 on first call,
 * 0 on every subsequent call within the same household).
 */
export async function ensureDefaultExpenseCategories(
  householdId: string,
): Promise<number> {
  if (ensuringByHousehold.has(householdId)) return 0;
  ensuringByHousehold.add(householdId);
  try {
    const liveExisting = await listAggregates('expenseCategory');
    if (liveExisting.length > 0) return 0;

    // Index every row including tombstones so a deterministic id that
    // was previously deleted (manually or by an import's Phase 1 wipe)
    // resurrects via `update @ tombstone.version` instead of conflicting
    // on `create @ 0`. The conflict path manifests on push as
    // CONFLICT → the SyncBadge sticks on "Refresh needed". Mirrors the
    // tombstone-aware logic in `applyImport`.
    const allByIdIncludingDeleted = new Map(
      (await listAggregatesIncludingDeleted('expenseCategory')).map((a) => [
        a.id,
        a,
      ]),
    );

    // Batch the per-category fine signals into one per touched store on exit
    // so the eight-category seed wakes mounted category readers once, not
    // eight times (the coarse `notifyWorkspaceChanged()` below is unchanged).
    await withBatchedStoreSignals(async (batch) => {
      for (const name of DEFAULT_EXPENSE_CATEGORIES) {
        const id = DEFAULT_EXPENSE_CATEGORY_IDS[name];
        if (!id) {
          throw new Error(`Missing deterministic id for default category "${name}"`);
        }
        // The seeded Medical category carries the generic medical flag
        // so the +2pp inflation default (and future HSA routing)
        // follows the persisted flag, not the hard-coded id.
        const payload: ExpenseCategoryPayload =
          id === DEFAULT_EXPENSE_CATEGORY_IDS.Medical
            ? { name, isMedical: true }
            : { name };
        const tombstoned = allByIdIncludingDeleted.get(id);
        if (tombstoned) {
          await queueLocalMutation<ExpenseCategoryPayload>({
            type: 'expenseCategory',
            aggregateId: id,
            householdId,
            operation: 'update',
            expectedVersion: tombstoned.version,
            payload,
          }, batch);
        } else {
          await queueLocalMutation<ExpenseCategoryPayload>({
            type: 'expenseCategory',
            aggregateId: id,
            householdId,
            operation: 'create',
            expectedVersion: 0,
            payload,
          }, batch);
        }
      }
    });
    // Broadcast so any already-mounted page (Expense Categories /
    // Expenses / scenario sub-screens that read categories) re-reads
    // after the bulk seed lands. Without this, a user who navigates to
    // /expense-categories before the App-level bootstrap useEffect
    // fires sees an empty page and has to refresh manually.
    notifyWorkspaceChanged();
    return DEFAULT_EXPENSE_CATEGORIES.length;
  } finally {
    ensuringByHousehold.delete(householdId);
  }
}

/**
 * Backfill ensure-pass (NOT a schema migration). On load for an already-
 * seeded household, if a LIVE `cat-medical` row exists whose `isMedical` is
 * absent (predates the generic-medical-flag feature), queue one `update @
 * version` setting `isMedical: true` so the existing seeded Medical category
 * keeps its +2pp inflation default on deploy.
 *
 * Necessary because the `expenseCategory` v1→v2 migration is payload-only —
 * it cannot see the aggregate id and so cannot flip the right row. This
 * id-keyed pass is complementary, not redundant.
 *
 * Idempotent + tombstone-safe + id-keyed: a row already carrying any boolean
 * `isMedical` (true OR false) is left untouched (so a deliberate opt-out
 * survives); a deleted `cat-medical` (tombstone) is skipped (only live rows
 * from `listAggregates`); a renamed-but-not-recreated Medical still flips
 * because the match is on id, not name. Returns whether a backfill was queued.
 */
export async function backfillSeededMedicalFlag(
  householdId: string,
): Promise<boolean> {
  if (backfillingByHousehold.has(householdId)) return false;
  backfillingByHousehold.add(householdId);
  try {
    const medicalId = DEFAULT_EXPENSE_CATEGORY_IDS.Medical;
    const live = (await listAggregates(
      'expenseCategory',
    )) as Aggregate<ExpenseCategoryPayload>[];
    const seeded = live.find((c) => c.id === medicalId);
    if (!seeded) return false;
    // Only flip a row that has NO boolean flag yet — never overwrite an
    // explicit `false` (a user opt-out) or an already-`true` row.
    if (typeof seeded.payload.isMedical === 'boolean') return false;
    await queueLocalMutation<ExpenseCategoryPayload>({
      type: 'expenseCategory',
      aggregateId: medicalId,
      householdId,
      operation: 'update',
      expectedVersion: seeded.version,
      payload: { ...seeded.payload, isMedical: true },
    });
    notifyWorkspaceChanged();
    return true;
  } finally {
    backfillingByHousehold.delete(householdId);
  }
}
