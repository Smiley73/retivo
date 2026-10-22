/**
 * Focused tests for the orchestrator's survivor claim-age dimension:
 * death-order selection (benefit-purpose birth years),
 * every inert branch (the optimizer never synthesizes a survivor
 * age), and the pair-crossing that holds the stored survivor age constant
 * while the own claim ages vary.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPairs,
  buildSurvivorDimension,
  resolvedSsPair,
  type PiaState,
  type SurvivorDimension,
} from './orchestrator-helpers';
import { mergeSsOverride } from './merge-ss-override';
import { projectSsByYear, type SsContext } from '../ss-projection';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  ScenarioOverrides,
  SocialSecurityOverride,
} from '../../db/types';

const memberAgg = (
  id: string,
  birthdate: string | undefined,
  isPrimary: boolean,
): Aggregate<HouseholdMemberPayload> =>
  ({
    id,
    payload: {
      firstName: id,
      lastName: 'Member',
      email: `${id}@example.com`,
      isPrimary,
      ...(birthdate ? { birthdate } : {}),
    },
  }) as Aggregate<HouseholdMemberPayload>;

const bothHavePia: PiaState = {
  primaryHasPia: true,
  secondaryHasPia: true,
  missingPiaMembers: [],
};

const resolvedWith = (overrides: Partial<ScenarioOverrides>): ScenarioOverrides =>
  ({
    lifeExpectancy: { primary: 90, secondary: 90 },
    ...overrides,
  }) as ScenarioOverrides;

describe('buildSurvivorDimension', () => {
  it('the later-death-year member becomes the survivor role', () => {
    // Primary born 1960 (death 2050), secondary born 1966 (death 2056) →
    // the SECONDARY is the prospective survivor; candidates carry the
    // secondary's stored survivor age.
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1966-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toHaveLength(1);
    expect(dim.candidates[0].survivor.secondary).toEqual({ ageYears: 66, ageMonths: 0 });
    expect(dim.candidates[0].survivor.primary).toBeUndefined();
  });

  it('reversed death order flips the survivor role to the primary', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1966-06-15', true),
      secondary: memberAgg('s', '1960-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { primary: { ageYears: 64, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toHaveLength(1);
    expect(dim.candidates[0].survivor.primary).toEqual({ ageYears: 64, ageMonths: 0 });
  });

  it('uses BENEFIT-PURPOSE birth years: a January-1 birth is the prior cohort', () => {
    // Primary born 1960-01-01 → SSA day-1 rule puts them in the 1959
    // cohort → death 1959 + 90 = 2049. Secondary born 1960-06-15 → death
    // 2050. Raw `slice(0, 4)` would read BOTH as 1960 → a FALSE tie → the
    // dimension would go inert and drop the survivor phase entirely.
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-01-01', true),
      secondary: memberAgg('s', '1960-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 67, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toHaveLength(1);
    expect(dim.candidates[0].survivor.secondary).toEqual({ ageYears: 67, ageMonths: 0 });
  });

  it('equal benefit-purpose death years → inert (no survivor phase)', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1960-03-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 67, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toEqual([]);
  });

  it('no stored survivor age → inert (never synthesized)', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1966-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
      }),
    });
    expect(dim.candidates).toEqual([]);
  });

  it('prospective deceased without a PIA → inert', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1966-06-15', false),
      // Secondary survives; the PRIMARY is the deceased-to-be with no PIA.
      piaState: { primaryHasPia: false, secondaryHasPia: true, missingPiaMembers: ['p'] },
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toEqual([]);
  });

  it('missing/invalid birthdate → inert', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', undefined, true),
      secondary: memberAgg('s', '1966-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
        },
      }),
    });
    expect(dim.candidates).toEqual([]);
  });

  it('carries a stored nonzero ageMonths component verbatim', () => {
    // Stored 66y6m must be SIMULATED as 66y6m — the earlier whole-year
    // truncation ranked a 66y0m projection that Apply (which preserves the
    // stored map) never reproduces.
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1966-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
          survivor: { secondary: { ageYears: 66, ageMonths: 6 } },
        },
      }),
    });
    expect(dim.candidates).toHaveLength(1);
    expect(dim.candidates[0].survivor.secondary).toEqual({ ageYears: 66, ageMonths: 6 });
  });

  it('single-member plan (no secondary) → inert', () => {
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: undefined,
      piaState: { primaryHasPia: true, secondaryHasPia: false, missingPiaMembers: [] },
      resolved: resolvedWith({}),
    });
    expect(dim.candidates).toEqual([]);
  });
});

describe('buildPairs × survivor dimension (expandWithSurvivor)', () => {
  const oneCandidate: SurvivorDimension = {
    candidates: [
      {
        survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
      },
    ],
  };

  it('holds the stored survivor age constant while own claim ages vary', () => {
    const pairs = buildPairs({
      primaryGrid: [67, 68],
      secondaryGrid: [66],
      hasSecondary: true,
      resolvedOverride: undefined,
      survivorDimension: oneCandidate,
    });
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.candidate.survivor).toEqual({
        secondary: { ageYears: 66, ageMonths: 0 },
      });
    }
    // The own ages still cross the grid.
    expect(pairs.map((p) => p.primaryAgeYears)).toEqual([67, 68]);
  });

  it('inert dimension → every pair is survivor-free (no candidate.survivor)', () => {
    const pairs = buildPairs({
      primaryGrid: [67],
      secondaryGrid: [66],
      hasSecondary: true,
      resolvedOverride: undefined,
      survivorDimension: { candidates: [] },
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].candidate.survivor).toBeUndefined();
  });

  it('1-D fallback pairs carry the survivor dimension too', () => {
    const pairs = buildPairs({
      primaryGrid: [67, 68],
      secondaryGrid: [],
      hasSecondary: true,
      resolvedOverride: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 65, ageMonths: 0 },
      },
      survivorDimension: oneCandidate,
    });
    expect(pairs).toHaveLength(2);
    for (const pair of pairs) {
      expect(pair.candidate.survivor).toEqual({
        secondary: { ageYears: 66, ageMonths: 0 },
      });
      expect(pair.candidate.secondary).toEqual({ ageYears: 65, ageMonths: 0 });
    }
  });
});

describe('buildPairs × the stored claim-age pair (extra candidate)', () => {
  const monthLevel: SocialSecurityOverride = {
    primary: { ageYears: 66, ageMonths: 4 },
    secondary: { ageYears: 67, ageMonths: 0 },
  };
  const joint = (resolvedOverride: SocialSecurityOverride | undefined) =>
    buildPairs({
      primaryGrid: [65, 66, 67],
      secondaryGrid: [66, 67, 68],
      hasSecondary: true,
      resolvedOverride,
      survivorDimension: {
        candidates: [{ survivor: { secondary: { ageYears: 66, ageMonths: 0 } } }],
      },
    });

  it('appends a month-level stored pair once, verbatim, crossed with the survivor dimension', () => {
    const pairs = joint(monthLevel);
    expect(pairs).toHaveLength(10);
    expect(pairs[9]).toEqual({
      primaryAgeYears: 66,
      primaryAgeMonths: 4,
      secondaryAgeYears: 67,
      secondaryAgeMonths: 0,
      candidate: {
        primary: { ageYears: 66, ageMonths: 4 },
        secondary: { ageYears: 67, ageMonths: 0 },
        survivor: { secondary: { ageYears: 66, ageMonths: 0 } },
      },
    });
  });

  it('uses the fallback default for a two-member plan with no stored secondary age', () => {
    const pairs = joint({ primary: { ageYears: 66, ageMonths: 4 } });
    expect(pairs).toHaveLength(10);
    expect(pairs[9].candidate.secondary).toEqual({ ageYears: 67, ageMonths: 0 });
    expect(resolvedSsPair({ primary: { ageYears: 66, ageMonths: 4 } }, true)).toEqual({
      primaryAgeYears: 66,
      primaryAgeMonths: 4,
      secondaryAgeYears: 67,
      secondaryAgeMonths: 0,
    });
  });

  it('resolves an unsearched secondary to null identity, like every candidate of the primary-only fallback', () => {
    const stored = {
      primary: { ageYears: 66, ageMonths: 4 },
      secondary: { ageYears: 72, ageMonths: 0 },
    };
    const expected = {
      primaryAgeYears: 66,
      primaryAgeMonths: 4,
      secondaryAgeYears: null,
      secondaryAgeMonths: undefined,
    };
    expect(resolvedSsPair(stored, false)).toEqual(expected);
    expect(resolvedSsPair({ primary: stored.primary }, false)).toEqual(expected);
  });

  it('secondary-only fallback carries the primary months on every pair, including the stored one', () => {
    const pairs = buildPairs({
      primaryGrid: [],
      secondaryGrid: [65, 66],
      hasSecondary: true,
      resolvedOverride: monthLevel,
    });
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      expect(pair.primaryAgeYears).toBe(66);
      expect(pair.primaryAgeMonths).toBe(4);
      expect(pair.candidate.primary).toEqual({ ageYears: 66, ageMonths: 4 });
    }
    expect(pairs.map((p) => p.secondaryAgeYears)).toEqual([65, 66, 67]);
    expect(pairs.map((p) => p.candidate.secondary?.ageMonths)).toEqual([0, 0, 0]);
  });

  it('primary-only fallback bakes the stored secondary into every pair without varying it', () => {
    const stored = { ...monthLevel, secondary: { ageYears: 67, ageMonths: 3 } };
    const pairs = buildPairs({
      primaryGrid: [65, 66],
      secondaryGrid: [],
      hasSecondary: true,
      resolvedOverride: stored,
    });
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      expect(pair.secondaryAgeYears).toBeNull();
      expect(pair.candidate.secondary).toEqual({ ageYears: 67, ageMonths: 3 });
    }
    expect(pairs[2].primaryAgeMonths).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The simulated survivor map must be EXACTLY the map `mergeSsOverride`
// writes on Apply. The projection is a pure function of the override, so
// candidate.survivor === merged.survivor proves the post-Apply projection
// reproduces the ranked candidate the user picked.
// ---------------------------------------------------------------------------
describe('survivor candidate ↔ Apply round-trip', () => {
  const roundTrip = (
    stored: { ageYears: number; ageMonths: number },
  ): void => {
    const override: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      survivor: { secondary: stored },
    };
    // Secondary born 1976 (death 2066) survives the primary (death 2050) —
    // every stored age in the 60–70 window rides the candidate verbatim.
    const dim = buildSurvivorDimension({
      primary: memberAgg('p', '1960-06-15', true),
      secondary: memberAgg('s', '1976-06-15', false),
      piaState: bothHavePia,
      resolved: resolvedWith({ socialSecurity: override }),
    });
    expect(dim.candidates).toHaveLength(1);
    const applied = mergeSsOverride({
      currentResolvedOverride: override,
      optimalPair: { primaryAgeYears: 67, secondaryAgeYears: 67 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    // The map the ranking simulated is byte-for-byte the map Apply writes.
    expect(dim.candidates[0].survivor).toEqual(applied.survivor);
    expect(dim.candidates[0].survivor.secondary).toEqual(stored);
  };

  it('a survivor age with a nonzero ageMonths component round-trips', () => {
    roundTrip({ ageYears: 62, ageMonths: 6 });
  });

  it('the minimum survivor claim age (60y0m) round-trips unclamped', () => {
    roundTrip({ ageYears: 60, ageMonths: 0 });
  });

  it('the maximum survivor claim age (70y0m) round-trips unclamped', () => {
    roundTrip({ ageYears: 70, ageMonths: 0 });
  });
});

// ---------------------------------------------------------------------------
// An already-"past" stored survivor age (earlier than the member's
// current age) with a death boundary landing before the next whole age must
// ride the candidate VERBATIM, so ranking and Apply produce IDENTICAL
// projections. An earlier grid silently rounded the stored 62 up to the
// next whole future age (65 for a 64.6-year-old), ranking a projection with
// a LATER survivor start than the one Apply's preserved 62 reproduces.
// ---------------------------------------------------------------------------
describe('survivor past stored age ↔ Apply round-trip', () => {
  // Deceased (primary) born 1962-03-15, PIA $2,000, claims 62, dies Dec 31
  // 2025 (life 63). Survivor (secondary) born 1961-11-15 (~64.6 in mid
  // 2026), PIA $800, own claim 63, STORED survivor claim age 62 — already
  // past. Survivor start = max(Nov 2023 [62], Jan 2026 [death boundary]) =
  // Jan 2026 with the stored 62; a rounded 65 would start Nov 2026.
  const override: SocialSecurityOverride = {
    primary: { ageYears: 62, ageMonths: 0 },
    secondary: { ageYears: 63, ageMonths: 0 },
    survivor: { secondary: { ageYears: 62, ageMonths: 0 } },
  };
  const primaryAgg = memberAgg('p', '1962-03-15', true);
  const secondaryAgg = memberAgg('s', '1961-11-15', false);
  const ctxWithSurvivorAge = (svAge: RetirementAgePerMember): SsContext => ({
    primary: {
      id: 'p',
      payload: primaryAgg.payload,
      pia: 2_000,
      claimAge: { ageYears: 62, ageMonths: 0 },
      lifeExpectancyAge: 63,
    },
    secondary: {
      id: 's',
      payload: secondaryAgg.payload,
      pia: 800,
      claimAge: { ageYears: 63, ageMonths: 0 },
      survivorClaimAge: svAge,
      lifeExpectancyAge: 90,
    },
    colaPct: 0,
    benefitReductionPct: 0,
  });

  it('ranks the verbatim stored 62 and Apply reproduces the identical projection', () => {
    const dim = buildSurvivorDimension({
      primary: primaryAgg,
      secondary: secondaryAgg,
      piaState: bothHavePia,
      resolved: resolvedWith({
        lifeExpectancy: { primary: 63, secondary: 90 },
        socialSecurity: override,
      }),
    });
    expect(dim.candidates).toHaveLength(1);
    const rankedAge = dim.candidates[0].survivor.secondary!;
    // Verbatim — never a next-whole-age normalization.
    expect(rankedAge).toEqual({ ageYears: 62, ageMonths: 0 });

    const applied = mergeSsOverride({
      currentResolvedOverride: override,
      optimalPair: { primaryAgeYears: 62, secondaryAgeYears: 63 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    const appliedAge = applied.survivor!.secondary!;
    expect(appliedAge).toEqual(rankedAge);

    // The projection ranked and the projection Apply writes are IDENTICAL.
    const range = { from: 2025, to: 2030 };
    const ranked = projectSsByYear(ctxWithSurvivorAge(rankedAge), range);
    const afterApply = projectSsByYear(ctxWithSurvivorAge(appliedAge), range);
    expect(afterApply).toEqual(ranked);

    // Load-bearing: a rounded 65 would produce a DIFFERENT projection
    // (survivor step-up delayed from Jan 2026 to Nov 2026).
    const normalized = projectSsByYear(
      ctxWithSurvivorAge({ ageYears: 65, ageMonths: 0 }),
      range,
    );
    const row2026 = (rows: ReturnType<typeof projectSsByYear>): number =>
      rows.find((r) => r.year === 2026)!.byMember.secondary ?? 0;
    expect(row2026(normalized)).not.toBeCloseTo(row2026(ranked), 0);
  });
});
