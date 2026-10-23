import { describe, expect, it } from 'vitest';
import { resolveFederalTaxSnapshotForYear } from './federal-tax-extrapolation';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

const BASE_2026 = FEDERAL_TAX_CONFIG.values[2026];

// 2027 is one year past the 2026 base, so the scaling factor is 1 + ratePct / 100.
function scaled2027(ratePct: number) {
  return {
    factor: 1 + ratePct / 100,
    config: resolveFederalTaxSnapshotForYear(FEDERAL_TAX_CONFIG, 2027, ratePct).snapshot.values[2027],
  };
}

describe('resolveFederalTaxSnapshotForYear — IRC §1(f)(7) round-DOWN rounding', () => {
  // §1(f)(7): joint returns, surviving spouses and heads of household round to $50; Single/MFS to $25.
  const ORDINARY_STEP = { Single: 25, MFS: 25, HoH: 50, MFJ: 50, QSS: 50 } as const;

  it('at_factor_1_consistent_statuses_reproduce_published_floors_and_HoH_rounds_to_50', () => {
    // Published HoH 32% floor $201,775 is not a $50 multiple, so the identity factor lowers it to $201,750.
    const { config } = scaled2027(0);
    for (const status of ['Single', 'MFS', 'MFJ', 'QSS'] as const) {
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        expect(config.brackets[status][i].floor).toBe(BASE_2026.brackets[status][i].floor);
      }
    }
    for (let i = 0; i < BASE_2026.brackets.HoH.length; i += 1) {
      const published = BASE_2026.brackets.HoH[i].floor;
      expect(config.brackets.HoH[i].floor).toBe(Math.floor(published / 50) * 50);
    }
    expect(BASE_2026.brackets.HoH[4].floor).toBe(201775);
    expect(config.brackets.HoH[4].floor).toBe(201750);
  });

  it('rounds_each_ordinary_bracket_floor_DOWN_status_aware_25_or_50', () => {
    const { factor, config } = scaled2027(9.35);
    for (const status of ['Single', 'MFS', 'MFJ', 'HoH', 'QSS'] as const) {
      const step = ORDINARY_STEP[status];
      let sawDivergenceFromStep25 = false;
      for (let i = 0; i < BASE_2026.brackets[status].length; i += 1) {
        const raw = BASE_2026.brackets[status][i].floor * factor;
        expect(config.brackets[status][i].floor).toBe(Math.floor(raw / step) * step);
        expect(config.brackets[status][i].floor).toBeLessThanOrEqual(raw);
        if (Math.floor(raw / step) * step !== Math.floor(raw / 25) * 25) sawDivergenceFromStep25 = true;
      }
      // The $50 statuses must land on a floor that floor-to-$25 would have missed.
      expect(sawDivergenceFromStep25).toBe(step === 50);
    }
  });

  it('rounds_LTCG_bracket_floors_DOWN_to_50_not_25', () => {
    // IRC §1(j)(5)(C): capital-gain thresholds round down to $50, unlike the ordinary $25 step.
    const { factor, config } = scaled2027(7.31);
    for (const status of ['Single', 'MFJ', 'HoH', 'MFS', 'QSS'] as const) {
      for (let i = 0; i < BASE_2026.ltcgBrackets[status].length; i += 1) {
        const raw = BASE_2026.ltcgBrackets[status][i].floor * factor;
        expect(config.ltcgBrackets[status][i].floor).toBe(Math.floor(raw / 50) * 50);
      }
    }
  });

  it('LTCG_floor_uses_floor_to_50_not_round_to_50_nor_floor_to_25', () => {
    // 2026 Single 15% floor $49,450 × 1.011 = $49,993.95: floor-to-$50 $49,950, nearest-$50 $50,000, floor-to-$25 $49,975.
    const { config } = scaled2027(1.1);
    expect(config.ltcgBrackets.Single[1].floor).toBe(49_950);
  });

  it('first_ordinary_floor_stays_zero', () => {
    const { config } = scaled2027(25);
    expect(config.brackets.Single[0].floor).toBe(0);
    expect(config.ltcgBrackets.Single[0].floor).toBe(0);
  });

  it('rounds_standard_deduction_to_nearest_50', () => {
    const { factor, config } = scaled2027(4.17);
    for (const status of ['Single', 'MFJ', 'HoH'] as const) {
      const raw = BASE_2026.standardDeduction[status] * factor;
      expect(config.standardDeduction[status]).toBe(Math.round(raw / 50) * 50);
    }
  });

  it('rounds_age65_addon_to_nearest_50', () => {
    const { factor, config } = scaled2027(8.33);
    expect(config.age65AddOn.mfj).toBe(Math.round((BASE_2026.age65AddOn.mfj * factor) / 50) * 50);
    expect(config.age65AddOn.singleOrHoH).toBe(
      Math.round((BASE_2026.age65AddOn.singleOrHoH * factor) / 50) * 50,
    );
  });

  it('keeps_NIIT_thresholds_frozen', () => {
    expect(scaled2027(50).config.niitThresholds).toEqual(BASE_2026.niitThresholds);
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
    const result = resolveFederalTaxSnapshotForYear(FEDERAL_TAX_CONFIG, 2028, 0);
    expect(result.lookupYear).toBe(2028);
    expect(result.taxYearExtrapolated).toBe(true);
    const cfg = result.snapshot.values[2028];
    expect(cfg).toBeDefined();
    expect(cfg.seniorBonusDeduction).toEqual(BASE_2026.seniorBonusDeduction);
  });
});
