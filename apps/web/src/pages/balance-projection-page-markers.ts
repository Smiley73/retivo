/** Retirement and life-expectancy marker builders: pure transformers over ISO date strings. */
import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type Aggregate,
  type HouseholdMemberPayload,
  type LifeExpectancyOverride,
} from '../db/types';
import { isValidRmdIsoDate } from '../db/rmd-fact-validation';
import { lifeMarkerColors } from '../lib/tokens';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { RetirementMarker } from '../components/ProjectionChart';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function retirementDateToMarker(isoDate: string): {
  fractionalYear: number;
  shortDate: string;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const monthIndex = month - 1;
  const dim = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const m = (monthIndex + (day - 1) / dim) / 12;
  return {
    fractionalYear: year + m,
    shortDate: `${SHORT_MONTHS[monthIndex]} ${year}`,
  };
}

export function buildRetirementMarkers(
  primaryRetirementIso: string | null,
): RetirementMarker[] {
  if (!primaryRetirementIso) return [];
  const marker = retirementDateToMarker(primaryRetirementIso);
  if (!marker) return [];
  return [
    {
      fractionalYear: marker.fractionalYear,
      label: `Retires ${marker.shortDate}`,
    },
  ];
}

export function primaryRetirementBoundary(
  primaryRetirementIso: string | null,
): { fractionalYear: number; retirementYear: number } | null {
  if (!primaryRetirementIso) return null;
  const marker = retirementDateToMarker(primaryRetirementIso);
  if (!marker) return null;
  return {
    fractionalYear: marker.fractionalYear,
    retirementYear: Math.floor(marker.fractionalYear),
  };
}

// Projected death year (birthYear + ageYears); death is Dec 31, so only the birth year matters. Returns null for an invalid birthdate.
// Deliberately as loose as the engine's projectedDeathFractionalYear, which sets the horizon: a stricter check would drop the death marker of a member with an impossible day (1990-02-31) who still drives the horizon.
// resolveLastSurvivor handles the disagreement on its own side.
function deathFractionalYearFromBirth(
  birthIso: string,
  ageYears: number,
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthIso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return year + ageYears;
}

// Member payloads come from envelope-only-validated imports, so firstName can be absent despite the type; a bare .trim() threw out of the whole page.
function safeFirstName(member: Aggregate<HouseholdMemberPayload>): string {
  const raw = member.payload.firstName;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Death markers for the retirement charts; fractionalYear is the integer death year and each chart maps it to its own terminal-data x-convention (yearly: deathYear, monthly: deathYear + 11/12, balance chart: deathYear + 1). */
export function buildExpenseDeathMarkers(
  primaryMember: Aggregate<HouseholdMemberPayload> | null,
  secondaryMember: Aggregate<HouseholdMemberPayload> | null,
  override: LifeExpectancyOverride | undefined,
  theme: 'light' | 'dark',
): CashflowChartMarker[] {
  const markerColors = lifeMarkerColors(theme);
  const out: CashflowChartMarker[] = [];
  const tryAdd = (
    member: Aggregate<HouseholdMemberPayload> | null,
    slot: 'primary' | 'secondary',
  ): void => {
    if (!member?.payload.birthdate) return;
    const age = override?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
    const deathYear = deathFractionalYearFromBirth(member.payload.birthdate, age);
    if (deathYear === null) return;
    const fallback = slot === 'primary' ? 'Primary' : 'Secondary';
    const firstName = safeFirstName(member) || fallback;
    out.push({
      fractionalYear: deathYear,
      label: `${firstName} life expectancy ${age}`,
      color: markerColors[slot],
      kind: 'death',
    });
  };
  tryAdd(primaryMember, 'primary');
  tryAdd(secondaryMember, 'secondary');
  return out;
}

/** firstName credits the added years (members reaching the horizon at the same age are named together); null when nobody can be named with confidence. */
export interface LastSurvivor {
  readonly firstName: string | null;
  readonly birthYear: number;
}

/**
* The member projected to die last, whose life the market-stress longevity case lengthens; distinct from the age-105 cap anchor, which is the youngest by birth year.
* Refuses the whole question unless every member's birthdate is strictly valid: the cap anchor, the death markers and the engine's computeHorizonYear use stricter and looser tests,
* so with an imported 1990-02-31 member the row could print a different member's age. Printing no age beats a wrong one.
*/
export function resolveLastSurvivor(
  primaryMember: Aggregate<HouseholdMemberPayload> | null,
  secondaryMember: Aggregate<HouseholdMemberPayload> | null,
  override: LifeExpectancyOverride | undefined,
): LastSurvivor | null {
  if (primaryMember === null) return null;
  const present: { member: Aggregate<HouseholdMemberPayload>; slot: 'primary' | 'secondary' }[] =
    [{ member: primaryMember, slot: 'primary' }];
  if (secondaryMember !== null) {
    present.push({ member: secondaryMember, slot: 'secondary' });
  }
  const candidates: { deathYear: number; birthYear: number; firstName: string }[] = [];
  for (const { member, slot } of present) {
    if (!isValidRmdIsoDate(member.payload.birthdate)) return null;
    const age = override?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
    // lifeExpectancy has no runtime shape check, so an imported scenario can hold a string or NaN: decline rather than print a death year.
    if (typeof age !== 'number' || !Number.isFinite(age)) return null;
    const birthYear = Number(member.payload.birthdate.slice(0, 4));
    candidates.push({ deathYear: birthYear + age, birthYear, firstName: safeFirstName(member) });
  }
  const lastDeathYear = Math.max(...candidates.map((c) => c.deathYear));
  const survivors = candidates.filter((c) => c.deathYear === lastDeathYear);
  const elder = survivors.reduce((a, b) => (a.birthYear <= b.birthYear ? a : b));
  // Same-age members tie on death year and are named together; a tie between different birth years falls back to the elder's age alone.
  const sameAge = survivors.every((c) => c.birthYear === elder.birthYear);
  const allNamed = survivors.every((c) => c.firstName !== '');
  return {
    firstName:
      sameAge && allNamed ? survivors.map((c) => c.firstName).join(' and ') : null,
    birthYear: elder.birthYear,
  };
}
