/**
 * Display-helper tests for Expense aggregates. Locks the user-facing
 * copy for each timepoint kind so future refactors don't silently
 * change what the list page renders.
 */
import { describe, expect, it } from 'vitest';
import {
  describeExpenseEnd,
  describeExpenseStart,
  formatExpenseAmount,
  frequencyToAnnual,
  memberLabel,
} from './expense-format';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

const member = (
  id: string,
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'h1',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-11T00:00:00Z',
  deviceId: 'd1',
  aggregateType: 'householdMember',
  payload: {
    isPrimary,
    firstName,
    lastName: '',
    email: '',
    birthdate: '1970-01-01',
  },
});

describe('frequencyToAnnual', () => {
  it.each([
    ['weekly', 52],
    ['monthly', 12],
    ['quarterly', 4],
    ['yearly', 1],
    ['oneOff', 1],
  ] as const)('%s -> %d', (freq, expected) => {
    expect(frequencyToAnnual(freq)).toBe(expected);
  });
});

describe('formatExpenseAmount', () => {
  it('renders a per-frequency suffix in whole dollars', () => {
    // Routed through the app-wide `formatCurrency` (whole-dollar) —
    // amounts no longer carry the always-`.00` cents.
    expect(formatExpenseAmount(400, 'monthly')).toBe('$400/mo');
    expect(formatExpenseAmount(8000, 'yearly')).toBe('$8,000/yr');
    expect(formatExpenseAmount(40000, 'oneOff')).toBe('$40,000 once');
    expect(formatExpenseAmount(200, 'weekly')).toBe('$200/wk');
    expect(formatExpenseAmount(150, 'quarterly')).toBe('$150/qtr');
  });
});

describe('describeExpenseStart', () => {
  it('renders each start kind with Primary/Secondary fallback when no members', () => {
    expect(describeExpenseStart({ kind: 'retirementStart' })).toBe('Start of retirement');
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'primary', years: 65, months: 0 }),
    ).toBe('Primary age 65');
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'secondary', years: 67, months: 6 }),
    ).toBe('Secondary age 67 years 6 months');
    expect(describeExpenseStart({ kind: 'year', year: 2034 })).toBe('Year 2034');
  });

  it('prefers firstName when members are provided', () => {
    const members = [member('m1', true, 'Robert'), member('m2', false, 'Jane')];
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'primary', years: 65, months: 0 }, members),
    ).toBe('Robert age 65');
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'secondary', years: 67, months: 6 }, members),
    ).toBe('Jane age 67 years 6 months');
  });

  it('falls back to Primary/Secondary when matching member has empty firstName', () => {
    const members = [member('m1', true, '   '), member('m2', false, '')];
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'primary', years: 65, months: 0 }, members),
    ).toBe('Primary age 65');
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'secondary', years: 70, months: 0 }, members),
    ).toBe('Secondary age 70');
  });

  it('singularises year / month units when count is 1', () => {
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'primary', years: 1, months: 1 }),
    ).toBe('Primary age 1 year 1 month');
    expect(
      describeExpenseStart({ kind: 'age', memberId: 'primary', years: 2, months: 1 }),
    ).toBe('Primary age 2 years 1 month');
  });
});

describe('describeExpenseEnd', () => {
  it('one-off frequency reads as (one-off) regardless of end value', () => {
    expect(describeExpenseEnd(undefined, 'oneOff')).toBe('(one-off)');
  });

  it('renders each end kind with primary/secondary fallback when no members', () => {
    expect(
      describeExpenseEnd({ kind: 'age', memberId: 'primary', years: 75, months: 0 }, 'monthly'),
    ).toBe('primary age 75');
    expect(describeExpenseEnd({ kind: 'year', year: 2034 }, 'yearly')).toBe('year 2034');
    expect(describeExpenseEnd({ kind: 'lifetime', whose: 'primary' }, 'monthly')).toBe(
      'until death of primary',
    );
    expect(describeExpenseEnd({ kind: 'lifetime', whose: 'secondary' }, 'monthly')).toBe(
      'until death of secondary',
    );
    expect(describeExpenseEnd({ kind: 'lifetime', whose: 'last' }, 'monthly')).toBe(
      'until death of last surviving',
    );
    expect(
      describeExpenseEnd({ kind: 'endOfRetirementYear', offsetYears: 0 }, 'monthly'),
    ).toBe('for the first retirement year');
    expect(
      describeExpenseEnd({ kind: 'endOfRetirementYear', offsetYears: 2 }, 'monthly'),
    ).toBe('for the first 3 retirement years');
    expect(
      describeExpenseEnd({ kind: 'durationFromStart', months: 18 }, 'monthly'),
    ).toBe('18 months from start');
    expect(
      describeExpenseEnd({ kind: 'durationFromStart', months: 120 }, 'yearly'),
    ).toBe('10 years from start');
  });

  it('prefers firstName when members are provided', () => {
    const members = [member('m1', true, 'Robert'), member('m2', false, 'Jane')];
    expect(
      describeExpenseEnd(
        { kind: 'age', memberId: 'primary', years: 75, months: 0 },
        'monthly',
        members,
      ),
    ).toBe('Robert age 75');
    expect(
      describeExpenseEnd(
        { kind: 'age', memberId: 'secondary', years: 80, months: 6 },
        'monthly',
        members,
      ),
    ).toBe('Jane age 80 years 6 months');
    expect(
      describeExpenseEnd({ kind: 'lifetime', whose: 'primary' }, 'monthly', members),
    ).toBe('until death of Robert');
    expect(
      describeExpenseEnd({ kind: 'lifetime', whose: 'secondary' }, 'monthly', members),
    ).toBe('until death of Jane');
    expect(
      describeExpenseEnd({ kind: 'lifetime', whose: 'last' }, 'monthly', members),
    ).toBe('until death of last surviving');
  });

  it('falls back to primary/secondary when matching member has empty firstName', () => {
    const members = [member('m1', true, ''), member('m2', false, '   ')];
    expect(
      describeExpenseEnd({ kind: 'lifetime', whose: 'primary' }, 'monthly', members),
    ).toBe('until death of primary');
    expect(
      describeExpenseEnd({ kind: 'lifetime', whose: 'secondary' }, 'monthly', members),
    ).toBe('until death of secondary');
  });
});

describe('memberLabel', () => {
  it('returns the trimmed firstName when present', () => {
    const m = member('m1', true, '  Robert  ');
    expect(memberLabel(m, undefined, 'primary')).toBe('Robert');
  });

  it('falls back to the lowercase slot when firstName is blank', () => {
    const m = member('m1', true, '   ');
    expect(memberLabel(m, undefined, 'primary')).toBe('primary');
  });

  it('falls back to the lowercase slot when the member is undefined', () => {
    expect(memberLabel(undefined, undefined, 'secondary')).toBe('secondary');
  });
});
