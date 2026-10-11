/**
 * Unit tests for the claim-age comparison + current-age resolution that
 * drive the optimizer table's "current → recommended" cell and the
 * live "already applied" button state.
 */
import { describe, expect, it } from 'vitest';
import {
  claimAgeMatches,
  resolveCurrentClaimAges,
} from './ss-optimizer-row-view';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioOverrides } from '../db/types';

function scenario(
  id: string,
  overrides: ScenarioOverrides,
  parentScenarioId: string | null = null,
  isPrimary = true,
): ScenarioAggregate {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev',
    payload: {
      name: id,
      description: '',
      parentScenarioId,
      isPrimary,
      notes: '',
      overrides,
    },
  };
}

describe('claimAgeMatches', () => {
  it('should_match_when_current_equals_whole_year_recommendation', () => {
    expect(claimAgeMatches({ ageYears: 65, ageMonths: 0 }, 65)).toBe(true);
  });

  it('should_not_match_when_current_carries_months', () => {
    // A 65y6m current is NOT already at a "65" recommendation.
    expect(claimAgeMatches({ ageYears: 65, ageMonths: 6 }, 65)).toBe(false);
  });

  it('should_not_match_on_different_year', () => {
    expect(claimAgeMatches({ ageYears: 62, ageMonths: 0 }, 65)).toBe(false);
  });

  it('should_not_match_when_no_current_age_set', () => {
    expect(claimAgeMatches(null, 65)).toBe(false);
  });

  it('should_match_null_recommendation_only_against_null_current', () => {
    // Secondary past the claim-age window (null recommendation) is
    // "already optimal" only when the scenario sets no secondary age.
    expect(claimAgeMatches(null, null)).toBe(true);
    expect(claimAgeMatches({ ageYears: 67, ageMonths: 0 }, null)).toBe(false);
  });
});

describe('resolveCurrentClaimAges', () => {
  it('should_return_the_scenarios_own_override', () => {
    const s = scenario('s1', {
      socialSecurity: {
        primary: { ageYears: 62, ageMonths: 0 },
        secondary: { ageYears: 64, ageMonths: 0 },
      },
    });
    expect(resolveCurrentClaimAges('s1', [s])).toEqual({
      primary: { ageYears: 62, ageMonths: 0 },
      secondary: { ageYears: 64, ageMonths: 0 },
    });
  });

  it('should_return_nulls_when_no_override_set', () => {
    const s = scenario('s1', { inflation: { ratePct: 0 } });
    expect(resolveCurrentClaimAges('s1', [s])).toEqual({
      primary: null,
      secondary: null,
    });
  });

  it('should_inherit_the_first_ancestor_with_a_claim_age', () => {
    const parent = scenario('p1', {
      socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
    });
    const child = scenario('c1', { inflation: { ratePct: 1 } }, 'p1', false);
    expect(resolveCurrentClaimAges('c1', [child, parent])).toEqual({
      primary: { ageYears: 70, ageMonths: 0 },
      secondary: null,
    });
  });
});

