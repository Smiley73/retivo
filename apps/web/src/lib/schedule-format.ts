/**
 * Display helpers for `ScheduleStart` / `ScheduleEnd` anchors. Pure
 * functions — no React, no DOM. Used by the expense list, income
 * schedule formatter, scenario-overrides UI, and any future feature
 * that needs to render a schedule anchor as user-facing copy.
 *
 * Naming: prefer the household member's `firstName` for any human-
 * readable copy. Fall back to capitalised `Primary` / `Secondary` (or
 * lowercase variants in mid-sentence positions) only when the members
 * list is unavailable or the matching member has no first name set.
 * See AGENTS.md → "UI coding standards" for the rule.
 */
import type {
  Aggregate,
  GlideAnchor,
  HouseholdMemberPayload,
  HouseholdRole,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import { formatAgeYearsMonths } from './format-age';

/**
 * Resolve a `HouseholdRole` reference to a display label, preferring the
 * household member's `firstName`. If `members` is omitted, or the
 * matching member has no first name set, returns `fallback` so the
 * caller can supply the right casing for its sentence position
 * (`'Primary'` for sentence-start, `'primary'` for mid-sentence).
 */
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

/** Render a `ScheduleStart` as a sentence-start phrase
 *  ("Start of retirement", "Christopher age 65", "Year 2034",
 *  "age 65" when memberId is absent). */
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
      // memberId absent → owner-implicit usage (income). Render the
      // age without a member prefix; the caller (e.g. owner-grouped
      // income list) supplies its own owner context.
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

/** Render a `ScheduleEnd` as a mid-sentence phrase ("until death of
 *  Christopher", "primary age 70", "year 2034"). `undefined` →
 *  `(no end set)`. */
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
      // Storage `offsetYears` is 0-indexed (0 = first year only); the
      // human reading is `offsetYears + 1` retirement years covered.
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

/** Render a `GlideAnchor` as a sentence-start summary phrase for the
 *  anchor-card collapsed view ("Start of retirement", "Christopher age
 *  65", "Year 2034", "3 years after it begins", "When this expense
 *  ends"). The shared `retirementStart` / `age` / `year` kinds reuse
 *  `describeStart` (the glide `age` is years-only, so months render as
 *  0); the two glide-only kinds are formatted here. */
export function describeGlideAnchor(
  anchor: GlideAnchor,
  members?: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  switch (anchor.kind) {
    case 'retirementStart':
    case 'age':
    case 'year':
      // Structural subset of `ScheduleStart` — same display vocabulary.
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
