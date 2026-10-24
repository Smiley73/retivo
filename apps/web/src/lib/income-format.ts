// Display helpers for IncomeStream rows; React-free so the engine and pages share them.

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

// Sentence-form, owner-implicit start phrase: the surrounding list already groups rows by owner.
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

// Plain-language partTime schedule, e.g. "Starts at age 67 for 5 years" or "Starts in 2034 until death"; drops the owner prefix the list grouping implies.
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
  // `describeExpenseStart` prefixes "Primary"/"Secondary", which is noise in a list grouped by owner.
  switch (start.kind) {
    case 'retirementStart':
      return 'retirement';
    case 'age':
      return `age ${formatAgeYearsMonths({ years: start.years, months: start.months })}`;
    case 'year':
      return `${start.year}`;
    default:
      // A new ScheduleStart kind falls back to the shared describer, so nothing renders undefined.
      return describeExpenseStart(start);
  }
}

/** Annualised income for header totals: annuity 12 × monthly, part-time its annual amount; lump sums and one-offs report nothing here (the header shows them as "+ $X one-time"). */
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
