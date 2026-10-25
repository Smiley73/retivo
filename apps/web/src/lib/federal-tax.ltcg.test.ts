import { describe, expect, it } from 'vitest';
import { computeFederalTax } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

describe('LTCG stacking', () => {
  it('should_apply_0pct_ltcg_rate_when_stacked_income_below_threshold_single_2025', () => {
    // Single 2025: 0% LTCG threshold = $48,350 of total taxable income
    // ordinaryIncome=40000, std=15750, taxableOrdinary=24250
    // ltcg=10000, totalTaxable=34250 (<48350 → all at 0%)
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 40000, ltcgAndQdi: 10000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(0);
  });

  it('should_stack_ordinary_income_below_ltcg_when_ordinary_already_in_15pct_band', () => {
    // ordinaryIncome=80000, std=15750, taxableOrdinary=64250
    // ltcg=5000, totalTaxable=69250
    // Ordinary fills 64250 into bracket. LTCG 5000 sits at 64250–69250 (all above 48350 → 15%)
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 80000, ltcgAndQdi: 5000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(75000); // 5000 * 0.15 = 750 → 75000 cents
  });

  it('should_split_ltcg_across_0pct_and_15pct_bands', () => {
    // Single 2025: 0% LTCG threshold = $48,350
    // ordinaryIncome=20000, std=15750, taxableOrdinary=4250
    // ltcg=60000, totalTaxable=64250
    // LTCG from 4250 to 64250:
    //   4250–48350 = 44100 at 0% = 0
    //   48350–64250 = 15900 at 15% = 2385.00 → 238500 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 60000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(238500);
  });

  it('should_apply_20pct_rate_on_ltcg_above_533400_threshold_single_2025', () => {
    // Ordinary=600000, std=15750, taxableOrdinary=584250
    // ltcg=20000, totalTaxable=604250
    // LTCG from 584250 to 604250: all above 533400 threshold → 20%
    // 20000 * 0.20 = 4000 → 400000 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 600000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(400000);
  });

  it('should_compute_ltcg_correctly_for_mfj_2025', () => {
    // MFJ 2025: 0% threshold = $96,700
    // ordinaryIncome=100000, std=31500, taxableOrdinary=68500
    // ltcg=40000, totalTaxable=108500
    // LTCG from 68500 to 108500:
    //   68500–96700 = 28200 at 0% = 0
    //   96700–108500 = 11800 at 15% = 1770 → 177000 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 100000, ltcgAndQdi: 40000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(177000);
  });

  it('should_compute_ltcg_as_zero_when_no_ltcg', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 200000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ltcgTax).toBe(0);
    expect(result.marginalLtcgRate).toBe(0);
  });
});

describe('unused deduction against LTCG (Schedule D)', () => {
  it('should_apply_unused_deduction_against_ltcg_when_ordinary_below_deduction', () => {
    // Single 2025: deduction $15,750; ordinary $10,000 < deduction
    // taxableIncome = max(0, 10000 + 100000 - 15750) = 94250
    // taxableLtcg   = min(100000, 94250) = 94250
    // taxableOrdinary = 0  → ordinaryTax = 0
    // ltcgTax = ltcgTaxOnStack(94250) - ltcgTaxOnStack(0)
    //         = (48350 × 0%) + ((94250 - 48350) × 15%)
    //         = 45900 × 0.15 = 6885.00 → 688500 cents
    const result = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'Single',
        ordinaryIncome: 10000,
        ltcgAndQdi: 100000,
        taxpayersAge65Plus: 0,
      },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(0);
    expect(result.ltcgTax).toBe(688500);
  });
});

describe('marginal LTCG rate', () => {
  it.each([
    [2025, 'Single', 40000, 10000, 0],
    [2025, 'Single', 80000, 5000, 0.15],
    [2025, 'Single', 600000, 20000, 0.2],
    [2025, 'MFJ', 60000, 5000, 0],
    [2025, 'MFJ', 100000, 40000, 0.15],
    [2026, 'Single', 100000, 10000, 0.15],
    [2026, 'Single', 20000, 5000, 0],
  ] as const)('%i %s with ordinary %i and LTCG %i has marginal LTCG rate %f', (year, filingStatus, ordinaryIncome, ltcgAndQdi, rate) => {
    const result = computeFederalTax({ year, filingStatus, ordinaryIncome, ltcgAndQdi }, FEDERAL_TAX_CONFIG);
    expect(result.marginalLtcgRate).toBe(rate);
  });
});
