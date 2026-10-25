import { describe, expect, it } from 'vitest';
import type { ExpensePayload } from '../db/types';
import {
  resolveReportExpenseOrderMonths,
  buildReportPdfAccountLists,
  sortReportAccounts,
  sortReportExpenses,
  sortReportIncomeStreams,
} from './report-table-ordering';
import type { ScheduleResolveContext } from './schedule-resolution';
const row = (id: string, overrides = {}) => ({
  id, name: 'Expense', categoryName: 'Other',
  classification: 'essential' as const,
  effectiveStartMonth: 24_360 as number | null, effectiveEndMonth: 24_372 as number | null,
  ...overrides,
});
const payload = (overrides: Partial<ExpensePayload> = {}): ExpensePayload => ({
  name: 'Expense', amount: 100, frequency: 'monthly',
  classification: 'essential', categoryId: 'cat',
  start: { kind: 'retirementStart' },
  end: { kind: 'durationFromStart', months: 12 },
  ...overrides,
});
const context: ScheduleResolveContext = {
  retirementYear: 2030, retirementMonth0: 4,
  primary: { birthdate: '1965-03-12' },
  secondary: { birthdate: '1968-09-03' },
  lifeExpectancy: { primary: 90, secondary: 95 },
  extendBeyondLifetime: false,
};
const ids = <T extends { id: string }>(values: T[]) => values.map(({ id }) => id);
describe('report table ordering', () => {
  it('sorts every expense key, natural text, null dates, and preserves input', () => {
    const input = [
      row('discretionary', { classification: 'discretionary' as const }),
      row('null', { effectiveStartMonth: null }),
      row('nan', { effectiveStartMonth: Number.NaN }),
      row('end', { effectiveEndMonth: 24_371 }),
      row('cat10', { categoryName: 'Category 10' }),
      row('name10', { categoryName: 'Category 2', name: 'Expense 10' }),
      row('name2-b', { categoryName: 'category 2', name: 'expense 2' }),
      row('name2-a', { categoryName: 'Category 2', name: 'Expense 2' }),
      row('start', { effectiveStartMonth: 24_359 }),
    ];
    expect(ids(sortReportExpenses(input))).toEqual([
      'name2-a', 'name2-b', 'name10', 'cat10', 'start', 'end',
      'nan', 'null', 'discretionary',
    ]);
    expect(ids(input)[0]).toBe('discretionary');
  });
  it.each([
    ['retirement/duration', {}, 2030 * 12 + 4, 2031 * 12 + 4],
    ['year', { start: { kind: 'year', year: 2029 }, end: { kind: 'year', year: 2030 } }, 2029 * 12, 2031 * 12],
    ['age/lifetime', { start: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, end: { kind: 'lifetime', whose: 'primary' } }, 2030 * 12 + 2, 2056 * 12],
    ['end age', { end: { kind: 'age', memberId: 'secondary', years: 70, months: 0 } }, 2030 * 12 + 4, 2038 * 12 + 8],
    ['retirement year end', { end: { kind: 'endOfRetirementYear', offsetYears: 2 } }, 2030 * 12 + 4, 2033 * 12],
    ['one-off', { frequency: 'oneOff', start: { kind: 'age', memberId: 'secondary', years: 70, months: 2 }, end: undefined }, 2038 * 12 + 10, 2038 * 12 + 10],
  ] as const)('resolves %s anchors', (_label, overrides, start, end) => {
    expect(resolveReportExpenseOrderMonths(payload(overrides), context)).toEqual({
      effectiveStartMonth: start, effectiveEndMonth: end,
    });
  });
  it('normalizes unresolved and non-finite expense dates to null', () => {
    expect(resolveReportExpenseOrderMonths(payload(), { ...context, retirementYear: Number.NaN }))
      .toEqual({ effectiveStartMonth: null, effectiveEndMonth: null });
    expect(resolveReportExpenseOrderMonths(payload({ start: { kind: 'age', memberId: 'secondary', years: 70, months: 0 } }), { ...context, secondary: undefined }))
      .toEqual({ effectiveStartMonth: null, effectiveEndMonth: null });
  });
  it('sorts income by owner, name, and ID without mutation', () => {
    const input = [
      { id: 'u', name: 'Unknown', ownerSortRank: 2 as const },
      { id: 's', name: 'Alpha', ownerSortRank: 1 as const },
      { id: 'b', name: 'Pension 10', ownerSortRank: 0 as const },
      { id: 'a', name: 'pension 2', ownerSortRank: 0 as const },
    ];
    expect(ids(sortReportIncomeStreams(input))).toEqual(['a', 'b', 's', 'u']);
    expect(ids(input)[0]).toBe('u');
  });
  it('sorts accounts by name, owner, and ID, and keeps the full list beside the by-account list without excluded ones', () => {
    const input = [
      { id: 'ten', name: 'Account 10', ownerDisplayName: 'Alex' },
      { id: 'z', name: 'account 2', ownerDisplayName: 'Zoe' },
      { id: 'a', name: 'Account 2', ownerDisplayName: 'alex' },
      { id: 'excluded', name: 'Account 1', ownerDisplayName: 'Alex' },
    ];
    expect(ids(sortReportAccounts(input))).toEqual(['excluded', 'a', 'z', 'ten']);
    const lists = buildReportPdfAccountLists(input, ['excluded']);
    expect(ids(lists.byAccountAccounts)).toEqual(['a', 'z', 'ten']);
    expect(lists.allAccounts).toBe(input);
    expect(ids(input)[0]).toBe('ten');
  });
});
