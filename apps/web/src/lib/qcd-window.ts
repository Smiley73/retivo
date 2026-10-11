/**
 * Resolve a QCD entry's calendar-year window to the INCLUSIVE
 * `[startYear, endYear]` pair, for the editor's backwards-window + same-account
 * overlap validations.
 *
 * A QCD entry's `start` / `end` are the same `age` / `year` anchor subset as a
 * working-years Roth conversion (structurally identical `MagiCapWindow` slice),
 * so this delegates to the same canonical schedule-resolution math
 * (`resolveStartMonth` / `resolveEndMonth`) used by `roth-conversion-window.ts`.
 * A distinct module name keeps the QCD feature's call sites self-documenting.
 *
 * QCD age anchors are intrinsically the GIVER's (their 70½): the editor
 * normalizes each `age` anchor's `memberId` to the giver's role before display,
 * so resolving against the household's primary/secondary birthdates reads the
 * giver's birthdate. The engine clamps `start` up to the 70½ floor, but this
 * UI-only resolver mirrors what the user typed (no 70½ / RMD clamping) — the
 * validations gate the raw window the user is configuring.
 *
 * A `year` END anchor is INCLUSIVE of its calendar year: `resolveEndMonth`
 * maps it to Jan 1 of Y+1 (the exclusive month boundary), so the inclusive end
 * year is `endMonth.year - 1`. `start == end` is a valid single-year window.
 *
 * Returns `null` when an `age` anchor can't resolve (missing birthdate) so the
 * caller can skip the row instead of crashing.
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

/** Build the anchor-resolve context from the household members. Only the two
 *  members' birthdates matter for `age` anchors (a QCD age anchor carries the
 *  giver's role as `memberId`, so the right birthdate is selected); the `year`
 *  anchors ignore the context entirely. `retirementYear` is unused by the
 *  `age` / `year` kinds but is required by the shared context type — pin it to 0. */
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

/** Resolve a QCD entry to its inclusive `[startYear, endYear]`. Returns `null`
 *  when either anchor can't resolve (e.g. an `age` anchor whose giver has no
 *  birthdate). */
export function resolveQcdYears(
  entry: QcdWindowEntry,
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
