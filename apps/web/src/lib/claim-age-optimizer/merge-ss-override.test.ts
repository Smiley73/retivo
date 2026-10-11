/**
 * Behaviour tests for `mergeSsOverride` — guards the merge
 * semantics (preserve haircut + COLA, write whole-year ageMonths, strip
 * secondary for single-member, preserve secondary past the claim-age
 * window).
 */
import { describe, expect, it } from 'vitest';
import { mergeSsOverride } from './merge-ss-override';
import { buildSsContext, projectSsByYear } from '../ss-projection';
import type {
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
} from '../../db/types';

describe('mergeSsOverride', () => {
  it('should_preserve_benefitReductionPct_and_colaPct', () => {
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 6 },
      benefitReductionPct: 25,
      colaPct: 1.5,
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.benefitReductionPct).toBe(25);
    expect(merged.colaPct).toBe(1.5);
  });

  it('should_write_ageMonths_zero_for_whole_year_search', () => {
    const merged = mergeSsOverride({
      currentResolvedOverride: undefined,
      optimalPair: { primaryAgeYears: 65, secondaryAgeYears: 67 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.primary).toEqual({ ageYears: 65, ageMonths: 0 });
    expect(merged.secondary).toEqual({ ageYears: 67, ageMonths: 0 });
  });

  it('should_strip_secondary_for_single_member_households', () => {
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      // Inherited override happened to carry a stale secondary — drop it.
      secondary: { ageYears: 67, ageMonths: 0 },
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: null },
      hasSecondary: false,
      secondaryPastWindow: false,
    });
    expect(merged.primary.ageYears).toBe(70);
    expect('secondary' in merged).toBe(false);
  });

  it('should_preserve_existing_secondary_when_secondaryPastWindow', () => {
    // Secondary past the claim-age window → Apply still runs and
    // writes only primary; secondary stays at the user's prior value.
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 68, ageMonths: 3 },
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: null },
      hasSecondary: true,
      secondaryPastWindow: true,
    });
    expect(merged.primary.ageYears).toBe(70);
    expect(merged.secondary).toEqual({ ageYears: 68, ageMonths: 3 });
  });

  it('omits secondary when secondaryPastWindow and no prior override exists', () => {
    const merged = mergeSsOverride({
      currentResolvedOverride: undefined,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: null },
      hasSecondary: true,
      secondaryPastWindow: true,
    });
    expect(merged.primary.ageYears).toBe(70);
    expect('secondary' in merged).toBe(false);
  });

  it('omits colaPct when current override only carries benefitReductionPct', () => {
    // Partial-preserve regression: a future change flipping the
    // undefined-guard to `?? 0` would silently materialise colaPct on
    // the merged payload with a wrong value. This test fails red on
    // that regression.
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      benefitReductionPct: 25,
      // colaPct intentionally undefined.
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.benefitReductionPct).toBe(25);
    expect('colaPct' in merged).toBe(false);
  });

  it('omits benefitReductionPct when current override only carries colaPct', () => {
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      colaPct: 1.5,
      // benefitReductionPct intentionally undefined.
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.colaPct).toBe(1.5);
    expect('benefitReductionPct' in merged).toBe(false);
  });

  it('should_preserve_the_resolved_survivor_map_on_apply', () => {
    const current: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      survivor: {
        primary: { ageYears: 60, ageMonths: 0 },
        secondary: { ageYears: 66, ageMonths: 0 },
      },
    };
    const merged = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect(merged.survivor).toEqual(current.survivor);
  });

  it('omits survivor when the resolved override never carried one (absence preserved)', () => {
    const merged = mergeSsOverride({
      currentResolvedOverride: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
      },
      optimalPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    expect('survivor' in merged).toBe(false);
  });

  // Round trip: the post-Apply override must reproduce the RANKED
  // candidate's projection — including the survivor phase the winner was
  // simulated with (dropping `survivor` would flip it to the withheld state).
  it('post_apply_projection_reproduces_the_ranked_candidate', () => {
    const memberAgg = (
      id: string,
      birthdate: string,
      isPrimary: boolean,
    ): Aggregate<HouseholdMemberPayload> =>
      ({
        id,
        payload: {
          firstName: id,
          lastName: 'Member',
          email: `${id}@example.com`,
          isPrimary,
          birthdate,
        },
      }) as Aggregate<HouseholdMemberPayload>;
    const benefitAgg = (
      memberId: string,
      pia: number,
    ): Aggregate<SocialSecurityBenefitPayload> =>
      ({
        id: `ss-${memberId}`,
        payload: { householdMemberId: memberId, pia, piaAsOfDate: null, notes: null },
      }) as Aggregate<SocialSecurityBenefitPayload>;
    const members = [
      memberAgg('p', '1960-03-15', true),
      memberAgg('s', '1962-03-15', false),
    ];
    const benefits = [benefitAgg('p', 3_000), benefitAgg('s', 1_000)];
    const current: SocialSecurityOverride = {
      primary: { ageYears: 62, ageMonths: 0 },
      secondary: { ageYears: 62, ageMonths: 0 },
      survivor: { secondary: { ageYears: 67, ageMonths: 0 } },
    };
    // The ranked winner: (67, 67) simulated WITH the stored survivor map.
    const winnerOverride: SocialSecurityOverride = {
      primary: { ageYears: 67, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
      survivor: current.survivor,
    };
    const applied = mergeSsOverride({
      currentResolvedOverride: current,
      optimalPair: { primaryAgeYears: 67, secondaryAgeYears: 67 },
      hasSecondary: true,
      secondaryPastWindow: false,
    });
    const project = (ss: SocialSecurityOverride) => {
      const ctx = buildSsContext(members, benefits, {
        claimAgePrimary: ss.primary,
        claimAgeSecondary: ss.secondary,
        survivorClaimAgePrimary: ss.survivor?.primary,
        survivorClaimAgeSecondary: ss.survivor?.secondary,
        lifeExpectancyPrimary: 90, // primary dies 2050 → survivor phase 2051+
        lifeExpectancySecondary: 95,
        colaPct: 0,
        benefitReductionPct: 0,
      });
      return projectSsByYear(ctx!, { from: 2051, to: 2055 });
    };
    const ranked = project(winnerOverride);
    const postApply = project(applied);
    for (let i = 0; i < ranked.length; i += 1) {
      expect(postApply[i].total).toBeCloseTo(ranked[i].total, 6);
      expect(postApply[i].survivorWithheld).toBeUndefined();
    }
    // The survivor phase actually contributes (the deceased component pays).
    expect(ranked[0].byMember.secondary ?? 0).toBeGreaterThan(1_000 * 12);
  });
});
