/**
 * Retirement-age date arithmetic for the same-date scenario mode.
 *
 * Given a birthdate (`YYYY-MM-DD`) and an age in years + months, returns
 * the calendar date the person hits that age. Inverse helper computes
 * one member's age at another member's retirement date.
 *
 * Uses pure UTC date math — no `Date` parsing of strings via the local
 * timezone (which would shift birthdays around midnight). All inputs
 * and outputs are calendar-date strings; nothing here is time-of-day
 * sensitive.
 */

export interface YearsMonths {
  ageYears: number;
  ageMonths: number;
}

interface YMD {
  year: number;
  month: number; // 1–12
  day: number;
}

function parseYmd(iso: string): YMD {
  const [y, m, d] = iso.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`Invalid birthdate: ${iso}`);
  }
  return { year: y, month: m, day: d };
}

function toIso({ year, month, day }: YMD): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function daysInMonth(year: number, month: number): number {
  // month 1–12; new Date(year, month, 0) returns last day of `month` because
  // day=0 rolls back into prior month; works in UTC by reading getUTCDate
  // after constructing in UTC.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Returns the calendar date `birthdate + ageYears years + ageMonths
 * months`. Day-of-month is preserved (clamped to the month's length so
 * "Feb 31" -> "Feb 28/29").
 */
export function retirementDate(birthdate: string, age: YearsMonths): string {
  const { year, month, day } = parseYmd(birthdate);
  const totalMonths = (month - 1) + age.ageMonths;
  const yearAdj = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  const newYear = year + age.ageYears + yearAdj;
  const clampedDay = Math.min(day, daysInMonth(newYear, newMonth));
  return toIso({ year: newYear, month: newMonth, day: clampedDay });
}

/**
 * Returns the age (years + whole months, floored) on `targetDate` for
 * someone born on `birthdate`. Negative inputs (target earlier than
 * birthdate) clamp to 0y 0m — the caller decides how to surface that.
 */
export function ageOnDate(birthdate: string, targetDate: string): YearsMonths {
  const b = parseYmd(birthdate);
  const t = parseYmd(targetDate);

  let years = t.year - b.year;
  let months = t.month - b.month;
  let dayDelta = t.day - b.day;

  if (dayDelta < 0) {
    months -= 1;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years < 0 || (years === 0 && months < 0)) {
    return { ageYears: 0, ageMonths: 0 };
  }
  return { ageYears: years, ageMonths: months };
}

/**
 * True iff the two members would retire on different calendar dates
 * given each member's birthdate + age. Used for the "different dates
 * not yet supported" warning on the retirement-age modal.
 */
export function retirementDatesDiffer(
  primaryBirthdate: string,
  primaryAge: YearsMonths,
  secondaryBirthdate: string,
  secondaryAge: YearsMonths,
): boolean {
  return (
    retirementDate(primaryBirthdate, primaryAge) !==
    retirementDate(secondaryBirthdate, secondaryAge)
  );
}

/**
 * Per-member retirement dates for a household, honoring `sameDateAnchor`.
 *
 * Stored ages are floored to whole years + whole months. The day-of-month
 * gap between two birthdates can't be encoded in that representation, so
 * recomputing the non-anchor's age from the anchor's retirement date and
 * feeding it back through `birthdate + age` lands on the non-anchor's
 * birthday-of-month — NOT the anchor's. Without the snap below, two
 * members configured to "retire on the same day" can drift up to ~30 days
 * apart in display + downstream calculations.
 *
 * Rule (same-date precision): consumers
 * that materialise dates MUST go through this helper, never directly
 * through `retirementDate(member.birthdate, member.age)` for both sides.
 *
 * Returns `null` for a member when their age is missing or birthdate is
 * unparseable. Members beyond primary/secondary always return `null`.
 */
export interface MemberForRetirement {
  id: string;
  isPrimary: boolean;
  birthdate: string;
}

export interface RetirementAgeResolved {
  primary?: YearsMonths;
  secondary?: YearsMonths;
  sameDateAnchor?: 'primary' | 'secondary';
}

export function resolveMemberRetirementDates(
  retirementAge: RetirementAgeResolved | undefined,
  members: ReadonlyArray<MemberForRetirement>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const m of members) out.set(m.id, null);
  if (!retirementAge) return out;

  const primary = members.find((m) => m.isPrimary) ?? null;
  const secondary = members.find((m) => !m.isPrimary) ?? null;

  const dateFor = (
    member: MemberForRetirement | null,
    age: YearsMonths | undefined,
  ): string | null => {
    if (!member || !age) return null;
    try {
      return retirementDate(member.birthdate, age);
    } catch {
      return null;
    }
  };

  let primaryDate = dateFor(primary, retirementAge.primary);
  let secondaryDate = dateFor(secondary, retirementAge.secondary);

  // The snap. See the doc block above.
  if (retirementAge.sameDateAnchor === 'primary' && primaryDate) {
    secondaryDate = primaryDate;
  } else if (retirementAge.sameDateAnchor === 'secondary' && secondaryDate) {
    primaryDate = secondaryDate;
  }

  if (primary) out.set(primary.id, primaryDate);
  if (secondary) out.set(secondary.id, secondaryDate);
  return out;
}
