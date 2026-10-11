/**
 * Default-categories bootstrap tests. Mirrors the auto-base-scenario
 * tests in scenario-bootstrap.test (if any) — verifies the seed runs
 * once on an empty store and is a no-op when at least one category
 * already exists.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listAggregates,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import {
  DEFAULT_EXPENSE_CATEGORY_IDS,
  backfillSeededMedicalFlag,
  ensureDefaultExpenseCategories,
} from './expense-categories-bootstrap';
import { WORKSPACE_CHANGED_EVENT } from './workspace-events';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  type Aggregate,
  type ExpenseCategoryPayload,
} from '../db/types';

const HH = 'hh-test';

describe('ensureDefaultExpenseCategories', () => {
  afterEach(async () => {
    await clearAllStores();
  });

  it('queues 8 create mutations with the seeded names on an empty store', async () => {
    const created = await ensureDefaultExpenseCategories(HH);
    expect(created).toBe(DEFAULT_EXPENSE_CATEGORIES.length);
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
    expect(pending.every((p) => p.aggregateType === 'expenseCategory')).toBe(true);
    expect(pending.every((p) => p.operation === 'create')).toBe(true);
    expect(pending.every((p) => p.expectedVersion === 0)).toBe(true);
    const names = pending
      .map((p) => (p.payload as ExpenseCategoryPayload).name)
      .sort();
    expect(names).toEqual([...DEFAULT_EXPENSE_CATEGORIES].sort());
  });

  it('is a no-op when at least one expense category already exists', async () => {
    const existing: Aggregate<ExpenseCategoryPayload> = {
      id: 'cat-pre-existing',
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: { name: 'My Category' },
    };
    await putAggregate('expenseCategory', existing);
    const created = await ensureDefaultExpenseCategories(HH);
    expect(created).toBe(0);
    const cats = await listAggregates('expenseCategory');
    expect(cats).toHaveLength(1);
  });

  it('fires WORKSPACE_CHANGED_EVENT after seeding so already-mounted pages re-read', async () => {
    const handler = vi.fn();
    window.addEventListener(WORKSPACE_CHANGED_EVENT, handler);
    try {
      await ensureDefaultExpenseCategories(HH);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, handler);
    }
  });

  it('does not fire WORKSPACE_CHANGED_EVENT on the no-op path', async () => {
    const existing: Aggregate<ExpenseCategoryPayload> = {
      id: 'cat-pre-existing',
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: { name: 'My Category' },
    };
    await putAggregate('expenseCategory', existing);
    const handler = vi.fn();
    window.addEventListener(WORKSPACE_CHANGED_EVENT, handler);
    try {
      await ensureDefaultExpenseCategories(HH);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, handler);
    }
  });

  it('seeds the Medical category with isMedical: true (and no other)', async () => {
    await ensureDefaultExpenseCategories(HH);
    const pending = await listPendingMutations();
    const medical = pending.find(
      (p) => p.aggregateId === DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
    );
    expect((medical?.payload as ExpenseCategoryPayload).isMedical).toBe(true);
    const flagged = pending.filter(
      (p) => (p.payload as ExpenseCategoryPayload).isMedical === true,
    );
    expect(flagged).toHaveLength(1);
  });

  it('resurrects a tombstoned Medical with isMedical: true via update @ version', async () => {
    const tombstone: Aggregate<ExpenseCategoryPayload> = {
      id: DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 2,
      version: 3,
      updatedAt: '2026-05-01T00:00:00Z',
      deletedAt: '2026-05-02T00:00:00Z',
      deviceId: 'dev-1',
      payload: { name: 'Medical' },
    };
    await putAggregate('expenseCategory', tombstone);
    await ensureDefaultExpenseCategories(HH);
    const pending = await listPendingMutations();
    const medical = pending.find(
      (p) => p.aggregateId === DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
    );
    expect(medical?.operation).toBe('update');
    expect(medical?.expectedVersion).toBe(3);
    expect((medical?.payload as ExpenseCategoryPayload).isMedical).toBe(true);
  });
});

describe('backfillSeededMedicalFlag', () => {
  afterEach(async () => {
    await clearAllStores();
  });

  function liveMedical(
    payload: ExpenseCategoryPayload,
    version = 4,
  ): Aggregate<ExpenseCategoryPayload> {
    return {
      id: DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
      householdId: HH,
      aggregateType: 'expenseCategory',
      schemaVersion: 1,
      version,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload,
    };
  }

  it('flips a live cat-medical whose isMedical is absent to true @ version', async () => {
    await putAggregate('expenseCategory', liveMedical({ name: 'Medical' }, 4));
    const queued = await backfillSeededMedicalFlag(HH);
    expect(queued).toBe(true);
    const pending = await listPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].operation).toBe('update');
    expect(pending[0].expectedVersion).toBe(4);
    expect((pending[0].payload as ExpenseCategoryPayload).isMedical).toBe(true);
    expect((pending[0].payload as ExpenseCategoryPayload).name).toBe('Medical');
  });

  it('is idempotent — a second run queues nothing once the flag is set', async () => {
    await putAggregate(
      'expenseCategory',
      liveMedical({ name: 'Medical', isMedical: true }),
    );
    const queued = await backfillSeededMedicalFlag(HH);
    expect(queued).toBe(false);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('does NOT touch a row already isMedical: false (user opt-out survives)', async () => {
    await putAggregate(
      'expenseCategory',
      liveMedical({ name: 'Medical', isMedical: false }),
    );
    const queued = await backfillSeededMedicalFlag(HH);
    expect(queued).toBe(false);
    expect(await listPendingMutations()).toHaveLength(0);
  });

  it('is a no-op when no cat-medical row exists', async () => {
    const queued = await backfillSeededMedicalFlag(HH);
    expect(queued).toBe(false);
  });
});
