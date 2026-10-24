// Seeds the default expense categories on first post-bootstrap render if the household has none.
// Ids are deterministic, so the demo loader's later upsert updates in place instead of doubling to 16 categories.

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

/** Stable id per default category name, shared with the demo loader so both seeding paths target one aggregate. */
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

/** No-op if any live category exists, else queues a `create` per default; idempotent across concurrent calls in a tab. Returns the number queued. */
export async function ensureDefaultExpenseCategories(
  householdId: string,
): Promise<number> {
  if (ensuringByHousehold.has(householdId)) return 0;
  ensuringByHousehold.add(householdId);
  try {
    const liveExisting = await listAggregates('expenseCategory');
    if (liveExisting.length > 0) return 0;

    // Includes tombstones: a previously deleted deterministic id must resurrect via `update` at its
    // version, since `create` at 0 conflicts on push and leaves the SyncBadge on "Refresh needed".
    const allByIdIncludingDeleted = new Map(
      (await listAggregatesIncludingDeleted('expenseCategory')).map((a) => [
        a.id,
        a,
      ]),
    );

    // Batched so the seed wakes mounted category readers once, not eight times.
    await withBatchedStoreSignals(async (batch) => {
      for (const name of DEFAULT_EXPENSE_CATEGORIES) {
        const id = DEFAULT_EXPENSE_CATEGORY_IDS[name];
        if (!id) {
          throw new Error(`Missing deterministic id for default category "${name}"`);
        }
        // The seeded Medical category carries the medical flag, so its +2pp inflation default follows the flag, not the id.
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
    // A mounted page (e.g. /expense-categories) would otherwise stay empty until a manual refresh.
    notifyWorkspaceChanged();
    return DEFAULT_EXPENSE_CATEGORIES.length;
  } finally {
    ensuringByHousehold.delete(householdId);
  }
}

/**
 * Flags a live seeded `cat-medical` row that lacks `isMedical` so it keeps its
 * +2pp inflation default. The `expenseCategory` v1-to-v2 migration is payload-only
 * and cannot see the id, so this id-keyed pass complements it. Any boolean
 * `isMedical` is left alone (a deliberate opt-out survives) and tombstones are
 * skipped; a renamed row still flips because the match is on id. Returns whether
 * a backfill was queued.
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
    // Never overwrite an explicit `false` (a user opt-out) or an existing `true`.
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
