/**
 * The rough ACA benchmark grows from its 2026 base year at the scenario's medical
 * inflation rate; a user-entered benchmark is used as entered. Golden numbers are
 * worked by hand; the medical rates are deliberately not 5% or the general rate.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTaxYear,
  applyTaxYearForFilingPlan,
  type ApplyFilingPlanYearInput,
  type TaxCalibrationBundle,
  type TaxMemberInput,
  type TaxYearInput,
} from './tax-integration';
import { growRoughBenchmarkCents, ROUGH_BENCHMARK_ASSUMPTIONS } from './aca-ptc';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

const BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

describe('growRoughBenchmarkCents', () => {
  it('case A: 7% medical for 3 years on the age-62 annual benchmark', () => {
    // Age 62: 700 × 1.05² = $771.75/mo = 77,175 cents; × 12 = 926,100.
    // × 1.07³ (1.225043) = 1,134,512.32 → 1,134,512.
    expect(growRoughBenchmarkCents(926_100, 2029, 7)).toBe(1_134_512);
  });

  it('is the identity at the base year and before it', () => {
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseYear).toBe(2026);
    expect(growRoughBenchmarkCents(926_100, 2026, 7)).toBe(926_100);
    expect(growRoughBenchmarkCents(926_100, 2025, 7)).toBe(926_100);
    expect(growRoughBenchmarkCents(926_100, 2024, 7)).toBe(926_100);
  });

  it('is the identity at a 0% rate and when the rate is absent', () => {
    expect(growRoughBenchmarkCents(926_100, 2035, 0)).toBe(926_100);
    expect(growRoughBenchmarkCents(926_100, 2035, undefined)).toBe(926_100);
  });

  it('returns an integer number of cents', () => {
    expect(Number.isInteger(growRoughBenchmarkCents(926_101, 2044, 7.25))).toBe(true);
  });
});

describe('applyTaxYear — rough ACA benchmark growth', () => {
  const member: TaxMemberInput = {
    memberId: 'm1',
    isoBirthdate: '1968-01-01', // age 60 in 2028
    onMedicare: false,
    hasAcaCoverage: true,
  };

  /** Case B/C household: single, 12 months, ACA MAGI exactly 200% of the
   *  deflated 2026 poverty line once the 4% general inflation is removed. */
  function caseInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
    return {
      taxYear: 2028,
      filingStatus: 'Single',
      grossSsDollars: 0,
      preTaxWithdrawalDollars: 33_854.08,
      postTaxNonRothWithdrawalDollars: 0,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: 0,
      taxExemptInterestDollars: 0,
      householdSize: 1,
      members: [member],
      accounts: [],
      taxpayersAge65Plus: 0,
      inflationRatePct: 4,
      ...overrides,
    };
  }

  it('case B: grows the age-priced benchmark at the medical rate (general 4% + 2 pp)', () => {
    // MAGI 3,385,408 / 1.0816 = 3,130,000 = exactly 200% FPL → 6.60%.
    // Expected contribution = round(3,130,000 × 0.066 × 1.0816) = 223,437.
    // Benchmark = 840,000 × 1.06² = 943,824. Credit = 720,387.
    const grown = applyTaxYear(caseInput({ medicalInflationRatePct: 6 }), BUNDLE);
    expect(grown.acaPtcSubsidyCents).toBe(720_387);
    // Without the field the engine reproduces today's output: 840,000 − 223,437.
    const ungrown = applyTaxYear(caseInput(), BUNDLE);
    expect(ungrown.acaPtcSubsidyCents).toBe(616_563);
  });

  it('case C: a user-entered benchmark is used verbatim at any medical rate', () => {
    // $9,000 entered for 2028: 900,000 − 223,437 = 676,563.
    const at = (medicalInflationRatePct: number | undefined) =>
      applyTaxYear(
        caseInput({ acaBenchmarkSlcspDollars: 9_000, medicalInflationRatePct }),
        BUNDLE,
      ).acaPtcSubsidyCents;
    expect(at(0)).toBe(676_563);
    expect(at(6)).toBe(676_563);
    expect(at(undefined)).toBe(676_563);
  });

  it('case E: the base year is priced exactly as today', () => {
    const at2026 = (medicalInflationRatePct: number | undefined) =>
      applyTaxYear(
        caseInput({
          taxYear: 2026,
          inflationRatePct: undefined,
          preTaxWithdrawalDollars: 31_300,
          members: [{ ...member, isoBirthdate: '1966-01-01' }],
          medicalInflationRatePct,
        }),
        BUNDLE,
      ).acaPtcSubsidyCents;
    expect(at2026(7)).toBe(at2026(undefined));
  });

  it('a separate-return (MFS + HoH) year grows the eligible unit’s fallback', () => {
    const members: TaxMemberInput[] = [
      { memberId: 'p', isoBirthdate: '1968-03-10', onMedicare: false, hasAcaCoverage: false },
      { memberId: 's', isoBirthdate: '1968-04-02', onMedicare: false, hasAcaCoverage: true },
    ];
    const plan = (medicalInflationRatePct: number | undefined): ApplyFilingPlanYearInput => ({
      ...caseInput({
        filingStatus: 'MFJ',
        householdSize: 2,
        members,
        preTaxWithdrawalDollars: 60_000,
        medicalInflationRatePct,
      }),
      memberIdByRole: { primary: 'p', secondary: 's' },
      ownerAttributedAmounts: { preTaxWithdrawalDollars: { p: 30_000, s: 30_000 } },
      taxUnits: [
        { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
        { memberIds: ['secondary'], filingStatus: 'HoH', householdSize: 2 },
      ],
    });
    const grown = applyTaxYearForFilingPlan(plan(6), BUNDLE).acaPtcSubsidyCents;
    const ungrown = applyTaxYearForFilingPlan(plan(undefined), BUNDLE).acaPtcSubsidyCents;
    // The HoH unit's benchmark is the covered spouse's age-60 annual premium,
    // grown 1.06²; its contribution is unchanged, so the credit rises by exactly
    // the growth of the benchmark.
    expect(grown - ungrown).toBe(943_824 - 840_000);
    expect(ungrown).toBeGreaterThan(0);
  });
});
