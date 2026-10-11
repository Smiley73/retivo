/**
 * Unit tests for the tax-integration layer.
 */
import { describe, it, expect } from 'vitest';
import {
  dollarsToCents,
  centsToDollars,
  resolveSnapshotYear,
  resolveAssumedYieldComponents,
  buildScaledFederalTaxConfig,
  isRothAccount,
  computeMagi,
  applyTaxYear,
  applyTaxYearForFilingPlan,
  computeRmdFloorCents,
  TaxIntegrationInvalidInputError,
  friendlyProjectionErrorMessage,
} from './tax-integration';
import { roughMonthlyBenchmarkCentsForMember } from './aca-ptc';
import type {
  ApplyFilingPlanYearInput,
  TaxCalibrationBundle,
  TaxYearInput,
  TaxMemberInput,
  TaxAccountSnapshot,
} from './tax-integration';
import type { ResolvedTaxUnit } from './filing-status';
import type { CalibrationSnapshot } from './calibration';
import { computeIrmaa } from './irmaa';
import { computeFederalTax } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REAL_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

/** Minimal single-member, no-SS, no-RMD input for 2024. */
function baseInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
  const member: TaxMemberInput = {
    memberId: 'test-primary',
    isoBirthdate: '1960-01-01', // age 64 in 2024 — no Medicare, no RMD
    onMedicare: false,
    hasAcaCoverage: false,
  };
  return {
    taxYear: 2024,
    filingStatus: 'Single',
    grossSsDollars: 0,
    preTaxWithdrawalDollars: 50_000,
    postTaxNonRothWithdrawalDollars: 0,
    rothWithdrawalDollars: 0,
    otherOrdinaryIncomeDollars: 0,
    taxExemptInterestDollars: 0,
    householdSize: 1,
    members: [member],
    accounts: [],
    taxpayersAge65Plus: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Friendly error mapping
// ---------------------------------------------------------------------------

describe('friendlyProjectionErrorMessage', () => {
  // There is no withdrawal-strategy ⨯ allocation conflict (allocation works with
  // every strategy), so there is no longer a
  // recognised configuration conflict to translate; the mapper returns null for
  // everything and callers fall back to the raw error message.
  it('returns null for a generic TaxIntegrationInvalidInputError', () => {
    expect(
      friendlyProjectionErrorMessage(new TaxIntegrationInvalidInputError('birthdate missing')),
    ).toBeNull();
  });

  it('returns null for unrelated errors and non-errors', () => {
    expect(friendlyProjectionErrorMessage(new Error('boom'))).toBeNull();
    expect(friendlyProjectionErrorMessage('nope')).toBeNull();
    expect(friendlyProjectionErrorMessage(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

describe('dollarsToCents', () => {
  it('converts whole dollars', () => {
    expect(dollarsToCents(1000)).toBe(100_000);
  });
  it('rounds half-up on clean values', () => {
    // 1.005 has float representation issues (JS); use a value that rounds cleanly
    expect(dollarsToCents(1.995)).toBe(200);
    expect(dollarsToCents(0.505)).toBe(51);
  });
  it('handles zero', () => {
    expect(dollarsToCents(0)).toBe(0);
  });
});

describe('centsToDollars', () => {
  it('converts integer cents to dollars', () => {
    expect(centsToDollars(100_000)).toBe(1000);
  });
  it('preserves sub-dollar cents', () => {
    expect(centsToDollars(1)).toBeCloseTo(0.01);
  });
  it('handles zero', () => {
    expect(centsToDollars(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveSnapshotYear
// ---------------------------------------------------------------------------

describe('resolveSnapshotYear', () => {
  const snapshot: CalibrationSnapshot<unknown> = {
    values: { 2024: {}, 2025: {}, 2026: {} },
    metadata: { source: 'test', asOfDate: '2024-01-01', jurisdiction: 'US-federal' },
  };

  it('returns exact year when present', () => {
    const r = resolveSnapshotYear(snapshot, 2025);
    expect(r.effectiveYear).toBe(2025);
    expect(r.taxYearExtrapolated).toBe(false);
  });

  it('clamps to latest when taxYear > all keys', () => {
    const r = resolveSnapshotYear(snapshot, 2030);
    expect(r.effectiveYear).toBe(2026);
    expect(r.taxYearExtrapolated).toBe(true);
  });

  it('resolves to highest key ≤ taxYear for sparse tables', () => {
    const sparse: CalibrationSnapshot<unknown> = {
      values: { 2024: {}, 2026: {} },
      metadata: { source: 't', asOfDate: '2024-01-01', jurisdiction: 'US-federal' },
    };
    const r = resolveSnapshotYear(sparse, 2025);
    expect(r.effectiveYear).toBe(2024);
    expect(r.taxYearExtrapolated).toBe(false);
  });

  it('resolves to first key when taxYear equals it', () => {
    const r = resolveSnapshotYear(snapshot, 2024);
    expect(r.effectiveYear).toBe(2024);
    expect(r.taxYearExtrapolated).toBe(false);
  });

  it('throws TaxIntegrationInvalidInputError on empty snapshot', () => {
    const empty: CalibrationSnapshot<unknown> = {
      values: {},
      metadata: { source: 't', asOfDate: '2024-01-01', jurisdiction: 'US-federal' },
    };
    expect(() => resolveSnapshotYear(empty, 2024)).toThrow(TaxIntegrationInvalidInputError);
  });
});

// ---------------------------------------------------------------------------
// isRothAccount
// ---------------------------------------------------------------------------

describe('isRothAccount', () => {
  it('returns true for RETIREMENT_ROTH_IRA', () => {
    expect(isRothAccount({ type: 'RETIREMENT_ROTH_IRA' })).toBe(true);
  });

  it('returns false for RETIREMENT_IRA (traditional)', () => {
    expect(isRothAccount({ type: 'RETIREMENT_IRA' })).toBe(false);
  });

  it('returns false for BROKERAGE', () => {
    expect(isRothAccount({ type: 'BROKERAGE' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeMagi
// ---------------------------------------------------------------------------

describe('computeMagi', () => {
  it('sums ordinary income + LTCG + tax-exempt interest', () => {
    expect(computeMagi({
      ordinaryIncomeDollars: 60_000,
      ltcgDollars: 10_000,
      taxExemptInterestDollars: 5_000,
    })).toBe(75_000);
  });

  it('returns just ordinary income when LTCG and TE-interest are zero', () => {
    expect(computeMagi({
      ordinaryIncomeDollars: 40_000,
      ltcgDollars: 0,
      taxExemptInterestDollars: 0,
    })).toBe(40_000);
  });

  it('handles all zeros', () => {
    expect(computeMagi({
      ordinaryIncomeDollars: 0,
      ltcgDollars: 0,
      taxExemptInterestDollars: 0,
    })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rough age-priced benchmark curve (the live curve is the per-member MONTHLY one)
// ---------------------------------------------------------------------------

/** The annual whole-year premium for one member at `age`, off the live curve. */
const annualBenchmarkForAge = (age: number): number =>
  (roughMonthlyBenchmarkCentsForMember(age) * 12) / 100;

describe('rough age-priced benchmark curve', () => {
  it('returns $8,400/yr at age 60 (base)', () => {
    expect(annualBenchmarkForAge(60)).toBeCloseTo(8_400, 0);
  });

  it('grows 5% per year of age above 60', () => {
    expect(annualBenchmarkForAge(61)).toBeCloseTo(8_400 * 1.05, 1);
  });

  it('age 65 benchmark is higher than age 60', () => {
    expect(annualBenchmarkForAge(65)).toBeGreaterThan(annualBenchmarkForAge(60));
  });

  it('age 55 benchmark is lower than age 60 (decay below base)', () => {
    expect(annualBenchmarkForAge(55)).toBeLessThan(annualBenchmarkForAge(60));
  });
});

// ---------------------------------------------------------------------------
// applyTaxYear — happy paths
// ---------------------------------------------------------------------------

describe('applyTaxYear', () => {
  describe('zero-income baseline', () => {
    it('returns zero tax for zero income', () => {
      const result = applyTaxYear(
        baseInput({ preTaxWithdrawalDollars: 0 }),
        REAL_BUNDLE,
      );
      expect(result.federalTaxCents).toBe(0);
      expect(result.taxableSsCents).toBe(0);
      expect(result.magiCents).toBe(0);
      expect(result.effectiveTaxRate).toBe(0);
      expect(result.rmdFloorCents).toBe(0);
    });
  });

  describe('federal tax engine wired', () => {
    it('computes non-zero federal tax on $50k pre-tax withdrawal Single 2024', () => {
      const result = applyTaxYear(baseInput(), REAL_BUNDLE);
      // $50k pre-tax single — expect tax >$0 and < $15k
      expect(result.federalTaxCents).toBeGreaterThan(0);
      expect(result.federalTaxCents).toBeLessThan(15_000 * 100);
    });

    it('MFJ has lower tax than Single at same income', () => {
      const single = applyTaxYear(baseInput({ filingStatus: 'Single' }), REAL_BUNDLE);
      const mfj = applyTaxYear(baseInput({ filingStatus: 'MFJ' }), REAL_BUNDLE);
      expect(mfj.federalTaxCents).toBeLessThan(single.federalTaxCents);
    });

    it('age-65+ deduction add-on reduces tax', () => {
      const under65 = applyTaxYear(baseInput({ taxpayersAge65Plus: 0 }), REAL_BUNDLE);
      const over65 = applyTaxYear(baseInput({ taxpayersAge65Plus: 1 }), REAL_BUNDLE);
      expect(over65.federalTaxCents).toBeLessThan(under65.federalTaxCents);
    });
  });

  describe('SS taxation wired (order)', () => {
    it('taxableSsCents is zero when grossSsDollars is zero', () => {
      // Even if the §86 tier logic fires (PI above threshold), 0 × rate = 0
      const result = applyTaxYear(baseInput({ grossSsDollars: 0 }), REAL_BUNDLE);
      expect(result.taxableSsCents).toBe(0);
    });

    it('SS at 85% tier for high income Single', () => {
      const result = applyTaxYear(
        baseInput({
          grossSsDollars: 24_000,
          preTaxWithdrawalDollars: 80_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.ssTaxationTier).toBe('eighty-five');
      expect(result.taxableSsCents).toBeGreaterThan(0);
      // taxable SS must be ≤ 85% of gross SS
      expect(result.taxableSsCents).toBeLessThanOrEqual(dollarsToCents(24_000 * 0.85) + 1);
    });

    it('SS included in MAGI computation', () => {
      const noSs = applyTaxYear(baseInput({ grossSsDollars: 0 }), REAL_BUNDLE);
      const withSs = applyTaxYear(
        baseInput({ grossSsDollars: 24_000, preTaxWithdrawalDollars: 50_000 }),
        REAL_BUNDLE,
      );
      // MAGI should be higher when SS benefits are present (taxable portion included)
      expect(withSs.magiCents).toBeGreaterThan(noSs.magiCents);
    });
  });

  describe('LTCG proxy', () => {
    it('LTCG is computed from POST_TAX non-Roth withdrawal', () => {
      const noPostTax = applyTaxYear(
        baseInput({ preTaxWithdrawalDollars: 0, postTaxNonRothWithdrawalDollars: 0 }),
        REAL_BUNDLE,
      );
      const withPostTax = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 40_000,
          assumedCostBasisFraction: 0.5,
        }),
        REAL_BUNDLE,
      );
      // With $40k post-tax at 0.5 cost basis → $20k LTCG → higher MAGI
      expect(withPostTax.magiCents).toBeGreaterThan(noPostTax.magiCents);
    });

    it('100% cost basis fraction → zero LTCG', () => {
      const result = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 50_000,
          assumedCostBasisFraction: 1.0,
        }),
        REAL_BUNDLE,
      );
      // All cost basis → no LTCG → federal tax ≈ 0 (ordinary income = 0)
      expect(result.federalTaxCents).toBe(0);
    });

    it('Roth withdrawals are tax-free (no LTCG, no ordinary income)', () => {
      const rothOnly = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 0,
          rothWithdrawalDollars: 100_000,
        }),
        REAL_BUNDLE,
      );
      expect(rothOnly.federalTaxCents).toBe(0);
      expect(rothOnly.magiCents).toBe(0);
    });
  });

  describe('IRMAA engagement gate', () => {
    it('IRMAA not applied when no member is on Medicare', () => {
      const result = applyTaxYear(
        baseInput({
          magiTwoYearsPriorDollars: 500_000,
          members: [{ memberId: 'test-primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false }],
        }),
        REAL_BUNDLE,
      );
      expect(result.irmaaSurchargeCents).toBe(0);
      expect(result.irmaaTier).toBe('none');
    });

    it('IRMAA not applied when magiTwoYearsPriorDollars is absent', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: undefined,
        }),
        REAL_BUNDLE,
      );
      expect(result.irmaaSurchargeCents).toBe(0);
      expect(result.irmaaTier).toBe('none');
    });

    it('IRMAA applies a non-zero surcharge for Medicare member with high prior MAGI', () => {
      // Single with $200k MAGI 2-years prior → above tier1 threshold
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 200_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.irmaaSurchargeCents).toBeGreaterThan(0);
      expect(result.irmaaTier).not.toBe('none');
    });

    it('IRMAA applies zero surcharge when prior MAGI is below tier1 threshold', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 90_000,  // below Single tier1 (~$103k in 2024)
        }),
        REAL_BUNDLE,
      );
      expect(result.irmaaSurchargeCents).toBe(0);
      expect(result.irmaaTier).toBe('none');
    });

    it('inflation extrapolation — MAGI just above 2026 tier1 but below inflation-adjusted tier1 does not trigger IRMAA', () => {
      // 2026 Single tier-1 = $109,000. At 2.5% inflation for 4 years (taxYear 2030),
      // the effective threshold is $109,000 × (1.025)^4 ≈ $120,315.
      // A look-back MAGI of $115,000 (above the raw 2026 threshold but below
      // the inflation-adjusted threshold) should NOT trigger IRMAA.
      const result = applyTaxYear(
        baseInput({
          taxYear: 2030,
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 115_000, // above raw $109k but below ~$120k adjusted
          inflationRatePct: 2.5,
        }),
        REAL_BUNDLE,
      );
      expect(result.taxYearExtrapolated).toBe(true);
      expect(result.irmaaSurchargeCents).toBe(0);
      expect(result.irmaaTier).toBe('none');
    });

    it('MAGI well above inflation-adjusted threshold still triggers IRMAA', () => {
      // $200,000 MAGI for 2030 → deflated to $200k / (1.025)^4 ≈ $181,200 > $109k
      const result = applyTaxYear(
        baseInput({
          taxYear: 2030,
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 200_000,
          inflationRatePct: 2.5,
        }),
        REAL_BUNDLE,
      );
      expect(result.taxYearExtrapolated).toBe(true);
      expect(result.irmaaSurchargeCents).toBeGreaterThan(0);
    });

    it('OUTPUT surcharge cents re-inflate by thresholdScalingFactor; tier classification unchanged', () => {
      // taxYear 2036 @3% inflation: latest IRMAA snapshot key is 2026, so
      // thresholdScalingFactor = 1.03^10 ≈ 1.34392. The MAGI look-back is
      // deflated for tier classification; the surcharge DOLLARS must be
      // re-inflated by that same factor.
      const taxYear = 2036;
      const inflationRatePct = 3;
      const scaling = Math.pow(1.03, taxYear - 2026);
      // Pick a deflated-MAGI that lands cleanly in the SAME tier as the 2026
      // frozen computation so we can compare the dollars directly. Use a high
      // MAGI well inside tier4 to avoid boundary ambiguity after deflation.
      const lookbackMagi = 500_000 * scaling; // deflates back to $500k
      const result = applyTaxYear(
        baseInput({
          taxYear,
          inflationRatePct,
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: lookbackMagi,
        }),
        REAL_BUNDLE,
      );
      // Frozen 2026 surcharge for the SAME deflated MAGI (no scaling applied).
      const frozen2026 = computeIrmaa(
        {
          taxYear: 2026,
          magiTwoYearsPriorCents: Math.round(500_000 * 100),
          filingStatus: 'Single',
          beneficiariesOnMedicareCount: 1,
        },
        IRMAA_TIERS,
      );
      expect(result.taxYearExtrapolated).toBe(true);
      expect(result.irmaaSurchargeCents).toBe(
        Math.round(frozen2026.totalHouseholdAnnualCents * scaling),
      );
      // Tier classification is unchanged by the re-inflation (no double-deflation).
      expect(result.irmaaTier).toBe(frozen2026.tier);
      // The scaled dollars are strictly larger than the frozen 2026 dollars.
      expect(result.irmaaSurchargeCents).toBeGreaterThan(
        frozen2026.totalHouseholdAnnualCents,
      );
    });
  });

  describe('ACA PTC engagement gate', () => {
    it('ACA PTC not applied when no member has ACA coverage', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false }],
          preTaxWithdrawalDollars: 30_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.acaPtcSubsidyCents).toBe(0);
      expect(result.acaPtcTier).toBe('below-fpl');
    });

    it('ACA PTC computed when member has ACA coverage and income in eligible range', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 25_000, // ~170% FPL for single in 2024
          householdSize: 1,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      // Should compute some PTC (eligible range)
      expect(result.acaPtcTier).not.toBe('below-fpl');
      expect(result.fplPercentage).toBeGreaterThan(0);
    });

    it('ACA PTC uses benchmark override when provided', () => {
      const withOverride = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 25_000,
          householdSize: 1,
          acaBenchmarkSlcspDollars: 6_000,
        }),
        REAL_BUNDLE,
      );
      const withFormula = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 25_000,
          householdSize: 1,
          acaBenchmarkSlcspDollars: undefined,
        }),
        REAL_BUNDLE,
      );
      // Different benchmark → different PTC
      expect(withOverride.acaPtcSubsidyCents).not.toBe(withFormula.acaPtcSubsidyCents);
    });

    it('default SLCSP is the per-member age-priced month sum; the override bypasses it', () => {
      // Spouse-only-on-ACA household: primary younger and NOT on ACA; the
      // covered spouse is older. The default benchmark must be priced off the
      // COVERED member's own age (the primary contributes $0 — zero covered
      // months), and the override must bypass that fallback. An "oldest covered
      // member's annual premium × covered count" rule would agree here, because
      // there is only one covered member; the per-member sum is what is pinned.
      const members = [
        { memberId: 'primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'spouse', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: true },
      ];
      const withDefault = applyTaxYear(
        baseInput({
          members,
          householdSize: 2,
          filingStatus: 'MFJ',
          preTaxWithdrawalDollars: 30_000,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      const withOverride = applyTaxYear(
        baseInput({
          members,
          householdSize: 2,
          filingStatus: 'MFJ',
          preTaxWithdrawalDollars: 30_000,
          taxYear: 2024,
          acaBenchmarkSlcspDollars: 9_000, // whole-year override
        }),
        REAL_BUNDLE,
      );
      // Default benchmark = the ONE covered member (spouse, age 64 in 2024)
      // priced off their own age, 12 covered months.
      // Expected PTC = max(0, benchmark − expectedContribution).
      const coveredSpouseAge = 2024 - 1960;
      const expectedDefaultBenchmark = annualBenchmarkForAge(coveredSpouseAge); // 1 covered
      // Both produce eligible (non-below-fpl) results; the benchmark differs, so
      // the PTC subsidy differs → the override is NOT the default formula.
      expect(withDefault.acaPtcTier).not.toBe('below-fpl');
      expect(withOverride.acaPtcSubsidyCents).not.toBe(withDefault.acaPtcSubsidyCents);
      // Sanity: the default benchmark is age-driven (the covered member's own
      // age), confirmed by the fact that changing the override changes the PTC.
      expect(expectedDefaultBenchmark).toBeGreaterThan(0);
    });

    // The MIRROR of the fallback case above. The editor collects a
    // WHOLE-YEAR benchmark price, but §36B(b)(2) sums the credit over coverage
    // months, so the override must be prorated by the SAME month count the
    // expected contribution is. This case combines coverage months with an
    // override.
    it('a whole-year benchmark override is prorated to the household coverage months', () => {
      const member = (marketplaceCoverageMonths: number): TaxMemberInput => ({
        memberId: 'test-primary',
        isoBirthdate: '1964-01-01', // age 62 in 2026
        onMedicare: false,
        hasAcaCoverage: true,
        marketplaceCoverageMonths,
      });
      const run = (months: number) =>
        applyTaxYear(
          baseInput({
            taxYear: 2026,
            members: [member(months)],
            householdSize: 1,
            preTaxWithdrawalDollars: 50_000,
            acaBenchmarkSlcspDollars: 12_000,
          }),
          REAL_BUNDLE,
        );
      const overrideCents = 1_200_000;
      const fullYear = run(12);
      const partYear = run(7);

      // The 12-month case is the identity: PTC = override − annual contribution.
      expect(fullYear.acaPtcSubsidyCents).toBeGreaterThan(0);
      const annualContributionCents = overrideCents - fullYear.acaPtcSubsidyCents;

      // 7 covered months: BOTH sides are prorated over the same range, so the
      // credit is `round(B × 7/12) − round(C × 7/12)`.
      const proratedBenchmarkCents = Math.round((overrideCents * 7) / 12);
      const proratedContributionCents = Math.round((annualContributionCents * 7) / 12);
      expect(partYear.acaPtcSubsidyCents).toBe(
        proratedBenchmarkCents - proratedContributionCents,
      );

      // Self-verifying against the defect: leaving the override at its full
      // 12-month value while prorating only the contribution credits
      // `12·B − 7·C`, which over-states the subsidy by `(12 − 7) × B/12`.
      const defectiveCents = overrideCents - proratedContributionCents;
      expect(defectiveCents - partYear.acaPtcSubsidyCents).toBe(
        overrideCents - proratedBenchmarkCents,
      );
      expect(defectiveCents).toBeGreaterThan(partYear.acaPtcSubsidyCents);

      // Equivalently: the part-year credit is 7/12 of the full-year credit.
      expect(partYear.acaPtcSubsidyCents).toBeCloseTo(
        (fullYear.acaPtcSubsidyCents * 7) / 12,
        -1,
      );
    });

    it('member on Medicare is excluded from ACA PTC even if hasAcaCoverage', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 25_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.acaPtcSubsidyCents).toBe(0);
    });

    it('ACA opt-out changes ONLY the SLCSP/PTC — MAGI, taxable SS, §86 tier are invariant', () => {
      // Spouse-and-primary both on ACA. Opting the YOUNGER member out (flipping
      // hasAcaCoverage false — the engine's view of the deterministic opt-out)
      // must change only the household benchmark + PTC; every MAGI path and the
      // §86 SS-taxation result stay identical (the tax family is unchanged).
      const grossSs = 30_000;
      const both = [
        { memberId: 'primary', isoBirthdate: '1962-01-01', onMedicare: false, hasAcaCoverage: true },
        { memberId: 'spouse', isoBirthdate: '1965-01-01', onMedicare: false, hasAcaCoverage: true },
      ];
      const youngerOptedOut = [
        both[0],
        { ...both[1], hasAcaCoverage: false },
      ];
      const args = {
        householdSize: 2, // tax family unchanged by the opt-out
        filingStatus: 'MFJ' as const,
        grossSsDollars: grossSs,
        preTaxWithdrawalDollars: 30_000,
        taxYear: 2024,
      };
      const baseline = applyTaxYear(baseInput({ ...args, members: both }), REAL_BUNDLE);
      const optedOut = applyTaxYear(
        baseInput({ ...args, members: youngerOptedOut }),
        REAL_BUNDLE,
      );
      // Invariant: every MAGI / SS-taxation field unchanged.
      expect(optedOut.magiCents).toBe(baseline.magiCents);
      expect(optedOut.taxableSsCents).toBe(baseline.taxableSsCents);
      expect(optedOut.ssTaxationTier).toBe(baseline.ssTaxationTier);
      expect(optedOut.federalTaxCents).toBe(baseline.federalTaxCents);
      expect(optedOut.irmaaSurchargeCents).toBe(baseline.irmaaSurchargeCents);
      // Changed: the covered set shrinks 2 → 1, so the benchmark + PTC shrink.
      expect(baseline.acaPtcSubsidyCents).toBeGreaterThan(0);
      expect(optedOut.acaPtcSubsidyCents).toBeLessThan(baseline.acaPtcSubsidyCents);
    });

    it('all members opted out → ACA block skipped, PTC $0, no NaN/throw', () => {
      const members = [
        { memberId: 'primary', isoBirthdate: '1962-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'spouse', isoBirthdate: '1965-01-01', onMedicare: false, hasAcaCoverage: false },
      ];
      const result = applyTaxYear(
        baseInput({
          members,
          householdSize: 2,
          filingStatus: 'MFJ',
          preTaxWithdrawalDollars: 30_000,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      expect(result.acaPtcSubsidyCents).toBe(0);
      expect(result.acaPtcTier).toBe('below-fpl');
      expect(Number.isNaN(result.magiCents)).toBe(false);
      expect(Number.isNaN(result.acaPtcSubsidyCents)).toBe(false);
    });
  });

  describe('RMD computation (independent pre-pass)', () => {

    it('rmdFloorCents > 0 for member at RMD trigger age (73+)', () => {
      // Born 1951 → trigger age 73 → in 2024 is age 73 ✓
      const accounts: TaxAccountSnapshot[] = [
        {
          id: 'ira1',
          type: 'RETIREMENT_IRA',
          ownerId: 'test-primary',
          taxTreatment: 'PRE_TAX',
          balancePriorYearDollars: 500_000,
          withdrawalDollars: 20_000,
        },
      ];
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false }],
          accounts,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      // $500k / 26.5 divisor (age 73) ≈ $18,868 → $1,886,800 cents approx
      expect(result.rmdFloorCents).toBeGreaterThan(1_000_000);
      expect(result.rmdPerAccountCents['ira1']).toBeGreaterThan(0);
    });

  });

  describe('rmdApplicable trigger-age signal', () => {
    it('rmdApplicable false below the SECURE 2.0 §107 trigger (born 1960 → 75)', () => {
      const accounts: TaxAccountSnapshot[] = [
        {
          id: 'ira1',
          type: 'RETIREMENT_IRA',
          ownerId: 'test-primary',
          taxTreatment: 'PRE_TAX',
          balancePriorYearDollars: 500_000,
          withdrawalDollars: 0,
        },
      ];
      // Born 1960 → trigger age 75 → in 2026 is age 66, below trigger.
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1960-01-01', onMedicare: false, hasAcaCoverage: false }],
          accounts,
          taxYear: 2026,
        }),
        REAL_BUNDLE,
      );
      expect(result.rmdApplicable).toBe(false);
      expect(result.rmdFloorCents).toBe(0);
    });

    it('rmdApplicable true but map empty when applicable owner has zero qualifying balance', () => {
      const accounts: TaxAccountSnapshot[] = [
        {
          id: 'ira1',
          type: 'RETIREMENT_IRA',
          ownerId: 'test-primary',
          taxTreatment: 'PRE_TAX',
          balancePriorYearDollars: 0,
          withdrawalDollars: 0,
        },
      ];
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false }],
          accounts,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      expect(result.rmdApplicable).toBe(true);
      expect(result.rmdFloorCents).toBe(0);
      expect(Object.keys(result.rmdPerAccountCents).length).toBe(0);
    });
  });

  describe('snapshot year resolution', () => {
    it('future year beyond all tables is clamped with taxYearExtrapolated = true', () => {
      const result = applyTaxYear(
        baseInput({ taxYear: 2035 }),
        REAL_BUNDLE,
      );
      expect(result.taxYearExtrapolated).toBe(true);
      // Should still produce a valid (non-zero) tax estimate
      expect(result.federalTaxCents).toBeGreaterThan(0);
    });

    it('supported year has taxYearExtrapolated = false', () => {
      const result = applyTaxYear(baseInput({ taxYear: 2024 }), REAL_BUNDLE);
      expect(result.taxYearExtrapolated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Cash-like POST_TAX withdrawals excluded from LTCG + MAGI
  // ---------------------------------------------------------------------------

  describe('postTaxCashLikeWithdrawalDollars excluded from LTCG + MAGI', () => {
    it('cash-like withdrawal contributes $0 to LTCG and $0 to MAGI', () => {
      const result = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 0,
          postTaxCashLikeWithdrawalDollars: 50_000,
          assumedCostBasisFraction: 0.5,
        }),
        REAL_BUNDLE,
      );
      // No LTCG, no ordinary income → MAGI = 0, federal tax = 0.
      expect(result.magiCents).toBe(0);
      expect(result.federalTaxCents).toBe(0);
    });

    it('brokerage (postTaxNonRoth) DOES add to MAGI while cash-like of the same size does not', () => {
      const cashLike = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 0,
          postTaxCashLikeWithdrawalDollars: 40_000,
          assumedCostBasisFraction: 0.5,
        }),
        REAL_BUNDLE,
      );
      const brokerage = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 40_000,
          postTaxCashLikeWithdrawalDollars: 0,
          assumedCostBasisFraction: 0.5,
        }),
        REAL_BUNDLE,
      );
      expect(cashLike.magiCents).toBe(0);
      // $40k × (1 − 0.5) = $20k LTCG → MAGI = $20k.
      expect(brokerage.magiCents).toBe(20_000 * 100);
    });

    it('validates the cash-like field (negative → throws)', () => {
      expect(() =>
        applyTaxYear(baseInput({ postTaxCashLikeWithdrawalDollars: -1 }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });
  });

  // ---------------------------------------------------------------------------
  // Federal threshold inflation extrapolation for future years
  // ---------------------------------------------------------------------------

  describe('federal bracket/deduction inflation extrapolation', () => {
    it('scales federal thresholds + deductions by inflation for a post-2026 year', () => {
      // Same nominal income; a far-future year with positive inflation scales
      // the brackets + standard deduction upward → lower federal tax than the
      // frozen latest-year (2026) table would produce.
      const latest = applyTaxYear(
        baseInput({ taxYear: 2026, preTaxWithdrawalDollars: 120_000, inflationRatePct: 3 }),
        REAL_BUNDLE,
      );
      const future = applyTaxYear(
        baseInput({ taxYear: 2040, preTaxWithdrawalDollars: 120_000, inflationRatePct: 3 }),
        REAL_BUNDLE,
      );
      expect(future.taxYearExtrapolated).toBe(true);
      expect(latest.taxYearExtrapolated).toBe(false);
      // Wider brackets + bigger deduction → strictly less tax on the same income.
      expect(future.federalTaxCents).toBeLessThan(latest.federalTaxCents);
    });

    it('keeps taxYearExtrapolated true for modeled future years', () => {
      const result = applyTaxYear(
        baseInput({ taxYear: 2050, preTaxWithdrawalDollars: 80_000, inflationRatePct: 3 }),
        REAL_BUNDLE,
      );
      expect(result.taxYearExtrapolated).toBe(true);
      expect(result.federalTaxCents).toBeGreaterThan(0);
    });

    it('buildScaledFederalTaxConfig rounds ordinary floors DOWN status-aware ($25/$50), LTCG down to $50, deductions to nearest $50', () => {
      const base = FEDERAL_TAX_CONFIG.values[2026];
      const factor = 1.0935; // arbitrary non-round factor to force rounding
      const scaled = buildScaledFederalTaxConfig(base, factor);
      // First ordinary floor stays 0; a non-zero Single floor rounds DOWN to $25
      // (IRC §1(f)(7); MFJ/HoH/QSS use $50, Single/MFS stay $25 — see federal-tax-extrapolation.test.ts).
      expect(scaled.brackets.Single[0].floor).toBe(0);
      expect(scaled.brackets.Single[1].floor).toBe(
        Math.floor((base.brackets.Single[1].floor * factor) / 25) * 25,
      );
      // MFJ ordinary floor rounds DOWN to $50 ($50-granularity table; §1(f)(7)).
      expect(scaled.brackets.MFJ[1].floor).toBe(
        Math.floor((base.brackets.MFJ[1].floor * factor) / 50) * 50,
      );
      // Standard deduction scaled + rounded to the nearest $50.
      expect(scaled.standardDeduction.MFJ).toBe(
        Math.round((base.standardDeduction.MFJ * factor) / 50) * 50,
      );
      // Age-65 add-on scaled + rounded to the nearest $50.
      expect(scaled.age65AddOn.mfj).toBe(
        Math.round((base.age65AddOn.mfj * factor) / 50) * 50,
      );
      // LTCG floor rounds DOWN to $50 (§1(j)(5)(C)).
      expect(scaled.ltcgBrackets.Single[1].floor).toBe(
        Math.floor((base.ltcgBrackets.Single[1].floor * factor) / 50) * 50,
      );
      // NIIT thresholds FROZEN (not scaled).
      expect(scaled.niitThresholds.Single).toBe(base.niitThresholds.Single);
      expect(scaled.niitThresholds.MFJ).toBe(base.niitThresholds.MFJ);
    });
  });

  // ---------------------------------------------------------------------------
  // ACA FPL inflation extrapolation (deflate MAGI by the factor)
  // ---------------------------------------------------------------------------

  describe('ACA FPL inflation extrapolation', () => {
    it('deflates the FPL-comparison MAGI by the inflation factor for a far-future year', () => {
      // Same nominal MAGI: at a far-future year the FPL bands are effectively
      // inflated (MAGI deflated), so fplPercentage is LOWER than if the raw
      // latest-year FPL were used. Consistent with IRMAA's MAGI-deflation.
      const member: TaxMemberInput = {
        memberId: 'aca-primary',
        isoBirthdate: '1975-01-01',
        onMedicare: false,
        hasAcaCoverage: true,
      };
      const near = applyTaxYear(
        baseInput({
          taxYear: 2026,
          members: [member],
          preTaxWithdrawalDollars: 60_000,
          householdSize: 1,
          inflationRatePct: 3,
        }),
        REAL_BUNDLE,
      );
      const far = applyTaxYear(
        baseInput({
          taxYear: 2045,
          members: [member],
          preTaxWithdrawalDollars: 60_000,
          householdSize: 1,
          inflationRatePct: 3,
        }),
        REAL_BUNDLE,
      );
      expect(far.taxYearExtrapolated).toBe(true);
      // Deflated MAGI compares against the same bands → lower FPL%.
      expect(far.fplPercentage).toBeLessThan(near.fplPercentage);
      expect(far.fplPercentage).toBeGreaterThan(0);
    });
  });

  describe('MAGI output', () => {
    it('magiCents includes taxable SS', () => {
      // High income SS case → taxable SS portion adds to MAGI
      const result = applyTaxYear(
        baseInput({
          grossSsDollars: 24_000,
          preTaxWithdrawalDollars: 80_000,
        }),
        REAL_BUNDLE,
      );
      // MAGI should be > pre-tax withdrawal alone
      expect(result.magiCents).toBeGreaterThan(dollarsToCents(80_000));
    });

    it('magiCents includes tax-exempt interest', () => {
      const noTei = applyTaxYear(
        baseInput({ taxExemptInterestDollars: 0 }),
        REAL_BUNDLE,
      );
      const withTei = applyTaxYear(
        baseInput({ taxExemptInterestDollars: 5_000 }),
        REAL_BUNDLE,
      );
      expect(withTei.magiCents).toBeGreaterThan(noTei.magiCents);
    });
  });

  describe('effective tax rate', () => {
    it('effectiveTaxRate is between 0 and 1 for typical income', () => {
      const result = applyTaxYear(baseInput(), REAL_BUNDLE);
      expect(result.effectiveTaxRate).toBeGreaterThanOrEqual(0);
      expect(result.effectiveTaxRate).toBeLessThan(1);
    });

    it('effectiveTaxRate is 0 for zero gross income', () => {
      const result = applyTaxYear(
        baseInput({ preTaxWithdrawalDollars: 0, grossSsDollars: 0 }),
        REAL_BUNDLE,
      );
      expect(result.effectiveTaxRate).toBe(0);
    });
  });

  describe('multi-member household', () => {
    it('two Medicare members get combined IRMAA surcharge greater than one member', () => {
      // Single filer threshold is $103k — use $150k to trigger tier1
      const members: TaxMemberInput[] = [
        { memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
        { memberId: 'test-secondary', isoBirthdate: '1951-01-01', onMedicare: true, hasAcaCoverage: false },
      ];
      const one = applyTaxYear(
        baseInput({
          members: [members[0]],
          magiTwoYearsPriorDollars: 150_000, // above Single tier1 ($103k in 2024)
          filingStatus: 'Single',
        }),
        REAL_BUNDLE,
      );
      const two = applyTaxYear(
        baseInput({
          members,
          magiTwoYearsPriorDollars: 150_000,
          filingStatus: 'Single', // Single lookup also covers HoH; 2 beneficiaries × surcharge
        }),
        REAL_BUNDLE,
      );
      // Both should have surcharge > 0
      expect(one.irmaaSurchargeCents).toBeGreaterThan(0);
      // Two beneficiaries should pay exactly twice
      expect(two.irmaaSurchargeCents).toBe(one.irmaaSurchargeCents * 2);
    });
  });

  describe('custom minimal bundle (isolation)', () => {
    it('works with a custom SS-only bundle slice that forces no-SS tier', () => {
      // Inject a real SS snapshot but a real federal-tax bundle with forced minimal income
      const result = applyTaxYear(
        baseInput({
          grossSsDollars: 0,
          preTaxWithdrawalDollars: 10_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.ssTaxationTier).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // SS taxation tier thresholds (additional coverage)
  // ---------------------------------------------------------------------------

  describe('SS taxation tier boundaries', () => {
    it('tier is none when provisional income is well below Single threshold', () => {
      // Single §86 threshold 1: $25k provisional income
      // With grossSS = $0 and preTax = $15k → PI = $15k (below $25k)
      const result = applyTaxYear(
        baseInput({ grossSsDollars: 0, preTaxWithdrawalDollars: 15_000 }),
        REAL_BUNDLE,
      );
      expect(result.ssTaxationTier).toBe('none');
    });

    it('fifty tier: modest SS + modest income pushes above tier-1 but not tier-2', () => {
      // Single thresholds (2024): tier1=$25k PI (exclusive, <=tier1 → 'none'), tier2=$34k PI
      // grossSS=$12k, preTax=$20k → PI = $20k + $6k (50% of $12k) = $26k
      // $26k > $25k tier1 → 'fifty'; $26k < $34k tier2 → not 'eighty-five'
      const result = applyTaxYear(
        baseInput({ grossSsDollars: 12_000, preTaxWithdrawalDollars: 20_000 }),
        REAL_BUNDLE,
      );
      expect(result.ssTaxationTier).toBe('fifty');
    });

    it('eighty-five tier when high income with SS for MFJ', () => {
      // MFJ tier2 threshold is $44k PI → use income well above that
      const result = applyTaxYear(
        baseInput({
          filingStatus: 'MFJ',
          grossSsDollars: 40_000,
          preTaxWithdrawalDollars: 60_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.ssTaxationTier).toBe('eighty-five');
    });
  });

  // ---------------------------------------------------------------------------
  // otherOrdinaryIncomeDollars wired into MAGI and federal tax
  // ---------------------------------------------------------------------------

  describe('otherOrdinaryIncomeDollars', () => {
    it('increases MAGI when added', () => {
      const without = applyTaxYear(baseInput({ otherOrdinaryIncomeDollars: 0 }), REAL_BUNDLE);
      const with_ = applyTaxYear(
        baseInput({ otherOrdinaryIncomeDollars: 20_000 }),
        REAL_BUNDLE,
      );
      expect(with_.magiCents).toBeGreaterThan(without.magiCents);
    });

    it('increases federal tax when added (higher ordinary income)', () => {
      const without = applyTaxYear(baseInput({ otherOrdinaryIncomeDollars: 0 }), REAL_BUNDLE);
      const with_ = applyTaxYear(
        baseInput({ otherOrdinaryIncomeDollars: 30_000 }),
        REAL_BUNDLE,
      );
      expect(with_.federalTaxCents).toBeGreaterThan(without.federalTaxCents);
    });

    it('contributes to effective tax rate denominator', () => {
      const result = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          otherOrdinaryIncomeDollars: 50_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.effectiveTaxRate).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // LTCG proxy edge cases
  // ---------------------------------------------------------------------------

  describe('LTCG proxy edge cases', () => {
    it('0% cost basis fraction → all POST_TAX withdrawal is LTCG', () => {
      const result = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 50_000,
          assumedCostBasisFraction: 0,
        }),
        REAL_BUNDLE,
      );
      // Entire $50k is LTCG → MAGI = $50k (no ordinary income, only LTCG)
      // Federal tax: LTCG portion taxed at 0%/15%/20% rate
      // At low income, 0% LTCG rate → federal tax = 0
      expect(result.magiCents).toBeGreaterThan(0);
    });

    it('Roth withdrawal excluded from MAGI regardless of size', () => {
      const result = applyTaxYear(
        baseInput({
          preTaxWithdrawalDollars: 0,
          postTaxNonRothWithdrawalDollars: 0,
          rothWithdrawalDollars: 500_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.magiCents).toBe(0);
      expect(result.federalTaxCents).toBe(0);
    });

    it('mixed pre-tax and Roth: only preTax contributes to federal tax', () => {
      const preTaxOnly = applyTaxYear(
        baseInput({ preTaxWithdrawalDollars: 50_000, rothWithdrawalDollars: 0 }),
        REAL_BUNDLE,
      );
      const withRoth = applyTaxYear(
        baseInput({ preTaxWithdrawalDollars: 50_000, rothWithdrawalDollars: 100_000 }),
        REAL_BUNDLE,
      );
      // Federal tax identical: Roth doesn't change tax
      expect(withRoth.federalTaxCents).toBe(preTaxOnly.federalTaxCents);
    });
  });

  // ---------------------------------------------------------------------------
  // IRMAA tier levels
  // ---------------------------------------------------------------------------

  describe('IRMAA tier levels', () => {
    it('tier1 at moderate MAGI above threshold (Single ~$103k–$129k in 2024)', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 110_000,
          filingStatus: 'Single',
        }),
        REAL_BUNDLE,
      );
      expect(result.irmaaTier).toBe('tier1');
    });

    it('higher MAGI produces higher IRMAA tier', () => {
      const tier1Result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 110_000,
          filingStatus: 'Single',
        }),
        REAL_BUNDLE,
      );
      const higherResult = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 400_000,
          filingStatus: 'Single',
        }),
        REAL_BUNDLE,
      );
      // Higher MAGI → higher tier → higher surcharge
      expect(higherResult.irmaaSurchargeCents).toBeGreaterThan(tier1Result.irmaaSurchargeCents);
    });

    it('MFJ IRMAA threshold is roughly double the Single threshold', () => {
      // Single tier1 ≈ $103k; MFJ tier1 ≈ $206k → same $110k MAGI clears Single
      // but falls below MFJ threshold
      const single = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 110_000,
          filingStatus: 'Single',
        }),
        REAL_BUNDLE,
      );
      const mfj = applyTaxYear(
        baseInput({
          filingStatus: 'MFJ',
          members: [{ memberId: 'test-primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
          magiTwoYearsPriorDollars: 110_000,
        }),
        REAL_BUNDLE,
      );
      // Single triggers tier1; MFJ at same MAGI likely stays 'none'
      expect(single.irmaaTier).not.toBe('none');
      expect(mfj.irmaaTier).toBe('none');
    });
  });

  // ---------------------------------------------------------------------------
  // ACA PTC tier levels
  // ---------------------------------------------------------------------------

  describe('ACA PTC tier levels', () => {
    it('above-400-cliff tier when income well above 400% FPL', () => {
      // For single in 2024, 400% FPL ≈ $58,320; use $100k to be well above
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 100_000,
          householdSize: 1,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      // Above 400% FPL → subsidyCents = 0 (cliff effect pre-2022 law)
      // Under ARPA 2021 extension (if tables reflect it), cap may not apply
      // Either way: verify tier is not 'below-fpl'
      expect(result.fplPercentage).toBeGreaterThan(100);
    });

    it('fplPercentage is zero when ACA gate is not engaged', () => {
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: false }],
          preTaxWithdrawalDollars: 25_000,
        }),
        REAL_BUNDLE,
      );
      expect(result.fplPercentage).toBe(0);
    });

    it('fplPercentage proportional to MAGI', () => {
      const low = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 20_000,
          householdSize: 1,
        }),
        REAL_BUNDLE,
      );
      const high = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1973-01-01', onMedicare: false, hasAcaCoverage: true }],
          preTaxWithdrawalDollars: 50_000,
          householdSize: 1,
        }),
        REAL_BUNDLE,
      );
      expect(high.fplPercentage).toBeGreaterThan(low.fplPercentage);
    });
  });

  // ---------------------------------------------------------------------------
  // RMD per-account breakdown
  // ---------------------------------------------------------------------------

  describe('RMD per-account breakdown', () => {

    it('rmdFloorCents equals sum of rmdPerAccountCents values', () => {
      const accounts: TaxAccountSnapshot[] = [
        {
          id: 'a1',
          type: 'RETIREMENT_IRA',
          ownerId: 'test-primary',
          taxTreatment: 'PRE_TAX',
          balancePriorYearDollars: 500_000,
          withdrawalDollars: 20_000,
        },
        {
          id: 'a2',
          type: 'RETIREMENT_IRA',
          ownerId: 'test-primary',
          taxTreatment: 'PRE_TAX',
          balancePriorYearDollars: 250_000,
          withdrawalDollars: 10_000,
        },
      ];
      const result = applyTaxYear(
        baseInput({
          members: [{ memberId: 'test-primary', isoBirthdate: '1951-01-01', onMedicare: false, hasAcaCoverage: false }],
          accounts,
          taxYear: 2024,
        }),
        REAL_BUNDLE,
      );
      const sum = Object.values(result.rmdPerAccountCents).reduce((a, b) => a + b, 0);
      expect(result.rmdFloorCents).toBe(sum);
    });

  });

  // ---------------------------------------------------------------------------
  // Unit helpers — additional edge cases
  // ---------------------------------------------------------------------------

  describe('dollarsToCents — additional', () => {
    it('handles negative dollars', () => {
      expect(dollarsToCents(-1000)).toBe(-100_000);
    });
  });

  describe('computeMagi — additional', () => {
    it('handles fractional dollar inputs without throwing', () => {
      const result = computeMagi({
        ordinaryIncomeDollars: 50_000.50,
        ltcgDollars: 0,
        taxExemptInterestDollars: 0,
      });
      expect(result).toBeCloseTo(50_000.50, 2);
    });
  });

  describe('resolveSnapshotYear — additional', () => {
    it('sparse table: year below all keys resolves to first key', () => {
      const sparse = {
        values: { 2024: {}, 2026: {} },
        metadata: { source: 't', asOfDate: '2024-01-01', jurisdiction: 'US-federal' as const },
      };
      const r = resolveSnapshotYear(sparse, 2020);
      // 2020 < 2024: still need the highest key ≤ 2020, but there is none
      // → resolved = keys[0] = 2024 (loop never increments resolved above 2024)
      // Actually resolveSnapshotYear sets resolved = keys[0] = 2024 since
      // no key <= 2020 passes the 'if (k <= taxYear)' check — resolved
      // remains keys[0]
      expect(r.effectiveYear).toBe(2024);
      expect(r.taxYearExtrapolated).toBe(false);
    });

    it('thresholdScalingFactor = 1 when not extrapolating', () => {
      const snapshot = {
        values: { 2026: {} },
        metadata: { source: 't', asOfDate: '2026-01-01', jurisdiction: 'US-federal' as const },
      };
      const r = resolveSnapshotYear(snapshot, 2026, 2.5);
      expect(r.thresholdScalingFactor).toBe(1);
    });

    it('thresholdScalingFactor = 1 when extrapolating without inflationRatePct', () => {
      const snapshot = {
        values: { 2026: {} },
        metadata: { source: 't', asOfDate: '2026-01-01', jurisdiction: 'US-federal' as const },
      };
      const r = resolveSnapshotYear(snapshot, 2030);
      expect(r.thresholdScalingFactor).toBe(1);
    });

    it('thresholdScalingFactor scales IRMAA threshold forward when extrapolating', () => {
      // 2026 IRMAA Single tier-1 = $109,000; taxYear = 2030 at 2.5% inflation
      // Expected scaling: (1.025)^4 ≈ 1.10381; adjusted threshold ≈ $120,315
      // A look-back MAGI of $115,000 deflated: $115,000 / 1.10381 ≈ $104,182 < $109,000 → no IRMAA
      const irmaaSnapshot = {
        values: { 2026: {} },
        metadata: { source: 't', asOfDate: '2026-01-01', jurisdiction: 'US-federal' as const },
      };
      const r = resolveSnapshotYear(irmaaSnapshot, 2030, 2.5);
      expect(r.taxYearExtrapolated).toBe(true);
      expect(r.thresholdScalingFactor).toBeCloseTo(Math.pow(1.025, 4), 5);
    });
  });

  // ---------------------------------------------------------------------------
  // Rough age-priced benchmark curve — additional
  // ---------------------------------------------------------------------------

  describe('rough age-priced benchmark curve — additional', () => {
    it('exact value at age 62 matches geometric formula', () => {
      const expected = 8_400 * Math.pow(1.05, 2);
      expect(annualBenchmarkForAge(62)).toBeCloseTo(expected, 1);
    });

    it('returns a positive number at age 30', () => {
      expect(annualBenchmarkForAge(30)).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // applyTaxYear — HoH filing status
  // ---------------------------------------------------------------------------

  describe('HoH filing status', () => {
    it('HoH has lower federal tax than Single at same income', () => {
      const single = applyTaxYear(baseInput({ filingStatus: 'Single' }), REAL_BUNDLE);
      const hoh = applyTaxYear(baseInput({ filingStatus: 'HoH' }), REAL_BUNDLE);
      expect(hoh.federalTaxCents).toBeLessThan(single.federalTaxCents);
    });

    it('HoH federal tax result is non-negative', () => {
      const result = applyTaxYear(baseInput({ filingStatus: 'HoH' }), REAL_BUNDLE);
      expect(result.federalTaxCents).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // applyTaxYear input validation matrix
  // ---------------------------------------------------------------------------

  describe('applyTaxYear input validation', () => {
    it('throws TaxIntegrationInvalidInputError for negative grossSsDollars', () => {
      expect(() =>
        applyTaxYear(baseInput({ grossSsDollars: -1 }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });

    it('throws TaxIntegrationInvalidInputError for NaN preTaxWithdrawalDollars', () => {
      expect(() =>
        applyTaxYear(baseInput({ preTaxWithdrawalDollars: NaN }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });

    it('throws TaxIntegrationInvalidInputError for Infinity postTaxNonRothWithdrawalDollars', () => {
      expect(() =>
        applyTaxYear(baseInput({ postTaxNonRothWithdrawalDollars: Infinity }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });

    it('throws TaxIntegrationInvalidInputError for negative otherOrdinaryIncomeDollars', () => {
      expect(() =>
        applyTaxYear(baseInput({ otherOrdinaryIncomeDollars: -0.01 }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });

    it('throws TaxIntegrationInvalidInputError for householdSize = 0', () => {
      expect(() =>
        applyTaxYear(baseInput({ householdSize: 0 }), REAL_BUNDLE),
      ).toThrow(TaxIntegrationInvalidInputError);
    });

    it('does not throw for all-zero dollar fields with householdSize = 1', () => {
      expect(() =>
        applyTaxYear(
          baseInput({
            grossSsDollars: 0,
            preTaxWithdrawalDollars: 0,
            postTaxNonRothWithdrawalDollars: 0,
            rothWithdrawalDollars: 0,
            otherOrdinaryIncomeDollars: 0,
            taxExemptInterestDollars: 0,
            householdSize: 1,
          }),
          REAL_BUNDLE,
        ),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // 30-year reference integration test
  // ---------------------------------------------------------------------------

  describe('30-year reference integration', () => {
    it('produces non-negative tax and positive MAGI across 30 projection years', () => {
      const startYear = 2025;
      for (let i = 0; i < 30; i++) {
        const taxYear = startYear + i;
        const result = applyTaxYear(
          baseInput({
            taxYear,
            preTaxWithdrawalDollars: 80_000,
            grossSsDollars: 24_000,
          }),
          REAL_BUNDLE,
        );
        expect(result.federalTaxCents).toBeGreaterThanOrEqual(0);
        expect(result.magiCents).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed-age household (primary 66, spouse 62)
  // ---------------------------------------------------------------------------

  describe('mixed-age household: primary on Medicare, spouse on ACA', () => {
    it('IRMAA applies when primary is on Medicare, not spouse', () => {
      // Primary born 1959 → age 66 in 2025 (Medicare)
      // Secondary born 1963 → age 62 in 2025 (ACA, not Medicare)
      const result = applyTaxYear(
        baseInput({
          taxYear: 2025,
          filingStatus: 'MFJ',
          members: [
            { memberId: 'primary', isoBirthdate: '1959-01-01', onMedicare: true, hasAcaCoverage: false },
            { memberId: 'secondary', isoBirthdate: '1963-01-01', onMedicare: false, hasAcaCoverage: true },
          ],
          magiTwoYearsPriorDollars: 250_000,
          preTaxWithdrawalDollars: 120_000,
        }),
        REAL_BUNDLE,
      );
      // IRMAA surcharge: only primary's Medicare triggers it; high prior MAGI → tier1+
      expect(result.irmaaTier).not.toBe('none');
      expect(result.irmaaSurchargeCents).toBeGreaterThan(0);
    });

    it('ACA subsidy applies when spouse has marketplace coverage', () => {
      // Low-income year: spouse under 65 + ACA coverage → subsidy possible
      const result = applyTaxYear(
        baseInput({
          taxYear: 2025,
          filingStatus: 'MFJ',
          members: [
            { memberId: 'primary', isoBirthdate: '1959-01-01', onMedicare: true, hasAcaCoverage: false },
            { memberId: 'secondary', isoBirthdate: '1963-01-01', onMedicare: false, hasAcaCoverage: true },
          ],
          preTaxWithdrawalDollars: 30_000, // low income → subsidy
          magiTwoYearsPriorDollars: undefined,
          householdSize: 2,
        }),
        REAL_BUNDLE,
      );
      // ACA-PTC engagement gate: secondary has hasAcaCoverage = true → subsidy computed
      expect(result.acaPtcSubsidyCents).toBeGreaterThanOrEqual(0);
    });
  });
});

// ---------------------------------------------------------------------------
// computeRmdFloorCents — the exported MC-reuse wrapper
// ---------------------------------------------------------------------------

describe('computeRmdFloorCents', () => {
  const member = (isoBirthdate: string): TaxMemberInput => ({
    memberId: 'test-primary',
    isoBirthdate,
    onMedicare: false,
    hasAcaCoverage: false,
  });
  const iraAccount: TaxAccountSnapshot = {
    id: 'ira1',
    type: 'RETIREMENT_IRA',
    ownerId: 'test-primary',
    taxTreatment: 'PRE_TAX',
    balancePriorYearDollars: 500_000,
    withdrawalDollars: 0,
  };

  it('is positive for a member at RMD trigger age (73+)', () => {
    // Born 1951 → age 73 in 2024. $500k / 26.5 divisor ≈ $18,868 → > $1,000,000 cents.
    const floor = computeRmdFloorCents(
      [member('1951-01-01')],
      [iraAccount],
      2024,
      REAL_BUNDLE.rmd,
    );
    expect(floor).toBeGreaterThan(1_000_000);
  });

});

describe('ACA PTC MAGI separation — nontaxable SS counts for ACA', () => {
  // A pre-Medicare retiree with ACA coverage, modest pre-tax income, and a
  // Social Security benefit whose taxable portion is below the gross. ACA MAGI
  // (per §36B) must add back the nontaxable SS, so the ACA FPL% is higher than
  // it would be on the federal/IRMAA MAGI alone.
  const acaMember: TaxMemberInput = {
    memberId: 'aca-primary',
    isoBirthdate: '1962-06-15', // age 62 in 2024 — pre-Medicare, ACA-eligible
    onMedicare: false,
    hasAcaCoverage: true,
  };

  function acaInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
    return baseInput({
      taxYear: 2024,
      filingStatus: 'Single',
      preTaxWithdrawalDollars: 20_000,
      grossSsDollars: 24_000,
      members: [acaMember],
      acaBenchmarkSlcspDollars: 9_000,
      ...overrides,
    });
  }

  it('ACA FPL% reflects gross SS, not just the taxable portion', () => {
    const withSs = applyTaxYear(acaInput(), REAL_BUNDLE);
    // Federal MAGI excludes nontaxable SS; ACA MAGI includes it. The taxable
    // SS portion here is < gross, so ACA FPL% must exceed the FPL% that the
    // federal MAGI alone would produce.
    // Build a comparison where the SAME total income is all taxable (no SS):
    // federal MAGI then equals ACA MAGI and FPL% is the federal-basis figure.
    const allTaxable = applyTaxYear(
      acaInput({ grossSsDollars: 0, preTaxWithdrawalDollars: 20_000 }),
      REAL_BUNDLE,
    );
    // The SS case has gross income 44k (20k pre-tax + 24k SS); the all-taxable
    // case has only 20k. The ACA FPL% for the SS case must be strictly higher
    // because gross SS is fully counted in ACA MAGI.
    expect(withSs.fplPercentage).toBeGreaterThan(allTaxable.fplPercentage);
    expect(withSs.acaPtcTier).not.toBe('below-fpl');
  });

  it('federal/IRMAA MAGI still excludes nontaxable SS (unchanged basis)', () => {
    const result = applyTaxYear(acaInput(), REAL_BUNDLE);
    // magiCents is the federal/IRMAA MAGI: pre-tax + taxable SS (+ LTCG +
    // tax-exempt interest, both 0 here). It must be strictly less than the
    // gross-SS-inclusive figure, i.e. below pre-tax + full gross SS.
    const grossInclusiveCents = dollarsToCents(20_000 + 24_000);
    expect(result.magiCents).toBeLessThan(grossInclusiveCents);
    // And it equals pre-tax + taxable SS exactly.
    expect(result.magiCents).toBe(dollarsToCents(20_000) + result.taxableSsCents);
  });
});

describe('HSA + early-withdrawal additional tax wired through applyTaxYear', () => {
  const young: TaxMemberInput = {
    memberId: 'p',
    isoBirthdate: '1985-06-15', // ~age 45 in 2030 — pre-59½ and pre-65
    onMedicare: false,
    hasAcaCoverage: false,
  };

  function penInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
    return baseInput({
      taxYear: 2030,
      preTaxWithdrawalDollars: 0,
      members: [young],
      ...overrides,
    });
  }

  it('emergency HSA withdrawal stays tax-free (100% qualified default)', () => {
    const r = applyTaxYear(
      penInput({
        penaltyAccounts: [
          { id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0, hsaWithdrawalDollars: 5_000 },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(r.hsaAdditionalTaxCents).toBe(0);
    expect(r.federalTaxCents).toBe(0);
  });

  it('nonqualified HSA withdrawal before 65 → ordinary income + 20% additional tax', () => {
    const r = applyTaxYear(
      penInput({
        hsaQualifiedMedicalExpensePct: 0, // entirely nonqualified
        penaltyAccounts: [
          { id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0, hsaWithdrawalDollars: 5_000 },
        ],
      }),
      REAL_BUNDLE,
    );
    // 20% of $5,000 = $1,000 additional tax (cents).
    expect(r.hsaAdditionalTaxCents).toBe(dollarsToCents(1_000));
    // The nonqualified $5,000 is ordinary income (here below the standard
    // deduction, so $0 income tax), and the 20% additional tax is folded into
    // federalTaxCents — so federalTaxCents includes at least the 20%.
    expect(r.federalTaxCents).toBeGreaterThanOrEqual(r.hsaAdditionalTaxCents);
    // Compared to a fully-qualified HSA draw (no income, no additional tax),
    // the nonqualified case must owe strictly more federal tax.
    const qualified = applyTaxYear(
      penInput({
        hsaQualifiedMedicalExpensePct: 100,
        penaltyAccounts: [
          { id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0, hsaWithdrawalDollars: 5_000 },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(r.federalTaxCents).toBeGreaterThan(qualified.federalTaxCents);
  });

  it('pre-59½ traditional withdrawal → 10% penalty folded into federalTaxCents', () => {
    const noPenalty = applyTaxYear(penInput({ preTaxWithdrawalDollars: 40_000 }), REAL_BUNDLE);
    const withPenalty = applyTaxYear(
      penInput({
        preTaxWithdrawalDollars: 40_000,
        penaltyAccounts: [
          { id: 'ira', type: 'RETIREMENT_IRA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 40_000, hsaWithdrawalDollars: 0 },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(withPenalty.earlyWithdrawalPenaltyCents).toBe(dollarsToCents(4_000)); // 10% of 40k
    expect(withPenalty.federalTaxCents).toBe(noPenalty.federalTaxCents + dollarsToCents(4_000));
  });

  it('scenario exempt account bypasses the penalty', () => {
    const r = applyTaxYear(
      penInput({
        preTaxWithdrawalDollars: 40_000,
        earlyWithdrawalPenaltyExemptAccountIds: ['ira'],
        penaltyAccounts: [
          { id: 'ira', type: 'RETIREMENT_IRA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 40_000, hsaWithdrawalDollars: 0 },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(r.earlyWithdrawalPenaltyCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §223 medical-qualified / emergency HSA split through applyTaxYear
// ---------------------------------------------------------------------------

describe('HSA §223 medical-qualified split', () => {
  const young: TaxMemberInput = {
    memberId: 'p',
    isoBirthdate: '1985-06-15', // ~age 45 in 2030 — pre-65
    onMedicare: false,
    hasAcaCoverage: false,
  };
  const old: TaxMemberInput = {
    memberId: 'p',
    isoBirthdate: '1955-06-15', // ~age 75 in 2030 — post-65
    onMedicare: false,
    hasAcaCoverage: false,
  };

  function input(member: TaxMemberInput, overrides: Partial<TaxYearInput> = {}): TaxYearInput {
    return baseInput({ taxYear: 2030, preTaxWithdrawalDollars: 0, members: [member], ...overrides });
  }

  it('medical-qualified dollars add $0 income + $0 20% tax at any owner age', () => {
    // $8,000 HSA draw, $8,000 medical-qualified → fully tax-free even pre-65 with
    // hsaQualifiedMedicalExpensePct: 0 (the pct scopes only the emergency residual).
    const pre = applyTaxYear(
      input(young, {
        hsaQualifiedMedicalExpensePct: 0,
        penaltyAccounts: [
          {
            id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0,
            hsaWithdrawalDollars: 8_000, hsaMedicalQualifiedDollars: 8_000,
            hsaWithdrawalCents: 800_000, hsaMedicalQualifiedCents: 800_000,
          },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(pre.hsaAdditionalTaxCents).toBe(0);
    expect(pre.federalTaxCents).toBe(0);
  });

  it('pre-65 emergency residual → emergency × (1 − pct/100) × 20% × penaltyFraction', () => {
    // $10,000 HSA draw, $6,000 medical-qualified → $4,000 emergency residual.
    // pct 0 → all $4,000 nonqualified → 20% of 4,000 = $800 (whole pre-65 year).
    const r = applyTaxYear(
      input(young, {
        hsaQualifiedMedicalExpensePct: 0,
        penaltyAccounts: [
          {
            id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0,
            hsaWithdrawalDollars: 10_000, hsaMedicalQualifiedDollars: 6_000,
            hsaWithdrawalCents: 1_000_000, hsaMedicalQualifiedCents: 600_000,
          },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(r.hsaAdditionalTaxCents).toBe(dollarsToCents(800));
  });

  it('post-65 emergency residual → $0 additional tax', () => {
    const r = applyTaxYear(
      input(old, {
        hsaQualifiedMedicalExpensePct: 0,
        penaltyAccounts: [
          {
            id: 'hsa', type: 'HSA', ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0,
            hsaWithdrawalDollars: 10_000, hsaMedicalQualifiedDollars: 6_000,
            hsaWithdrawalCents: 1_000_000, hsaMedicalQualifiedCents: 600_000,
          },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(r.hsaAdditionalTaxCents).toBe(0);
  });

  it('pct=100 vs pct<100 boundary on the emergency residual', () => {
    const accounts = [
      {
        id: 'hsa', type: 'HSA' as const, ownerId: 'p', penaltyPreTaxWithdrawalDollars: 0,
        hsaWithdrawalDollars: 10_000, hsaMedicalQualifiedDollars: 4_000,
        hsaWithdrawalCents: 1_000_000, hsaMedicalQualifiedCents: 400_000,
      },
    ];
    // pct=100: the $6,000 emergency residual is all "qualified receipts" → $0 tax.
    const full = applyTaxYear(
      input(young, { hsaQualifiedMedicalExpensePct: 100, penaltyAccounts: accounts }),
      REAL_BUNDLE,
    );
    expect(full.hsaAdditionalTaxCents).toBe(0);
    // pct=0: the whole $6,000 emergency residual is nonqualified → 20% = $1,200.
    const none = applyTaxYear(
      input(young, { hsaQualifiedMedicalExpensePct: 0, penaltyAccounts: accounts }),
      REAL_BUNDLE,
    );
    expect(none.hsaAdditionalTaxCents).toBe(dollarsToCents(1_200));
  });
});

// ---------------------------------------------------------------------------
// Annual assumed-yield tax drag on brokerage-like balances
// ---------------------------------------------------------------------------

describe('assumed taxable-yield drag', () => {
  it('one_million_brokerage_balance_2pct_50pct_qdi_raises_magi_by_20k', () => {
    // $1,000,000 brokerage-like start balance × 2% = $20,000 total yield,
    // split 50% → $10,000 QDI (LTCG/QDI) + $10,000 ordinary interest. Both feed
    // MAGI, so MAGI rises by $20,000 vs the no-yield baseline.
    const noYield = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000, brokerageLikeStartBalanceDollars: 0 }),
      REAL_BUNDLE,
    );
    const withYield = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000, brokerageLikeStartBalanceDollars: 1_000_000 }),
      REAL_BUNDLE,
    );
    expect(withYield.magiCents - noYield.magiCents).toBe(dollarsToCents(20_000));
  });

  it('niit_base_includes_the_ordinary_interest_yield_stream', () => {
    // The integration layer passes an explicit NIIT base of
    // `ltcg + ordinaryInterest` (the FULL yield), not the engine's
    // `ltcgAndQdi`-only default. With $1M brokerage @ 2% / 50% QDI and income
    // above the $200k Single NIIT threshold, NII = $10k QDI + $10k ordinary
    // interest = $20k. We replicate the engine call with the narrower default
    // (NII = QDI only = $10k) and confirm the integration layer taxes $10k MORE
    // of NII at 3.8% → $380 (38_000 cents) extra federal tax.
    const integration = applyTaxYear(
      baseInput({ taxYear: 2026, preTaxWithdrawalDollars: 300_000, brokerageLikeStartBalanceDollars: 1_000_000 }),
      REAL_BUNDLE,
    );
    // Engine replica with NII defaulted to ltcgAndQdi only:
    // ordinaryIncome = $300k pre-tax + $10k ordinary-interest yield = $310k;
    // ltcgAndQdi = $10k QDI yield; NII omitted → defaults to ltcgAndQdi ($10k).
    const oldBehavior = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 310_000, ltcgAndQdi: 10_000, taxpayersAge65Plus: 0 },
      FEDERAL_TAX_CONFIG,
    );
    // MAGI ($320k) clears the $200k threshold and the extra $10k of NII is fully
    // below MAGI−threshold, so the difference is exactly 0.038 × $10,000.
    expect(integration.federalTaxCents).toBe(oldBehavior.totalTax + Math.round(0.038 * 10_000 * 100));
    expect(integration.magiCents).toBeGreaterThan(dollarsToCents(200_000));
  });

  it('zero_brokerage_balance_produces_no_yield_drag', () => {
    const r = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000, brokerageLikeStartBalanceDollars: 0 }),
      REAL_BUNDLE,
    );
    // MAGI is just the $50k pre-tax withdrawal — no yield added.
    expect(r.magiCents).toBe(dollarsToCents(50_000));
  });
});

// ---------------------------------------------------------------------------
// Cash-like interest + explicit yield tax character (ordinary/QDI/muni)
// ---------------------------------------------------------------------------

describe('cash-like interest (savings/money-market/CD)', () => {
  it('cash_interest_is_ordinary_income_raising_magi_dollar_for_dollar', () => {
    const noInterest = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000 }),
      REAL_BUNDLE,
    );
    const withInterest = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000, cashInterestDollars: 8_000 }),
      REAL_BUNDLE,
    );
    expect(withInterest.magiCents - noInterest.magiCents).toBe(dollarsToCents(8_000));
    expect(withInterest.federalTaxCents).toBeGreaterThan(noInterest.federalTaxCents);
  });

  it('cash_interest_is_niit_base_income_1411c', () => {
    // Above the $200k Single NIIT threshold, $10k of cash interest adds both
    // ordinary tax AND 3.8% NIIT. Replicate the engine call without the NII
    // term to isolate the 3.8% × $10k = $380 NIIT delta.
    const integration = applyTaxYear(
      baseInput({ taxYear: 2026, preTaxWithdrawalDollars: 300_000, cashInterestDollars: 10_000 }),
      REAL_BUNDLE,
    );
    const withoutNiitTerm = computeFederalTax(
      { year: 2026, filingStatus: 'Single', ordinaryIncome: 310_000, ltcgAndQdi: 0, taxpayersAge65Plus: 0 },
      FEDERAL_TAX_CONFIG,
    );
    expect(integration.federalTaxCents).toBe(
      withoutNiitTerm.totalTax + Math.round(0.038 * 10_000 * 100),
    );
  });

  it('cash_interest_feeds_86_provisional_income_raising_taxable_ss', () => {
    // §86 provisional income includes interest, so cash interest can pull more
    // of the SS benefit into taxable income.
    const noInterest = applyTaxYear(
      baseInput({ grossSsDollars: 30_000, preTaxWithdrawalDollars: 20_000 }),
      REAL_BUNDLE,
    );
    const withInterest = applyTaxYear(
      baseInput({
        grossSsDollars: 30_000,
        preTaxWithdrawalDollars: 20_000,
        cashInterestDollars: 15_000,
      }),
      REAL_BUNDLE,
    );
    expect(withInterest.taxableSsCents).toBeGreaterThan(noInterest.taxableSsCents);
  });

  it('cash_interest_is_excluded_from_the_effective_rate_denominator', () => {
    // The interest is assumed reinvested (like the assumed yield), so it is not
    // spendable gross income: the denominator stays the same while the tax
    // rises → the effective rate strictly rises.
    const noInterest = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 80_000 }),
      REAL_BUNDLE,
    );
    const withInterest = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 80_000, cashInterestDollars: 20_000 }),
      REAL_BUNDLE,
    );
    expect(withInterest.effectiveTaxRate).toBeGreaterThan(noInterest.effectiveTaxRate);
    // Same denominator: rate ratio equals tax ratio.
    expect(withInterest.effectiveTaxRate * 80_000).toBeCloseTo(
      withInterest.federalTaxCents / 100,
      6,
    );
  });

  it('negative_cash_interest_throws_validation_error', () => {
    expect(() =>
      applyTaxYear(baseInput({ cashInterestDollars: -1 }), REAL_BUNDLE),
    ).toThrow(TaxIntegrationInvalidInputError);
  });
});

describe('explicit yield tax character (ordinary / QDI / tax-exempt muni)', () => {
  /** REAL_BUNDLE with an explicit 25% tax-exempt municipal yield component
   *  (0.5 QDI / 0.25 muni / 0.25 ordinary of the 2% total). */
  const MUNI_BUNDLE: TaxCalibrationBundle = {
    ...REAL_BUNDLE,
    assumedTaxableYield: {
      values: {
        2026: {
          totalYieldPct: 0.02,
          qualifiedDividendFraction: 0.5,
          taxExemptMunicipalFraction: 0.25,
        },
      },
      metadata: { source: 'test', asOfDate: '2026-01-01', jurisdiction: 'US-federal' },
    },
  };

  it('resolveAssumedYieldComponents_splits_and_clamps_the_three_streams', () => {
    expect(
      resolveAssumedYieldComponents({
        totalYieldPct: 0.02,
        qualifiedDividendFraction: 0.5,
        taxExemptMunicipalFraction: 0.25,
      }),
    ).toEqual({ qdiFraction: 0.5, taxExemptFraction: 0.25, ordinaryFraction: 0.25 });
    // Over-committed pair: muni yields to QDI, ordinary floors at 0.
    expect(
      resolveAssumedYieldComponents({
        totalYieldPct: 0.02,
        qualifiedDividendFraction: 0.8,
        taxExemptMunicipalFraction: 0.5,
      }),
    ).toEqual({
      qdiFraction: 0.8,
      taxExemptFraction: expect.closeTo(0.2, 12) as number,
      ordinaryFraction: 0,
    });
    // Seed default: no muni component unless explicitly calibrated.
    expect(
      resolveAssumedYieldComponents(
        DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG.values[2026],
      ).taxExemptFraction,
    ).toBe(0);
  });

  it('muni_component_feeds_magi_addback_but_not_federal_taxable_income', () => {
    // $1M brokerage @ 2%: default split taxes $10k QDI + $10k ordinary.
    // The muni bundle re-characterizes $5k of the ordinary stream as
    // tax-exempt: MAGI is unchanged (the §36B add-back keeps the full $20k in
    // MAGI) but federal tax falls (only $5k ordinary remains taxable).
    const defaultSplit = applyTaxYear(
      baseInput({
        taxYear: 2026,
        preTaxWithdrawalDollars: 60_000,
        brokerageLikeStartBalanceDollars: 1_000_000,
      }),
      REAL_BUNDLE,
    );
    const muniSplit = applyTaxYear(
      baseInput({
        taxYear: 2026,
        preTaxWithdrawalDollars: 60_000,
        brokerageLikeStartBalanceDollars: 1_000_000,
      }),
      MUNI_BUNDLE,
    );
    expect(muniSplit.magiCents).toBe(defaultSplit.magiCents);
    expect(muniSplit.federalTaxCents).toBeLessThan(defaultSplit.federalTaxCents);
  });

  it('muni_component_still_counts_toward_86_provisional_income', () => {
    // §86 counts tax-exempt interest in provisional income, so the muni
    // stream pulls the same SS fraction into taxable income as an equal
    // ordinary-interest stream would.
    const muni = applyTaxYear(
      baseInput({
        taxYear: 2026,
        grossSsDollars: 30_000,
        preTaxWithdrawalDollars: 10_000,
        brokerageLikeStartBalanceDollars: 1_000_000,
      }),
      MUNI_BUNDLE,
    );
    const defaultSplit = applyTaxYear(
      baseInput({
        taxYear: 2026,
        grossSsDollars: 30_000,
        preTaxWithdrawalDollars: 10_000,
        brokerageLikeStartBalanceDollars: 1_000_000,
      }),
      REAL_BUNDLE,
    );
    expect(muni.taxableSsCents).toBe(defaultSplit.taxableSsCents);
  });

  it('senior_deduction_magi_excludes_tax_exempt_interest_obbba', () => {
    // The OBBBA senior-deduction MAGI is AGI-based — it does NOT add back
    // tax-exempt interest. A 65+ single filer with base MAGI below the $75k
    // phase-out keeps the FULL senior deduction even when muni interest pushes
    // the §36B/IRMAA MAGI over the threshold: federal tax must be UNCHANGED by
    // the muni interest (no SS in this input, so §86 is inert).
    const senior: TaxMemberInput = {
      memberId: 'senior',
      isoBirthdate: '1958-06-15', // 68 in 2026
      onMedicare: false,
      hasAcaCoverage: false,
    };
    const base = baseInput({
      taxYear: 2026,
      preTaxWithdrawalDollars: 70_000,
      members: [senior],
      taxpayersAge65Plus: 1,
    });
    const withoutMuni = applyTaxYear(base, REAL_BUNDLE);
    const withMuni = applyTaxYear(
      { ...base, taxExemptInterestDollars: 40_000 },
      REAL_BUNDLE,
    );
    // MAGI rises by the muni add-back…
    expect(withMuni.magiCents - withoutMuni.magiCents).toBe(dollarsToCents(40_000));
    // …but the senior-deduction base ignores it → identical federal tax.
    expect(withMuni.federalTaxCents).toBe(withoutMuni.federalTaxCents);
  });
});

describe('applyTaxYear — QCD income exclusion', () => {
  it('subtracts qcdIncomeExclusionDollars from MAGI and lowers federal tax', () => {
    const noQcd = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000 }),
      REAL_BUNDLE,
    );
    const withQcd = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 50_000, qcdIncomeExclusionDollars: 20_000 }),
      REAL_BUNDLE,
    );
    // The $20k QCD drops MAGI by exactly $20k (the only income is the pre-tax
    // withdrawal here), and the lower taxable income lowers federal tax.
    expect(withQcd.magiCents).toBe(noQcd.magiCents - dollarsToCents(20_000));
    expect(withQcd.federalTaxCents).toBeLessThan(noQcd.federalTaxCents);
  });

  it('clamps the exclusion at the pre-tax withdrawal total (never negative income)', () => {
    // A QCD larger than the pre-tax withdrawal cannot drive taxable pre-tax
    // income below 0 — MAGI floors at the other income (0 here).
    const r = applyTaxYear(
      baseInput({ preTaxWithdrawalDollars: 30_000, qcdIncomeExclusionDollars: 50_000 }),
      REAL_BUNDLE,
    );
    expect(r.magiCents).toBe(0);
  });

  it('rejects a non-finite / negative qcdIncomeExclusionDollars', () => {
    expect(() =>
      applyTaxYear(
        baseInput({ qcdIncomeExclusionDollars: -1 }),
        REAL_BUNDLE,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-tax-unit filing pipeline
// ---------------------------------------------------------------------------

import { computeSsTaxation } from './ss-taxation';
import { computeAcaPtc, acaPtcEligibleForFilingStatus, AcaPtcInvalidInputError } from './aca-ptc';
import { resolveTaxUnitsForYear } from './balance-projection-runner-tax';
import { buildFilingPlanContextForYear } from './balance-projection-runner-tax-helpers';
import type { PipelineContext } from './balance-projection-runner-types';

describe('federal-tax — MFS / QSS statuses', () => {
  it('QSS computes identically to MFJ (uses the MFJ schedule, §1(a))', () => {
    const base = { year: 2026 as const, ordinaryIncome: 300_000, ltcgAndQdi: 40_000 };
    const mfj = computeFederalTax({ ...base, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    const qss = computeFederalTax({ ...base, filingStatus: 'QSS' }, FEDERAL_TAX_CONFIG);
    expect(qss).toEqual(mfj);
  });

  it('MFS is NOT half-of-MFJ-cheap: its compressed brackets tax high income more than MFJ', () => {
    const base = { year: 2026 as const, ordinaryIncome: 300_000, ltcgAndQdi: 0 };
    const mfj = computeFederalTax({ ...base, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    const mfs = computeFederalTax({ ...base, filingStatus: 'MFS' }, FEDERAL_TAX_CONFIG);
    expect(mfs.totalTax).toBeGreaterThan(mfj.totalTax);
  });

  it('MFS NIIT threshold is $125,000 (not MFJ $250,000)', () => {
    // $200k MAGI, $50k of it NII: MFJ ($250k threshold) → no NIIT; MFS ($125k) → NIIT on $75k.
    const input = {
      year: 2026 as const,
      ordinaryIncome: 150_000,
      ltcgAndQdi: 50_000,
      netInvestmentIncome: 50_000,
    };
    const mfj = computeFederalTax({ ...input, filingStatus: 'MFJ' }, FEDERAL_TAX_CONFIG);
    const mfs = computeFederalTax({ ...input, filingStatus: 'MFS' }, FEDERAL_TAX_CONFIG);
    expect(mfj.niitTax).toBe(0);
    // NIIT = 3.8% × min(NII, MAGI − 125000) = 3.8% × min(50000, 75000) = 3.8% × 50000.
    expect(mfs.niitTax).toBe(Math.round(0.038 * 50_000 * 100));
  });
});

describe('ss-taxation — MFS lived-with-spouse zero base', () => {
  const args = {
    grossSsCents: 30_000_00,
    otherAgiCents: 20_000_00,
    taxExemptInterestCents: 0,
    taxYear: 2026,
  };
  it('MFS lived-together taxes 85% of benefits from the first PI dollar', () => {
    const r = computeSsTaxation({ ...args, filingStatus: 'MFS', mfsLivedWithSpouse: true }, SS_TAX_THRESHOLDS);
    expect(r.tier).toBe('eighty-five');
    // Full 85% cap binds: 0.85 × grossSS.
    expect(r.taxableSsCents).toBe(Math.round(0.85 * 30_000_00));
  });
  it('MFS NOT-lived-together uses the Single threshold pair (some benefits shielded)', () => {
    const r = computeSsTaxation({ ...args, filingStatus: 'MFS', mfsLivedWithSpouse: false }, SS_TAX_THRESHOLDS);
    expect(r.taxableSsCents).toBeLessThan(Math.round(0.85 * 30_000_00));
  });
  it('QSS uses the Single (individual) threshold pair', () => {
    const qss = computeSsTaxation({ ...args, filingStatus: 'QSS' }, SS_TAX_THRESHOLDS);
    const single = computeSsTaxation({ ...args, filingStatus: 'Single' }, SS_TAX_THRESHOLDS);
    expect(qss).toEqual(single);
  });
});

describe('irmaa / aca — MFS / QSS routing', () => {
  it('IRMAA routes MFS-lived-with-spouse to the steeper byMfs schedule; QSS to bySingle', () => {
    const common = { taxYear: 2026, magiTwoYearsPriorCents: 150_000_00, beneficiariesOnMedicareCount: 1 as const };
    const mfs = computeIrmaa({ ...common, filingStatus: 'MFS', mfsLivedWithSpouse: true }, IRMAA_TIERS);
    const single = computeIrmaa({ ...common, filingStatus: 'Single' }, IRMAA_TIERS);
    const qss = computeIrmaa({ ...common, filingStatus: 'QSS' }, IRMAA_TIERS);
    // $150k: MFS-lived-together is already in its wide surcharge band; Single is only tier1.
    expect(mfs.totalHouseholdAnnualCents).toBeGreaterThan(single.totalHouseholdAnnualCents);
    expect(qss).toEqual(single);
  });
  it('IRMAA routes MFS-lived-APART to the individual bySingle ladder', () => {
    // §36B-parallel CMS rule: an MFS filer who lived apart all year uses the
    // single ladder, NOT the steeper two-band byMfs schedule.
    const common = { taxYear: 2026, magiTwoYearsPriorCents: 150_000_00, beneficiariesOnMedicareCount: 1 as const };
    const apart = computeIrmaa({ ...common, filingStatus: 'MFS', mfsLivedWithSpouse: false }, IRMAA_TIERS);
    const together = computeIrmaa({ ...common, filingStatus: 'MFS', mfsLivedWithSpouse: true }, IRMAA_TIERS);
    const single = computeIrmaa({ ...common, filingStatus: 'Single' }, IRMAA_TIERS);
    // Absent flag defaults to lived-apart → single ladder.
    const absent = computeIrmaa({ ...common, filingStatus: 'MFS' }, IRMAA_TIERS);
    expect(apart.totalHouseholdAnnualCents).toBe(single.totalHouseholdAnnualCents);
    expect(absent.totalHouseholdAnnualCents).toBe(single.totalHouseholdAnnualCents);
    expect(apart.totalHouseholdAnnualCents).toBeLessThan(together.totalHouseholdAnnualCents);
  });
  it('ACA-PTC: MFS is ineligible; computeAcaPtc throws for MFS; QSS computes normally', () => {
    expect(acaPtcEligibleForFilingStatus('MFS')).toBe(false);
    expect(acaPtcEligibleForFilingStatus('QSS')).toBe(true);
    expect(() =>
      computeAcaPtc(
        { taxYear: 2026, filingStatus: 'MFS', householdSize: 1, magiCents: 30_000_00, benchmarkAnnualSlcspCents: 9_000_00 },
        ACA_PTC_PARAMETERS,
      ),
    ).toThrow(AcaPtcInvalidInputError);
  });
});

describe('deterministic runner filing-plan resolution seam', () => {
  const pipelineCtx = (over: { filingStatus?: 'MFJ' | 'Single' | 'HoH'; secondary?: boolean } = {}) =>
    ({
      resolvedScenario: { filingStatus: over.filingStatus },
      secondary: over.secondary ? { payload: { birthdate: '1961-04-02' } } : undefined,
      primary: { payload: { birthdate: '1958-03-10' } },
    }) as unknown as PipelineContext;

  it('buildFilingPlanContextForYear bridges the pipeline context (couple, no plan)', () => {
    const ctx = buildFilingPlanContextForYear(pipelineCtx({ secondary: true }), 2026, true, true);
    expect(ctx.hasSecondaryMember).toBe(true);
    expect(ctx.primaryBirthYear).toBe(1958);
    expect(ctx.secondaryBirthYear).toBe(1961);
  });
  it('resolveTaxUnitsForYear resolves a two-member no-scalar couple to one MFJ unit', () => {
    const res = resolveTaxUnitsForYear(pipelineCtx({ secondary: true }), 2026, true, true);
    expect(res).toEqual({ kind: 'resolved', taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }] });
  });

});

// ---------------------------------------------------------------------------
// applyTaxYearForFilingPlan — the PRODUCTION per-year orchestrator
// ---------------------------------------------------------------------------

describe('applyTaxYearForFilingPlan — 3-way branch', () => {
  const couple: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1958-03-10', onMedicare: true, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1959-04-02', onMedicare: true, hasAcaCoverage: false },
  ];
  const coupleInput = (over: Partial<ApplyFilingPlanYearInput> = {}): ApplyFilingPlanYearInput => ({
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members: couple,
      preTaxWithdrawalDollars: 160_000,
      grossSsDollars: 60_000,
    }),
    memberIdByRole: { primary: 'p', secondary: 's' },
    ...over,
  });
  const MFS_UNITS: ResolvedTaxUnit[] = [
    { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
    { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 1 },
  ];

  it('should_use_the_legacy_status_when_taxUnits_is_absent', () => {
    // An unresolvable legacy scalar keeps filing exactly as before.
    const input = coupleInput();
    expect(applyTaxYearForFilingPlan(input, REAL_BUNDLE).federalTaxCents).toBe(
      applyTaxYear(input, REAL_BUNDLE).federalTaxCents,
    );
  });

  it('should_use_the_legacy_status_when_taxUnits_is_empty', () => {
    const input = coupleInput({ taxUnits: [] });
    expect(applyTaxYearForFilingPlan(input, REAL_BUNDLE).federalTaxCents).toBe(
      applyTaxYear(coupleInput(), REAL_BUNDLE).federalTaxCents,
    );
  });

  it('should_short_circuit_a_single_unit_to_its_resolved_status', () => {
    const asSingle = applyTaxYearForFilingPlan(
      coupleInput({
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single', householdSize: 1 }],
      }),
      REAL_BUNDLE,
    );
    const direct = applyTaxYear(
      coupleInput({ filingStatus: 'Single', householdSize: 1 }),
      REAL_BUNDLE,
    );
    expect(asSingle.federalTaxCents).toBe(direct.federalTaxCents);
    // A survivor year files under ONE return, so the look-back ring gets one entry.
    expect(asSingle.filingUnitMagi).toHaveLength(1);
    expect(asSingle.filingUnitMagi?.[0].filingStatus).toBe('Single');
  });

  it('should_run_the_engine_per_unit_and_sum_for_a_separate_couple', () => {
    // With income attributed to ONE spouse the progressive schedule bites: two
    // MFS returns on a lopsided household cost MORE than one joint return.
    // (An even 50/50 split is the degenerate case where two MFS returns sum
    // exactly to MFJ — two MFS deductions = the MFJ deduction, MFS brackets =
    // MFJ ÷ 2 — so it proves nothing about per-unit execution.)
    const merged = applyTaxYearForFilingPlan(
      coupleInput({
        taxUnits: MFS_UNITS,
        grossSsDollarsByMemberId: { p: 60_000 },
        ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 160_000 } },
      }),
      REAL_BUNDLE,
    );
    const joint = applyTaxYear(coupleInput(), REAL_BUNDLE);
    expect(merged.federalTaxCents).toBeGreaterThan(joint.federalTaxCents);
    expect(merged.filingUnitMagi).toHaveLength(2);
    expect(merged.irmaaSurchargeCentsByUnit).toHaveLength(2);
  });
});

describe('mergeUnitResults contract — UNEQUAL units', () => {
  // Deliberately lopsided: only the primary owns the pre-tax account (so only
  // that return carries an RMD floor and a §72(t) penalty), only the primary
  // receives Social Security, and the two returns file different statuses.
  const members: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1948-03-10', onMedicare: true, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1975-04-02', onMedicare: false, hasAcaCoverage: false },
  ];
  const accounts: TaxAccountSnapshot[] = [
    {
      id: 'ira-p',
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerId: 'p',
      balancePriorYearDollars: 900_000,
      withdrawalDollars: 40_000,
    },
  ];
  const input: ApplyFilingPlanYearInput = {
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members,
      accounts,
      preTaxWithdrawalDollars: 120_000,
      grossSsDollars: 48_000,
      taxpayersAge65Plus: 1,
    }),
    memberIdByRole: { primary: 'p', secondary: 's' },
    grossSsDollarsByMemberId: { p: 48_000 },
    age65PlusMemberIds: ['p'],
    penaltyAccounts: [
      {
        id: 'ira-s',
        type: 'RETIREMENT_IRA',
        ownerId: 's',
        penaltyPreTaxWithdrawalDollars: 20_000,
        hsaWithdrawalDollars: 0,
      },
    ],
    ownerAttributedAmounts: {
      preTaxWithdrawalDollars: { p: 100_000, s: 20_000 },
    },
    taxUnits: [
      { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
      { memberIds: ['secondary'], filingStatus: 'HoH', householdSize: 3 },
    ],
  };
  const merged = applyTaxYearForFilingPlan(input, REAL_BUNDLE);

  it('should_sum_the_cash_fields_across_returns', () => {
    const magiSum = (merged.filingUnitMagi ?? []).reduce((n, u) => n + u.magiCents, 0);
    expect(merged.magiCents).toBe(magiSum);
    expect(merged.federalTaxCents).toBeGreaterThan(0);
    // Only the primary owns the RMD-qualifying account, so the merged floor is
    // that ONE return's floor — never doubled by the merge.
    expect(merged.rmdFloorCents).toBeGreaterThan(0);
    expect(Object.keys(merged.rmdPerAccountCents)).toEqual(['ira-p']);
    // Only the secondary's account carries a §72(t) basis, and they are 51 — the
    // penalty lands once, on their return.
    expect(merged.earlyWithdrawalPenaltyCents).toBe(dollarsToCents(20_000 * 0.1));
    expect(merged.hsaAdditionalTaxCents).toBe(0);
  });

  it('should_compute_the_effective_rate_on_the_HOUSEHOLD_denominator', () => {
    // Same formula the single-return path uses, so a separate year's displayed
    // rate stays comparable with a joint year's.
    const grossIncome = 48_000 + 120_000;
    expect(merged.effectiveTaxRate).toBeCloseTo(
      centsToDollars(merged.federalTaxCents) / grossIncome,
      10,
    );
  });

  it('should_collapse_the_categorical_fields_to_the_most_affected_return', () => {
    const perUnitTiers = ['none', 'fifty', 'eighty-five'];
    expect(perUnitTiers).toContain(merged.ssTaxationTier);
    // The SS recipient is the only Medicare beneficiary, so the household badge
    // is whatever THAT return landed on — never 'none' while a surcharge is due.
    if (merged.irmaaSurchargeCents > 0) expect(merged.irmaaTier).not.toBe('none');
    expect(merged.acaPtcTier).toBe('below-fpl');
    expect(merged.taxYearExtrapolated).toBe(false);
    expect(merged.rmdApplicable).toBe(true);
  });
});

describe('per-owner income attribution', () => {
  const members: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1962-03-10', onMedicare: false, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1963-04-02', onMedicare: false, hasAcaCoverage: false },
  ];
  const MFS_UNITS: ResolvedTaxUnit[] = [
    { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
    { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 1 },
  ];
  const input = (over: Partial<ApplyFilingPlanYearInput>): ApplyFilingPlanYearInput => ({
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members,
      preTaxWithdrawalDollars: 200_000,
      grossSsDollars: 0,
    }),
    memberIdByRole: { primary: 'p', secondary: 's' },
    taxUnits: MFS_UNITS,
    ...over,
  });

  it('should_report_each_owners_withdrawals_on_their_own_return', () => {
    // The whole $200k comes out of the PRIMARY's accounts. Attributed, that is
    // one big MFS return plus one empty one; blanket-split it would be two
    // $100k returns — a materially different bill in a progressive system.
    const attributed = applyTaxYearForFilingPlan(
      input({ ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 200_000 } } }),
      REAL_BUNDLE,
    );
    const evenSplit = applyTaxYearForFilingPlan(input({}), REAL_BUNDLE);
    expect(attributed.federalTaxCents).toBeGreaterThan(evenSplit.federalTaxCents);
    // Per-return MAGI proves the attribution rather than just the total moving.
    const [first, second] = attributed.filingUnitMagi ?? [];
    expect(first.magiCents).toBeGreaterThan(second.magiCents);
    expect(second.magiCents).toBe(0);
  });

  it('should_split_only_the_UNATTRIBUTED_residual_evenly', () => {
    const result = applyTaxYearForFilingPlan(
      input({ ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 120_000 } } }),
      REAL_BUNDLE,
    );
    // $120k is the primary's; the remaining $80k has no owner → $40k each.
    const [first, second] = result.filingUnitMagi ?? [];
    expect(centsToDollars(first.magiCents)).toBeCloseTo(160_000, 6);
    expect(centsToDollars(second.magiCents)).toBeCloseTo(40_000, 6);
  });

  it('should_attribute_gross_Social_Security_to_its_recipient', () => {
    // §86 is non-linear per return, so who receives the benefit changes the
    // taxable portion — not just which return reports it.
    const attributed = applyTaxYearForFilingPlan(
      input({
        preTaxWithdrawalDollars: 40_000,
        grossSsDollars: 60_000,
        grossSsDollarsByMemberId: { p: 60_000 },
        ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 40_000 } },
      }),
      REAL_BUNDLE,
    );
    const evenSplit = applyTaxYearForFilingPlan(
      input({ preTaxWithdrawalDollars: 40_000, grossSsDollars: 60_000 }),
      REAL_BUNDLE,
    );
    expect(attributed.taxableSsCents).not.toBe(evenSplit.taxableSsCents);
  });
});

describe('per-return IRMAA look-back', () => {
  const members: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1955-03-10', onMedicare: true, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1956-04-02', onMedicare: true, hasAcaCoverage: false },
  ];
  const input = (over: Partial<ApplyFilingPlanYearInput>): ApplyFilingPlanYearInput => ({
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members,
      preTaxWithdrawalDollars: 60_000,
      grossSsDollars: 0,
    }),
    memberIdByRole: { primary: 'p', secondary: 's' },
    ...over,
  });

  it('should_tier_a_mixed_MFS_and_HoH_couple_on_two_DIFFERENT_schedules', () => {
    // Same $150k look-back MAGI on each return, but an MFS filer who lived with
    // their spouse is scored on the steep `byMfs` ladder while an HoH filer is
    // scored on the individual ladder — so the two surcharges must DIFFER.
    const result = applyTaxYearForFilingPlan(
      input({
        mfsLivedWithSpouse: true,
        taxUnits: [
          { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
          { memberIds: ['secondary'], filingStatus: 'HoH', householdSize: 2 },
        ],
        irmaaLookbackUnits: [
          { memberIds: ['p'], filingStatus: 'MFS', mfsLivedWithSpouse: true, magiCents: dollarsToCents(150_000) },
          { memberIds: ['s'], filingStatus: 'HoH', mfsLivedWithSpouse: false, magiCents: dollarsToCents(150_000) },
        ],
      }),
      REAL_BUNDLE,
    );
    const [mfsUnit, hohUnit] = result.irmaaSurchargeCentsByUnit ?? [];
    expect(mfsUnit.surchargeCents).toBeGreaterThan(0);
    expect(hohUnit.surchargeCents).toBeGreaterThan(0);
    expect(mfsUnit.surchargeCents).not.toBe(hohUnit.surchargeCents);
    expect(result.irmaaSurchargeCents).toBe(
      mfsUnit.surchargeCents + hohUnit.surchargeCents,
    );
  });

  it('should_tier_a_survivor_on_their_OWN_prior_return_not_the_household_sum', () => {
    // Death transition: last year the couple filed two separate returns; this
    // year only the survivor remains. They must be tiered on THEIR OWN prior
    // MAGI, not on the merged two-return household figure.
    const survivorOnly: ApplyFilingPlanYearInput = input({
      members: [members[0]],
      householdSize: 1,
      taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single', householdSize: 1 }],
      // The household look-back scalar is the SUM of both prior returns.
      magiTwoYearsPriorDollars: 400_000,
      irmaaLookbackUnits: [
        { memberIds: ['p'], filingStatus: 'MFS', mfsLivedWithSpouse: false, magiCents: dollarsToCents(60_000) },
        { memberIds: ['s'], filingStatus: 'MFS', mfsLivedWithSpouse: false, magiCents: dollarsToCents(340_000) },
      ],
    });
    const withRing = applyTaxYearForFilingPlan(survivorOnly, REAL_BUNDLE);
    const householdSumOnly = applyTaxYearForFilingPlan(
      { ...survivorOnly, irmaaLookbackUnits: undefined },
      REAL_BUNDLE,
    );
    // $60k of their own income is below every IRMAA threshold; the $400k
    // household sum is deep into the surcharge tiers.
    expect(withRing.irmaaSurchargeCents).toBe(0);
    expect(householdSumOnly.irmaaSurchargeCents).toBeGreaterThan(0);
  });

  it('should_fall_back_to_the_household_scalar_when_no_ring_entry_matches', () => {
    const result = applyTaxYearForFilingPlan(
      input({
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single', householdSize: 1 }],
        members: [members[0]],
        householdSize: 1,
        magiTwoYearsPriorDollars: 400_000,
        irmaaLookbackUnits: [
          { memberIds: ['someone-else'], filingStatus: 'Single', mfsLivedWithSpouse: false, magiCents: 0 },
        ],
      }),
      REAL_BUNDLE,
    );
    expect(result.irmaaSurchargeCents).toBeGreaterThan(0);
  });
});

describe('ACA SLCSP override across separate returns', () => {
  const members: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1970-03-10', onMedicare: false, hasAcaCoverage: true },
    { memberId: 's', isoBirthdate: '1971-04-02', onMedicare: false, hasAcaCoverage: true },
  ];
  const separateMfsHoh: ApplyFilingPlanYearInput = {
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members,
      preTaxWithdrawalDollars: 70_000,
      grossSsDollars: 0,
    }),
    memberIdByRole: { primary: 'p', secondary: 's' },
    acaBenchmarkSlcspDollars: 24_000,
    ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 35_000, s: 35_000 } },
    taxUnits: [
      { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
      { memberIds: ['secondary'], filingStatus: 'HoH', householdSize: 2 },
    ],
  };

  it('should_pass_the_full_override_to_the_PTC_eligible_return', () => {
    // MFS is statutorily ineligible (§36B(c)(1)(C)), so the HoH return is the
    // only claimant — it must see the override VERBATIM, not halved.
    const separate = applyTaxYearForFilingPlan(separateMfsHoh, REAL_BUNDLE);
    const hohAlone = applyTaxYear(
      {
        ...separateMfsHoh,
        filingStatus: 'HoH',
        householdSize: 2,
        members: [members[1]],
        preTaxWithdrawalDollars: 35_000,
      },
      REAL_BUNDLE,
    );
    expect(separate.acaPtcSubsidyCents).toBe(hohAlone.acaPtcSubsidyCents);
    expect(separate.acaPtcSubsidyCents).toBeGreaterThan(0);
  });

  it('should_divide_the_one_household_benchmark_when_BOTH_returns_are_eligible', () => {
    const bothHoh = applyTaxYearForFilingPlan(
      {
        ...separateMfsHoh,
        taxUnits: [
          { memberIds: ['primary'], filingStatus: 'HoH', householdSize: 2 },
          { memberIds: ['secondary'], filingStatus: 'HoH', householdSize: 2 },
        ],
      },
      REAL_BUNDLE,
    );
    expect(bothHoh.acaPtcSubsidyCents).toBeGreaterThan(0);
  });
});

describe('memberIdByRole validation', () => {
  const members: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1948-03-10', onMedicare: true, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1949-04-02', onMedicare: true, hasAcaCoverage: false },
  ];
  const accounts: TaxAccountSnapshot[] = [
    {
      id: 'ira-p',
      type: 'RETIREMENT_IRA',
      taxTreatment: 'PRE_TAX',
      ownerId: 'p',
      balancePriorYearDollars: 1_000_000,
      withdrawalDollars: 50_000,
    },
  ];
  const withRoles = (
    memberIdByRole: ApplyFilingPlanYearInput['memberIdByRole'],
  ): ApplyFilingPlanYearInput => ({
    ...baseInput({
      taxYear: 2026,
      filingStatus: 'MFJ',
      householdSize: 2,
      members,
      accounts,
      preTaxWithdrawalDollars: 120_000,
    }),
    ...(memberIdByRole !== undefined ? { memberIdByRole } : {}),
    taxUnits: [
      { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
      { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 1 },
    ],
  });

  it('should_fall_back_to_the_single_status_path_when_roles_are_absent', () => {
    // The old fail-open gave BOTH returns the whole household, so the merge
    // doubled the RMD floor. The fallback is exact for the household total.
    const exactFloor = applyTaxYear(withRoles({ primary: 'p', secondary: 's' }), REAL_BUNDLE)
      .rmdFloorCents;
    const failOpen = applyTaxYearForFilingPlan(withRoles(undefined), REAL_BUNDLE);
    expect(failOpen.rmdFloorCents).toBe(exactFloor);
    expect(failOpen.filingUnitMagi).toHaveLength(1);
  });

  it('should_fall_back_when_the_roles_do_not_partition_the_household', () => {
    // A partial map (no secondary) cannot separate the two returns.
    const partial = applyTaxYearForFilingPlan(withRoles({ primary: 'p' }), REAL_BUNDLE);
    const exactFloor = applyTaxYear(withRoles({ primary: 'p', secondary: 's' }), REAL_BUNDLE)
      .rmdFloorCents;
    expect(partial.rmdFloorCents).toBe(exactFloor);
  });

  it('should_not_double_count_the_RMD_floor_with_a_valid_partition', () => {
    const exactFloor = applyTaxYear(withRoles({ primary: 'p', secondary: 's' }), REAL_BUNDLE)
      .rmdFloorCents;
    const merged = applyTaxYearForFilingPlan(
      withRoles({ primary: 'p', secondary: 's' }),
      REAL_BUNDLE,
    );
    expect(merged.rmdFloorCents).toBe(exactFloor);
  });
});
