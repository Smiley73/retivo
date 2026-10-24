// Slider bounds for the schedule-anchor age/year pickers, pure given `now`; neither bound clamps past the value being edited.
// Age runs from the current age to `MAX_AGE`; year from now to the year the youngest member reaches `MAX_AGE`.

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

/**
 * Age-slider `{ min, max }`. `maxAgeCap` lowers the ceiling from `MAX_AGE` (the
 * Roth-conversion editor caps at the owner's last working age) and `minAgeFloor`
 * raises the floor above the current age (the QCD editor floors at 70½); a
 * non-finite value is ignored.
 */
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

function currentYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

function maxAnchorYear(members: Members, now: Date = new Date()): number {
  const birthYears = (members ?? [])
    .map((m) => birthYearMonthDay(m.payload.birthdate)?.year)
    .filter((y): y is number => typeof y === 'number');
  // No birthdates: assume a 65-year-old so the range is sane.
  const youngestBirthYear = birthYears.length
    ? Math.max(...birthYears)
    : currentYear(now) - 65;
  return youngestBirthYear + MAX_AGE;
}

/** Year-slider `{ min, max }`; `maxYearCap` and `minYearFloor` bound it like the age caps, and a non-finite value is ignored. */
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
