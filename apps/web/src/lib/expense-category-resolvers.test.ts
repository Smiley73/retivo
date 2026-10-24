// `isMedical` is normalised strictly (`=== true`, CWE-20) with a dangerous-key drop (CWE-1321); `hsaQualified` is strict too, and absent or truthy-non-boolean is not qualified.
import { describe, it, expect } from 'vitest';
import {
  medicalCategoryIdsFrom,
  medicalCategoryIdSet,
  isHsaQualifiedMedical,
} from './expense-category-resolvers';
import { DEFAULT_EXPENSE_CATEGORY_IDS } from './expense-categories-bootstrap';
import type { Aggregate, ExpenseCategoryPayload } from '../db/types';

function cat(
  id: string,
  payload: Partial<ExpenseCategoryPayload> & { name?: string },
  opts: { deletedAt?: string } = {},
): Aggregate<ExpenseCategoryPayload> {
  return {
    id,
    householdId: 'h1',
    schemaVersion: 2,
    version: 1,
    updatedAt: '2026-06-23T00:00:00.000Z',
    deviceId: 'd1',
    aggregateType: 'expenseCategory',
    ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    payload: { name: payload.name ?? id, ...payload },
  };
}

describe('medicalCategoryIdsFrom', () => {
  it('returns the ids of categories flagged isMedical === true', () => {
    const ids = medicalCategoryIdsFrom([
      cat('cat-medical', { isMedical: true }),
      cat('cat-housing', { isMedical: false }),
      cat('cat-care', { isMedical: true }),
      cat('cat-food', {}),
    ]);
    expect(ids.sort()).toEqual(['cat-care', 'cat-medical']);
  });

  it('is empty when no category is flagged', () => {
    expect(medicalCategoryIdsFrom([cat('cat-food', {})])).toEqual([]);
  });

  it('skips deleted (tombstoned) categories even when flagged', () => {
    const ids = medicalCategoryIdsFrom([
      cat('cat-medical', { isMedical: true }, { deletedAt: '2026-06-23T00:00:00.000Z' }),
      cat('cat-care', { isMedical: true }),
    ]);
    expect(ids).toEqual(['cat-care']);
  });

  it('treats a non-boolean isMedical as not-medical (CWE-20)', () => {
    for (const bad of ['true', 1, {}, []] as unknown[]) {
      const ids = medicalCategoryIdsFrom([
        cat('cat-x', { isMedical: bad as boolean }),
      ]);
      expect(ids).toEqual([]);
    }
  });

  it('drops a forbidden-key id even when flagged (CWE-1321)', () => {
    for (const danger of ['__proto__', 'constructor', 'prototype']) {
      const ids = medicalCategoryIdsFrom([cat(danger, { isMedical: true })]);
      expect(ids).toEqual([]);
    }
  });
});

describe('isHsaQualifiedMedical', () => {
  const medicalIds: ReadonlySet<string> = new Set(['cat-medical', 'cat-care']);

  function exp(categoryId: string, hsaQualified?: unknown) {
    return {
      payload: {
        categoryId,
        ...(hsaQualified !== undefined ? { hsaQualified } : {}),
      },
    } as { payload: { categoryId: string; hsaQualified?: boolean } };
  }

  it('returns true when categoryId is medical AND hsaQualified === true', () => {
    expect(isHsaQualifiedMedical(exp('cat-medical', true), medicalIds)).toBe(true);
    expect(isHsaQualifiedMedical(exp('cat-care', true), medicalIds)).toBe(true);
  });

  it('returns false for a medical category with hsaQualified === false', () => {
    expect(isHsaQualifiedMedical(exp('cat-medical', false), medicalIds)).toBe(false);
  });

  it('returns false for a medical category with absent hsaQualified (absent ⇒ not qualified)', () => {
    expect(isHsaQualifiedMedical(exp('cat-medical'), medicalIds)).toBe(false);
  });

  it('returns false for a non-medical category even when hsaQualified === true', () => {
    expect(isHsaQualifiedMedical(exp('cat-housing', true), medicalIds)).toBe(false);
    expect(isHsaQualifiedMedical(exp('cat-food', true), medicalIds)).toBe(false);
  });

  it('returns false when categoryId is empty', () => {
    expect(isHsaQualifiedMedical(exp('', true), medicalIds)).toBe(false);
  });

  it('treats non-boolean truthy as not-qualified (CWE-20)', () => {
    for (const bad of ['true', 1, {}, [], 'yes'] as unknown[]) {
      expect(
        isHsaQualifiedMedical(
          { payload: { categoryId: 'cat-medical', hsaQualified: bad as boolean } },
          medicalIds,
        ),
      ).toBe(false);
    }
  });

  it('treats non-boolean falsy (0, null, "") as not-qualified (CWE-20)', () => {
    for (const bad of [0, null, ''] as unknown[]) {
      expect(
        isHsaQualifiedMedical(
          { payload: { categoryId: 'cat-medical', hsaQualified: bad as boolean } },
          medicalIds,
        ),
      ).toBe(false);
    }
  });

  it('ignores the flag on a non-medical category (flag is inert)', () => {
    expect(isHsaQualifiedMedical(exp('cat-food', true), medicalIds)).toBe(false);
  });
});

describe('medicalCategoryIdSet', () => {
  it('falls back to the seeded cat-medical id when the array is absent', () => {
    expect([...medicalCategoryIdSet(undefined)]).toEqual([
      DEFAULT_EXPENSE_CATEGORY_IDS.Medical,
    ]);
  });

  it('returns an empty set for an explicitly empty array (no legacy fallback)', () => {
    expect([...medicalCategoryIdSet([])]).toEqual([]);
  });

  it('re-applies the dangerous-key filter (defense-in-depth)', () => {
    const set = medicalCategoryIdSet(['cat-care', '__proto__', 'constructor']);
    expect([...set]).toEqual(['cat-care']);
  });
});
