/**
 * Core tests for the federal income tax engine — ordinary brackets,
 * standard deduction, age-65 add-on, effective rate, rounding, 2026
 * OBBBA-permanent brackets.
 */

import { describe, expect, it } from 'vitest';
import {
  computeFederalTax,
  federalOrdinaryTaxCents,
  marginalOrdinaryRate,
  nextBracketCeiling,
  toCents,
  UnsupportedTaxYearError,
} from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

// ---------------------------------------------------------------------------
// toCents — half-up rounding contract lock
// ---------------------------------------------------------------------------

describe('toCents', () => {
  it('should_round_half_cent_up', () => {
    expect(toCents(0.005)).toBe(1);
  });

  it('should_truncate_below_half_cent', () => {
    expect(toCents(0.0049)).toBe(0);
  });

  it('should_return_zero_for_zero', () => {
    expect(toCents(0)).toBe(0);
  });

  it('should_round_exact_dollars_without_fractional_error', () => {
    expect(toCents(500)).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Zero income
// ---------------------------------------------------------------------------

describe('zero income', () => {
  it('should_return_zero_tax_for_zero_income', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.totalTax).toBe(0);
    expect(result.ordinaryTax).toBe(0);
    expect(result.ltcgTax).toBe(0);
    expect(result.niitTax).toBe(0);
    expect(result.effectiveRatePct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Standard deduction — income below deduction
// ---------------------------------------------------------------------------

describe('income below standard deduction', () => {
  it('should_owe_zero_tax_when_ordinary_income_below_standard_deduction_single_2025', () => {
    // Standard deduction Single 2025 = $15,750 (OBBBA-raised)
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 14000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(0);
    expect(result.totalTax).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ordinary brackets
// ---------------------------------------------------------------------------

describe('ordinary brackets', () => {
  it('should_compute_10pct_bracket_correctly_single_2025', () => {
    // Single 2025: std deduction $15,750 (OBBBA); 10% bracket $0–$11,925
    // Taxable ordinary = 20000 - 15750 = 4250; tax = 4250 * 0.10 = 425
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(42500); // 425.00 in cents
  });

  it('should_compute_22pct_bracket_crossing_correctly_single_2025', () => {
    // Single 2025: std = 15750, taxable = 50000 - 15750 = 34250
    // 10% on 0–11925 = 1192.50
    // 12% on 11925–34250 = 22325 × 0.12 = 2679.00
    // total = 3871.50 → 387150 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 50000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(387150);
  });

  it('should_compute_correctly_for_mfj_2025', () => {
    // MFJ 2025: std = 31500, taxable = 100000 - 31500 = 68500
    // 10% on 0–23850 = 2385.00
    // 12% on 23850–68500 = 44650 × 0.12 = 5358.00
    // total = 7743 → 774300 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 100000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(774300);
  });

  it('should_compute_correctly_for_hoh_2025', () => {
    // HoH 2025: std = 23625, taxable = 80000 - 23625 = 56375
    // 10% on 0–17000 = 1700.00
    // 12% on 17000–56375 = 39375 × 0.12 = 4725.00
    // total = 6425 → 642500 cents
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 80000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(642500);
  });
});

// ---------------------------------------------------------------------------
// Age-65 add-on
// ---------------------------------------------------------------------------

describe('age-65 standard deduction add-on', () => {
  it('should_apply_single_age65_addon_2025', () => {
    // Single 2025: base $15,750 + $2,000 add-on + $6,000 OBBBA senior bonus
    // (MAGI $20k ≪ $75k base → no phase-out) = $23,750 deduction.
    // Taxable = max(0, 20000 - 23750) = 0; ordinaryTax = 0.
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(0);
  });

  it('should_apply_mfj_two_spouses_age65_addon_2025', () => {
    // MFJ 2025: base $31,500 + 2 × $1,600 add-on + 2 × $6,000 OBBBA senior
    // bonus (MAGI $50k ≪ $150k base → no phase-out) = $46,700 deduction.
    // Taxable = max(0, 50000 - 46700) = 3300; tax = 3300 * 0.10 = 330 → 33000 cents.
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 50000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(33000);
  });

  it('should_cap_mfj_age65_at_2_persons', () => {
    // taxpayersAge65Plus: 3 on MFJ should use only 2
    const r2 = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 50000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    const r3 = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 50000, ltcgAndQdi: 0, taxpayersAge65Plus: 3 },
      FEDERAL_TAX_CONFIG,
    );
    expect(r2.ordinaryTax).toBe(r3.ordinaryTax);
  });

  it('should_cap_single_age65_at_1_person', () => {
    // Single 2025 add-on caps at 1 filer; the OBBBA senior bonus likewise
    // caps at 1 (max 1 for Single). Both the add-on ($2,000) and the senior
    // bonus ($6,000, MAGI $20k ≪ $75k → no phase-out) apply once.
    // Deduction = $15,750 + $2,000 + $6,000 = $23,750 ≥ $20,000 → taxable 0.
    const r1 = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 },
      FEDERAL_TAX_CONFIG,
    );
    const r5 = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0, taxpayersAge65Plus: 5 },
      FEDERAL_TAX_CONFIG,
    );
    // Both clamp the add-on AND the senior bonus to 1 filer → same tax (0).
    expect(r1.ordinaryTax).toBe(0);
    expect(r5.ordinaryTax).toBe(r1.ordinaryTax);
  });
});

// ---------------------------------------------------------------------------
// 2026 — OBBBA-permanent TCJA brackets (no sunset reversion)
// ---------------------------------------------------------------------------

describe('2026 OBBBA-permanent TCJA brackets', () => {
  it('should_keep_37pct_top_bracket_for_2026', () => {
    // OBBBA repealed the TCJA sunset — $800k ordinary Single 2026 lands in the
    // 37% marginal bracket, NOT the pre-TCJA 39.6% it would have reverted to.
    const result = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 800000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.marginalOrdinaryRate).toBe(0.37);
  });

  it('should_compute_slightly_lower_tax_in_2026_vs_2025_at_high_income_mfj', () => {
    // Same income, OBBBA-permanent schedule: 2026 brackets + standard deduction
    // are inflation-adjusted above 2025, so 2026 tax is slightly LOWER (bracket
    // creep relief), not higher as under the old sunset assumption.
    const r2025 = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 200000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    const r2026 = computeFederalTax(
      { year: 2026, filingStatus: 'MFJ', ordinaryIncome: 200000, ltcgAndQdi: 20000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(r2026.totalTax).toBeLessThan(r2025.totalTax);
  });

  it('should_use_TCJA_22pct_second_band_in_2026_single', () => {
    // 2026 Single: std $16,100; taxable $40,000 - reaches the 22% band only
    // above $50,400 of taxable income, so $40k taxable stays in the 12% band.
    const result = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 56100, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    // taxable = 56100 - 16100 = 40000 → marginal 12% (50400 floor not crossed)
    expect(result.marginalOrdinaryRate).toBe(0.12);
  });
});

// ---------------------------------------------------------------------------
// 2024 brackets
// ---------------------------------------------------------------------------

describe('2024 brackets', () => {
  it('should_compute_positive_tax_for_single_100k_ordinary_2024', () => {
    const result = computeFederalTax(
      { year: 2024, filingStatus: 'Single', ordinaryIncome: 100000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    // Taxable = 100000 - 14600 = 85400; 22% bracket Single 2024 starts at $47,150
    expect(result.ordinaryTax).toBeGreaterThan(0);
    expect(result.marginalOrdinaryRate).toBe(0.22);
  });
});

// ---------------------------------------------------------------------------
// Standalone helpers
// ---------------------------------------------------------------------------

describe('marginalOrdinaryRate helper', () => {
  it('should_return_10pct_for_income_in_first_bracket', () => {
    const rate = marginalOrdinaryRate(2025, 'Single', 5000, FEDERAL_TAX_CONFIG);
    expect(rate).toBe(0.10);
  });

  it('should_return_22pct_for_income_in_22pct_bracket_single_2025', () => {
    // Single 2025: 22% starts at $48,475 of taxable income
    const rate = marginalOrdinaryRate(2025, 'Single', 60000, FEDERAL_TAX_CONFIG);
    expect(rate).toBe(0.22);
  });

  it('should_return_0_when_taxable_income_is_zero', () => {
    // marginalOrdinaryRate on 0 income should be 0, not brackets[0].rate
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.marginalOrdinaryRate).toBe(0);
  });

  it('should_return_0_when_standalone_taxable_income_is_zero', () => {
    // Standalone helper should return 0, not first-bracket rate
    expect(marginalOrdinaryRate(2025, 'Single', 0, FEDERAL_TAX_CONFIG)).toBe(0);
  });

  it('should_return_0_when_standalone_taxable_income_is_negative', () => {
    // Negative taxableIncome should return 0
    expect(marginalOrdinaryRate(2025, 'Single', -1000, FEDERAL_TAX_CONFIG)).toBe(0);
  });
});

describe('nextBracketCeiling helper', () => {
  it('should_return_the_next_bracket_floor_in_cents_for_a_mid_bracket_income', () => {
    // MFJ 2025: 22% band 96,950–206,700. Income $150k post-deduction lands in the
    // 22% band → the next ceiling is the 24% floor at $206,700.
    expect(nextBracketCeiling(150_000_00, 2025, 'MFJ', FEDERAL_TAX_CONFIG)).toBe(206_700_00);
  });

  it('should_return_Infinity_for_a_top_bracket_income', () => {
    // MFJ 2025: 37% top bracket has no higher boundary.
    expect(nextBracketCeiling(900_000_00, 2025, 'MFJ', FEDERAL_TAX_CONFIG)).toBe(Infinity);
  });

  it('should_throw_UnsupportedTaxYearError_for_an_unknown_year', () => {
    expect(() => nextBracketCeiling(150_000_00, 2099, 'MFJ', FEDERAL_TAX_CONFIG)).toThrow(
      UnsupportedTaxYearError,
    );
  });
});

describe('federalOrdinaryTaxCents helper', () => {
  it('should_compute_bracket_tax_on_a_post_deduction_income', () => {
    // MFJ 2025 on $68,500 of post-deduction taxable ordinary income:
    // 10% on 0–23,850 = 2,385.00; 12% on 23,850–68,500 = 44,650 × 0.12 = 5,358.00
    // total = 7,743.00 → 774,300 cents (matches computeFederalTax ordinary brackets).
    expect(federalOrdinaryTaxCents(68_500_00, 2025, 'MFJ', FEDERAL_TAX_CONFIG)).toBe(774_300);
  });

  it('should_clamp_negative_income_to_zero_tax', () => {
    expect(federalOrdinaryTaxCents(-50_000_00, 2025, 'MFJ', FEDERAL_TAX_CONFIG)).toBe(0);
  });

  it('should_throw_UnsupportedTaxYearError_for_an_unknown_year', () => {
    expect(() => federalOrdinaryTaxCents(68_500_00, 2099, 'MFJ', FEDERAL_TAX_CONFIG)).toThrow(
      UnsupportedTaxYearError,
    );
  });
});

// ---------------------------------------------------------------------------
// Effective rate
// ---------------------------------------------------------------------------

describe('effective rate', () => {
  it('should_compute_effective_rate_as_total_tax_over_gross_income', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    const expected = (result.totalTax / 100 / 100000) * 100;
    expect(result.effectiveRatePct).toBeCloseTo(expected, 5);
  });
});

// ---------------------------------------------------------------------------
// Rounding — integer cents
// ---------------------------------------------------------------------------

describe('rounding', () => {
  it('should_return_integer_cent_values', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 73427, ltcgAndQdi: 5000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(Number.isInteger(result.ordinaryTax)).toBe(true);
    expect(Number.isInteger(result.ltcgTax)).toBe(true);
    expect(Number.isInteger(result.niitTax)).toBe(true);
    expect(Number.isInteger(result.totalTax)).toBe(true);
  });

  it('should_sum_components_to_totalTax', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 250000, ltcgAndQdi: 50000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.totalTax).toBe(result.ordinaryTax + result.ltcgTax + result.niitTax);
  });
});

// ---------------------------------------------------------------------------
// Age-65 add-on — MFJ one spouse
// ---------------------------------------------------------------------------

describe('age-65 standard deduction add-on — MFJ one spouse', () => {
  it('should_apply_mfj_one_spouse_age65_addon_2025', () => {
    // MFJ 2025: base $31,500 + 1 × $1,600 add-on + 1 × $6,000 OBBBA senior
    // bonus (one qualifying filer; MAGI $60k ≪ $150k base → no phase-out)
    // = $39,100 deduction. Taxable ordinary = 60000 - 39100 = 20900.
    // Tax: 10% on 0–20900 = 2090 → 209000 cents.
    const result = computeFederalTax(
      {
        year: 2025,
        filingStatus: 'MFJ',
        ordinaryIncome: 60000,
        ltcgAndQdi: 0,
        taxpayersAge65Plus: 1,
      },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.ordinaryTax).toBe(209000);
  });
});

// ---------------------------------------------------------------------------
// OBBBA senior bonus deduction (2025–2028), 6% MAGI phase-out
// ---------------------------------------------------------------------------

describe('OBBBA senior bonus deduction', () => {
  // Helper: ordinary tax (cents) for an MFJ household whose ordinary income is
  // entirely above the standard + age-65 + senior deductions, so the whole
  // deduction lands in the 10% bracket → Δtax = 0.10 × Δdeduction. We isolate
  // the senior-deduction effect by comparing taxpayersAge65Plus on the SAME
  // year (2025) at a MAGI where the standard deduction + add-on are identical.
  function mfjOrdinaryTax(ordinaryIncome: number, age65: number, magi?: number): number {
    return computeFederalTax(
      {
        year: 2025,
        filingStatus: 'MFJ',
        ordinaryIncome,
        ltcgAndQdi: 0,
        taxpayersAge65Plus: age65,
        ...(magi !== undefined ? { magiForSeniorDeduction: magi } : {}),
      },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
  }

  it('full_deduction_65plus_mfj_year_2025_subtracts_12000_from_taxable', () => {
    // 2 qualifying filers, MAGI $140k < $150k base → full $12,000 deduction.
    // Hold ordinary income at $300k (entirely inside the 24% MFJ bracket, which
    // spans $206,700–$394,600 in 2025) so the whole $12,000 deduction sits at a
    // single marginal rate. Compare against a fully-phased-out twin at the SAME
    // $300k ordinary income (forced off via a high MAGI) → Δtax = 0.24 × $12,000.
    const withSenior = mfjOrdinaryTax(300_000, 2, /* magi */ 140_000);
    const phasedOut = mfjOrdinaryTax(300_000, 2, /* magi */ 350_000);
    expect(withSenior).toBe(phasedOut - Math.round(0.24 * 12_000 * 100));
  });

  it('full_deduction_magi_returned_by_engine_is_unchanged_by_the_deduction', () => {
    // The senior deduction lowers taxable income, NOT MAGI. The federal engine's
    // own MAGI (ordinaryIncome + ltcgAndQdi) is unaffected: NIIT base is the same
    // whether or not the deduction applies.
    const withSenior = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 140_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    const noSenior = computeFederalTax(
      { year: 2024, filingStatus: 'MFJ', ordinaryIncome: 140_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    // NIIT is 0 below threshold in both → MAGI parity is observable via niitTax = 0.
    expect(withSenior.niitTax).toBe(0);
    expect(noSenior.niitTax).toBe(0);
    // The 2025 (senior-deduction) tax is strictly lower than the same nominal
    // 2024 case purely from the extra $12,000 deduction (brackets are close).
    expect(withSenior.ordinaryTax).toBeLessThan(noSenior.ordinaryTax);
  });

  it('phaseout_boundary_at_base_magi_150k_mfj_keeps_full_deduction', () => {
    // Phase-out starts STRICTLY above the base, so MAGI exactly $150,000 gets the
    // full $12,000 (2 filers). Equal to a MAGI just below the base.
    const atBase = mfjOrdinaryTax(200_000, 2, 150_000);
    const belowBase = mfjOrdinaryTax(200_000, 2, 149_000);
    expect(atBase).toBe(belowBase);
  });

  it('partial_phaseout_mfj_magi_200k_reduces_each_cap_by_3000', () => {
    // 0.06 × ($200,000 − $150,000) = $3,000 phase-out per cap → each $6,000 cap
    // becomes $3,000; 2 filers → $6,000 total deduction (down from $12,000).
    const partial = mfjOrdinaryTax(220_000, 2, 200_000);
    const full = mfjOrdinaryTax(220_000, 2, 150_000);
    // Extra taxable income from the $6,000 lost deduction at the 22% bracket.
    expect(partial).toBe(full + Math.round(0.22 * 6_000 * 100));
  });

  it('fully_phased_out_floors_deduction_at_zero_never_negative', () => {
    // 0.06 × (MAGI − base) ≥ $6,000 when MAGI − base ≥ $100,000 → MAGI ≥ $250,000.
    // Beyond that the deduction floors at $0; a higher MAGI does not over-subtract.
    const atFloor = mfjOrdinaryTax(400_000, 2, 250_000);
    const wayPast = mfjOrdinaryTax(400_000, 2, 500_000);
    expect(atFloor).toBe(wayPast);
    // And both equal the no-senior-deduction baseline at that income.
    const noSenior = mfjOrdinaryTax(400_000, 2, 9_999_999);
    expect(atFloor).toBe(noSenior);
  });

  it('hoh_uses_75000_base_single_uses_75000_base', () => {
    // HoH shares the Single $75,000 base (enacted non-joint threshold), NOT a
    // $112,500 base. Full deduction at MAGI = base $75,000; partial just above,
    // and full above the old (wrong) $112,500 value is now already phasing out.
    const hohFull = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 75_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    const hohBelowBase = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 74_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    // At and just below the $75,000 base the full $6,000 deduction applies.
    expect(hohFull).toBe(hohBelowBase);

    const hohPartial = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 95_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    // $95,000 − $75,000 = $20,000 over base → 0.06 × 20,000 = $1,200 phase-out.
    // Lost deduction $1,200 at HoH 22% bracket (≈$130k taxable) → higher tax.
    expect(hohPartial).toBeGreaterThan(hohFull);

    // A MAGI at the old wrong $112,500 base is now well into the phase-out, so
    // it must produce a strictly higher tax than the correct $75,000-base full
    // deduction — this is the regression guard against reverting to $112,500.
    const hohAtOldWrongBase = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 112_500 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    expect(hohAtOldWrongBase).toBeGreaterThan(hohFull);

    // Single: base $75,000. Full at $75,000, partial above.
    const singleFull = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 75_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    const singlePartial = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 95_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    expect(singlePartial).toBeGreaterThan(singleFull);

    // HoH and Single now share the same base: identical MAGI over base yields
    // the same phase-out amount, so the deduction lost is identical.
    expect(hohPartial - hohFull).toBe(singlePartial - singleFull);
  });

  it('year_gate_2024_and_2029_apply_zero_senior_deduction', () => {
    // 2024: config has no slot → $0 deduction. The ordinary tax equals the
    // standard + age-65-only deduction case.
    const r2024WithAge65 = computeFederalTax(
      { year: 2024, filingStatus: 'MFJ', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    // Synthesize a 2029 config by copying 2026 + an extrapolated future config
    // that should NOT carry the slot: drive the engine via the integration layer
    // is heavier; here assert the engine's own year-gate by passing a synthetic
    // snapshot keyed 2029 that DOES carry the slot, and confirm the gate zeroes it.
    const snapshot2029WithSlot = {
      ...FEDERAL_TAX_CONFIG,
      values: { 2029: FEDERAL_TAX_CONFIG.values[2025] },
    };
    const r2029 = computeFederalTax(
      { year: 2029, filingStatus: 'MFJ', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2, magiForSeniorDeduction: 100_000 },
      snapshot2029WithSlot,
    );
    // 2024 should not throw and yields a positive tax (sanity).
    expect(r2024WithAge65).toBeGreaterThan(0);
    // 2029 with the slot present but past the statutory window → gate zeroes the
    // deduction, so the tax matches the same config with the slot stripped.
    const snapshot2029NoSlot = {
      ...FEDERAL_TAX_CONFIG,
      values: { 2029: { ...FEDERAL_TAX_CONFIG.values[2025], seniorBonusDeduction: undefined } },
    };
    const r2029NoSlot = computeFederalTax(
      { year: 2029, filingStatus: 'MFJ', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2, magiForSeniorDeduction: 100_000 },
      snapshot2029NoSlot,
    );
    expect(r2029.ordinaryTax).toBe(r2029NoSlot.ordinaryTax);
  });

  it('never_negative_deduction_across_a_swept_magi_range', () => {
    // Across a wide MAGI sweep the ordinary tax is monotonically non-decreasing
    // in MAGI (the deduction shrinks then floors at 0 — never goes negative,
    // which would otherwise make tax DROP as MAGI rises past the floor).
    let prevTax = -1;
    for (let magi = 100_000; magi <= 400_000; magi += 10_000) {
      const tax = mfjOrdinaryTax(300_000, 2, magi);
      expect(tax).toBeGreaterThanOrEqual(prevTax);
      prevTax = tax;
    }
  });
});

// ---------------------------------------------------------------------------
// MFS / QSS age-65 add-on + senior bonus eligibility
// ---------------------------------------------------------------------------

describe('MFS / QSS age-65 add-on and senior bonus', () => {
  it('MFS uses the married-rate age-65 add-on and gets ZERO senior bonus', () => {
    // 2026 MFS: std ded $16,100 + married age-65 add-on $1,650 = $17,750;
    // taxable $12,250 (all in the 10% band, MFS 12% floor $12,400); senior bonus
    // = $0 (MFS ineligible). If the single-rate add-on ($2,050) or a $6,000
    // senior bonus were applied, the tax would be lower than this.
    const r = computeFederalTax(
      { year: 2026, filingStatus: 'MFS', ordinaryIncome: 30_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 },
      FEDERAL_TAX_CONFIG,
    );
    expect(r.totalTax).toBe(Math.round(0.1 * 12_250 * 100));
  });

  it('MFS senior bonus is $0 regardless of age/MAGI — only the $1,650 add-on differs', () => {
    const base = { year: 2026 as const, filingStatus: 'MFS' as const, ordinaryIncome: 40_000, ltcgAndQdi: 0 };
    const with65 = computeFederalTax({ ...base, taxpayersAge65Plus: 1 }, FEDERAL_TAX_CONFIG);
    const without = computeFederalTax({ ...base, taxpayersAge65Plus: 0 }, FEDERAL_TAX_CONFIG);
    // The affected deduction range [$22,250, $23,900] is entirely in the MFS 12%
    // bracket, so the ONLY gap is the $1,650 age-65 add-on × 12%. A wrongly
    // applied $6,000 senior bonus would make the gap far larger.
    expect(without.totalTax - with65.totalTax).toBe(Math.round(1_650 * 0.12 * 100));
  });

  it('QSS gets the married-rate age-65 add-on AND the senior bonus at the $75k base (c)', () => {
    // Below both phase-out bases → QSS is identical to MFJ with one age-65 filer
    // (QSS uses the MFJ tables + one married-rate add-on + full $6,000 bonus).
    const base = { year: 2026 as const, ordinaryIncome: 60_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 };
    const qss = computeFederalTax({ ...base, filingStatus: 'QSS' }, FEDERAL_TAX_CONFIG);
    const mfj = computeFederalTax({ ...base, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    expect(qss).toEqual(mfj);
  });

  it('QSS senior bonus phases out at the $75k base, unlike MFJ at $150k (c)', () => {
    // MAGI $100k: QSS ($75k base) phases the bonus by 6%×$25k=$1,500 → $4,500;
    // MFJ ($150k base) keeps the full $6,000. QSS taxable higher → more tax.
    const base = {
      year: 2026 as const,
      ordinaryIncome: 130_000,
      ltcgAndQdi: 0,
      taxpayersAge65Plus: 1,
      magiForSeniorDeduction: 100_000,
    };
    const qss = computeFederalTax({ ...base, filingStatus: 'QSS' }, FEDERAL_TAX_CONFIG);
    const mfj = computeFederalTax({ ...base, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    expect(qss.totalTax).toBeGreaterThan(mfj.totalTax);
  });
});
