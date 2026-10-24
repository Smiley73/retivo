// Display helpers for Expense aggregates, wrapping the generic schedule-format helpers with expense-only concerns.

import type {
  Aggregate,
  ExpenseFrequency,
  HouseholdMemberPayload,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import { formatCurrency } from './format-currency';
import { describeEnd, describeStart } from './schedule-format';

export function frequencyToAnnual(f: ExpenseFrequency): number {
  switch (f) {
    case 'weekly':
      return 52;
    case 'monthly':
      return 12;
    case 'quarterly':
      return 4;
    case 'yearly':
      return 1;
    case 'oneOff':
      // A single event; the multiplier of 1 lets generic code multiply without branching.
      return 1;
  }
}

const FREQ_SUFFIX: Record<ExpenseFrequency, string> = {
  weekly: '/wk',
  monthly: '/mo',
  quarterly: '/qtr',
  yearly: '/yr',
  oneOff: ' once',
};

export function formatExpenseAmount(amount: number, freq: ExpenseFrequency): string {
  return `${formatCurrency(amount)}${FREQ_SUFFIX[freq]}`;
}

export function describeExpenseStart(
  start: ScheduleStart,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  return describeStart(start, members);
}

export function describeExpenseEnd(
  end: ScheduleEnd | undefined,
  freq: ExpenseFrequency,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  if (freq === 'oneOff') return '(one-off)';
  return describeEnd(end, members);
}

/** A member's display label: `firstName` (docs/ui-conventions.md, "Member labels"), else the lowercase slot label. */
export function memberLabel(
  member: Aggregate<HouseholdMemberPayload> | undefined,
  // Unused; kept so call sites that already pass it need no parallel variant.
  _members: ReadonlyArray<Aggregate<HouseholdMemberPayload>> | undefined,
  fallbackSlot: 'primary' | 'secondary',
): string {
  const name = member?.payload.firstName?.trim();
  return name && name.length > 0 ? name : fallbackSlot;
}
