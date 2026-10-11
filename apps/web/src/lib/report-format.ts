/**
 * Pure display formatters for the CFP Report page, extracted from
 * `report-data.ts` so the aggregator file stays under the shape limit.
 * These are orthogonal to `buildReportData`: each is a
 * stateless string/number formatter (member names, retirement dates,
 * scenario age/strategy knobs, the plain-English discretionary-glide
 * summary, the report header timestamp, and the expense label/amount
 * helpers). `buildReportData` imports them; no logic changed in the move.
 */
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

/** Default Social Security claim age (years) when no scenario override
 *  sets one — mirrors the SS UI / `buildSsContext` fallback. */
export const DEFAULT_SS_CLAIM_AGE_YEARS = 67;
/** Default retirement age (years) used only as an overview fallback when
 *  the scenario sets no `retirementAge` override at all. */
export const DEFAULT_RETIREMENT_AGE_YEARS = 65;

// ---------- Timestamp helper ----------

/**
 * Render the report header timestamp, e.g. "Generated June 6, 2026 at
 * 2:34 PM". The `Date` is injected so tests can freeze the clock; the
 * page passes `new Date()` captured at mount.
 */
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

// ---------- Glide summary ----------

// Floor/ceiling effectiveness is the ONE shared direction-aware predicate
// from `expense-glide-format.ts` so the summary and `isNeutralGlide`
// can never diverge on the ceiling case: a *ceiling* above the glide end
// (rising glide) is effective; a *floor* below it (falling glide) is too.

/** "100%" / "70%" — the curve endpoints read as plain percentages. */
function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/** Glide anchor as a mid-sentence phrase ("the start of retirement",
 *  "Ada age 65", "the expense end", "3 years after it begins"). Reuses
 *  the shared label helpers; only the kinds whose label is safe to
 *  lower-case mid-sentence are lower-cased. */
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
      // `describeGlideAnchor` returns "Ada age 65" (member first name) or
      // "age 65" (no memberId). Lower-casing the first char would mangle a
      // proper name ("ada age 65"), so build the age phrase directly via
      // the shared describer without any case mangling.
      return describeStart(anchor, members);
    default: {
      // year / durationFromExpenseStart don't start with a name, so the
      // first-character lower-case reads correctly mid-sentence.
      const label = describeGlideAnchor(anchor, members);
      return label.charAt(0).toLowerCase() + label.slice(1);
    }
  }
}

/**
 * Build the plain-English spending-glide summary for an expense, or
 * `null` when the expense has no meaningful glide to describe.
 * The glide is classification-agnostic (essentials too) and
 * direction-aware: it can describe a rise as well as a fall. `null`
 * cases: no `discretionaryGlide`, a one-off (never glided), or a no-op
 * glide (`endMultiplierPct === 100` and no effective floor/ceiling).
 *
 * Shapes produced (examples):
 *  - decline only:          "declines to 70% by the expense end"
 *  - decline + floor:       "declines from 100% to 40% between the start
 *                            of retirement and Ada age 80, then holds at
 *                            25% after Ada age 85"
 *  - increase only:         "rises to 150% by the expense end"
 *  - increase + ceiling:    "rises from 100% to 150% between the start of
 *                            retirement and Ada age 80, then holds at
 *                            180% after Ada age 85"
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
    // When the glide simply runs from the start of retirement the
    // single-anchor read is clearest ("declines to 70% by lifetime
    // end"); otherwise spell out the from/to window with both anchors.
    if (g.glideStart.kind === 'retirementStart') {
      core = `${verb} to ${endPct} by ${endPhrase}`;
    } else {
      const startPhrase = anchorPhrase(g.glideStart, members);
      core = `${verb} from ${pct(NEUTRAL_END_PCT)} to ${endPct} between ${startPhrase} and ${endPhrase}`;
    }
  } else {
    // Flat end (100%) but an effective floor — the curve holds at 100%
    // then steps down at the floor anchor (a ceiling can't be effective
    // at a flat end, so this branch is always a floor step-down).
    core = `holds at 100% until ${endPhrase}`;
  }

  if (plateau) {
    const plateauPhrase = anchorPhrase(plateau.anchor, members);
    return `${core}, then holds at ${pct(plateau.multiplierPct)} after ${plateauPhrase}`;
  }
  return core;
}

// ---------- Scenario override summaries ----------

/** Resolved override "knobs" surfaced per scenario. A field is present
 *  only when the scenario chain actually sets it (an unset knob is
 *  `undefined` ⇒ the page renders no row for it). */
export interface ReportScenarioKnobs {
  inflationRatePct?: number;
  lifeExpectancyPrimary?: number;
  lifeExpectancySecondary?: number;
  discretionarySpendingBumpPct?: number;
  /** `null` ⇒ whole retirement; a positive integer ⇒ first N years. */
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

// ---------- Resolution helpers ----------

// Local fallback helper; uses role strings ('Primary' / 'Secondary') as defaults
// which differ from memberDisplayName's fallback — that's why we don't reuse it.
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

// ---------- Expense label/amount helpers (local to the report) ----------

/** Normalise an expense's entered amount to a yearly figure (today's
 *  dollars). One-offs report their nominal single amount. */
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

/** Start label for an expense, reusing the shared schedule describer via
 *  the glide-anchor-compatible kinds. Falls back through the shared
 *  helpers so wording matches the rest of the app. */
export function describeGlideAnchorFreeStart(
  p: ExpensePayload,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): string {
  // `start` is a ScheduleStart (subset of GlideAnchor's shared kinds) —
  // reuse the shared describer for consistent wording.
  switch (p.start.kind) {
    case 'retirementStart':
      return 'Start of retirement';
    case 'age':
    case 'year':
      return describeGlideAnchor(p.start, members);
  }
}

/** End label for an expense — "(one-off)" for single events, else the
 *  shared end describer. */
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
