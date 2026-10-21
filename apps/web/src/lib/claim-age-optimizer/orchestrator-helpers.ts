/**
 * Internal helpers for the claim-age optimizer orchestrator.
 * Extracted from `claim-age-optimizer.ts` to keep the barrel under
 * the universal 400-line shape cap. Not part of the public
 * API — re-imported by the barrel only.
 */
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../../db/types';
import { DEFAULT_LIFE_EXPECTANCY_AGE } from '../../db/types';
import { birthYearForBenefitPurposes } from '../ssa-formulas';
import { buildCandidateGrid, buildSurvivorCandidateGrid } from './build-grid';
import type { SurvivorClaimAges } from './types';
import type { ResolvedPair } from './pick-winner';

/** Default secondary claim-age fallback when no override exists — matches
 *  the SS modal's "67y 0m" default and `buildSsContext`'s internal
 *  default. Used when the secondary has no resolved override and its
 *  grid is empty (secondary past the claim-age window) or the engine runs a 1-D primary
 *  fallback. */
export const DEFAULT_SECONDARY_CLAIM_AGE: RetirementAgePerMember = {
  ageYears: 67,
  ageMonths: 0,
};

/** Same for primary — used by the symmetric fallback (primary
 *  missing PIA + secondary has candidates). */
export const DEFAULT_PRIMARY_CLAIM_AGE: RetirementAgePerMember = {
  ageYears: 67,
  ageMonths: 0,
};

export interface PairSpec {
  /** Always a real age. For the 1-D secondary fallback branch
   *  (primary PIA missing / past window) the orchestrator carries the
   *  resolved primary age forward unchanged — preserved, not
   *  optimised. The partial-state signal is `partial: true` +
   *  `missingPiaMembers` on the OptimizerResult; the page reads those
   *  to render the "PIA not set" callout in the primary cell. */
  readonly primaryAgeYears: number;
  /** Months on top of `primaryAgeYears`. Set for a stored month-level
   *  pair and for a primary the search did not vary (the secondary-only
   *  fallback); absent for a whole-year grid candidate. */
  readonly primaryAgeMonths?: number;
  readonly secondaryAgeYears: number | null;
  /** Months on top of `secondaryAgeYears`; same rule as the primary's. */
  readonly secondaryAgeMonths?: number;
  readonly candidate: {
    readonly primary: RetirementAgePerMember;
    readonly secondary?: RetirementAgePerMember;
    /** Survivor claim-age dimension — see `SurvivorClaimAges`. */
    readonly survivor?: SurvivorClaimAges;
  };
}

/**
 * The independent survivor claim-age dimension crossed into every
 * pair. `candidates` is empty when the dimension is inert (single-member
 * plan, no stored survivor age — the withheld-survivor state — or the prospective
 * deceased has no PIA); each entry carries both members' survivor ages
 * (month-precise years + months) for the overlay.
 */
export interface SurvivorDimension {
  readonly candidates: ReadonlyArray<{
    readonly survivor: SurvivorClaimAges;
  }>;
}

/** The inert dimension (no survivor axis on any candidate). */
const NO_SURVIVOR_DIMENSION: SurvivorDimension = { candidates: [] };

/**
 * Determine the survivor claim-age dimension for a two-spouse scenario.
 * Death order comes from the fixed death-age basis: the member with
 * the LATER resolved death year is the prospective survivor — either
 * spouse can be it. Equal death years → no survivor phase → inert. The
 * candidate set is `buildSurvivorCandidateGrid` (verbatim-or-inert:
 * the stored survivor age — month-precise years + months — rides
 * through untransformed when inside the 60–70 window, regardless of the
 * member's current age; out-of-window or absent → empty).
 */
export function buildSurvivorDimension(args: {
  primary: Aggregate<HouseholdMemberPayload>;
  secondary: Aggregate<HouseholdMemberPayload> | undefined;
  piaState: PiaState;
  resolved: ScenarioOverrides;
}): SurvivorDimension {
  if (!args.secondary) return NO_SURVIVOR_DIMENSION;
  const lifePrimary =
    args.resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const lifeSecondary = args.resolved.lifeExpectancy?.secondary ?? lifePrimary;
  // Derive death years from the BENEFIT-PURPOSE birth year (SSA
  // day-1 rule, POMS GN 00302.400) — the same `birthYearForBenefitPurposes`
  // + lifeExpectancy arithmetic `deathYearFor` uses in the engine. Raw
  // `slice(0, 4)` puts a January-1 birth in the wrong cohort, which can
  // flip the death ordering or fake a tie against the engine's own model.
  const birthYearOf = (m: Aggregate<HouseholdMemberPayload>): number | null => {
    const iso = m.payload.birthdate;
    if (!iso) return null;
    try {
      return birthYearForBenefitPurposes(iso);
    } catch {
      return null;
    }
  };
  const primaryBirth = birthYearOf(args.primary);
  const secondaryBirth = birthYearOf(args.secondary);
  if (primaryBirth === null || secondaryBirth === null) return NO_SURVIVOR_DIMENSION;
  const primaryDeath = primaryBirth + lifePrimary;
  const secondaryDeath = secondaryBirth + lifeSecondary;
  if (primaryDeath === secondaryDeath) return NO_SURVIVOR_DIMENSION;
  const survivingRole = primaryDeath > secondaryDeath ? 'primary' : 'secondary';
  const deceasedHasPia =
    survivingRole === 'primary'
      ? args.piaState.secondaryHasPia
      : args.piaState.primaryHasPia;
  const survivorOverride = args.resolved.socialSecurity?.survivor;
  // Pass the COMPLETE stored age (years + months) —
  // `mergeSsOverride` preserves the stored survivor map verbatim on Apply,
  // so the simulated candidate must carry the same month-precise value
  // (never rounded to a "future" age) or the ranked projection would not
  // be the one Apply reproduces.
  const grid = buildSurvivorCandidateGrid({
    resolvedSurvivorAge: survivorOverride?.[survivingRole],
    deceasedHasPia,
  });
  const otherRole = survivingRole === 'primary' ? 'secondary' : 'primary';
  const otherResolved = survivorOverride?.[otherRole];
  return {
    candidates: grid.map((age) => ({
      survivor: {
        [survivingRole]: age,
        ...(otherResolved ? { [otherRole]: otherResolved } : {}),
      } as SurvivorClaimAges,
    })),
  };
}

export interface PiaState {
  readonly primaryHasPia: boolean;
  readonly secondaryHasPia: boolean;
  readonly missingPiaMembers: ReadonlyArray<string>;
}

export function findMembers(
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): {
  primary: Aggregate<HouseholdMemberPayload> | undefined;
  secondary: Aggregate<HouseholdMemberPayload> | undefined;
} {
  const primary = members.find((m) => m.payload.isPrimary);
  const secondary = members.find((m) => !m.payload.isPrimary);
  return { primary, secondary };
}

export function derivePiaState(args: {
  primary: Aggregate<HouseholdMemberPayload>;
  secondary: Aggregate<HouseholdMemberPayload> | undefined;
  ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
}): PiaState {
  const piaByMember = new Map<string, number | null>();
  for (const b of args.ssBenefits) {
    piaByMember.set(b.payload.householdMemberId, b.payload.pia ?? null);
  }
  const missingPiaMembers: string[] = [];
  const primaryHasPia = (piaByMember.get(args.primary.id) ?? null) !== null;
  if (!primaryHasPia) missingPiaMembers.push(args.primary.id);
  const secondaryHasPia = args.secondary
    ? (piaByMember.get(args.secondary.id) ?? null) !== null
    : false;
  if (args.secondary && !secondaryHasPia) missingPiaMembers.push(args.secondary.id);
  return { primaryHasPia, secondaryHasPia, missingPiaMembers };
}

export function buildGrids(args: {
  primary: Aggregate<HouseholdMemberPayload>;
  secondary: Aggregate<HouseholdMemberPayload> | undefined;
  piaState: PiaState;
  today: Date;
}): {
  primary: ReadonlyArray<number>;
  secondary: ReadonlyArray<number>;
  partial: boolean;
} {
  const primaryGrid = buildCandidateGrid({
    memberAgeYearsToday: ageYearsToday(args.primary, args.today),
    hasPia: args.piaState.primaryHasPia,
  });
  const secondaryGrid = args.secondary
    ? buildCandidateGrid({
        memberAgeYearsToday: ageYearsToday(args.secondary, args.today),
        hasPia: args.piaState.secondaryHasPia,
      })
    : [];
  const partial =
    !args.piaState.primaryHasPia ||
    (args.secondary !== undefined && !args.piaState.secondaryHasPia) ||
    primaryGrid.length === 0 ||
    (args.secondary !== undefined && secondaryGrid.length === 0);
  return { primary: primaryGrid, secondary: secondaryGrid, partial };
}

export interface BuildPairsArgs {
  readonly primaryGrid: ReadonlyArray<number>;
  readonly secondaryGrid: ReadonlyArray<number>;
  readonly hasSecondary: boolean;
  /** Resolved scenario SS override — used to bake the *other* member's
   *  claim age into 1-D fallback candidates so the
   *  simulation runs against the user's stored value, not the
   *  buildSsContext internal default. */
  readonly resolvedOverride: SocialSecurityOverride | undefined;
  /** Survivor claim-age dimension crossed into every pair (inert →
   *  candidates carry no survivor field). Defaults to inert for
   *  single-member callers. */
  readonly survivorDimension?: SurvivorDimension;
}

export function buildPairs(args: BuildPairsArgs): PairSpec[] {
  const dim = args.survivorDimension ?? NO_SURVIVOR_DIMENSION;
  return withStoredPair(buildGridPairs(args, dim), args, dim);
}

/**
 * Append the scenario's stored claim-age pair (both members verbatim,
 * months included) as one extra candidate, so a month-level setting has a
 * baseline and can rank. Skipped when the grid branch is empty (past-window
 * and missing-PIA outcomes stay as they were) and when an equal candidate
 * is already listed. A member the search does not vary keeps `null`
 * secondary identity, like every other pair of its branch. The survivor
 * dimension is crossed in so the stored pair competes like for like.
 */
function withStoredPair(
  pairs: PairSpec[],
  args: BuildPairsArgs,
  dim: SurvivorDimension,
): PairSpec[] {
  const stored = args.resolvedOverride;
  if (!stored || pairs.length === 0) return pairs;
  const secondary = args.hasSecondary
    ? (stored.secondary ?? DEFAULT_SECONDARY_CLAIM_AGE)
    : undefined;
  const secondarySearched = secondary !== undefined && args.secondaryGrid.length > 0;
  const identity = {
    primaryAgeYears: stored.primary.ageYears,
    primaryAgeMonths: stored.primary.ageMonths,
    secondaryAgeYears: secondarySearched ? secondary.ageYears : null,
    ...(secondarySearched ? { secondaryAgeMonths: secondary.ageMonths } : {}),
  };
  if (pairs.some((p) => sameClaimIdentity(p, identity))) return pairs;
  return [
    ...pairs,
    ...expandWithSurvivor(
      {
        ...identity,
        candidate: {
          primary: stored.primary,
          ...(secondary ? { secondary } : {}),
        },
      },
      dim,
    ),
  ];
}

function sameClaimIdentity(
  a: Omit<PairSpec, 'candidate'>,
  b: Omit<PairSpec, 'candidate'>,
): boolean {
  return (
    a.primaryAgeYears === b.primaryAgeYears &&
    (a.primaryAgeMonths ?? 0) === (b.primaryAgeMonths ?? 0) &&
    a.secondaryAgeYears === b.secondaryAgeYears &&
    (a.secondaryAgeMonths ?? 0) === (b.secondaryAgeMonths ?? 0)
  );
}

function buildGridPairs(args: BuildPairsArgs, dim: SurvivorDimension): PairSpec[] {
  if (!args.hasSecondary) return buildSingleMemberPairs(args.primaryGrid);
  if (args.primaryGrid.length === 0 && args.secondaryGrid.length === 0) {
    return [];
  }
  if (args.secondaryGrid.length === 0) {
    return buildPrimaryOnlyPairs(args.primaryGrid, args.resolvedOverride, dim);
  }
  if (args.primaryGrid.length === 0) {
    return buildSecondaryOnlyPairs(args.secondaryGrid, args.resolvedOverride, dim);
  }
  return buildJointPairs(args.primaryGrid, args.secondaryGrid, dim);
}

/**
 * Cross a base pair with the survivor dimension: one spec per survivor
 * candidate, or a single survivor-free spec when the dimension is inert
 * (the projection then runs the withheld-survivor state for the pair —
 * never a silent survivor-age default).
 */
function expandWithSurvivor(
  base: Omit<PairSpec, 'candidate'> & {
    candidate: { primary: RetirementAgePerMember; secondary?: RetirementAgePerMember };
  },
  dim: SurvivorDimension,
): PairSpec[] {
  if (dim.candidates.length === 0) {
    return [base];
  }
  return dim.candidates.map((c) => ({
    ...base,
    candidate: { ...base.candidate, survivor: c.survivor },
  }));
}

function buildSingleMemberPairs(primaryGrid: ReadonlyArray<number>): PairSpec[] {
  // Single-member plans have no survivor phase — the dimension is absent
  // by construction (types.ts edge).
  const pairs: PairSpec[] = [];
  for (const p of primaryGrid) {
    pairs.push({
      primaryAgeYears: p,
      secondaryAgeYears: null,
      candidate: { primary: { ageYears: p, ageMonths: 0 } },
    });
  }
  return pairs;
}

function buildPrimaryOnlyPairs(
  primaryGrid: ReadonlyArray<number>,
  resolvedOverride: SocialSecurityOverride | undefined,
  dim: SurvivorDimension,
): PairSpec[] {
  // Secondary past the window (or missing PIA) — vary primary,
  // bake the secondary's resolved claim age into every candidate so
  // `buildSsContext` uses the user's stored value instead of its
  // internal 67y default.
  const secondaryFallback =
    resolvedOverride?.secondary ?? DEFAULT_SECONDARY_CLAIM_AGE;
  const pairs: PairSpec[] = [];
  for (const p of primaryGrid) {
    pairs.push(
      ...expandWithSurvivor(
        {
          primaryAgeYears: p,
          secondaryAgeYears: null,
          candidate: {
            primary: { ageYears: p, ageMonths: 0 },
            secondary: secondaryFallback,
          },
        },
        dim,
      ),
    );
  }
  return pairs;
}

function buildSecondaryOnlyPairs(
  secondaryGrid: ReadonlyArray<number>,
  resolvedOverride: SocialSecurityOverride | undefined,
  dim: SurvivorDimension,
): PairSpec[] {
  // Primary missing PIA (or past the window) + secondary
  // has candidates → 1-D search on the secondary, baking the primary's
  // resolved claim age into every candidate so the simulation runs
  // against the user's stored primary value. The PairSpec carries the
  // RESOLVED primary age (preserved, not optimised) so the Winner
  // contract — `primaryAgeYears: number` — is honoured and the merge
  // helper can pass it through Apply. The "partial" state is signalled
  // via `OptimizerResult.partial` + `missingPiaMembers`; the page
  // reads those to render "PIA not set" in the primary cell.
  const primaryFallback =
    resolvedOverride?.primary ?? DEFAULT_PRIMARY_CLAIM_AGE;
  const pairs: PairSpec[] = [];
  for (const s of secondaryGrid) {
    pairs.push(
      ...expandWithSurvivor(
        {
          primaryAgeYears: primaryFallback.ageYears,
          primaryAgeMonths: primaryFallback.ageMonths,
          secondaryAgeYears: s,
          candidate: {
            primary: primaryFallback,
            secondary: { ageYears: s, ageMonths: 0 },
          },
        },
        dim,
      ),
    );
  }
  return pairs;
}

function buildJointPairs(
  primaryGrid: ReadonlyArray<number>,
  secondaryGrid: ReadonlyArray<number>,
  dim: SurvivorDimension,
): PairSpec[] {
  const pairs: PairSpec[] = [];
  for (const p of primaryGrid) {
    for (const s of secondaryGrid) {
      pairs.push(
        ...expandWithSurvivor(
          {
            primaryAgeYears: p,
            secondaryAgeYears: s,
            candidate: {
              primary: { ageYears: p, ageMonths: 0 },
              secondary: { ageYears: s, ageMonths: 0 },
            },
          },
          dim,
        ),
      );
    }
  }
  return pairs;
}

/**
 * Calendar-aware fractional age in years today. The integer part is
 * completed whole years (zero day-averaging — exact birthday returns
 * the integer, not 70.0014); the fractional part is days since the
 * most recent birthday divided by the days to the next birthday.
 *
 * A 62-and-a-half-year-old must round UP to 63 in the grid's
 * `ceil` clamp (62 is a past claim age — birthday was six months ago).
 * A whole-day-past-birthday at age 62 (62.003) also rounds up to 63.
 * The exact 70th birthday returns 70.0 so `ceil(70.0) === 70` keeps
 * the grid populated with [70].
 */
function ageYearsToday(
  member: Aggregate<HouseholdMemberPayload>,
  today: Date,
): number {
  const iso = member.payload.birthdate;
  if (!iso) return 0;
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return 0;
  const birthYear = Number(parts[0]);
  const birthMonth = Number(parts[1]);
  const birthDay = Number(parts[2]);
  if (
    !Number.isFinite(birthYear) ||
    !Number.isFinite(birthMonth) ||
    !Number.isFinite(birthDay)
  ) {
    return 0;
  }
  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth() + 1; // getUTCMonth is 0-indexed
  const todayDay = today.getUTCDate();
  const beforeBirthday =
    todayMonth < birthMonth || (todayMonth === birthMonth && todayDay < birthDay);
  const completedYears = todayYear - birthYear - (beforeBirthday ? 1 : 0);
  if (completedYears < 0) return 0;
  // Fractional component: days since last birthday / days to next
  // birthday. Date.UTC normalises e.g. Feb 29 in a non-leap year to
  // Mar 1, which is the right behaviour for the rare leap-day case
  // (the next reachable anniversary is Mar 1 of a non-leap year).
  const lastBirthdayYear = todayYear - (beforeBirthday ? 1 : 0);
  const nextBirthdayYear = lastBirthdayYear + 1;
  const lastBirthdayMs = Date.UTC(lastBirthdayYear, birthMonth - 1, birthDay);
  const nextBirthdayMs = Date.UTC(nextBirthdayYear, birthMonth - 1, birthDay);
  const todayMs = Date.UTC(todayYear, todayMonth - 1, todayDay);
  const span = nextBirthdayMs - lastBirthdayMs;
  const fraction = span > 0 ? (todayMs - lastBirthdayMs) / span : 0;
  return completedYears + fraction;
}

/** The scenario's stored pair in the identity `withStoredPair` gives its
 *  candidate. `secondarySearched` is whether the search varies the
 *  secondary (two members and a non-empty secondary grid): a two-member
 *  plan with no stored secondary age then resolves to the same default the
 *  fallbacks bake in, and an unsearched secondary (single member, or the
 *  1-D primary-only fallback) keeps `null` identity like every candidate. */
export function resolvedSsPair(
  override: SocialSecurityOverride | undefined,
  secondarySearched: boolean,
): ResolvedPair | null {
  if (!override) return null;
  const secondary = secondarySearched
    ? (override.secondary ?? DEFAULT_SECONDARY_CLAIM_AGE)
    : undefined;
  return {
    primaryAgeYears: override.primary.ageYears,
    primaryAgeMonths: override.primary.ageMonths,
    secondaryAgeYears: secondary ? secondary.ageYears : null,
    secondaryAgeMonths: secondary ? secondary.ageMonths : undefined,
  };
}

// `buildCtx` is no longer needed — `simulateOneCandidate`
// delegates to `runBalanceProjection`, which constructs the
// `ProjectionContext` inline from the resolved scenario chain.
//
// Per-call `partial` flag still drives the page's missing-PIA + past-
// window callouts; the orchestrator computes it directly from `PiaState`
// + grid emptiness (see `buildGrids`).
