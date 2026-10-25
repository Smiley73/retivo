import { describe, expect, it } from 'vitest';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

const TAX_YEARS = [2024, 2025, 2026] as const;
const FILING_STATUSES = ['Single', 'MFJ', 'HoH'] as const;

describe('FEDERAL_TAX_CONFIG snapshot schema', () => {
  it('should_have_values_for_all_required_years', () => {
    for (const year of TAX_YEARS) {
      expect(FEDERAL_TAX_CONFIG.values[year]).toBeDefined();
    }
  });

  it('should_have_required_metadata_fields', () => {
    expect(FEDERAL_TAX_CONFIG.metadata.source).toBeTruthy();
    expect(FEDERAL_TAX_CONFIG.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FEDERAL_TAX_CONFIG.metadata.jurisdiction).toBe('US-federal');
  });

  for (const year of TAX_YEARS) {
    describe(`year ${year}`, () => {
      it('should_have_all_filing_status_bracket_arrays', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          expect(config.brackets[status].length).toBeGreaterThan(0);
        }
      });

      it('should_have_brackets_starting_at_floor_zero', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          expect(config.brackets[status][0].floor).toBe(0);
        }
      });

      it('should_have_brackets_sorted_ascending_by_floor', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          const floors = config.brackets[status].map((b) => b.floor);
          for (let i = 1; i < floors.length; i++) {
            expect(floors[i]).toBeGreaterThan(floors[i - 1]);
          }
        }
      });

      it('should_have_brackets_with_ascending_rates', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          const rates = config.brackets[status].map((b) => b.rate);
          for (let i = 1; i < rates.length; i++) {
            expect(rates[i]).toBeGreaterThan(rates[i - 1]);
          }
        }
      });

      it('should_have_standard_deduction_for_all_filing_statuses', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          expect(config.standardDeduction[status]).toBeGreaterThan(0);
        }
      });

      it('should_have_mfj_standard_deduction_2x_single', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        expect(config.standardDeduction.MFJ).toBe(config.standardDeduction.Single * 2);
      });

      it('should_have_niit_thresholds_unchanged_across_years', () => {
        // NIIT thresholds are not CPI-indexed — frozen since 2013
        const config = FEDERAL_TAX_CONFIG.values[year];
        expect(config.niitThresholds.Single).toBe(200000);
        expect(config.niitThresholds.MFJ).toBe(250000);
        expect(config.niitThresholds.HoH).toBe(200000);
      });

      it('should_have_ltcg_brackets_starting_at_zero_pct', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          expect(config.ltcgBrackets[status][0].rate).toBe(0);
          expect(config.ltcgBrackets[status][0].floor).toBe(0);
        }
      });

      it('should_have_ltcg_brackets_with_three_bands', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        for (const status of FILING_STATUSES) {
          expect(config.ltcgBrackets[status].length).toBe(3);
          const rates = config.ltcgBrackets[status].map((b) => b.rate);
          expect(rates).toEqual([0, 0.15, 0.20]);
        }
      });

      it('should_have_positive_age65_addons', () => {
        const config = FEDERAL_TAX_CONFIG.values[year];
        expect(config.age65AddOn.singleOrHoH).toBeGreaterThan(0);
        expect(config.age65AddOn.mfj).toBeGreaterThan(0);
      });
    });
  }

  it('should_have_higher_standard_deduction_in_2025_vs_2024', () => {
    for (const status of FILING_STATUSES) {
      expect(FEDERAL_TAX_CONFIG.values[2025].standardDeduction[status]).toBeGreaterThan(
        FEDERAL_TAX_CONFIG.values[2024].standardDeduction[status],
      );
    }
  });

  it('should_pin_2026_HoH_32pct_and_35pct_bracket_floors', () => {
    // Rev. Proc. 2025-32: HoH 32% floor equals Single's $201,775, but HoH 35% starts at $256,200 (Single: $256,225).
    const hoh2026 = FEDERAL_TAX_CONFIG.values[2026].brackets.HoH;
    const floor32 = hoh2026.find((b) => b.rate === 0.32)!.floor;
    const floor35 = hoh2026.find((b) => b.rate === 0.35)!.floor;
    expect(floor32).toBe(201775);
    expect(floor35).toBe(256200);
  });

  it('should_have_2026_standard_deduction_above_2025_OBBBA_amounts', () => {
    // Rev. Proc. 2025-32 inflation-adjusts the OBBBA-raised 2025 amounts upward.
    for (const status of FILING_STATUSES) {
      expect(FEDERAL_TAX_CONFIG.values[2026].standardDeduction[status]).toBeGreaterThan(
        FEDERAL_TAX_CONFIG.values[2025].standardDeduction[status],
      );
    }
  });

  it('should_pin_OBBBA_senior_bonus_deduction_phaseout_bases', () => {
    // OBBBA §70103: 6% phase-out above $75,000 Single/HoH and $150,000 MFJ (not CPI-indexed); HoH is not $112,500.
    for (const year of [2025, 2026] as const) {
      const slot = FEDERAL_TAX_CONFIG.values[year].seniorBonusDeduction;
      expect(slot).toBeDefined();
      expect(slot!.perFilerCap).toBe(6_000);
      expect(slot!.phaseoutRatePct).toBe(0.06);
      expect(slot!.phaseoutBaseMagi.Single).toBe(75_000);
      expect(slot!.phaseoutBaseMagi.HoH).toBe(75_000);
      expect(slot!.phaseoutBaseMagi.MFJ).toBe(150_000);
    }
    // The 2024 config has no slot (deduction begins in 2025 per statute).
    expect(FEDERAL_TAX_CONFIG.values[2024].seniorBonusDeduction).toBeUndefined();
  });
});
