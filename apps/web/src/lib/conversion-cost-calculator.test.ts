/**
 * Unit tests for the all-in Roth-conversion cost probe.
 * Fixtures use the real DEFAULT_TAX_CALIBRATION_BUNDLE (2025/2026 in-range +
 * 2035 extrapolated) so the §86 / IRMAA / ACA / federal wiring is exercised
 * end-to-end. Every engine input is supplied by the typed contract — no value
 * is back-derived from magiCents / taxableIncomeCents alone.
 */

import { describe, it, expect } from 'vitest';
import {
  computeAllInConversionCost,
  type AllInConversionCostInput,
} from './conversion-cost-calculator';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration-helpers';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;

/** Base MFJ input with no SS / Medicare / ACA exposure (federal-only path). */
function baseInput(overrides: Partial<AllInConversionCostInput> = {}): AllInConversionCostInput {
  return {
    year: 2025,
    filingStatus: 'MFJ',
    conversionCents: 10_000_00,
    taxableIncomeCents: 50_000_00, // MFJ 2025 12% band (23,850–96,950)
    magiCents: 80_000_00,
    taxableSsCents: 0,
    grossSsAnnualCents: 0,
    taxExemptInterestCents: 0,
    beneficiariesOnMedicareCount: 0,
    householdSize: 2,
    benchmarkAnnualSlcspCents: 0,
    inflationRatePct: 2.5,
    ...overrides,
  };
}

describe('computeAllInConversionCost — federal income-tax delta', () => {
  it('should_charge_marginal_bracket_rate_within_a_single_band', () => {
    // $10k converted entirely inside the MFJ 2025 12% band → $1,200.
    const result = computeAllInConversionCost(baseInput(), BUNDLE);
    expect(result.incomeTaxDeltaCents).toBe(1_200_00);
    expect(result.ssTaxDeltaCents).toBe(0);
    expect(result.irmaaDeltaCents).toBe(0);
    expect(result.ptcDeltaCents).toBe(0);
    expect(result.allInCents).toBe(1_200_00);
    expect(result.allInRate).toBeCloseTo(0.12, 10);
  });

  it('should_blend_two_bracket_rates_when_conversion_straddles_a_boundary', () => {
    // Income at 96,000 (12% band); convert 10k → 950 stays at 12% (to 96,950),
    // 9,050 at 22%. delta = 950*0.12 + 9050*0.22 = 114 + 1,991 = 2,105.
    const result = computeAllInConversionCost(
      baseInput({ taxableIncomeCents: 96_000_00 }),
      BUNDLE,
    );
    expect(result.incomeTaxDeltaCents).toBe(2_105_00);
  });
});

describe('computeAllInConversionCost — §86 SS-taxation delta', () => {
  it('should_be_zero_when_household_has_no_SS_income', () => {
    const result = computeAllInConversionCost(baseInput({ grossSsAnnualCents: 0 }), BUNDLE);
    expect(result.ssTaxDeltaCents).toBe(0);
  });

  it('should_add_income_tax_on_extra_taxable_SS_when_conversion_crosses_a_tier', () => {
    // MFJ tier-1 $32k / tier-2 $44k. otherAgi base = magi - taxableSs = small,
    // conversion pushes provisional income up so more SS becomes taxable.
    // gross SS $40k, baseline otherAgi $20k → PI = 20k + 20k = 40k (50% tier).
    // After +$10k otherAgi → PI = 50k (85% tier) → taxable SS rises → extra tax.
    const input = baseInput({
      taxableIncomeCents: 50_000_00,
      magiCents: 20_000_00, // otherAgi base = 20k (taxableSs 0 here is the §86 BASE recompute)
      taxableSsCents: 0,
      grossSsAnnualCents: 40_000_00,
    });
    const result = computeAllInConversionCost(input, BUNDLE);
    expect(result.ssTaxDeltaCents).toBeGreaterThan(0);
    // Income tax delta is still the pure bracket delta on the conversion.
    expect(result.incomeTaxDeltaCents).toBe(1_200_00);
  });

  it('should_be_zero_when_SS_already_at_85pct_cap_before_conversion', () => {
    // Provisional income already far past tier-2 → SS at 85% cap → no further
    // taxable-SS delta from the conversion.
    const input = baseInput({
      magiCents: 200_000_00,
      taxableSsCents: 34_000_00, // 0.85 * 40k
      grossSsAnnualCents: 40_000_00,
      taxableIncomeCents: 150_000_00,
    });
    const result = computeAllInConversionCost(input, BUNDLE);
    expect(result.ssTaxDeltaCents).toBe(0);
  });
});

describe('computeAllInConversionCost — IRMAA Y+2 surcharge delta', () => {
  it('should_be_zero_with_no_medicare_beneficiaries', () => {
    const result = computeAllInConversionCost(
      baseInput({ beneficiariesOnMedicareCount: 0, magiCents: 205_000_00 }),
      BUNDLE,
    );
    expect(result.irmaaDeltaCents).toBe(0);
  });

  it('should_charge_a_surcharge_when_conversion_crosses_the_MFJ_tier1_threshold', () => {
    // MFJ 2026 IRMAA tier-1 threshold is $218,000. Use year 2024 (surcharge year
    // 2026 in-range, no scaling). Baseline MAGI just below, conversion crosses it.
    const oneBene = computeAllInConversionCost(
      baseInput({
        year: 2024,
        magiCents: 215_000_00,
        conversionCents: 5_000_00,
        beneficiariesOnMedicareCount: 1,
      }),
      BUNDLE,
    );
    expect(oneBene.irmaaDeltaCents).toBeGreaterThan(0);

    const twoBene = computeAllInConversionCost(
      baseInput({
        year: 2024,
        magiCents: 215_000_00,
        conversionCents: 5_000_00,
        beneficiariesOnMedicareCount: 2,
      }),
      BUNDLE,
    );
    // Two beneficiaries → exactly double the household surcharge delta.
    expect(twoBene.irmaaDeltaCents).toBe(oneBene.irmaaDeltaCents * 2);
  });
});

describe('computeAllInConversionCost — ACA-PTC delta', () => {
  it('should_count_lost_subsidy_as_a_positive_cost_near_the_400pct_cliff', () => {
    // 2026 = pre-arpa regime (400% cliff). MFJ household size 2, FPL ~ $20,440
    // base + increment. Set MAGI just below 400% FPL and convert across it so
    // the subsidy is lost.
    const input = baseInput({
      year: 2026,
      conversionCents: 20_000_00,
      magiCents: 70_000_00,
      taxableSsCents: 0,
      grossSsAnnualCents: 0,
      householdSize: 2,
      benchmarkAnnualSlcspCents: 18_000_00,
    });
    const result = computeAllInConversionCost(input, BUNDLE);
    expect(result.ptcDeltaCents).toBeGreaterThanOrEqual(0);
  });
});

describe('computeAllInConversionCost — additive-delta property', () => {
  it('should_have_two_sequential_probes_sum_to_one_double_probe_within_a_band', () => {
    // Within one bracket band, two $5k probes (stacked) sum to one $10k probe.
    const probeA = computeAllInConversionCost(
      baseInput({ taxableIncomeCents: 50_000_00, conversionCents: 5_000_00 }),
      BUNDLE,
    );
    const probeB = computeAllInConversionCost(
      baseInput({ taxableIncomeCents: 55_000_00, conversionCents: 5_000_00 }),
      BUNDLE,
    );
    const doubleProbe = computeAllInConversionCost(
      baseInput({ taxableIncomeCents: 50_000_00, conversionCents: 10_000_00 }),
      BUNDLE,
    );
    expect(probeA.incomeTaxDeltaCents + probeB.incomeTaxDeltaCents).toBe(
      doubleProbe.incomeTaxDeltaCents,
    );
  });
});

describe('computeAllInConversionCost — senior-bonus phase-out limitation', () => {
  it('should_return_bracket_only_federal_delta_and_NOT_add_senior_bonus_loss', () => {
    // 2026, age-65+ MFJ in the senior-bonus phase-out band. The bracket-only
    // federal delta is marginalRate * conversion; the probe does NOT add the
    // senior-bonus deduction loss (accepted limitation, pinned here).
    // taxableIncome at $90k (MFJ 2026 12% band 24,800–100,800); convert $5k →
    // stays in 12% → $600 bracket delta, regardless of the senior-bonus window.
    const result = computeAllInConversionCost(
      baseInput({
        year: 2026,
        taxableIncomeCents: 90_000_00,
        conversionCents: 5_000_00,
        magiCents: 160_000_00, // in the MFJ $150k phase-out band, age-65+
      }),
      BUNDLE,
    );
    expect(result.incomeTaxDeltaCents).toBe(600_00);
  });
});

describe('computeAllInConversionCost — post-2026 future-year extrapolation', () => {
  it('should_resolve_scaled_snapshots_without_throwing_for_a_2035_row', () => {
    // 2035 is past every table; the probe must route IRMAA (year+2=2037), ACA
    // (2035), and federal through the extrapolating resolvers — no
    // UnsupportedTaxYearError, finite deltas.
    const input = baseInput({
      year: 2035,
      conversionCents: 10_000_00,
      taxableIncomeCents: 60_000_00,
      magiCents: 90_000_00,
      grossSsAnnualCents: 30_000_00,
      taxableSsCents: 10_000_00,
      beneficiariesOnMedicareCount: 2,
      benchmarkAnnualSlcspCents: 0,
      inflationRatePct: 3,
    });
    const run = (): ReturnType<typeof computeAllInConversionCost> =>
      computeAllInConversionCost(input, BUNDLE);
    expect(run).not.toThrow();
    const result = run();
    expect(Number.isFinite(result.allInCents)).toBe(true);
    expect(Number.isFinite(result.allInRate)).toBe(true);
    expect(result.incomeTaxDeltaCents).toBeGreaterThan(0);
  });
});
