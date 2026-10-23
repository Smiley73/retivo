import { describe, expect, it } from 'vitest';
import {
  computeFederalTax,
  federalOrdinaryTaxCents,
  marginalOrdinaryRate,
  nextBracketCeiling,
} from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';

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
    // The add-on and the $6,000 senior bonus each clamp to one filer: deduction $23,750 ≥ $20,000.
    const r1 = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 },
      FEDERAL_TAX_CONFIG,
    );
    const r5 = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 20000, ltcgAndQdi: 0, taxpayersAge65Plus: 5 },
      FEDERAL_TAX_CONFIG,
    );
    expect(r1.ordinaryTax).toBe(0);
    expect(r5.ordinaryTax).toBe(r1.ordinaryTax);
  });
});

describe('2026 OBBBA-permanent TCJA brackets', () => {
  it('should_keep_37pct_top_bracket_for_2026', () => {
    // OBBBA repealed the TCJA sunset: 37%, not the 39.6% it would have reverted to.
    const result = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 800000, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.marginalOrdinaryRate).toBe(0.37);
  });

  it('should_compute_slightly_lower_tax_in_2026_vs_2025_at_high_income_mfj', () => {
    // 2026 brackets and standard deduction are inflation-adjusted above 2025, so the same income owes slightly less.
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
    // 2026 Single: std $16,100; the 22% band starts above $50,400 taxable, so $40,000 stays in 12%.
    const result = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 56100, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.marginalOrdinaryRate).toBe(0.12);
  });
});

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
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 0, ltcgAndQdi: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.marginalOrdinaryRate).toBe(0);
  });

  it('should_return_0_when_standalone_taxable_income_is_zero', () => {
    expect(marginalOrdinaryRate(2025, 'Single', 0, FEDERAL_TAX_CONFIG)).toBe(0);
  });

  it('should_return_0_when_standalone_taxable_income_is_negative', () => {
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
    expect(nextBracketCeiling(900_000_00, 2025, 'MFJ', FEDERAL_TAX_CONFIG)).toBe(Infinity);
  });

  it('should_throw_UnsupportedTaxYearError_for_an_unknown_year', () => {
    expect(() => nextBracketCeiling(150_000_00, 2099, 'MFJ', FEDERAL_TAX_CONFIG)).toThrow(
      expect.objectContaining({ name: 'UnsupportedTaxYearError' }),
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
      expect.objectContaining({ name: 'UnsupportedTaxYearError' }),
    );
  });
});

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

  it('should_round_a_half_cent_of_tax_up_and_a_fraction_below_it_down', () => {
    // Taxable $12.25 and $12.24 in the 10% bracket: tax of $1.225 and $1.224.
    const taxCents = (ordinaryIncome: number) =>
      computeFederalTax(
        { year: 2025, filingStatus: 'Single', ordinaryIncome, ltcgAndQdi: 0 },
        FEDERAL_TAX_CONFIG,
      ).ordinaryTax;
    expect(taxCents(15762.25)).toBe(123);
    expect(taxCents(15762.24)).toBe(122);
  });

  it('should_sum_components_to_totalTax', () => {
    const result = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 250000, ltcgAndQdi: 50000 },
      FEDERAL_TAX_CONFIG,
    );
    expect(result.totalTax).toBe(result.ordinaryTax + result.ltcgTax + result.niitTax);
  });
});

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

describe('OBBBA senior bonus deduction', () => {
  // Ordinary tax in cents for an MFJ household whose income sits above all deductions, so Δtax = rate × Δdeduction.
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
    // 2 qualifying filers, MAGI $140k < $150k base: full $12,000. At $300k the 24% MFJ bracket holds all of it, so Δtax = 0.24 × $12,000 against a phased-out twin.
    const withSenior = mfjOrdinaryTax(300_000, 2, /* magi */ 140_000);
    const phasedOut = mfjOrdinaryTax(300_000, 2, /* magi */ 350_000);
    expect(withSenior).toBe(phasedOut - Math.round(0.24 * 12_000 * 100));
  });

  it('full_deduction_magi_returned_by_engine_is_unchanged_by_the_deduction', () => {
    // The senior deduction lowers taxable income, not MAGI, so NIIT is unchanged.
    const withSenior = computeFederalTax(
      { year: 2025, filingStatus: 'MFJ', ordinaryIncome: 140_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    const noSenior = computeFederalTax(
      { year: 2024, filingStatus: 'MFJ', ordinaryIncome: 140_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    );
    expect(withSenior.niitTax).toBe(0);
    expect(noSenior.niitTax).toBe(0);
    expect(withSenior.ordinaryTax).toBeLessThan(noSenior.ordinaryTax);
  });

  it('phaseout_boundary_at_base_magi_150k_mfj_keeps_full_deduction', () => {
    // The phase-out starts strictly above the base, so MAGI exactly $150,000 keeps the full $12,000.
    const atBase = mfjOrdinaryTax(200_000, 2, 150_000);
    const belowBase = mfjOrdinaryTax(200_000, 2, 149_000);
    expect(atBase).toBe(belowBase);
  });

  it('partial_phaseout_mfj_magi_200k_reduces_each_cap_by_3000', () => {
    // 0.06 × ($200,000 − $150,000) = $3,000 phase-out per cap → each $6,000 cap
    // becomes $3,000; 2 filers → $6,000 total deduction (down from $12,000).
    const partial = mfjOrdinaryTax(220_000, 2, 200_000);
    const full = mfjOrdinaryTax(220_000, 2, 150_000);
    expect(partial).toBe(full + Math.round(0.22 * 6_000 * 100));
  });

  it('fully_phased_out_floors_deduction_at_zero_never_negative', () => {
    // 0.06 × (MAGI − base) ≥ $6,000 when MAGI − base ≥ $100,000 → MAGI ≥ $250,000.
    // Beyond that the deduction floors at $0; a higher MAGI does not over-subtract.
    const atFloor = mfjOrdinaryTax(400_000, 2, 250_000);
    const wayPast = mfjOrdinaryTax(400_000, 2, 500_000);
    expect(atFloor).toBe(wayPast);
    const noSenior = mfjOrdinaryTax(400_000, 2, 9_999_999);
    expect(atFloor).toBe(noSenior);
  });

  it('hoh_uses_75000_base_single_uses_75000_base', () => {
    // HoH shares the Single $75,000 base, not a $112,500 one.
    const hohFull = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 75_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    const hohBelowBase = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 74_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    expect(hohFull).toBe(hohBelowBase);

    const hohPartial = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 95_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    // $95,000 − $75,000 over base → 0.06 × 20,000 = $1,200 phase-out.
    expect(hohPartial).toBeGreaterThan(hohFull);

    // Regression guard: a MAGI at the old wrong $112,500 base is well into the phase-out.
    const hohAtOldWrongBase = computeFederalTax(
      { year: 2025, filingStatus: 'HoH', ordinaryIncome: 130_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 112_500 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    expect(hohAtOldWrongBase).toBeGreaterThan(hohFull);

    const singleFull = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 75_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    const singlePartial = computeFederalTax(
      { year: 2025, filingStatus: 'Single', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1, magiForSeniorDeduction: 95_000 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    expect(singlePartial).toBeGreaterThan(singleFull);

    // Identical MAGI over the shared base loses the same deduction.
    expect(hohPartial - hohFull).toBe(singlePartial - singleFull);
  });

  it('year_gate_2024_and_2029_apply_zero_senior_deduction', () => {
    const r2024WithAge65 = computeFederalTax(
      { year: 2024, filingStatus: 'MFJ', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2 },
      FEDERAL_TAX_CONFIG,
    ).ordinaryTax;
    const snapshot2029WithSlot = {
      ...FEDERAL_TAX_CONFIG,
      values: { 2029: FEDERAL_TAX_CONFIG.values[2025] },
    };
    const r2029 = computeFederalTax(
      { year: 2029, filingStatus: 'MFJ', ordinaryIncome: 100_000, ltcgAndQdi: 0, taxpayersAge65Plus: 2, magiForSeniorDeduction: 100_000 },
      snapshot2029WithSlot,
    );
    expect(r2024WithAge65).toBeGreaterThan(0);
    // Past the statutory window the gate zeroes the slot, so tax matches the slot-stripped config.
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
    // Tax is non-decreasing in MAGI: the deduction floors at 0 rather than going negative.
    let prevTax = -1;
    for (let magi = 100_000; magi <= 400_000; magi += 10_000) {
      const tax = mfjOrdinaryTax(300_000, 2, magi);
      expect(tax).toBeGreaterThanOrEqual(prevTax);
      prevTax = tax;
    }
  });
});

describe('MFS / QSS age-65 add-on and senior bonus', () => {
  it('MFS uses the married-rate age-65 add-on and gets ZERO senior bonus', () => {
    // 2026 MFS: std $16,100 + married add-on $1,650 = $17,750, taxable $12,250 (10% band); senior bonus $0 (MFS ineligible).
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
    // The affected range [$22,250, $23,900] sits in the MFS 12% bracket; a wrongly applied $6,000 bonus would widen the gap.
    expect(without.totalTax - with65.totalTax).toBe(Math.round(1_650 * 0.12 * 100));
  });

  it('QSS gets the married-rate age-65 add-on AND the senior bonus at the $75k base (c)', () => {
    // Below both bases QSS equals MFJ with one age-65 filer.
    const base = { year: 2026 as const, ordinaryIncome: 60_000, ltcgAndQdi: 0, taxpayersAge65Plus: 1 };
    const qss = computeFederalTax({ ...base, filingStatus: 'QSS' }, FEDERAL_TAX_CONFIG);
    const mfj = computeFederalTax({ ...base, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    expect(qss).toEqual(mfj);
  });

  it('QSS senior bonus phases out at the $75k base, unlike MFJ at $150k (c)', () => {
    // MAGI $100k: QSS ($75k base) phases the bonus down by $1,500; MFJ ($150k base) keeps the full $6,000.
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
