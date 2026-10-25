/**
 * ACA Premium Tax Credit engine (IRC §36B sliding scale), in integer cents. Regimes: 'ira-expanded'
 * (2024-2025, no 400% cliff) and 'pre-arpa' (2026+, cliff reinstated).
 */

import type { CalibrationSnapshot } from './calibration';
import type { FilingStatus } from './federal-tax';

type AcaFilingStatus = FilingStatus;

/**
 * Federal-poverty-level region: HHS publishes separate schedules for the 48 states + DC, Alaska and Hawaii.
 * A higher poverty line gives a lower FPL% and usually a larger subsidy. Absent means 'contiguous'.
 */
export type AcaFplRegion = 'contiguous' | 'alaska' | 'hawaii';

/**
 * False only for MFS (§36B(c)(1)(C)). The "considered unmarried" exception (Treas. Reg. §1.36B-2(b)(2)) is not
 * modeled because the household model carries no such attestation, so MFS always gets $0. `applyTaxYear` gates
 * on this, so an MFS unit never reaches `computeAcaPtc`.
 */
export function acaPtcEligibleForFilingStatus(status: FilingStatus): boolean {
  return status !== 'MFS';
}

interface AcaApplicableFigureBand {
  readonly fplFloorPct: number;
  readonly fplCeilingPct: number;
  readonly floorContributionPct: number;
  readonly ceilingContributionPct: number;
}

interface AcaFplRegionParams {
  readonly base: number;
  readonly increment: number;
}

interface AcaFplParams extends AcaFplRegionParams {
  readonly alaska?: AcaFplRegionParams;
  readonly hawaii?: AcaFplRegionParams;
}

export interface AcaPtcTable {
  /** Eligibility above 400% FPL: 'ira-expanded' (ARPA §9661 as extended by the IRA) has no cliff; 'pre-arpa' reinstates it. */
  readonly regime: 'ira-expanded' | 'pre-arpa';
  /** Prior-year FPL parameters (N-1 lag per Rev Proc 2014-37 §4.02). */
  readonly fpl: AcaFplParams;
  readonly bands: readonly AcaApplicableFigureBand[];
}

class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(readonly year: number) {
    super(`ACA PTC: no calibration data for tax year ${year}`);
    this.name = 'UnsupportedTaxYearError';
  }
}

export class AcaPtcInvalidInputError extends Error {
  readonly code = 'ACA_PTC_INVALID_INPUT' as const;
  constructor(readonly reason: string) {
    super(`ACA PTC: invalid input — ${reason}`);
    this.name = 'AcaPtcInvalidInputError';
  }
}

type AcaPtcTier = 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';

export interface AcaPtcInput {
  readonly taxYear: number;
  readonly filingStatus: AcaFilingStatus;
  readonly householdSize: number;
  readonly magiCents: number;
  /**
   * Benchmark SLCSP premium in cents, already summed over the covered member-months. §36B(b)(2) sums the credit
   * over coverage months, so this and `coverageMonths` must span the same months: a whole-year benchmark with
   * a part-year count over-credits by `(12 − coverageMonths) × monthly benchmark`.
   */
  readonly benchmarkAnnualSlcspCents: number;
  /**
   * Re-inflation multiplier for the output `expectedContributionCents`: `magiCents` is deflated to the clamped
   * snapshot year, so the affordability output is in that year's dollars. The benchmark is already in
   * projection-year dollars. Absent or <= 0 means 1.
   */
  readonly expectedContributionScalingFactor?: number;
  /** FPL region for the denominator; absent means 'contiguous'. */
  readonly fplRegion?: AcaFplRegion;
  /**
   * Marketplace coverage months (0..12). §36B(b)(2) sums `monthly benchmark − applicable% × income ÷ 12` over
   * coverage months (Form 8962 lines 12–23), so a non-coverage month contributes zero on both sides. Absent means 12.
   */
  readonly coverageMonths?: number;
}

export interface AcaPtcResult {
  readonly annualPtcCents: number;
  readonly fplPercentage: number;
  readonly applicableFigurePct: number;
  readonly tier: AcaPtcTier;
  readonly fplDollars: number;
  /** Expected contribution for the credited coverage months: MAGI × applicable figure × coverageMonths ÷ 12; 0 when ineligible. */
  readonly expectedContributionCents: number;
  readonly coverageMonths: number;
  readonly eligible: boolean;
}

function assertCentField(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AcaPtcInvalidInputError(`${name} must be a non-negative integer (cents); got ${value}`);
  }
}

function validateInput(input: AcaPtcInput): void {
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new AcaPtcInvalidInputError(`taxYear must be an integer 2000-2100; got ${input.taxYear}`);
  }
  if (input.filingStatus === 'MFS') {
    // §36B(c)(1)(C): MFS is ineligible (the "considered unmarried" exception is unmodeled). Callers gate on
    // `acaPtcEligibleForFilingStatus`, so reaching here with MFS is a caller bug: fail fast.
    throw new AcaPtcInvalidInputError(
      'MFS is statutorily ineligible for the PTC (§36B(c)(1)(C)); gate on acaPtcEligibleForFilingStatus and emit $0 before calling computeAcaPtc',
    );
  }
  if (
    input.filingStatus !== 'Single' &&
    input.filingStatus !== 'MFJ' &&
    input.filingStatus !== 'HoH' &&
    input.filingStatus !== 'QSS'
  ) {
    throw new AcaPtcInvalidInputError(
      `filingStatus must be Single, MFJ, HoH, or QSS; got ${String(input.filingStatus)}`,
    );
  }
  if (!Number.isInteger(input.householdSize) || input.householdSize < 1) {
    throw new AcaPtcInvalidInputError(`householdSize must be a positive integer; got ${input.householdSize}`);
  }
  assertCentField(input.magiCents, 'magiCents');
  assertCentField(input.benchmarkAnnualSlcspCents, 'benchmarkAnnualSlcspCents');
  if (
    input.coverageMonths !== undefined &&
    (!Number.isInteger(input.coverageMonths) ||
      input.coverageMonths < 0 ||
      input.coverageMonths > 12)
  ) {
    throw new AcaPtcInvalidInputError(
      `coverageMonths must be an integer between 0 and 12; got ${input.coverageMonths}`,
    );
  }
}

function interpolateApplicableFigure(
  fplPercentage: number,
  band: AcaApplicableFigureBand,
): number {
  const { fplFloorPct, fplCeilingPct, floorContributionPct, ceilingContributionPct } = band;
  if (floorContributionPct === ceilingContributionPct) {
    return floorContributionPct;
  }
  const rangePct = fplCeilingPct - fplFloorPct;
  const positionInBand = (fplPercentage - fplFloorPct) / rangePct;
  const raw = floorContributionPct + positionInBand * (ceilingContributionPct - floorContributionPct);
  return Math.round(raw * 10_000) / 10_000;
}

function ineligibleResult(
  tier: 'below-fpl' | 'above-400-cliff',
  fplPercentage: number,
  fplDollars: number,
): AcaPtcResult {
  return {
    annualPtcCents: 0,
    fplPercentage,
    applicableFigurePct: 0,
    tier,
    fplDollars,
    expectedContributionCents: 0,
    coverageMonths: 0,
    eligible: false,
  };
}

function resolveEligibilityTier(regime: AcaPtcTable['regime'], fplPercentage: number): AcaPtcTier {
  if (regime === 'ira-expanded' && fplPercentage >= 400) return 'cap-applies';
  return 'sliding';
}

function resolveApplicableFigurePct(
  tier: AcaPtcTier,
  fplPercentage: number,
  bands: readonly AcaApplicableFigureBand[],
  taxYear: number,
): number {
  if (tier === 'cap-applies') {
    const capBand = bands.find((b) => !Number.isFinite(b.fplCeilingPct));
    if (capBand === undefined) {
      throw new AcaPtcInvalidInputError(`no cap band found in snapshot for tax year ${taxYear}`);
    }
    return capBand.floorContributionPct;
  }

  // Sliding: lower-inclusive / upper-exclusive matching; last band is inclusive on both ends.
  const band = bands.find(
    (b, idx) =>
      fplPercentage >= b.fplFloorPct &&
      (idx === bands.length - 1 ? fplPercentage <= b.fplCeilingPct : fplPercentage < b.fplCeilingPct),
  );
  // Pre-ARPA, a raw FPL% in (400, 401) is subsidy-eligible by the whole-percent cliff floor (400.9 → 400) but
  // falls just past the top band's inclusive ceiling; Form 8962 truncates to a whole percent, so clamp to the top band.
  if (band === undefined && bands.length > 0) {
    const topBand = bands[bands.length - 1];
    if (
      Math.floor(fplPercentage) <= topBand.fplCeilingPct &&
      fplPercentage > topBand.fplCeilingPct
    ) {
      return interpolateApplicableFigure(topBand.fplCeilingPct, topBand);
    }
  }
  if (band === undefined) {
    throw new AcaPtcInvalidInputError(
      `no applicable-figure band found for FPL% ${fplPercentage.toFixed(2)} in tax year ${taxYear}`,
    );
  }
  return interpolateApplicableFigure(fplPercentage, band);
}

/**
 * Computes the ACA Premium Tax Credit for a household.
 * @throws {AcaPtcInvalidInputError} on invalid input.
 * @throws {UnsupportedTaxYearError} when the snapshot has no row for the tax year.
 */
export function computeAcaPtc(
  input: AcaPtcInput,
  snapshot: CalibrationSnapshot<AcaPtcTable>,
): AcaPtcResult {
  validateInput(input);

  const table = snapshot.values[input.taxYear as keyof typeof snapshot.values];
  if (table === undefined) throw new UnsupportedTaxYearError(input.taxYear);

  const { fpl, bands, regime } = table;
  const { magiCents, benchmarkAnnualSlcspCents, householdSize } = input;

  const fplDollars = fplDollarsForRegion(fpl, householdSize, input.fplRegion ?? 'contiguous');
  const fplPercentage = (magiCents / 100 / fplDollars) * 100;
  // Form 8962 reports income as a whole percent of FPL, so the pre-ARPA >400% cliff test floors it
  // (400.9 → 400 is not over the cliff); every other use keeps the raw value.
  const fplPercentageForCliff = Math.floor(fplPercentage);

  if (fplPercentage < 100) return ineligibleResult('below-fpl', fplPercentage, fplDollars);
  if (regime === 'pre-arpa' && fplPercentageForCliff > 400) {
    return ineligibleResult('above-400-cliff', fplPercentage, fplDollars);
  }

  const tier = resolveEligibilityTier(regime, fplPercentage);
  const applicableFigurePct = resolveApplicableFigurePct(tier, fplPercentage, bands, input.taxYear);
  // Re-inflate to projection-year dollars (`magiCents` is deflated to the clamped snapshot year); the benchmark is already priced for the year.
  const contributionScaling =
    input.expectedContributionScalingFactor !== undefined &&
    input.expectedContributionScalingFactor > 0
      ? input.expectedContributionScalingFactor
      : 1;
  // §36B(b)(2) sums the credit over coverage months, so the contribution is prorated over the same range as
  // the covered-member-month benchmark; a whole-year contribution against a part-year benchmark understates the credit.
  const coverageMonths = input.coverageMonths ?? 12;
  const annualContributionCents = magiCents * applicableFigurePct * contributionScaling;
  // Keep the 12-month branch separate so a whole-year household is byte-identical to the annual formula
  // (`(x / 12) * 12` is not exactly `x` in IEEE-754).
  const expectedContributionCents =
    coverageMonths === 12
      ? Math.round(annualContributionCents)
      : Math.round((annualContributionCents * coverageMonths) / 12);
  const annualPtcCents = Math.max(0, benchmarkAnnualSlcspCents - expectedContributionCents);

  return { annualPtcCents, fplPercentage, applicableFigurePct, tier, fplDollars, expectedContributionCents, coverageMonths, eligible: true };
}

/**
 * Poverty line in dollars: `base + (householdSize - 1) × increment`, from the region's HHS schedule when the
 * year's row carries one, else the contiguous pair. That fallback usually understates the line (overstating
 * FPL% and understating the subsidy), but near the 100% floor it can make an ineligible household look
 * eligible, so it is not universally conservative.
 *
 * @throws {AcaPtcInvalidInputError} householdSize is not a positive integer.
 */
export function fplDollarsForRegion(
  fpl: AcaFplParams,
  householdSize: number,
  region: AcaFplRegion,
): number {
  if (!Number.isInteger(householdSize) || householdSize < 1) {
    throw new AcaPtcInvalidInputError(`householdSize must be a positive integer; got ${householdSize}`);
  }
  const params: AcaFplRegionParams =
    region === 'alaska'
      ? (fpl.alaska ?? fpl)
      : region === 'hawaii'
        ? (fpl.hawaii ?? fpl)
        : fpl;
  return params.base + (householdSize - 1) * params.increment;
}

/**
 * Rough age-priced ACA benchmark, not an exchange quote: a base monthly premium at a reference age growing a
 * fixed percentage per year of age. The one source of the age-premium curve ($700/mo at age 60, +5%/yr):
 * `acaBenchmarkByAge` in tax-integration-helpers.ts derives from it (×12), so the curves cannot drift.
 * Per member per month; `baseYear` is the year the base amount is priced in.
 */
export const ROUGH_BENCHMARK_ASSUMPTIONS = {
  baseMonthlyDollars: 700,
  baseAge: 60,
  ageGrowthRate: 0.05,
  baseYear: 2026,
  disclosure:
    "Rough estimate: age-priced benchmark ($700/mo at age 60 in 2026, +5% per year of age), summed per covered member per covered month and grown each year after 2026 at the scenario's medical inflation rate — not an exchange SLCSP quote. Editable per year.",
} as const;

/**
 * Grow the age-priced annual benchmark (integer cents) from the base year to
 * `taxYear` at the scenario's medical inflation rate, rounded once. Identity at or
 * before the base year or without a rate. A user-entered benchmark never passes
 * through here.
 */
export function growRoughBenchmarkCents(
  annualCents: number,
  taxYear: number,
  medicalRatePct: number | undefined,
): number {
  if (medicalRatePct === undefined) return annualCents;
  const years = Math.max(0, taxYear - ROUGH_BENCHMARK_ASSUMPTIONS.baseYear);
  if (years === 0) return annualCents;
  return Math.round(annualCents * Math.pow(1 + medicalRatePct / 100, years));
}

// An off-curve age (negative or fractional) has no benchmark: fail fast rather than price it.
function assertBenchmarkAge(age: number): void {
  if (!Number.isSafeInteger(age) || age < 0) {
    throw new AcaPtcInvalidInputError(`age must be a non-negative integer; got ${age}`);
  }
}

/**
 * Rough monthly SLCSP benchmark (cents) for one member at `age`; region changes only the FPL denominator, not
 * this curve.
 *
 * @throws {AcaPtcInvalidInputError} age is invalid, or the exponential curve overflows the safe-integer cent range.
 */
export function roughMonthlyBenchmarkCentsForMember(age: number): number {
  assertBenchmarkAge(age);
  const { baseMonthlyDollars, baseAge, ageGrowthRate } = ROUGH_BENCHMARK_ASSUMPTIONS;
  const monthly = baseMonthlyDollars * Math.pow(1 + ageGrowthRate, age - baseAge);
  const cents = Math.round(monthly * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new AcaPtcInvalidInputError(
      `benchmark premium for age ${age} exceeds the safe integer cent range; got ${cents}`,
    );
  }
  return cents;
}

export interface AcaMemberCoverage {
  readonly age: number;
  readonly marketplaceMonths: number;
}

/**
 * Household annual rough benchmark (cents): the sum over members of
 * `roughMonthlyBenchmarkCentsForMember(age) × marketplaceMonths`. `overrideAnnualDollars` (the `acaPtcBenchmark`
 * scenario field) is used verbatim and bypasses the fallback, so a caller with a whole-year override for a
 * part-year household must prorate it first (`overrideBenchmarkCentsForCoverageMonths`).
 *
 * @throws {AcaPtcInvalidInputError} on a month count outside [0, 12], an invalid age on any member (even a
 *   zero-month one), a negative or non-finite override, or a sum that overflows the safe-integer cent range.
 */
export function roughHouseholdAnnualBenchmarkCents(
  members: readonly AcaMemberCoverage[],
  overrideAnnualDollars?: number,
): number {
  if (overrideAnnualDollars !== undefined) {
    if (!Number.isFinite(overrideAnnualDollars) || overrideAnnualDollars < 0) {
      throw new AcaPtcInvalidInputError(
        `overrideAnnualDollars must be a finite number >= 0; got ${overrideAnnualDollars}`,
      );
    }
    const overrideCents = Math.round(overrideAnnualDollars * 100);
    if (!Number.isSafeInteger(overrideCents)) {
      throw new AcaPtcInvalidInputError(
        `overrideAnnualDollars ${overrideAnnualDollars} exceeds the safe integer cent range; got ${overrideCents}`,
      );
    }
    return overrideCents;
  }
  const total = members.reduce((sum, m) => {
    if (!Number.isInteger(m.marketplaceMonths) || m.marketplaceMonths < 0 || m.marketplaceMonths > 12) {
      throw new AcaPtcInvalidInputError(
        `marketplaceMonths must be an integer between 0 and 12; got ${m.marketplaceMonths}`,
      );
    }
    // Every member's age is validated, even at zero months; a covered member's is validated inside
    // `roughMonthlyBenchmarkCentsForMember` (asserting twice would cost the Monte Carlo hot path).
    if (m.marketplaceMonths === 0) {
      assertBenchmarkAge(m.age);
      return sum;
    }
    return sum + roughMonthlyBenchmarkCentsForMember(m.age) * m.marketplaceMonths;
  }, 0);
  if (!Number.isSafeInteger(total)) {
    throw new AcaPtcInvalidInputError(
      `household benchmark exceeds the safe integer cent range; got ${total}`,
    );
  }
  return total;
}
