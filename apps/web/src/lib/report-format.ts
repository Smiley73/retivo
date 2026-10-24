// Pure display formatters for the report page: member names, retirement dates, scenario knobs, the glide summary, the header timestamp and expense labels.

import type {
  Aggregate,
  ExpensePayload,
  GlideAnchor,
  HouseholdMemberPayload,
  ScenarioOverrides,
} from '../db/types';
import { describeGlideAnchor, describeStart } from './schedule-format';
import { hasEffectiveFloor, NEUTRAL_END_PCT } from './expense-glide-format';
import type { AgeYearsMonths } from './format-age';

export const DEFAULT_SS_CLAIM_AGE_YEARS = 67;
export const DEFAULT_RETIREMENT_AGE_YEARS = 65;

/** Renders "Generated June 6, 2026 at 2:34 PM"; `now` is injected so tests can freeze the clock. */
export function buildReportTimestamp(now: Date): string {
  const date = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return `Generated ${date} at ${time}`;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function anchorPhrase(
  anchor: GlideAnchor,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  switch (anchor.kind) {
    case 'retirementStart':
      return 'the start of retirement';
    case 'expenseEnd':
      return 'the expense end';
    case 'age':
      // `describeStart` keeps a member's name intact; lower-casing "Ada age 65" would mangle it.
      return describeStart(anchor, members);
    default: {
      // These do not start with a name, so lower-casing the first character reads correctly mid-sentence.
      const label = describeGlideAnchor(anchor, members);
      return label.charAt(0).toLowerCase() + label.slice(1);
    }
  }
}

/**
 * Plain-English spending-glide summary, e.g. "declines from 100% to 40% between
 * the start of retirement and Ada age 80, then holds at 25% after Ada age 85".
 * It handles rises and ceilings too. Null for no glide, a one-off, or a no-op glide.
 */
export function buildGlideSummary(
  payload: ExpensePayload,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string | null {
  if (payload.frequency === 'oneOff') return null; // one-offs are never glided
  const g = payload.discretionaryGlide;
  if (!g) return null;

  const moves = g.endMultiplierPct !== NEUTRAL_END_PCT;
  const plateau = hasEffectiveFloor(g) ? g.floor : undefined;
  if (!moves && !plateau) return null; // no-op glide

  const endPhrase = anchorPhrase(g.glideEnd, members);
  const rises = g.endMultiplierPct > NEUTRAL_END_PCT;
  const verb = rises ? 'rises' : 'declines';

  let core: string;
  if (moves) {
    const endPct = pct(g.endMultiplierPct);
    // A glide from the start of retirement reads best as a single anchor.
    if (g.glideStart.kind === 'retirementStart') {
      core = `${verb} to ${endPct} by ${endPhrase}`;
    } else {
      const startPhrase = anchorPhrase(g.glideStart, members);
      core = `${verb} from ${pct(NEUTRAL_END_PCT)} to ${endPct} between ${startPhrase} and ${endPhrase}`;
    }
  } else {
    // A flat end with an effective floor holds at 100%, then steps down at the floor anchor.
    core = `holds at 100% until ${endPhrase}`;
  }

  if (plateau) {
    const plateauPhrase = anchorPhrase(plateau.anchor, members);
    return `${core}, then holds at ${pct(plateau.multiplierPct)} after ${plateauPhrase}`;
  }
  return core;
}

/** Resolved override knobs; a field is present only when the scenario chain sets it. */
export interface ReportScenarioKnobs {
  inflationRatePct?: number;
  lifeExpectancyPrimary?: number;
  lifeExpectancySecondary?: number;
  discretionarySpendingBumpPct?: number;
  discretionarySpendingDurationYears?: number | null;
}

export function resolvedKnobs(resolved: ScenarioOverrides): ReportScenarioKnobs {
  const knobs: ReportScenarioKnobs = {};
  if (resolved.inflation !== undefined) {
    knobs.inflationRatePct = resolved.inflation.ratePct;
  }
  if (resolved.lifeExpectancy !== undefined) {
    if (resolved.lifeExpectancy.primary !== undefined) {
      knobs.lifeExpectancyPrimary = resolved.lifeExpectancy.primary;
    }
    if (resolved.lifeExpectancy.secondary !== undefined) {
      knobs.lifeExpectancySecondary = resolved.lifeExpectancy.secondary;
    }
  }
  if (resolved.discretionarySpending !== undefined) {
    knobs.discretionarySpendingBumpPct = resolved.discretionarySpending.bumpPct;
    knobs.discretionarySpendingDurationYears =
      resolved.discretionarySpending.durationYears;
  }
  return knobs;
}

// Not `memberDisplayName`: its fallback differs ('Primary' / 'Secondary' here).
export function memberName(
  member: Aggregate<HouseholdMemberPayload> | undefined,
  fallback: string,
): string {
  const first = member?.payload.firstName?.trim();
  const last = member?.payload.lastName?.trim();
  if (first && first.length > 0) {
    return last && last.length > 0 ? `${first} ${last}` : first;
  }
  return fallback;
}

export function withdrawalStrategyKind(resolved: ScenarioOverrides): string {
  return resolved.withdrawalStrategy?.kind ?? 'taxEfficient';
}

export function retirementAges(resolved: ScenarioOverrides): {
  primary: AgeYearsMonths;
  secondary?: AgeYearsMonths;
} {
  const ra = resolved.retirementAge;
  return {
    primary: ra?.primary
      ? { years: ra.primary.ageYears, months: ra.primary.ageMonths }
      : { years: DEFAULT_RETIREMENT_AGE_YEARS, months: 0 },
    ...(ra?.secondary !== undefined
      ? { secondary: { years: ra.secondary.ageYears, months: ra.secondary.ageMonths } }
      : {}),
  };
}

export function ssClaimAges(
  resolved: ScenarioOverrides,
  hasSecondary: boolean,
): { primary: number; secondary?: number } {
  const ss = resolved.socialSecurity;
  return {
    primary: ss?.primary?.ageYears ?? DEFAULT_SS_CLAIM_AGE_YEARS,
    ...(hasSecondary
      ? { secondary: ss?.secondary?.ageYears ?? DEFAULT_SS_CLAIM_AGE_YEARS }
      : {}),
  };
}

/** Entered amount as a yearly figure in today's dollars; one-offs report their single amount. */
export function annualExpenseAmount(p: ExpensePayload): number {
  switch (p.frequency) {
    case 'weekly':
      return p.amount * 52;
    case 'monthly':
      return p.amount * 12;
    case 'quarterly':
      return p.amount * 4;
    case 'yearly':
    case 'oneOff':
      return p.amount;
  }
}

export function describeGlideAnchorFreeStart(
  p: ExpensePayload,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  switch (p.start.kind) {
    case 'retirementStart':
      return 'Start of retirement';
    case 'age':
    case 'year':
      return describeGlideAnchor(p.start, members);
  }
}

export function describeExpenseEndLabel(
  p: ExpensePayload,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  if (p.frequency === 'oneOff') return '(one-off)';
  if (!p.end) return '(no end set)';
  return describeScheduleEndLabel(p.end, members);
}

function describeScheduleEndLabel(
  end: NonNullable<ExpensePayload['end']>,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  switch (end.kind) {
    case 'age': {
      const who =
        end.memberId === 'secondary'
          ? memberName(members.find((m) => !m.payload.isPrimary), 'secondary')
          : end.memberId === 'primary'
            ? memberName(members.find((m) => m.payload.isPrimary), 'primary')
            : null;
      const agePart = `age ${end.years}${end.months ? ` ${end.months} months` : ''}`;
      return who ? `until ${who} ${agePart}` : `until ${agePart}`;
    }
    case 'year':
      return `until ${end.year}`;
    case 'lifetime':
      return end.whose === 'last' ? 'until last surviving' : 'lifetime';
    case 'endOfRetirementYear': {
      const n = end.offsetYears + 1;
      return n === 1
        ? 'first retirement year'
        : `first ${n} retirement years`;
    }
    case 'durationFromStart': {
      if (end.months % 12 === 0) {
        const years = end.months / 12;
        return `${years} year${years === 1 ? '' : 's'} from start`;
      }
      return `${end.months} months from start`;
    }
  }
}
