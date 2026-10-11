/**
 * NIIT (Net Investment Income Tax, IRC §1411) tests for the federal tax engine.
 * NIIT = 3.8% × min(NII, max(0, MAGI − threshold)).
 * Thresholds: Single/HoH $200k, MFJ $250k — NOT CPI-indexed.
 */

import { describe, expect, it } from 'vitest';
import { computeFederalTax } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

// ---------------------------------------------------------------------------
// No NIIT below threshold
// ---------------------------------------------------------------------------

describe('no NIIT below threshold', () => {
  it('should_owe_no_niit_when_magi_below_single_threshold', () => {
    // Single threshold = $200k; MAGI = 100k + 10k = 110k < 200k → no NIIT
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100000, ltcgAndQdi: 10000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(0);
  });

  it('should_owe_no_niit_when_magi_below_mfj_threshold', () => {
    // MFJ threshold = $250k; MAGI = 200k + 10k = 210k < 250k → no NIIT
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 200000, ltcgAndQdi: 10000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(0);
  });

  it('should_owe_no_niit_when_no_net_investment_income', () => {
    // High income but all ordinary (wages) — not NII → no NIIT
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 500000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NIIT on MAGI excess
// ---------------------------------------------------------------------------

describe('NIIT on MAGI excess', () => {
  it('should_compute_niit_on_lesser_of_nii_and_magi_excess_single', () => {
    // MAGI = 210000 + 20000 = 230000; excess over threshold = 230000 - 200000 = 30000
    // NII defaults to ltcgAndQdi = 20000 < 30000 → NIIT on 20000
    // 20000 * 0.038 = 760 → 76000 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 210000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(76000);
  });

  it('should_cap_niit_base_at_magi_excess_when_nii_exceeds_excess', () => {
    // MAGI = 200500; excess = 500; NII = 50000 >> 500 → NIIT on 500 only
    // 500 * 0.038 = 19 → 1900 cents
    const result = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'Single',
        ordinaryIncome: 150500,
        ltcgAndQdi: 50000,
        netInvestmentIncome: 50000,
      },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(1900);
  });

  it('should_compute_niit_on_mfj_excess_above_250k', () => {
    // MFJ MAGI = 200000 + 60000 = 260000; excess = 10000; NII = 60000 > 10000 → on 10000
    // 10000 * 0.038 = 380 → 38000 cents
    const result = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'MFJ',
        ordinaryIncome: 200000,
        ltcgAndQdi: 60000,
        netInvestmentIncome: 60000,
      },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(38000);
  });
});

// ---------------------------------------------------------------------------
// NII vs ltcgAndQdi default
// ---------------------------------------------------------------------------

describe('netInvestmentIncome defaults to ltcgAndQdi', () => {
  it('should_use_ltcgAndQdi_as_nii_when_not_specified', () => {
    // NII defaults to ltcgAndQdi=20000 — same as providing it explicitly
    const withDefault = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 210000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    const withExplicit = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'Single',
        ordinaryIncome: 210000,
        ltcgAndQdi: 20000,
        netInvestmentIncome: 20000,
      },
      FEDERAL_TAX_CONFIG,
    );
    expect(withDefault.niitTax).toBe(withExplicit.niitTax);
  });

  it('should_compute_higher_niit_when_explicit_nii_larger_than_ltcg', () => {
    // Rental income included in NII but NOT in ltcgAndQdi
    // explicit NII = 40000 (ltcg + rental); defaults = ltcg = 20000
    // default NIIT on 20000 < explicit on 30000 (excess)
    const withDefault = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 210000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    const withExplicit = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'Single',
        ordinaryIncome: 210000,
        ltcgAndQdi: 20000,
        netInvestmentIncome: 40000,
      },
      FEDERAL_TAX_CONFIG,
    );
    // Both cases: excess over threshold = 30000; NII limits:
    //   default: min(20000,30000) = 20000 → 76000 cents
    //   explicit: min(40000,30000) = 30000 → 114000 cents
    expect(withExplicit.niitTax).toBeGreaterThan(withDefault.niitTax);
    expect(withDefault.niitTax).toBe(76000);
    expect(withExplicit.niitTax).toBe(114000);
  });
});

// ---------------------------------------------------------------------------
// NIIT thresholds not CPI-indexed — same across 2024/2025/2026
// ---------------------------------------------------------------------------

describe('NIIT thresholds frozen across years', () => {
  it('should_use_200k_single_threshold_in_2024', () => {
    const result = computeFederalTax(
      { year: 2024, filingStatus: 'Single', ordinaryIncome: 201000, ltcgAndQdi: 5000 },
      FEDERAL_TAX_CONFIG,
    );
    // MAGI = 206000; excess = 6000; NII = 5000 < 6000 → 5000 * 0.038 = 190 → 19000 cents
    expect(result.niitTax).toBe(19000);
  });

  it('should_use_200k_single_threshold_in_2026', () => {
    const result = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 201000, ltcgAndQdi: 5000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.niitTax).toBe(19000);
  });
});

// ---------------------------------------------------------------------------
// NIIT included in totalTax
// ---------------------------------------------------------------------------

describe('NIIT contributes to totalTax', () => {
  it('should_add_niit_to_total_tax', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 210000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.totalTax).toBe(result.ordinaryTax + result.ltcgTax + result.niitTax);
    expect(result.niitTax).toBeGreaterThan(0);
  });
});
