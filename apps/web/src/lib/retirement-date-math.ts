// Retirement-age date arithmetic: the calendar date a person reaches an age, in UTC string math so a local timezone cannot shift birthdays.

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
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `birthdate + ageYears + ageMonths`; the day is clamped to the month's length ("Feb 31" becomes Feb 28/29). */
export function retirementDate(birthdate: string, age: YearsMonths): string {
  const { year, month, day } = parseYmd(birthdate);
  const totalMonths = (month - 1) + age.ageMonths;
  const yearAdj = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  const newYear = year + age.ageYears + yearAdj;
  const clampedDay = Math.min(day, daysInMonth(newYear, newMonth));
  return toIso({ year: newYear, month: newMonth, day: clampedDay });
}

/** Age (years and whole months) on `targetDate`; a target before the birthdate clamps to 0y 0m. */
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

/** True iff the two members would retire on different calendar dates. */
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

/**
 * Per-member retirement dates, honoring `sameDateAnchor`. Stored ages are floored
 * to years and months, so recomputing the non-anchor from the anchor's date lands
 * on the non-anchor's own birthday-of-month, up to ~30 days off. The non-anchor
 * therefore takes the anchor's date directly, and consumers must use this helper
 * rather than `retirementDate` for both sides. A member with no age or an
 * unparseable birthdate gets `null`.
 */
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

  // Snap to the anchor's date; see `resolveMemberRetirementDates`.
  if (retirementAge.sameDateAnchor === 'primary' && primaryDate) {
    secondaryDate = primaryDate;
  } else if (retirementAge.sameDateAnchor === 'secondary' && secondaryDate) {
    primaryDate = secondaryDate;
  }

  if (primary) out.set(primary.id, primaryDate);
  if (secondary) out.set(secondary.id, secondaryDate);
  return out;
}
