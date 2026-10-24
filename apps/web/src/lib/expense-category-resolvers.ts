// Pure resolvers over the ExpenseCategory set; the only place `isMedical` and `hsaQualified` are normalised, with a strict `=== true` so a tampered `"true"` or `1` reads false.
// `DANGEROUS_CATEGORY_RATE_KEYS` (prototype-pollution keys) lives in `db/types.ts` to stay cycle-free.

import type { Aggregate, ExpenseCategoryPayload, ExpensePayload } from '../db/types';
import { DANGEROUS_CATEGORY_RATE_KEYS } from '../db/types';
import { DEFAULT_EXPENSE_CATEGORY_IDS } from './expense-categories-bootstrap';

/** Ids of live categories with `isMedical === true`, minus any `DANGEROUS_CATEGORY_RATE_KEYS` id. */
export function medicalCategoryIdsFrom(
  categories: ReadonlyArray<Aggregate<ExpenseCategoryPayload>>,
): string[] {
  const out: string[] = [];
  for (const cat of categories) {
    if (cat.deletedAt) continue;
    if (cat.payload.isMedical !== true) continue;
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(cat.id)) continue;
    out.push(cat.id);
  }
  return out;
}

export function isMedicalExpense(
  expense: { payload: Pick<ExpensePayload, 'categoryId'> },
  medicalIds: ReadonlySet<string>,
): boolean {
  return medicalIds.has(expense.payload.categoryId);
}

/**
 * True for a resolved expense in a medical category with `hsaQualified === true`;
 * the one predicate both engine builders and the form gate use for HSA medical demand.
 */
export function isHsaQualifiedMedical(
  expense: { payload: Pick<ExpensePayload, 'categoryId' | 'hsaQualified'> },
  medicalIds: ReadonlySet<string>,
): boolean {
  return (
    medicalIds.has(expense.payload.categoryId) &&
    expense.payload.hsaQualified === true
  );
}

/**
 * Array to `Set` adapter applied at every engine `categoryRates` consumer so the
 * absent and empty boundary is identical. An absent array defaults to the seeded
 * `cat-medical` id, while an explicitly empty one means no medical categories.
 * It re-applies the dangerous-key filter so a non-resolver array cannot smuggle a
 * forbidden id into an engine map.
 */
export function medicalCategoryIdSet(
  arr: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  const source = arr ?? [DEFAULT_EXPENSE_CATEGORY_IDS.Medical];
  const out = new Set<string>();
  for (const id of source) {
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(id)) continue;
    out.add(id);
  }
  return out;
}
