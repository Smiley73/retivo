/**
 * Tests for the federal tax-config inflation extrapolation — statutory
 * IRC §1(f)(7) round-DOWN rounding and the OBBBA senior-bonus year-gated
 * carry.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScaledFederalTaxConfig,
  resolveFederalTaxSnapshotForYear,
} from './federal-tax-extrapolation';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

const BASE_2026 = FEDERAL_TAX_CONFIG.values[2026];

describe('buildScaledFederalTaxConfig — IRC §1(f)(7) round-DOWN rounding', () => {
  // §1(f)(7): ordinary floors round DOWN — Single/MFS to $25, MFJ/HoH/QSS to
  // $50. §1(f)(7) groups joint returns, surviving spouses, and heads of household
  // together at the $50 step; Single/MFS fall to the residual $25 step.
  const ORDINARY_STEP = { Single: 25, MFS: 25, HoH: 50, MFJ: 50, QSS: 50 } as const;

  it('at_factor_1_consistent_statuses_reproduce_published_floors_and_HoH_rounds_to_50', () => {
    // Zero-inflation identity: factor EXACTLY 1 reproduces the published
    // (non-extrapolated) floors byte-for-byte for the statuses whose published
    // floors already sit on their statutory rounding step — Single/MFS ($25) and
    // MFJ/QSS ($50). HoH rounds to $50 with MFJ/QSS per §1(f)(7), but its real
    // published 2026 32% floor $201,775 is NOT a $50-multiple, so at factor 1 the
    // $50 step lowers it to $201,750. The published IRS table predates and is
    // independent of the extrapolation rounding convention, so a real-data
    // divergence at the identity factor is expected here, not a bug.
    const scaled = buildScaledFederalTaxConfig(BASE_2026, 1);
    for (const status of ['Single', 'MFS', 'MFJ', 'QSS'] as const) {
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        expect(scaled.brackets[status][i].floor).toBe(BASE_2026.brackets[status][i].floor);
      }
    }
    // HoH: every floor equals its $50-floored value; the 32% floor is the one
    // published value that is not a $50-multiple, so it lands $25 below published.
    for (let i = 0; i < BASE_2026.brackets.HoH.length; i += 1) {
      const published = BASE_2026.brackets.HoH[i].floor;
      expect(scaled.brackets.HoH[i].floor).toBe(Math.floor(published / 50) * 50);
    }
    expect(BASE_2026.brackets.HoH[4].floor).toBe(201775);
    expect(scaled.brackets.HoH[4].floor).toBe(201750);
  });

  it('rounds_each_ordinary_bracket_floor_DOWN_status_aware_25_or_50', () => {
    // Force a fractional scaled floor and confirm round-DOWN to the status-correct
    // $25 (Single/MFS) or $50 (MFJ/HoH/QSS) granularity, never round-to-nearest.
    const factor = 1.0935;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    for (const status of ['Single', 'MFS', 'MFJ', 'HoH', 'QSS'] as const) {
      const step = ORDINARY_STEP[status];
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        const raw = BASE_2026.brackets[status][i].floor * factor;
        const expected = Math.floor(raw / step) * step;
        expect(scaled.brackets[status][i].floor).toBe(expected);
        // Always a multiple of the status step and never above the raw value.
        expect(scaled.brackets[status][i].floor % step).toBe(0);
        expect(scaled.brackets[status][i].floor).toBeLessThanOrEqual(raw);
      }
    }
  });

  it('MFJ_HoH_QSS_ordinary_floors_diverge_from_the_old_uniform_25', () => {
    // Prove the $50 statuses genuinely differ from the old uniform-$25 behavior:
    // pick a factor that lands ≥ 1 MFJ/HoH/QSS floor in the [x+25, x+50) band
    // where floor-to-$50 (x) ≠ floor-to-$25 (x+25). A regression to uniform-$25
    // fails this — the two conventions disagree and the config uses the $50 one.
    // HoH is here: §1(f)(7) groups it with MFJ/QSS at $50 (joint returns,
    // surviving spouses, heads of household).
    const factor = 1.0935;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    for (const status of ['MFJ', 'HoH', 'QSS'] as const) {
      let sawDivergence = false;
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        const raw = BASE_2026.brackets[status][i].floor * factor;
        const floor50 = Math.floor(raw / 50) * 50;
        const floor25 = Math.floor(raw / 25) * 25;
        expect(scaled.brackets[status][i].floor).toBe(floor50);
        if (floor50 !== floor25) sawDivergence = true;
      }
      expect(sawDivergence).toBe(true);
    }
  });

  it('Single_MFS_ordinary_floors_stay_25_granularity', () => {
    // These tables keep the $25 granularity — a regression that $50-rounded them
    // would fail here. §1(f)(7) reserves the $50 step for joint returns, surviving
    // spouses, and heads of household, leaving Single/MFS (MFS = MFJ ÷ 2) on $25:
    // verify every floor is a $25 multiple.
    const factor = 1.0417;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    for (const status of ['Single', 'MFS'] as const) {
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        const raw = BASE_2026.brackets[status][i].floor * factor;
        expect(scaled.brackets[status][i].floor).toBe(Math.floor(raw / 25) * 25);
        expect(scaled.brackets[status][i].floor % 25).toBe(0);
      }
    }
  });

  it('rounds_LTCG_bracket_floors_DOWN_to_50_not_25', () => {
    // IRC §1(j)(5)(C): capital-gain thresholds use the $50 granularity, NOT the
    // ordinary-bracket $25, and round DOWN (floor), NOT to nearest. Every scaled
    // LTCG floor across every status is a floor-to-$50 multiple.
    const factor = 1.0731;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    for (const status of ['Single', 'MFJ', 'HoH', 'MFS', 'QSS'] as const) {
      for (let i = 0; i < BASE_2026.ltcgBrackets[status].length; i += 1) {
        const raw = BASE_2026.ltcgBrackets[status][i].floor * factor;
        expect(scaled.ltcgBrackets[status][i].floor).toBe(Math.floor(raw / 50) * 50);
        expect(scaled.ltcgBrackets[status][i].floor % 50).toBe(0);
        expect(scaled.ltcgBrackets[status][i].floor).toBeLessThanOrEqual(raw);
      }
    }
  });

  it('LTCG_floor_uses_floor_to_50_not_round_to_50_nor_floor_to_25', () => {
    // A case where floor-to-$50, round-to-nearest-$50, and floor-to-$25 all
    // diverge, proving the LTCG floors are floor-to-$50. 2026 Single 15% floor
    // $49,450 × 1.011 = $49,993.95 → floor-to-$50 = $49,950; round-to-$50 =
    // $50,000; floor-to-$25 = $49,975. All three differ; the config uses the
    // statutory floor-to-$50 result.
    const factor = 1.011;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    const raw = BASE_2026.ltcgBrackets.Single[1].floor * factor; // 49_993.95
    const floor50 = Math.floor(raw / 50) * 50; // 49_950
    const nearest50 = Math.round(raw / 50) * 50; // 50_000
    const floor25 = Math.floor(raw / 25) * 25; // 49_975
    expect(floor50).not.toBe(nearest50);
    expect(floor50).not.toBe(floor25);
    expect(scaled.ltcgBrackets.Single[1].floor).toBe(floor50);
  });

  it('first_ordinary_floor_stays_zero', () => {
    const scaled = buildScaledFederalTaxConfig(BASE_2026, 1.25);
    expect(scaled.brackets.Single[0].floor).toBe(0);
    expect(scaled.ltcgBrackets.Single[0].floor).toBe(0);
  });

  it('rounds_standard_deduction_to_nearest_50', () => {
    const factor = 1.0417; // forces a non-round scaled deduction
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    for (const status of ['Single', 'MFJ', 'HoH'] as const) {
      const raw = BASE_2026.standardDeduction[status] * factor;
      expect(scaled.standardDeduction[status]).toBe(Math.round(raw / 50) * 50);
      expect(scaled.standardDeduction[status] % 50).toBe(0);
    }
  });

  it('rounds_age65_addon_to_nearest_50', () => {
    const factor = 1.0833;
    const scaled = buildScaledFederalTaxConfig(BASE_2026, factor);
    expect(scaled.age65AddOn.mfj).toBe(Math.round((BASE_2026.age65AddOn.mfj * factor) / 50) * 50);
    expect(scaled.age65AddOn.singleOrHoH).toBe(
      Math.round((BASE_2026.age65AddOn.singleOrHoH * factor) / 50) * 50,
    );
  });

  it('keeps_NIIT_thresholds_frozen', () => {
    const scaled = buildScaledFederalTaxConfig(BASE_2026, 1.5);
    expect(scaled.niitThresholds).toEqual(BASE_2026.niitThresholds);
  });
});

describe('buildScaledFederalTaxConfig — OBBBA senior-bonus year gate', () => {
  it('carries_the_senior_bonus_slot_forward_within_the_2025_2028_window', () => {
    // 2027/2028 are extrapolated from the 2026 base, which carries the slot.
    const scaled2028 = buildScaledFederalTaxConfig(BASE_2026, 1.04, 2028);
    expect(scaled2028.seniorBonusDeduction).toEqual(BASE_2026.seniorBonusDeduction);
  });

  it('drops_the_senior_bonus_slot_past_2028', () => {
    const scaled2029 = buildScaledFederalTaxConfig(BASE_2026, 1.06, 2029);
    expect(scaled2029.seniorBonusDeduction).toBeUndefined();
  });

  it('preserves_the_slot_when_no_target_year_is_given', () => {
    const scaled = buildScaledFederalTaxConfig(BASE_2026, 1.04);
    expect(scaled.seniorBonusDeduction).toEqual(BASE_2026.seniorBonusDeduction);
  });
});

describe('resolveFederalTaxSnapshotForYear — zero-inflation post-2028 senior bonus (regression)', () => {
  it('returns lookupYear=2029 and no seniorBonusDeduction when inflationRatePct=0 and taxYear=2029', () => {
    const result = resolveFederalTaxSnapshotForYear(FEDERAL_TAX_CONFIG, 2029, 0);
    expect(result.lookupYear).toBe(2029);
    expect(result.taxYearExtrapolated).toBe(true);
    const cfg = result.snapshot.values[2029];
    expect(cfg).toBeDefined();
    expect(cfg.seniorBonusDeduction).toBeUndefined();
  });

  it('returns lookupYear=2028 and carries seniorBonusDeduction when inflationRatePct=0 and taxYear=2028', () => {
    // 2028 is within SENIOR_BONUS_DEDUCTION_LAST_YEAR — should still carry the slot
    // (2028 IS the last published year if config had 2028; currently max published is 2026
    // so 2028 is also extrapolated)
    const result = resolveFederalTaxSnapshotForYear(FEDERAL_TAX_CONFIG, 2028, 0);
    expect(result.lookupYear).toBe(2028);
    expect(result.taxYearExtrapolated).toBe(true);
    const cfg = result.snapshot.values[2028];
    expect(cfg).toBeDefined();
    expect(cfg.seniorBonusDeduction).toBeDefined();
  });
});
