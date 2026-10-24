// Display helpers for `ScheduleStart` / `ScheduleEnd` anchors. Copy prefers the member's `firstName`, falling back to
// `Primary` / `Secondary` (see AGENTS.md "UI coding standards").

import type {
  Aggregate,
  GlideAnchor,
  HouseholdMemberPayload,
  HouseholdRole,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import { formatAgeYearsMonths } from './format-age';

function resolveMemberLabel(
  role: HouseholdRole,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>> | undefined,
  fallback: string,
): string {
  if (!members) return fallback;
  const wantPrimary = role === 'primary';
  const m = members.find((x) => x.payload.isPrimary === wantPrimary);
  const first = m?.payload.firstName?.trim();
  return first || fallback;
}

export function describeStart(
  start: ScheduleStart,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  ownerFallback: 'capitalised' | 'lowercase' = 'capitalised',
): string {
  switch (start.kind) {
    case 'retirementStart':
      return 'Start of retirement';
    case 'age': {
      const agePhrase = `age ${formatAgeYearsMonths({ years: start.years, months: start.months })}`;
      // No `memberId` means owner-implicit (income): the caller's owner-grouped list supplies the owner.
      if (!start.memberId) return agePhrase;
      const fallback =
        ownerFallback === 'capitalised'
          ? start.memberId === 'primary'
            ? 'Primary'
            : 'Secondary'
          : start.memberId === 'primary'
            ? 'primary'
            : 'secondary';
      const who = resolveMemberLabel(start.memberId, members, fallback);
      return `${who} ${agePhrase}`;
    }
    case 'year':
      return `Year ${start.year}`;
  }
}

export function describeEnd(
  end: ScheduleEnd | undefined,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  if (!end) return '(no end set)';
  switch (end.kind) {
    case 'age': {
      const agePhrase = `age ${formatAgeYearsMonths({ years: end.years, months: end.months })}`;
      if (!end.memberId) return agePhrase;
      const who = resolveMemberLabel(
        end.memberId,
        members,
        end.memberId === 'primary' ? 'primary' : 'secondary',
      );
      return `${who} ${agePhrase}`;
    }
    case 'year':
      return `year ${end.year}`;
    case 'lifetime': {
      const whose =
        end.whose === 'last'
          ? 'last surviving'
          : resolveMemberLabel(
              end.whose,
              members,
              end.whose === 'primary' ? 'primary' : 'secondary',
            );
      return `until death of ${whose}`;
    }
    case 'endOfRetirementYear': {
      // `offsetYears` is 0-indexed, so the reading is `offsetYears + 1` retirement years.
      const n = end.offsetYears + 1;
      return n === 1
        ? 'for the first retirement year'
        : `for the first ${n} retirement years`;
    }
    case 'durationFromStart': {
      if (end.months % 12 === 0)
        return `${end.months / 12} year${end.months / 12 === 1 ? '' : 's'} from start`;
      return `${end.months} month${end.months === 1 ? '' : 's'} from start`;
    }
  }
}

/** Sentence-start summary for the anchor card ("3 years after it begins", "When this expense ends"); the shared kinds reuse `describeStart`. */
export function describeGlideAnchor(
  anchor: GlideAnchor,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  switch (anchor.kind) {
    case 'retirementStart':
    case 'age':
    case 'year':
      return describeStart(anchor, members);
    case 'durationFromExpenseStart': {
      const years = Math.floor(anchor.months / 12);
      const months = anchor.months % 12;
      const parts: string[] = [];
      if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
      if (months) parts.push(`${months} month${months === 1 ? '' : 's'}`);
      if (parts.length === 0) parts.push('0 months');
      return `${parts.join(' ')} after it begins`;
    }
    case 'expenseEnd':
      return 'When this expense ends';
  }
}
