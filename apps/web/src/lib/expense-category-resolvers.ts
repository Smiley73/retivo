/**
 * Pure resolvers over the ExpenseCategory aggregate set.
 *
 * The SOLE normalisation point for the `isMedical` flag: the strict
 * `payload.isMedical === true` test (CWE-20 — a tampered/imported `"true"` /
 * `1` / `{}` must read not-medical) lives here only. Every consumer
 * (inflation, report, projection engine, optimizer, HSA routing)
 * reads the resolver's id-set output, never the raw payload boolean.
 *
 * The SOLE normalisation point for the `hsaQualified` flag: the strict
 * `payload.hsaQualified === true` test (CWE-20) lives in
 * `isHsaQualifiedMedical` only. No consumer reads `ExpensePayload.hsaQualified`
 * directly; both engine builders and the form gate call this predicate.
 *
 * `DANGEROUS_CATEGORY_RATE_KEYS` is the single shared source (CWE-1321),
 * defined in `db/types.ts` (lowest-level, cycle-free) and re-exported here so
 * resolver consumers have one import path.
 */
import type { Aggregate, ExpenseCategoryPayload, ExpensePayload } from '../db/types';
import { DANGEROUS_CATEGORY_RATE_KEYS } from '../db/types';
import { DEFAULT_EXPENSE_CATEGORY_IDS } from './expense-categories-bootstrap';

/**
 * The ids of non-deleted categories flagged `isMedical === true`, dropping
 * any id matching {@link DANGEROUS_CATEGORY_RATE_KEYS}. This is the canonical
 * "which categories are medical?" source.
 *
 * Strict `=== true` (CWE-20): a non-boolean stored value (`"true"`, `1`,
 * `{}`) reads not-medical. Tombstoned (deleted) rows never count.
 */
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

/** Every modeled Medical expense, HSA-qualified or not. */
export function isMedicalExpense(
  expense: { payload: Pick<ExpensePayload, 'categoryId'> },
  medicalIds: ReadonlySet<string>,
): boolean {
  return medicalIds.has(expense.payload.categoryId);
}

/**
 * The SINGLE-SOURCE predicate for HSA-qualified medical demand.
 *
 * A resolved expense contributes to HSA medical demand iff:
 *   1. Its `categoryId` is in the `medicalIds` set (isMedical gate).
 *   2. Its `payload.hsaQualified === true` (strict CWE-20; absent ⇒ false).
 *
 * Both engine builders (`buildMedicalDemandByMonth` in
 * balance-projection-runner-cashflow.ts and `computeMedicalDemandBase` in
 * balance-projection-runner-mc.ts) AND the form's gate call this predicate.
 * No caller reads `payload.hsaQualified` directly.
 *
 * @param expense - A resolved expense (payload + meta).
 * @param medicalIds - The `ReadonlySet<string>` from `medicalCategoryIdSet`.
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
 * Array → `Set` adapter applied at EVERY engine `categoryRates` consumer so
 * the absent / empty / legacy-default boundary is identical everywhere
 * (single-source rule). An absent array defaults to the seeded
 * `cat-medical` id (back-compat). Re-applies the dangerous-key filter
 * (defense-in-depth) so a non-resolver-derived array can't smuggle a
 * forbidden id into the engine `Map` / report plain-object.
 *
 * NOTE: an explicitly-empty array means "no medical categories" — it does
 * NOT fall back to the legacy default (only `undefined` does).
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
