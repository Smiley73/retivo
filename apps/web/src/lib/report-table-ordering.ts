// Defines deterministic report/PDF table ordering.
import type { ExpensePayload } from '../db/types';
import { monthIndex, resolveEndMonth, resolveStartMonth, type ScheduleResolveContext } from './schedule-resolution';

const REPORT_COLLATOR = new Intl.Collator('en-US', { sensitivity: 'base', numeric: true });

interface ExpenseOrderFields {
  readonly id: string; readonly name: string; readonly categoryName: string;
  readonly classification: ExpensePayload['classification'];
  readonly effectiveStartMonth: number | null; readonly effectiveEndMonth: number | null;
}
interface IncomeOrderFields { readonly id: string; readonly name: string; readonly ownerSortRank: 0 | 1 | 2; }
interface AccountOrderFields { readonly id: string; readonly name: string; readonly ownerDisplayName: string; }
/** Effective month indexes used exclusively for deterministic expense ordering. */
export interface ReportExpenseOrderMonths {
  readonly effectiveStartMonth: number | null; readonly effectiveEndMonth: number | null;
}

function compareNullableMonth(a: number | null, b: number | null): number {
  const finiteA = a !== null && Number.isFinite(a) ? a : null;
  const finiteB = b !== null && Number.isFinite(b) ? b : null;
  if (finiteA === null) return finiteB === null ? 0 : 1;
  if (finiteB === null) return -1;
  return finiteA - finiteB;
}

function resolvedMonthIndex(value: { year: number; month0: number } | null): number | null {
  if (
    value === null ||
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month0) ||
    value.month0 < 0 ||
    value.month0 > 11
  ) {
    return null;
  }
  const index = monthIndex(value.year, value.month0);
  return Number.isFinite(index) ? index : null;
}

/** Resolves the effective start and end months used to order an expense row. */
export function resolveReportExpenseOrderMonths(
  expense: Pick<ExpensePayload, 'frequency' | 'start' | 'end'>,
  context: ScheduleResolveContext,
): ReportExpenseOrderMonths {
  const start = resolveStartMonth(expense.start, context);
  const effectiveStartMonth = resolvedMonthIndex(start);
  if (start === null || effectiveStartMonth === null) {
    return { effectiveStartMonth: null, effectiveEndMonth: null };
  }
  if (expense.frequency === 'oneOff') {
    return { effectiveStartMonth, effectiveEndMonth: effectiveStartMonth };
  }
  const end = expense.end ? resolveEndMonth(expense.end, start, context) : null;
  return {
    effectiveStartMonth,
    effectiveEndMonth: resolvedMonthIndex(end),
  };
}

/** Returns expense rows in the report's deterministic display order. */
export function sortReportExpenses<T extends ExpenseOrderFields>(
  expenses: ReadonlyArray<T>,
): T[] {
  return [...expenses].sort(
    (a, b) =>
      (a.classification === 'essential' ? 0 : 1) -
        (b.classification === 'essential' ? 0 : 1) ||
      REPORT_COLLATOR.compare(a.categoryName, b.categoryName) ||
      compareNullableMonth(a.effectiveStartMonth, b.effectiveStartMonth) ||
      compareNullableMonth(a.effectiveEndMonth, b.effectiveEndMonth) ||
      REPORT_COLLATOR.compare(a.name, b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Returns income rows ordered by owner, natural name, and stable ID. */
export function sortReportIncomeStreams<T extends IncomeOrderFields>(
  streams: ReadonlyArray<T>,
): T[] {
  return [...streams].sort(
    (a, b) =>
      a.ownerSortRank - b.ownerSortRank ||
      REPORT_COLLATOR.compare(a.name, b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Compares by natural name then stable ID — for report rows keyed by a
 *  display name with no owner column (e.g. the Account limits group), so
 *  they order identically to the account tables sorted just below. */
export function compareReportNameThenId(
  a: { readonly id: string; readonly name: string },
  b: { readonly id: string; readonly name: string },
): number {
  return REPORT_COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

/** Returns account rows ordered by natural name, owner name, and stable ID. */
export function sortReportAccounts<T extends AccountOrderFields>(
  accounts: ReadonlyArray<T>,
): T[] {
  return [...accounts].sort(
    (a, b) =>
      REPORT_COLLATOR.compare(a.name, b.name) ||
      REPORT_COLLATOR.compare(a.ownerDisplayName, b.ownerDisplayName) ||
      a.id.localeCompare(b.id),
  );
}

/** Returns the ordered accounts included in the selected scenario's by-account view. */
function selectReportByAccountAccounts<T extends AccountOrderFields>(
  accounts: ReadonlyArray<T>,
  excludedAccountIds: ReadonlyArray<string>,
): T[] {
  const excluded = new Set(excludedAccountIds);
  return sortReportAccounts(accounts.filter((account) => !excluded.has(account.id)));
}

/** Preserves the full account list while deriving the selected scenario's by-account list. */
export function buildReportPdfAccountLists<T extends AccountOrderFields>(
  accounts: ReadonlyArray<T>,
  excludedAccountIds: ReadonlyArray<string>,
): { allAccounts: ReadonlyArray<T>; byAccountAccounts: T[] } {
  return { allAccounts: accounts,
    byAccountAccounts: selectReportByAccountAccounts(accounts, excludedAccountIds) };
}
