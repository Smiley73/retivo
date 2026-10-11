/**
 * Balance Projection page — retirement + life-expectancy marker
 * builders. Extracted from `BalanceProjectionPage.tsx` to keep the page itself
 * small.
 *
 * Each helper is a pure transformer over ISO date strings (no React,
 * no DOM). The runner currently emits its own `retirementMarkers` /
 * `lifeExpectancyMarkers` shapes but does not surface the page-specific
 * label / color presentation.
 */
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

/** Convert an ISO `YYYY-MM-DD` retirement date into a fractional X-axis
 *  coordinate plus a compact `MMM YYYY` label. */
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

/**
 * Projected death year (integer `deathYear = birthYear + ageYears`).
 *
 * Death is modelled as Dec 31 of `deathYear`, so the birth
 * month/day no longer shift the result — only the birth *year* matters
 * (no partial-year proration; the death year is a full year). The ISO
 * regex + `month < 1 || month > 12` guard are preserved so an invalid
 * birthdate still returns `null` (the null contract is unchanged).
 *
 * DELIBERATELY as loose as the engine's `projectedDeathFractionalYear`, which
 * is what `computeHorizonYear` projects the plan to. Tightening this to the
 * strict ISO validator looked like a fix — it would agree with the market-
 * stress cap anchor — but it made the markers STRICTER than the projection they
 * annotate: a member with an impossible day (`1990-02-31`) kept driving the
 * horizon while losing their death marker, and the charts' end year shrank
 * below the years still being drawn. The market-stress row handles the
 * disagreement on its own side instead, by declining to name anyone when any
 * member's birthdate is one the two validators could read differently — see
 * {@link resolveLastSurvivor}.
 */
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

/** A member's given name as a usable string, or `''` when it is blank, missing,
 *  or not a string at all. Member payloads reach this module straight off an
 *  envelope-only-validated import, so `firstName` really can be absent despite
 *  the type — and a bare `.trim()` on it threw out of the whole page. */
function safeFirstName(member: Aggregate<HouseholdMemberPayload>): string {
  const raw = member.payload.firstName;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Life-expectancy death markers for the retirement charts (Expected
 * cashflow, Income breakdown, Portfolio Flow, Tax & Health-Cost Burden).
 *
 * Each marker's `fractionalYear` is the **integer death year**.
 * Death is modelled on Dec 31 of `deathYear`, the terminal year — no
 * partial-year proration. Each chart maps this integer to its own
 * terminal-data x-convention so the marker hugs the last data point
 *: yearly charts use `deathYear` directly; always-monthly charts
 * map to the December sample (`deathYear + 11/12`); the per-year balance
 * chart applies its `year + 1` convention (`deathYear + 1`).
 */
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

/** Who the plan's horizon belongs to. `firstName` credits the added years —
 *  two members reaching the horizon at the SAME age are named together, since
 *  the years are added to both lives; it is `null` when nobody can be named
 *  with confidence, and the row then states the age alone. */
export interface LastSurvivor {
  readonly firstName: string | null;
  readonly birthYear: number;
}

/**
 * Resolve the household member projected to die LAST — the person whose life
 * the market-stress longevity case actually lengthens, because the plan's
 * horizon IS their death year and the stress extends that horizon.
 *
 * DISTINCT from the age-105 cap anchor (`longestLivedBirthYearOf`), which is
 * the YOUNGEST member by birth year. That one bounds how FAR the stress may
 * run; this one names WHOSE life it extends. They are the same person in an
 * ordinary household and diverge only when an older member's longer life
 * expectancy carries them past a younger member's — in which case naming the
 * youngest would credit the added years to someone the plan already buried.
 *
 * WHY THE STRICT PRE-CHECK. Three code paths disagree about which members
 * exist: the cap anchor runs the strict ISO validator, the death markers and
 * this module run the looser shape-plus-month test, and the ENGINE's
 * `computeHorizonYear` — the one that actually sets the horizon being aged
 * here — is looser still, falling back to a bare four-digit year prefix. Where
 * they disagree, the member who owns the horizon can be one this function never
 * saw, and it would then confidently print a DIFFERENT member's age: with an
 * imported `1990-02-31` secondary driving the horizon, the row named the
 * primary at an age the plan has her dead well before. So this refuses the
 * whole question unless EVERY member's birthdate is strictly valid — the one
 * condition under which all three paths provably agree, since the loose test
 * and the bare-year fallback both reduce to the strict result. Outside it the
 * row prints no age rather than a wrong one.
 */
export function resolveLastSurvivor(
  primaryMember: Aggregate<HouseholdMemberPayload> | null,
  secondaryMember: Aggregate<HouseholdMemberPayload> | null,
  override: LifeExpectancyOverride | undefined,
): LastSurvivor | null {
  // A household with no primary is not one this can mirror the engine on.
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
    // `lifeExpectancy` carries no runtime shape check either, so an imported
    // scenario can hold a string or a NaN here. An age that is not a real
    // number yields no trustworthy death year, so decline rather than print one.
    if (typeof age !== 'number' || !Number.isFinite(age)) return null;
    const birthYear = Number(member.payload.birthdate.slice(0, 4));
    candidates.push({ deathYear: birthYear + age, birthYear, firstName: safeFirstName(member) });
  }
  const lastDeathYear = Math.max(...candidates.map((c) => c.deathYear));
  const survivors = candidates.filter((c) => c.deathYear === lastDeathYear);
  const elder = survivors.reduce((a, b) => (a.birthYear <= b.birthYear ? a : b));
  // Two members born the same year on the same life expectancy tie on the death
  // year and reach the horizon at the SAME age — the out-of-the-box shape for a
  // same-age couple, so dropping both names there would leave the commonest
  // two-person household unnamed. Name them together. A tie between DIFFERENT
  // birth years means two different ages, with no single one to print, so that
  // falls back to the elder's age stated alone.
  const sameAge = survivors.every((c) => c.birthYear === elder.birthYear);
  const allNamed = survivors.every((c) => c.firstName !== '');
  return {
    firstName:
      sameAge && allNamed ? survivors.map((c) => c.firstName).join(' and ') : null,
    birthYear: elder.birthYear,
  };
}
