/**
 * Display helpers for Expense aggregates. Pure functions — no React,
 * no DOM. Wraps the generic schedule-format helpers with expense-only
 * concerns (amount/frequency formatting, the `(one-off)` end label).
 */
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
      // OneOff is a single event — callers handle it specially. The
      // multiplier here just lets generic code default-multiply by 1
      // without branching.
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

/**
 * Resolve a household member's display label. Prefers `firstName` (per
 * docs/ui-conventions.md, "Member labels"); falls back to the lowercase slot
 * label (`primary` / `secondary`) when the member is absent or the
 * trimmed first name is empty.
 *
 * The `members` parameter is accepted for call-site flexibility — some
 * call sites resolve the member by id from a members array before
 * invoking; the helper itself only reads the named `member`.
 */
export function memberLabel(
  member: Aggregate<HouseholdMemberPayload> | undefined,
  // The `members` parameter is unused inside this helper — kept on the
  // signature so call sites that already pass it (e.g. the CBP banner,
  // which looks up an ownerId → member upstream) don't need a parallel
  // variant. The lookup is the caller's responsibility.
  _members: ReadonlyArray<Aggregate<HouseholdMemberPayload>> | undefined,
  fallbackSlot: 'primary' | 'secondary',
): string {
  const name = member?.payload.firstName?.trim();
  return name && name.length > 0 ? name : fallbackSlot;
}
