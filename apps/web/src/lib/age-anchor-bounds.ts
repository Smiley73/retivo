/**
 * Slider bounds for the schedule-anchor age/year pickers (expense
 * Start/End, the discretionary-glide anchors, and the income schedule
 * pickers). Pure given `now`, so callers can inject a fixed clock in
 * tests.
 *
 * - **Age** runs from the member's current age (you can't anchor an
 *   expense in the past) up to the app-wide `MAX_AGE` ceiling. The floor
 *   never rises above the value being edited, so an existing expense
 *   already anchored below the member's current age still shows its real
 *   value instead of being silently clamped forward.
 * - **Year** runs from the current calendar year to the year the
 *   YOUNGEST household member reaches `MAX_AGE` — the household's full
 *   planning horizon (the last member to reach the ceiling), with the
 *   same never-clamp-an-existing-value floor/ceiling guard.
 */
import { MAX_AGE } from '../db/types';
import type {
  Aggregate,
  HouseholdMemberPayload,
  HouseholdRole,
} from '../db/types';

type Members = ReadonlyArray<Aggregate<HouseholdMemberPayload>> | undefined;

function memberByRole(
  role: HouseholdRole | undefined,
  members: Members,
): Aggregate<HouseholdMemberPayload> | undefined {
  const wantPrimary = role !== 'secondary';
  return members?.find((m) => m.payload.isPrimary === wantPrimary);
}

function birthYearMonthDay(
  birthdate: string | undefined,
): { year: number; month0: number; day: number } | null {
  const bd = birthdate?.trim();
  if (!bd) return null;
  const d = new Date(bd);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

/** Whole-years current age of the member in `role`, or `undefined` when
 *  no usable birthdate is on file. */
export function currentAgeOfRole(
  role: HouseholdRole | undefined,
  members: Members,
  now: Date = new Date(),
): number | undefined {
  const b = birthYearMonthDay(memberByRole(role, members)?.payload.birthdate);
  if (!b) return undefined;
  let age = now.getUTCFullYear() - b.year;
  const monthDiff = now.getUTCMonth() - b.month0;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < b.day)) age -= 1;
  return Math.max(0, age);
}

/** Age-slider `{ min, max }` for the member in `role`, editing `value`.
 *
 *  `maxAgeCap` (optional) lowers the ceiling from the app-wide `MAX_AGE` to a
 *  caller-supplied age (e.g. the Roth-conversion editor caps the age slider at
 *  the owner's last working age). The never-clamp-an-existing-value guard still
 *  wins: the effective max is `Math.max(cap, value)`, so an already-stored
 *  anchor above the cap keeps displaying its real value. Omitted ⇒ `MAX_AGE`,
 *  so every existing caller is unaffected. A non-finite cap is ignored.
 *
 *  `minAgeFloor` (optional) RAISES the floor above the member's current age to a
 *  caller-supplied age (e.g. the QCD editor floors the age slider at the giver's
 *  70½ first-eligible age, so a pre-70½ window can't be selected). The
 *  never-clamp-an-existing-value guard still wins: the effective min is
 *  `Math.min(Math.max(current, floor), value)`, so an already-stored anchor
 *  below the floor keeps displaying its real value. Omitted ⇒ the current age,
 *  so every existing caller is unaffected. A non-finite floor is ignored. */
export function ageSliderBounds(
  value: number,
  role: HouseholdRole | undefined,
  members: Members,
  now: Date = new Date(),
  maxAgeCap?: number,
  minAgeFloor?: number,
): { min: number; max: number } {
  const current = currentAgeOfRole(role, members, now) ?? 0;
  const ceiling = Number.isFinite(maxAgeCap) ? (maxAgeCap as number) : MAX_AGE;
  const floored = Number.isFinite(minAgeFloor)
    ? Math.max(current, minAgeFloor as number)
    : current;
  return { min: Math.min(floored, value), max: Math.max(ceiling, value) };
}

/** The current calendar year. */
function currentYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

/** The calendar year the youngest household member reaches `MAX_AGE` —
 *  i.e. the furthest-out year the household is still being planned for. */
function maxAnchorYear(members: Members, now: Date = new Date()): number {
  const birthYears = (members ?? [])
    .map((m) => birthYearMonthDay(m.payload.birthdate)?.year)
    .filter((y): y is number => typeof y === 'number');
  // No birthdates on file ⇒ assume a ~65-year-old so the range is sane.
  const youngestBirthYear = birthYears.length
    ? Math.max(...birthYears)
    : currentYear(now) - 65;
  return youngestBirthYear + MAX_AGE;
}

/** Year-slider `{ min, max }` for the household, editing `value`.
 *
 *  `maxYearCap` (optional) lowers the ceiling from the household planning
 *  horizon to a caller-supplied calendar year (e.g. the Roth-conversion editor
 *  caps the year slider at the owner's last convertible working year). The
 *  never-clamp-an-existing-value guard still wins: the effective max is
 *  `Math.max(cap, value)`, so an already-stored anchor beyond the cap keeps
 *  displaying its real value. Omitted ⇒ the full planning horizon, so every
 *  existing caller is unaffected. A non-finite cap is ignored.
 *
 *  `minYearFloor` (optional) RAISES the floor above the current calendar year to
 *  a caller-supplied year (e.g. the QCD editor floors the year slider at the
 *  giver's 70½ first-eligible year, so a pre-70½ window can't be selected). The
 *  never-clamp-an-existing-value guard still wins: the effective min is
 *  `Math.min(Math.max(currentYear, floor), value)`, so an already-stored anchor
 *  before the floor keeps displaying its real value. Omitted ⇒ the current year,
 *  so every existing caller is unaffected. A non-finite floor is ignored. */
export function yearSliderBounds(
  value: number,
  members: Members,
  now: Date = new Date(),
  maxYearCap?: number,
  minYearFloor?: number,
): { min: number; max: number } {
  const ceiling = Number.isFinite(maxYearCap)
    ? (maxYearCap as number)
    : maxAnchorYear(members, now);
  const floored = Number.isFinite(minYearFloor)
    ? Math.max(currentYear(now), minYearFloor as number)
    : currentYear(now);
  return {
    min: Math.min(floored, value),
    max: Math.max(ceiling, value),
  };
}
