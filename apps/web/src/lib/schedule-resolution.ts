// Shared resolver for `ScheduleStart` / `ScheduleEnd` anchors, used by the expense and income engines.
// An `age` anchor with no `memberId` reads `ctx.owner` (income passes the stream's owner; expense always sets `memberId`).

import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type GlideAnchor,
  type HouseholdRole,
  type LifeExpectancyOverride,
  type ScheduleEnd,
  type ScheduleStart,
} from '../db/types';

interface ScheduleResolveMember {
  birthdate: string;
}

export interface ScheduleResolveContext {
  /** Household retirement year for expense; the owner's retirement year for income. */
  retirementYear: number;
  /** 0-indexed month (Jan = 0) retirement falls in; defaults to 0. */
  retirementMonth0?: number;
  primary?: ScheduleResolveMember;
  secondary?: ScheduleResolveMember;
  /** Implicit role for `age` anchors with no `memberId`; needed only by income. */
  owner?: HouseholdRole;
  lifeExpectancy?: LifeExpectancyOverride;
  /** Treats `lifetime` end anchors as never ending within the projection window. */
  extendBeyondLifetime?: boolean;
}

const MONTH_FROM_ISO = (iso: string): { year: number; month0: number } => {
  const [y, m] = iso.split('-').map((s) => Number(s));
  return { year: y, month0: m - 1 };
};

export const monthIndex = (year: number, month0: number): number =>
  year * 12 + month0;

const ageMember = (
  memberIdOnAnchor: HouseholdRole | undefined,
  ctx: ScheduleResolveContext,
): ScheduleResolveMember | undefined => {
  const role = memberIdOnAnchor ?? ctx.owner;
  if (!role) return undefined;
  return role === 'primary' ? ctx.primary : ctx.secondary;
};

/** The (year, month0) where the start anchor fires; inclusive, the first active month. */
export function resolveStartMonth(
  start: ScheduleStart,
  ctx: ScheduleResolveContext,
): { year: number; month0: number } | null {
  switch (start.kind) {
    case 'retirementStart':
      return { year: ctx.retirementYear, month0: ctx.retirementMonth0 ?? 0 };
    case 'year':
      return { year: start.year, month0: 0 };
    case 'age': {
      const m = ageMember(start.memberId, ctx);
      if (!m?.birthdate) return null;
      const b = MONTH_FROM_ISO(m.birthdate);
      const totalMonths = start.years * 12 + start.months;
      const idx = monthIndex(b.year, b.month0) + totalMonths;
      return { year: Math.floor(idx / 12), month0: idx % 12 };
    }
  }
}

/** The (year, month0) of the exclusive end boundary, the first month the window is not active. */
export function resolveEndMonth(
  end: ScheduleEnd,
  startMonth: { year: number; month0: number },
  ctx: ScheduleResolveContext,
): { year: number; month0: number } | null {
  switch (end.kind) {
    case 'year':
      return { year: end.year + 1, month0: 0 };
    case 'age': {
      const m = ageMember(end.memberId, ctx);
      if (!m?.birthdate) return null;
      const b = MONTH_FROM_ISO(m.birthdate);
      const totalMonths = end.years * 12 + end.months;
      const idx = monthIndex(b.year, b.month0) + totalMonths;
      return { year: Math.floor(idx / 12), month0: idx % 12 };
    }
    case 'lifetime': {
      if (ctx.extendBeyondLifetime) {
        return { year: 9999, month0: 0 };
      }
      const lifeExpFromOverride = ctx.lifeExpectancy;
      // Death is Dec 31 of `birthYear + age`, so the exclusive end is Jan 1 of the next year whatever the birth month.
      const projectMember = (
        slot: 'primary' | 'secondary',
      ): { year: number; month0: number } | null => {
        const m = slot === 'primary' ? ctx.primary : ctx.secondary;
        if (!m?.birthdate) return null;
        const overrideAge =
          lifeExpFromOverride?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
        const b = MONTH_FROM_ISO(m.birthdate);
        const deathYear = b.year + overrideAge;
        return { year: deathYear + 1, month0: 0 };
      };
      if (end.whose === 'primary') return projectMember('primary');
      if (end.whose === 'secondary') return projectMember('secondary');
      // `whose: 'last'`: the later end boundary.
      const p = projectMember('primary');
      const s = projectMember('secondary');
      if (!p && !s) return null;
      if (!p) return s;
      if (!s) return p;
      return monthIndex(p.year, p.month0) >= monthIndex(s.year, s.month0) ? p : s;
    }
    case 'endOfRetirementYear':
      return { year: ctx.retirementYear + end.offsetYears + 1, month0: 0 };
    case 'durationFromStart': {
      const idx = monthIndex(startMonth.year, startMonth.month0) + end.months;
      return { year: Math.floor(idx / 12), month0: idx % 12 };
    }
  }
}

/**
 * Resolves a glide anchor to (year, month0). The absolute kinds reuse
 * `resolveStartMonth`'s arithmetic, so they land on the same point for every
 * expense; `durationFromExpenseStart` offsets from the caller's expense start;
 * `expenseEnd` resolves to the expense's own `end` window. Null when
 * unresolvable, which the engine treats as glide off for that expense.
 */
export function resolveGlideAnchorMonth(
  anchor: GlideAnchor,
  expenseStartMonth: { year: number; month0: number },
  ctx: ScheduleResolveContext,
  expenseEnd?: ScheduleEnd,
): { year: number; month0: number } | null {
  switch (anchor.kind) {
    case 'retirementStart':
      return { year: ctx.retirementYear, month0: ctx.retirementMonth0 ?? 0 };
    case 'year':
      return { year: anchor.year, month0: 0 };
    case 'age': {
      const m = ageMember(anchor.memberId, ctx);
      if (!m?.birthdate) return null;
      const b = MONTH_FROM_ISO(m.birthdate);
      const totalMonths = anchor.years * 12 + anchor.months;
      const idx = monthIndex(b.year, b.month0) + totalMonths;
      return { year: Math.floor(idx / 12), month0: idx % 12 };
    }
    case 'durationFromExpenseStart': {
      const idx =
        monthIndex(expenseStartMonth.year, expenseStartMonth.month0) +
        anchor.months;
      return { year: Math.floor(idx / 12), month0: idx % 12 };
    }
    case 'expenseEnd':
      // Glide-end only: the glide ends when the expense's own `end` does; an absent `end` (a one-off) is unresolvable.
      return expenseEnd
        ? resolveEndMonth(expenseEnd, expenseStartMonth, ctx)
        : null;
  }
}

/** Months of year `year` inside the active window. */
export function monthsActiveInYear(
  startMonth: { year: number; month0: number },
  endMonthExclusive: { year: number; month0: number },
  year: number,
): number {
  const yearStartIdx = year * 12;
  const yearEndIdx = year * 12 + 12;
  const startIdx = monthIndex(startMonth.year, startMonth.month0);
  const endIdx = monthIndex(endMonthExclusive.year, endMonthExclusive.month0);
  const loIdx = Math.max(startIdx, yearStartIdx);
  const hiIdx = Math.min(endIdx, yearEndIdx);
  return Math.max(0, hiIdx - loIdx);
}

/** True when an anchor references a member with no usable birthdate, so callers can surface the expense instead of zeroing it. */
export function isScheduleAnchorBroken(
  start: ScheduleStart,
  end: ScheduleEnd | undefined,
  ctx: ScheduleResolveContext,
): boolean {
  if (start.kind === 'age') {
    const m = ageMember(start.memberId, ctx);
    if (!m?.birthdate) return true;
  }
  if (end?.kind === 'age') {
    const m = ageMember(end.memberId, ctx);
    if (!m?.birthdate) return true;
  }
  if (end?.kind === 'lifetime') {
    if (end.whose === 'primary' && !ctx.primary?.birthdate) return true;
    if (end.whose === 'secondary' && !ctx.secondary?.birthdate) return true;
    if (end.whose === 'last' && !ctx.primary?.birthdate && !ctx.secondary?.birthdate) return true;
  }
  return false;
}
