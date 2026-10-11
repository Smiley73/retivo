/**
 * Unit tests for the pure sync-inspector label resolver.
 *
 * `getAggregate` is mocked over a test-controlled map so the cases are
 * deterministic and cover the parent-lookup + throw-safety paths without a
 * real IndexedDB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Aggregate, AggregateType } from '../db/types';
import { AGGREGATE_TYPE_LABEL, resolveMutationLabel } from './mutation-label';

const store = new Map<string, Aggregate>();
let throwFor: Set<string> | null = null;

vi.mock('../db/store', () => ({
  getAggregate: vi.fn(async (type: AggregateType, id: string) => {
    if (throwFor?.has(`${type}:${id}`)) throw new Error('idb read failed');
    return store.get(`${type}:${id}`) ?? null;
  }),
}));

function put(type: AggregateType, id: string, payload: Record<string, unknown>): void {
  store.set(`${type}:${id}`, {
    id,
    householdId: 'hh',
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-07-01T00:00:00Z',
    deviceId: 'dev',
    payload,
  });
}

beforeEach(() => {
  store.clear();
  throwFor = null;
});

/**
 * One happy-path case per `AggregateType`: seed local state, then assert the
 * resolved type label + name (+ detail for the balance). Keyed by the exact
 * `AggregateType` so the exhaustiveness assertion below proves all 9 are here.
 */
const cases: Record<
  AggregateType,
  { seed: () => void; id: string; typeLabel: string; name: string; detail?: string }
> = {
  household: {
    seed: () => put('household', 'hh-1', { name: 'Smith Household' }),
    id: 'hh-1',
    typeLabel: 'Household',
    name: 'Smith Household',
  },
  householdMember: {
    seed: () => put('householdMember', 'mem-1', { firstName: 'Jane', lastName: 'Doe' }),
    id: 'mem-1',
    typeLabel: 'Household member',
    name: 'Jane Doe',
  },
  account: {
    seed: () => put('account', 'acc-1', { name: 'John 401(k)' }),
    id: 'acc-1',
    typeLabel: 'Account',
    name: 'John 401(k)',
  },
  accountBalance: {
    seed: () => {
      put('account', 'acc-1', { name: 'John 401(k)' });
      put('accountBalance', 'bal-1', { accountId: 'acc-1', year: 2026 });
    },
    id: 'bal-1',
    typeLabel: 'Account balance',
    name: 'John 401(k)',
    detail: '2026',
  },
  socialSecurityBenefit: {
    seed: () => {
      put('householdMember', 'mem-1', { firstName: 'Jane', lastName: 'Doe' });
      put('socialSecurityBenefit', 'ss-1', { householdMemberId: 'mem-1' });
    },
    id: 'ss-1',
    typeLabel: 'Social Security',
    name: 'Jane Doe',
  },
  scenario: {
    seed: () => put('scenario', 'sc-1', { name: 'Base' }),
    id: 'sc-1',
    typeLabel: 'Scenario',
    name: 'Base',
  },
  expenseCategory: {
    seed: () => put('expenseCategory', 'cat-1', { name: 'Housing' }),
    id: 'cat-1',
    typeLabel: 'Expense category',
    name: 'Housing',
  },
  expense: {
    seed: () => put('expense', 'exp-1', { name: 'Groceries' }),
    id: 'exp-1',
    typeLabel: 'Expense',
    name: 'Groceries',
  },
  incomeStream: {
    seed: () => put('incomeStream', 'inc-1', { name: 'Pension' }),
    id: 'inc-1',
    typeLabel: 'Income',
    name: 'Pension',
  },
};

describe('resolveMutationLabel', () => {
  it('covers every AggregateType (exhaustiveness)', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(AGGREGATE_TYPE_LABEL).sort());
  });

  it.each(Object.entries(cases))(
    'resolves a %s mutation to its friendly type + name',
    async (type, spec) => {
      spec.seed();
      const label = await resolveMutationLabel({
        aggregateType: type as AggregateType,
        aggregateId: spec.id,
      });
      expect(label.typeLabel).toBe(spec.typeLabel);
      expect(label.name).toBe(spec.name);
      expect(label.detail).toBe(spec.detail);
    },
  );

  it('falls back to the raw id when a simple aggregate is absent (child-absent)', async () => {
    const label = await resolveMutationLabel({
      aggregateType: 'scenario',
      aggregateId: 'sc-gone',
    });
    expect(label).toEqual({ typeLabel: 'Scenario', name: 'sc-gone' });
  });

  it('falls back to the raw id for a delete-conflict whose accountBalance is gone', async () => {
    const label = await resolveMutationLabel({
      aggregateType: 'accountBalance',
      aggregateId: 'bal-gone',
    });
    expect(label).toEqual({ typeLabel: 'Account balance', name: 'bal-gone' });
  });

  it('falls back to the raw id when the balance resolves but its account is gone (parent-absent)', async () => {
    put('accountBalance', 'bal-1', { accountId: 'acc-missing', year: 2026 });
    const label = await resolveMutationLabel({
      aggregateType: 'accountBalance',
      aggregateId: 'bal-1',
    });
    expect(label).toEqual({ typeLabel: 'Account balance', name: 'bal-1' });
  });

  it('falls back to the raw id when the SS-benefit owning member is gone (parent-absent)', async () => {
    put('socialSecurityBenefit', 'ss-1', { householdMemberId: 'mem-missing' });
    const label = await resolveMutationLabel({
      aggregateType: 'socialSecurityBenefit',
      aggregateId: 'ss-1',
    });
    expect(label).toEqual({ typeLabel: 'Social Security', name: 'ss-1' });
  });

  it('never throws when getAggregate rejects — falls back to the raw id', async () => {
    throwFor = new Set(['scenario:sc-boom']);
    const label = await resolveMutationLabel({
      aggregateType: 'scenario',
      aggregateId: 'sc-boom',
    });
    expect(label).toEqual({ typeLabel: 'Scenario', name: 'sc-boom' });
  });

  it('never throws when a parent lookup rejects — falls back to the raw id', async () => {
    put('accountBalance', 'bal-1', { accountId: 'acc-1', year: 2026 });
    throwFor = new Set(['account:acc-1']);
    const label = await resolveMutationLabel({
      aggregateType: 'accountBalance',
      aggregateId: 'bal-1',
    });
    expect(label).toEqual({ typeLabel: 'Account balance', name: 'bal-1' });
  });
});
