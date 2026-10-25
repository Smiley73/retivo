/**
 * Resolves a QCD entry's age/year window to an inclusive `[startYear, endYear]` for the editor's
 * window checks; UI-only, so no 70½ clamp. `null` when an age anchor can't resolve.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  QcdEntry,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

export type QcdWindowEntry = Pick<QcdEntry, 'start' | 'end'>;

/** Anchor-resolve context from the household members; `retirementYear` is unused by age/year anchors but required by the type. */
export function buildQcdResolveCtx(
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ScheduleResolveContext {
  const primary = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  return {
    retirementYear: 0,
    primary: primary?.payload.birthdate
      ? { birthdate: primary.payload.birthdate }
      : undefined,
    secondary: secondary?.payload.birthdate
      ? { birthdate: secondary.payload.birthdate }
      : undefined,
  };
}

/** Inclusive `[startYear, endYear]`, or `null` when either anchor can't resolve. */
export function resolveQcdYears(
  entry: QcdWindowEntry,
  ctx: ScheduleResolveContext,
): { startYear: number; endYear: number } | null {
  const startMonth = resolveStartMonth(entry.start as ScheduleStart, ctx);
  if (!startMonth) return null;
  const endMonth = resolveEndMonth(entry.end as ScheduleEnd, startMonth, ctx);
  if (!endMonth) return null;
  // `endMonth.year` is the exclusive boundary (Jan 1 after the last active year).
  return { startYear: startMonth.year, endYear: endMonth.year - 1 };
}
