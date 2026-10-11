/**
 * Display helpers for IncomeStream rows. Keep this lib free of React
 * imports so engine + page can share.
 */
import type {
  HouseholdMemberPayload,
  IncomeStreamPayload,
  Aggregate,
} from '../db/types';
import {
  describeExpenseEnd,
  describeExpenseStart,
} from './expense-format';
import { formatAgeYearsMonths } from './format-age';
import { formatCurrency } from './format-currency';

export function formatIncomeKind(p: IncomeStreamPayload): string {
  if (p.kind === 'pension') {
    return p.payoutType === 'annuity' ? 'Pension (annuity)' : 'Pension (lump sum)';
  }
  if (p.kind === 'partTime') return 'Part-time / earned';
  return 'One-off / windfall';
}

export function formatIncomeAmount(p: IncomeStreamPayload): string {
  if (p.kind === 'pension') {
    if (p.payoutType === 'annuity') {
      return `${formatCurrency(p.monthlyBenefit ?? 0)}/mo`;
    }
    return formatCurrency(p.lumpSumAmount ?? 0);
  }
  if (p.kind === 'partTime') {
    return `${formatCurrency(p.annualAmount ?? 0)}/yr`;
  }
  return formatCurrency(p.oneOffAmount ?? 0);
}

export function formatIncomeSchedule(
  p: IncomeStreamPayload,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  if (!p.start) return 'No schedule set';
  if (p.kind === 'pension') {
    if (p.payoutType === 'annuity') {
      return `Starts at ${formatStartPhrase(p.start)}`;
    }
    if (p.payoutType === 'lumpSum') {
      return `Received at ${formatStartPhrase(p.start)}`;
    }
    return 'No schedule set';
  }
  if (p.kind === 'partTime') {
    return formatPartTimeSchedule(p, members);
  }
  if (p.kind === 'oneOff') {
    return `Received at ${formatStartPhrase(p.start)}`;
  }
  return 'No schedule set';
}

/** Sentence-form start phrase, owner-implicit. Used by single-event
 *  income (annuity payment-start, lumpSum receipt, oneOff windfall)
 *  where the surrounding sentence already implies the owner via
 *  list-grouping. */
function formatStartPhrase(start: NonNullable<IncomeStreamPayload['start']>): string {
  switch (start.kind) {
    case 'retirementStart':
      return 'retirement';
    case 'age':
      return `age ${formatAgeYearsMonths({ years: start.years, months: start.months })}`;
    case 'year':
      return `${start.year}`;
  }
}

/**
 * Plain-language schedule line for a partTime IncomeStream. Aims for
 * sentence-form phrasing the user would read aloud, rather than the
 * `<start> → <end>` debug form. Drops the "primary/secondary" (or
 * resolved first-name) prefix because the list page already groups
 * rows under their owner.
 *
 *   age 67 + durationFromStart 60mo  → "Starts at age 67 for 5 years"
 *   age 67 + age 72                  → "Starts at age 67 until age 72"
 *   retirementStart + duration 24mo  → "Starts at retirement for 2 years"
 *   year 2034 + lifetime             → "Starts in 2034 until death"
 */
function formatPartTimeSchedule(
  p: IncomeStreamPayload,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  if (!p.start) return 'No schedule set';
  const startPhrase = formatPartTimeStart(p.start);
  if (!p.end) return `Starts at ${startPhrase} (no end set)`;
  if (p.end.kind === 'durationFromStart') {
    const months = p.end.months;
    const duration =
      months % 12 === 0
        ? `${months / 12} year${months / 12 === 1 ? '' : 's'}`
        : `${months} month${months === 1 ? '' : 's'}`;
    return `Starts at ${startPhrase} for ${duration}`;
  }
  return `Starts at ${startPhrase} until ${describeExpenseEnd(p.end, 'yearly', members)}`;
}

function formatPartTimeStart(start: NonNullable<IncomeStreamPayload['start']>): string {
  // describeExpenseStart prefixes "Primary"/"Secondary" which is noisy
  // in a list already grouped by owner; strip it for partTime.
  switch (start.kind) {
    case 'retirementStart':
      return 'retirement';
    case 'age':
      return `age ${formatAgeYearsMonths({ years: start.years, months: start.months })}`;
    case 'year':
      return `${start.year}`;
    default:
      // Future-proofing: any new ScheduleStart kind falls back to the
      // shared describer so we never render undefined.
      return describeExpenseStart(start);
  }
}

/** Annualised income for header totals. Pension annuity → 12 ×
 *  monthly. Part-time → annualAmount. Lump sums + one-offs are
 *  reported as their nominal amount (the header shows "+ $X one-time"
 *  separately rather than amortising it). */
export function annualizeIncome(p: IncomeStreamPayload): number {
  if (p.kind === 'pension') {
    if (p.payoutType === 'annuity') {
      return (p.monthlyBenefit ?? 0) * 12;
    }
    return 0; // lump-sum doesn't annualise
  }
  if (p.kind === 'partTime') {
    return p.annualAmount ?? 0;
  }
  return 0; // oneOff doesn't annualise
}

export function memberDisplayName(
  member: Aggregate<HouseholdMemberPayload> | undefined,
): string {
  if (!member) return '(unknown member)';
  return member.payload.firstName?.trim() || '(unnamed member)';
}
