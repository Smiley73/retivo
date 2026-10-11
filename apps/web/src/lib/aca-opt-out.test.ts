/**
 * ACA Marketplace coverage opt-out (per member) — deterministic engine tests.
 *
 * The opt-out (`ScenarioOverrides.acaMarketplaceOptOutMemberIds`, threaded onto
 * `PipelineContext.acaMarketplaceOptOutMemberIds`) is the SINGLE point of truth
 * in the `hasAcaCoverage` derivation: a member in the set is forced off the
 * Marketplace, which removes them from BOTH the household benchmark
 * (`defaultHouseholdSlcspByAge` — the SUM of each covered member's own
 * age-priced premium × their covered months) AND the ACA-block engagement gate
 * (`anyMemberHasAcaCoverage`). `householdSize` (the FPL denominator) is NOT
 * narrowed.
 */
import { describe, it, expect } from 'vitest';
import { buildMemberInputs } from './balance-projection-runner-tax-helpers';
import {
  anyMemberHasAcaCoverage,
  defaultHouseholdSlcspByAge,
} from './tax-integration-helpers';
import { roughMonthlyBenchmarkCentsForMember } from './aca-ptc';
import { makeCtx } from './balance-projection-runner-tax-test-fixtures';

/** A full year of the per-member rough benchmark, in whole dollars. */
function fullYearDollars(age: number): number {
  return (roughMonthlyBenchmarkCentsForMember(age) * 12) / 100;
}

const PRIMARY = 'member-primary';
const SECONDARY = 'member-secondary';

// A two-member household, both retired pre-65, in a year where neither is on
// Medicare yet. Primary is OLDER (1962 → age 62 in 2024); secondary is YOUNGER
// (1965 → age 59 in 2024).
function twoCoveredHousehold(optOut: readonly string[] = []) {
  return makeCtx({
    primaryBirthdate: '1962-03-01',
    secondaryBirthdate: '1965-03-01',
    primaryRetirementYear: 2024,
    acaMarketplaceOptOutMemberIds: optOut,
  });
}

describe('ACA opt-out — buildMemberInputs hasAcaCoverage derivation', () => {
  it('should_keep_both_members_on_marketplace_when_no_opt_out', () => {
    const ctx = twoCoveredHousehold();
    const members = buildMemberInputs(ctx, 2024, true, true);
    expect(members.map((m) => m.hasAcaCoverage)).toEqual([true, true]);
  });

  it('should_force_hasAcaCoverage_false_for_an_opted_out_member', () => {
    const ctx = twoCoveredHousehold([SECONDARY]);
    const members = buildMemberInputs(ctx, 2024, true, true);
    const primary = members.find((m) => m.memberId === PRIMARY);
    const secondary = members.find((m) => m.memberId === SECONDARY);
    expect(primary?.hasAcaCoverage).toBe(true);
    expect(secondary?.hasAcaCoverage).toBe(false);
  });
});

describe('ACA opt-out — household benchmark narrowing', () => {
  it('should_credit_zero_ptc_eligibility_household_wide_when_all_members_opted_out', () => {
    const ctx = twoCoveredHousehold([PRIMARY, SECONDARY]);
    const members = buildMemberInputs(ctx, 2024, true, true);
    // anyMemberHasAcaCoverage false → ACA block skipped → no oldest lookup, no NaN.
    expect(anyMemberHasAcaCoverage(members)).toBe(false);
    const benchmark = defaultHouseholdSlcspByAge(members, 2024);
    expect(benchmark).toBe(0);
    expect(Number.isNaN(benchmark)).toBe(false);
  });

  it('should_drop_the_opted_out_YOUNGER_member_from_the_per_member_sum', () => {
    const full = buildMemberInputs(twoCoveredHousehold(), 2024, true, true);
    const optOut = buildMemberInputs(twoCoveredHousehold([SECONDARY]), 2024, true, true);
    // Each covered member is priced at their OWN age, so the full household
    // is age-62 + age-59 and the opt-out leaves the age-62 member alone.
    expect(defaultHouseholdSlcspByAge(full, 2024)).toBeCloseTo(
      fullYearDollars(62) + fullYearDollars(59),
      6,
    );
    expect(defaultHouseholdSlcspByAge(optOut, 2024)).toBeCloseTo(fullYearDollars(62), 6);
  });

  it('should_price_only_the_remaining_member_when_the_OLDEST_member_opts_out', () => {
    // Opting out the OLDEST (primary, age 62) leaves the benchmark at the
    // remaining member's OWN age-59 premium. The surviving member's subsidy is
    // recomputed — NOT "unchanged".
    const optOutOldest = buildMemberInputs(
      twoCoveredHousehold([PRIMARY]),
      2024,
      true,
      true,
    );
    const benchmark = defaultHouseholdSlcspByAge(optOutOldest, 2024);
    expect(benchmark).toBeCloseTo(fullYearDollars(59), 6);
    // It differs from the full-household benchmark AND from the oldest-member
    // anchor — proving the per-member re-pricing.
    expect(benchmark).toBeLessThan(fullYearDollars(62) + fullYearDollars(59));
    expect(benchmark).toBeLessThan(fullYearDollars(62));
  });
});

describe('ACA opt-out — no-op edges', () => {
  it('should_be_byte_identical_for_a_never_pre65_retired_member', () => {
    // Secondary still WORKING at the projection year (retires far in the future)
    // → not on the Marketplace anyway, so opting them out is a no-op.
    const base = makeCtx({
      primaryBirthdate: '1962-03-01',
      secondaryBirthdate: '1965-03-01',
      primaryRetirementYear: 2024,
    });
    // The factory derives secondary retirement from `retirementByMember`, which
    // is empty → secondary falls back to the primary retirement year. Use a year
    // BEFORE retirement so neither is retired (isRetiredByYear false).
    const before = buildMemberInputs(base, 2023, true, true);
    const beforeOptOut = buildMemberInputs(
      makeCtx({
        primaryBirthdate: '1962-03-01',
        secondaryBirthdate: '1965-03-01',
        primaryRetirementYear: 2024,
        acaMarketplaceOptOutMemberIds: [SECONDARY],
      }),
      2023,
      true,
      true,
    );
    expect(before.map((m) => m.hasAcaCoverage)).toEqual([false, false]);
    expect(beforeOptOut.map((m) => m.hasAcaCoverage)).toEqual(
      before.map((m) => m.hasAcaCoverage),
    );
  });

  it('should_be_byte_identical_for_an_already_Medicare_member', () => {
    // Primary born 1955 → already past 65 in 2024 (on Medicare, no ACA anyway).
    const base = makeCtx({
      primaryBirthdate: '1955-03-01',
      secondaryBirthdate: '1965-03-01',
      primaryRetirementYear: 2024,
    });
    const optOut = makeCtx({
      primaryBirthdate: '1955-03-01',
      secondaryBirthdate: '1965-03-01',
      primaryRetirementYear: 2024,
      acaMarketplaceOptOutMemberIds: [PRIMARY],
    });
    const baseMembers = buildMemberInputs(base, 2024, true, true);
    const optOutMembers = buildMemberInputs(optOut, 2024, true, true);
    // Primary already on Medicare → hasAcaCoverage already false; opting out is
    // a no-op (still false) and the surviving member is unaffected.
    expect(baseMembers.find((m) => m.memberId === PRIMARY)?.hasAcaCoverage).toBe(false);
    expect(optOutMembers.map((m) => m.hasAcaCoverage)).toEqual(
      baseMembers.map((m) => m.hasAcaCoverage),
    );
  });
});

describe('ACA opt-out — forward compatibility', () => {
  it('should_resolve_a_pre_feature_scenario_to_all_on_marketplace_with_no_migration', () => {
    // A scenario whose overrides carry no opt-out field (factory default) leaves
    // every retired pre-65 member on the Marketplace — current behavior.
    const ctx = twoCoveredHousehold(); // no acaMarketplaceOptOutMemberIds
    const members = buildMemberInputs(ctx, 2024, true, true);
    expect(anyMemberHasAcaCoverage(members)).toBe(true);
    expect(members.every((m) => m.hasAcaCoverage)).toBe(true);
  });
});
