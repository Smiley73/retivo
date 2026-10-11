/**
 * `resolveSsColaPct` — the single read point deciding whether a
 * scenario's Social Security COLA tracks the general inflation rate
 * (default-on) or uses a fixed `colaPct` (explicit opt-out) — plus
 * `buildSsContext` construction: the statement COLA anchor, the
 * separate survivor claim age, and the monthly earned-income series
 * must survive into the built `SsContext`.
 */
import { describe, expect, it } from 'vitest';
import { buildSsContext, resolveSsColaPct } from './ss-context-builder';
import type {
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import { DEFAULT_COLA_PCT } from '../db/types';

describe('resolveSsColaPct', () => {
  it('should_track_inflation_when_override_is_undefined', () => {
    // Default-on: a scenario that never set the flag still tracks inflation.
    expect(resolveSsColaPct(undefined, 3)).toBe(3);
  });

  it('should_track_inflation_when_flag_is_absent_even_with_a_fixed_colaPct', () => {
    // colaPct is ignored unless tracking is explicitly disabled.
    expect(resolveSsColaPct({ colaPct: 1.5 }, 2.5)).toBe(2.5);
  });

  it('should_track_inflation_when_flag_is_true', () => {
    expect(resolveSsColaPct({ colaTracksInflation: true, colaPct: 1.5 }, 2.5)).toBe(2.5);
  });

  it('should_use_fixed_colaPct_when_tracking_disabled', () => {
    expect(resolveSsColaPct({ colaTracksInflation: false, colaPct: 4 }, 2.5)).toBe(4);
  });

  it('should_fall_back_to_default_cola_when_disabled_without_a_colaPct', () => {
    expect(resolveSsColaPct({ colaTracksInflation: false }, 2.5)).toBe(DEFAULT_COLA_PCT);
  });
});

const memberRow = (
  id: string,
  isPrimary: boolean,
  birthdate = '1965-03-12',
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'hh',
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  deviceId: 'dev',
  payload: {
    isPrimary,
    firstName: 'T',
    lastName: 'M',
    email: 't@example.test',
    birthdate,
  },
});

const benefitRow = (
  memberId: string,
  pia: number | null,
  piaAsOfDate: string | null,
): Aggregate<SocialSecurityBenefitPayload> => ({
  id: `ss-${memberId}`,
  householdId: 'hh',
  aggregateType: 'socialSecurityBenefit',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  deviceId: 'dev',
  payload: { householdMemberId: memberId, pia, piaAsOfDate, notes: null },
});

describe('buildSsContext — statement anchor, survivor age, monthly earnings', () => {
  const baseInputs = {
    claimAgePrimary: { ageYears: 67, ageMonths: 0 },
    claimAgeSecondary: { ageYears: 67, ageMonths: 0 },
    lifeExpectancyPrimary: 95,
    lifeExpectancySecondary: 95,
    colaPct: 2,
    benefitReductionPct: 0,
  };

  it('should_lift_the_piaAsOfDate_year_into_statementAnchorYear_per_member', () => {
    const ctx = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      [benefitRow('m1', 2000, '2026-01-15'), benefitRow('m2', 1500, '2024-06-30')],
      baseInputs,
    );
    expect(ctx?.primary.statementAnchorYear).toBe(2026);
    expect(ctx?.secondary?.statementAnchorYear).toBe(2024);
  });

  it('should_leave_statementAnchorYear_absent_when_piaAsOfDate_is_null_or_malformed', () => {
    const ctx = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      [benefitRow('m1', 2000, null), benefitRow('m2', 1500, 'not-a-date')],
      baseInputs,
    );
    expect(ctx?.primary.statementAnchorYear).toBeUndefined();
    expect(ctx?.secondary?.statementAnchorYear).toBeUndefined();
  });

  it('should_leave_statementAnchorYear_absent_when_piaAsOfDate_is_calendar_invalid', () => {
    // A shape-only `YYYY-MM-DD` match would accept these and turn a
    // garbage year into the load-bearing COLA anchor. Strict calendar
    // validation must treat them as absent (age-62 fallback anchor instead).
    const ctx = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      // Impossible day (Feb 30) + out-of-range month (13).
      [benefitRow('m1', 2000, '2026-02-30'), benefitRow('m2', 1500, '2026-13-01')],
      baseInputs,
    );
    expect(ctx?.primary.statementAnchorYear).toBeUndefined();
    expect(ctx?.secondary?.statementAnchorYear).toBeUndefined();
  });

  it('should_carry_survivor_claim_ages_per_member_and_leave_them_absent_when_not_supplied', () => {
    const withSurvivor = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      [benefitRow('m1', 2000, null)],
      {
        ...baseInputs,
        survivorClaimAgePrimary: { ageYears: 62, ageMonths: 0 },
        survivorClaimAgeSecondary: { ageYears: 60, ageMonths: 6 },
      },
    );
    expect(withSurvivor?.primary.survivorClaimAge).toEqual({ ageYears: 62, ageMonths: 0 });
    expect(withSurvivor?.secondary?.survivorClaimAge).toEqual({ ageYears: 60, ageMonths: 6 });
    const withheld = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      [benefitRow('m1', 2000, null)],
      baseInputs,
    );
    expect(withheld?.primary.survivorClaimAge).toBeUndefined();
    expect(withheld?.secondary?.survivorClaimAge).toBeUndefined();
  });

  it('should_thread_annual_and_monthly_earned_income_series_to_the_owning_member', () => {
    const monthly2026 = [1_000, 1_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const ctx = buildSsContext(
      [memberRow('m1', true), memberRow('m2', false)],
      [benefitRow('m1', 2000, null)],
      {
        ...baseInputs,
        earnedIncomeByMemberYear: { m1: { 2026: 2_000 } },
        earnedIncomeMonthlyByMemberYear: { m1: { 2026: monthly2026 } },
      },
    );
    expect(ctx?.primary.earnedIncomeByYear).toEqual({ 2026: 2_000 });
    expect(ctx?.primary.earnedIncomeMonthlyByYear).toEqual({ 2026: monthly2026 });
    // Unkeyed member gets neither series.
    expect(ctx?.secondary?.earnedIncomeByYear).toBeUndefined();
    expect(ctx?.secondary?.earnedIncomeMonthlyByYear).toBeUndefined();
  });
});
