/**
 * Resolve a working-years Roth-conversion entry's calendar-year window to the
 * INCLUSIVE `[startYear, endYear]` pair, the same way the deterministic
 * pre-pass (`roth-conversion-projection.ts`) collapses each entry's anchors.
 *
 * The entry's `start` / `end` are the `age` / `year` subset of
 * `ScheduleStart` / `ScheduleEnd`, so we reuse `resolveStartMonth` /
 * `resolveEndMonth` (the one canonical anchor math) rather than re-deriving
 * the age/year arithmetic. A `year` END anchor maps to Jan 1 of Y+1 (the
 * exclusive month boundary), so the inclusive end year is `endMonth.year - 1`.
 *
 * UI-only: the summary card uses the window to find the peak single-year tax
 * burden, and the editor uses it to flag a backwards (start-after-end) window.
 * Neither needs the engine's working-years / RMD / no-past bounds — those gate
 * what the projection actually converts, not what the user typed.
 *
 * Returns `null` when an `age` anchor can't resolve (missing birthdate) so the
 * caller can fall back gracefully instead of crashing.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  MagiCapWindow,
  ScheduleEnd,
  ScheduleStart,
} from '../db/types';
import {
  resolveStartMonth,
  resolveEndMonth,
  type ScheduleResolveContext,
} from './schedule-resolution';

export interface RothConversionWindowEntry {
  readonly start: Extract<MagiCapWindow['start'], { kind: 'age' | 'year' }>;
  readonly end: Extract<MagiCapWindow['end'], { kind: 'age' | 'year' }>;
}

/** Build the anchor-resolve context from the household members. Only the two
 *  members' birthdates matter for `age` anchors; the `year` anchors ignore the
 *  context entirely. `retirementYear` is unused by the `age` / `year` kinds but
 *  is required by the shared context type — pin it to 0. */
export function buildRothConversionResolveCtx(
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

/** Resolve a conversion entry to its inclusive `[startYear, endYear]`. Returns
 *  `null` when either anchor can't resolve (e.g. an `age` anchor whose member
 *  has no birthdate). */
export function resolveConversionYears(
  entry: RothConversionWindowEntry,
  ctx: ScheduleResolveContext,
): { startYear: number; endYear: number } | null {
  const startMonth = resolveStartMonth(entry.start as ScheduleStart, ctx);
  if (!startMonth) return null;
  const endMonth = resolveEndMonth(entry.end as ScheduleEnd, startMonth, ctx);
  if (!endMonth) return null;
  // `endMonth.year` is the EXCLUSIVE boundary (Jan 1 of the year after the last
  // active year), so the inclusive end year is one less.
  return { startYear: startMonth.year, endYear: endMonth.year - 1 };
}
