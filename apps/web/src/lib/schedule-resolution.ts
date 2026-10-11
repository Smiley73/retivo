/**
 * Shared resolver for `ScheduleStart` / `ScheduleEnd` anchors. Used by
 * both the expense and income projection engines so the start / end
 * vocabulary has one canonical implementation.
 *
 * Pure functions — no React, no I/O. Inputs are the anchor + a context
 * object carrying the calendar year of retirement, optional sub-year
 * month, the two members' birthdates, and (for `lifetime` ends) the
 * scenario's life-expectancy override.
 *
 * Owner-implicit `age` anchors: when `memberId` is absent on a
 * `ScheduleStart.age` / `ScheduleEnd.age`, the resolver reads `ctx.owner`
 * as the implicit member. Callers driving an income stream pass the
 * stream's owner role; callers driving an expense (which always sets
 * `memberId` explicitly) can omit `owner`.
 */
import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type GlideAnchor,
  type HouseholdRole,
  type LifeExpectancyOverride,
  type ScheduleEnd,
  type ScheduleStart,
} from '../db/types';

interface ScheduleResolveMember {
  /** ISO date `YYYY-MM-DD`. */
  birthdate: string;
}

export interface ScheduleResolveContext {
  /** Calendar year retirement begins. For expense, this is the
   *  household-level retirement year. For income, callers pass the
   *  *owner's* retirement year (asymmetric). */
  retirementYear: number;
  /** 0-indexed calendar month (Jan = 0) retirement falls in.
   *  Defaults to 0 (Jan) when callers only know the year. */
  retirementMonth0?: number;
  primary?: ScheduleResolveMember;
  secondary?: ScheduleResolveMember;
  /** Implicit member role for owner-default `age` anchors with no
   *  `memberId` set. Required only when the caller may pass anchors
   *  without `memberId` (i.e. income). */
  owner?: HouseholdRole;
  lifeExpectancy?: LifeExpectancyOverride;
  /** When true, `lifetime` end anchors are treated as effectively
   *  never-ending within the projection window. Off by default. */
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

/** Resolve the calendar (year, month0) where the start anchor fires.
 *  Inclusive: this month is the first active month. */
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

/** Resolve the calendar (year, month0) for the *exclusive* end boundary
 *  (the first month the window is NOT active). */
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
      // Death is modelled as Dec 31 of `deathYear`
      // (`deathYear = birthYear + lifeExpectancyAge`); the member is alive
      // through all of `deathYear`. The exclusive end boundary is therefore
      // Jan 1 of `deathYear + 1`, regardless of birth month — lifetime
      // expenses stay active through December of the death year.
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
      // `whose: 'last'` — the later of the two members' exclusive end
      // boundaries (i.e. the later death year + 1).
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
 * Resolve a discretionary-glide anchor to a calendar (year, month0).
 *
 * Not a call to `resolveStartMonth` — that handles only 3 kinds and has
 * no duration case. The three absolute kinds (`retirementStart` /
 * `year` / `age`) reuse the *exact same arithmetic* as
 * `resolveStartMonth`'s corresponding cases (so an absolute glide
 * anchor lands at the same calendar point for every expense — Decision
 * 20); `durationFromExpenseStart` is the genuinely per-expense kind and
 * mirrors `resolveEndMonth`'s `durationFromStart` case, offset from the
 * caller-supplied expense start month. `expenseEnd` (glide-end only)
 * resolves to the expense's own resolved `end` window via
 * `resolveEndMonth(expenseEnd, …)` — the caller threads the resolved
 * expense `end`; `undefined` (one-off / not supplied) ⇒ `null`.
 *
 * Returns `null` when unresolvable (e.g. an `age` anchor whose member
 * has no birthdate, or an `expenseEnd` whose `end` is absent /
 * unresolvable) — the engine treats that as glide-off for the affected
 * expense.
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
      // Glide-end-only kind: the spending decline ends exactly when the
      // expense's own resolved end window does. `undefined` end (one-off
      // / not threaded by the caller) ⇒ unresolvable ⇒ null (engine
      // fail-safe, glide off for this expense).
      return expenseEnd
        ? resolveEndMonth(expenseEnd, expenseStartMonth, ctx)
        : null;
  }
}

/** Count months in calendar year Y that satisfy the active rule:
 *  startAnniv ≤ end-of-M AND endAnniv > start-of-M. */
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

/** True when either anchor references a member with no resolvable
 *  birthdate (or a `whose` that points at a missing member). Callers
 *  surface broken-anchor expenses to the user rather than silently
 *  zeroing them. */
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
