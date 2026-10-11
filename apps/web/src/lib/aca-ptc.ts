/**
 * ACA Premium Tax Credit engine — IRC §36B sliding-scale formula.
 *
 * Pure functions only. `applyTaxYearForFilingPlan` reaches
 * this engine on the live planning path, once per resolved tax unit, so an
 * `HoH` return inside a separate-filing plan really is credited a PTC and an
 * `MFS` return really is gated out (§36B(c)(1)(C)).
 * Monetary I/O in integer cents. Supports two regimes:
 *   'ira-expanded'  — 2024-2025 (no 400% cliff)
 *   'pre-arpa'      — 2026+ (400% cliff reinstated by statute expiry)
 */

import type { CalibrationSnapshot } from './calibration';
import type { FilingStatus } from './federal-tax';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/** ACA §36B filing-status alias. MFS is statutorily ineligible (§36B(c)(1)(C)). */
type AcaFilingStatus = FilingStatus;

/**
 * Federal-poverty-level region. HHS publishes THREE
 * poverty-guideline schedules: one for the 48 contiguous states + DC, a higher
 * one for Alaska, and a distinct one for Hawaii. The region selects which
 * `base`/`increment` pair the FPL denominator is computed from — a household in
 * Alaska/Hawaii has a higher poverty line, so the same MAGI is a LOWER FPL% and
 * (usually) a larger subsidy. Absent → `'contiguous'` (the default; every
 * existing scenario keeps its 48-state FPL). The scenario's
 * `acaFplRegion` reaches `computeAcaPtc` on the live planning path.
 */
export type AcaFplRegion = 'contiguous' | 'alaska' | 'hawaii';

/**
 * Whether a filing status may claim the ACA Premium Tax Credit.
 *
 * `false` ONLY for `MFS`: §36B(c)(1)(C) denies the PTC to married taxpayers
 * filing separately. A narrow statutory exception exists — a spouse "considered
 * unmarried" (lived apart the last six months, or a victim of domestic abuse /
 * spousal abandonment, Treas. Reg. §1.36B-2(b)(2)) — but it is NOT modeled here
 * (the household model carries no such attestation); the default is always-zero
 * PTC for MFS. Do not infer the exception. Every other
 * status (`Single`, `MFJ`, `HoH`, `QSS`) is eligible and computes normally.
 * The tax pass `applyTaxYear` gates the PTC on this predicate, so an MFS
 * unit emits $0 rather than reaching (and throwing from) `computeAcaPtc`.
 */
export function acaPtcEligibleForFilingStatus(status: FilingStatus): boolean {
  return status !== 'MFS';
}

// ---------------------------------------------------------------------------
// Schema types (re-used by aca-ptc-parameters.ts)
// ---------------------------------------------------------------------------

/** One row in the applicable-figure table (Table 2 of the relevant Rev Proc). */
interface AcaApplicableFigureBand {
  /** Lower bound of FPL%, inclusive. */
  readonly fplFloorPct: number;
  /** Upper bound of FPL%, inclusive on the last band; exclusive on others. */
  readonly fplCeilingPct: number;
  /** Applicable figure at the floor (4 decimal places). */
  readonly floorContributionPct: number;
  /** Applicable figure at the ceiling (4 decimal places). */
  readonly ceilingContributionPct: number;
}

/** One region's federal-poverty-guideline pair (dollars). */
interface AcaFplRegionParams {
  /** Base FPL for a single-person household (dollars). */
  readonly base: number;
  /** Per-additional-person increment (dollars). */
  readonly increment: number;
}

/**
 * Federal poverty level parameters for a single year. `base`/`increment` are
 * the 48 contiguous states + DC schedule (the default, and the values
 * `computeAcaPtc` reads for every household that sets no region).
 * `alaska`/`hawaii` carry the two higher HHS regional schedules, read
 * through `fplDollarsForRegion`; absent → the contiguous pair is used
 * for that region (fallback: the lower contiguous line usually overstates FPL% and
 * understates estimated subsidy, but near the 100%-FPL floor it can flip an
 * ineligible household to eligible — not universally conservative, see
 * `fplDollarsForRegion`).
 */
interface AcaFplParams extends AcaFplRegionParams {
  /** Alaska HHS poverty guidelines (higher than contiguous). Sparse. */
  readonly alaska?: AcaFplRegionParams;
  /** Hawaii HHS poverty guidelines (between contiguous and Alaska). Sparse. */
  readonly hawaii?: AcaFplRegionParams;
}

/** Full calibration table for one tax year. */
export interface AcaPtcTable {
  /**
   * Regime flag — determines eligibility above 400% FPL.
   *   'ira-expanded': 2024-2025 rules (§9661 of ARPA extended by IRA 2022).
   *   'pre-arpa':     2026+ if no further extension (400% cliff reinstated).
   */
  readonly regime: 'ira-expanded' | 'pre-arpa';
  /** Prior-year FPL params (N-1 lag per Rev Proc 2014-37 §4.02). */
  readonly fpl: AcaFplParams;
  /** Applicable figure bands, ordered by ascending fplFloorPct. */
  readonly bands: readonly AcaApplicableFigureBand[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnsupportedTaxYearError extends Error {
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

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Which portion of the FPL range the household falls into.
 *   below-fpl        — MAGI < 100% FPL → ineligible (marketplace subsidy reserved
 *                       for those above Medicaid threshold).
 *   sliding          — 100-400% (pre-arpa) or 100-400% (ira-expanded, below cap).
 *   cap-applies      — ≥ 400% FPL under ira-expanded regime; flat 8.5% applies.
 *   above-400-cliff  — > 400% FPL under pre-arpa regime → ineligible.
 */
type AcaPtcTier = 'below-fpl' | 'sliding' | 'cap-applies' | 'above-400-cliff';

export interface AcaPtcInput {
  readonly taxYear: number;
  readonly filingStatus: AcaFilingStatus;
  /** Household size (≥ 1). */
  readonly householdSize: number;
  /** Modified Adjusted Gross Income in cents (≥ 0). */
  readonly magiCents: number;
  /**
   * Benchmark SLCSP premium for the household in cents (≥ 0), **already summed
   * over the household's covered member-months** — NOT a whole-year price when
   * `coverageMonths` is below 12.
   *
   * §36B(b)(2) sums the credit over coverage months, so this figure and
   * `coverageMonths` must describe the SAME month range: the engine subtracts a
   * contribution prorated to `coverageMonths` from this number, and a whole-year
   * benchmark paired with a part-year month count over-credits the household by
   * `(12 − coverageMonths) × monthly benchmark`.
   *
   * Both production callers satisfy the contract by construction: the rough
   * age-priced fallback (`roughHouseholdAnnualBenchmarkCents`) multiplies each
   * member's monthly premium by that member's covered months, and a user-entered
   * whole-year override is prorated first by
   * `overrideBenchmarkCentsForCoverageMonths` (tax-integration-helpers.ts).
   */
  readonly benchmarkAnnualSlcspCents: number;
  /**
   * Re-inflation multiplier applied to the OUTPUT
   * `expectedContributionCents` so the future-dollar affordability figure keeps
   * pace with the projection horizon. `magiCents` is already deflated to the
   * clamped snapshot year by the caller (for tier classification), so the
   * affordability output — `MAGI(deflated) × applicableFigure` — comes back in
   * clamped-year dollars and must be re-inflated to projection-year dollars.
   * The benchmark premium input is already expressed in projection-year
   * (calibration) dollars, so it is NOT scaled here. Absent or ≤ 0 → 1.0 (no
   * scaling).
   */
  readonly expectedContributionScalingFactor?: number;
  /**
   * Federal-poverty-level region for the FPL denominator. HHS publishes a
   * separate (higher) poverty-guideline schedule for Alaska and Hawaii, so the
   * same MAGI is a LOWER FPL% — and usually a larger subsidy — there. Absent →
   * `'contiguous'`, which resolves to the same `base`/`increment` pair the
   * engine used before this field existed (byte-identical output for every
   * scenario that does not set a region). Sourced from
   * `ScenarioOverrides.acaFplRegion`.
   */
  readonly fplRegion?: AcaFplRegion;
  /**
   * The number of calendar months the household had Marketplace coverage
   * (integer 0..12). IRC §36B(b)(2) computes the credit as the SUM OVER
   * COVERAGE MONTHS of `monthly benchmark − applicable% × household income ÷ 12`
   * (IRS Form 8962 lines 12–23), so a non-coverage month contributes ZERO on
   * BOTH sides. `benchmarkAnnualSlcspCents` is already summed over covered
   * member-months, and this field prorates the expected contribution by the same
   * range. Absent → 12 (a whole covered year), which reproduces the annual
   * formula exactly for every full-year household.
   */
  readonly coverageMonths?: number;
}

export interface AcaPtcResult {
  /** Annual PTC in cents (≥ 0; zero when ineligible). */
  readonly annualPtcCents: number;
  /** Household's MAGI as a percentage of FPL (e.g. 250 = 250%). */
  readonly fplPercentage: number;
  /**
   * Applicable figure percentage used in the computation (4 decimal places).
   * Zero when ineligible.
   */
  readonly applicableFigurePct: number;
  /** FPL-range classification for this household. */
  readonly tier: AcaPtcTier;
  /** Dollar value of FPL for this household size and year. */
  readonly fplDollars: number;
  /**
   * Expected household contribution in cents for the COVERAGE MONTHS actually
   * credited — `MAGI × applicable figure × coverageMonths ÷ 12`. Equal to
   * the full annual figure for a 12-month household; `0` when ineligible.
   */
  readonly expectedContributionCents: number;
  /** The coverage months the credit was summed over (0..12). */
  readonly coverageMonths: number;
  /** True when the household qualifies for a PTC (tier is sliding or cap-applies). */
  readonly eligible: boolean;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function assertCentField(value: number, name: string): void {
  // Number.isSafeInteger rejects NaN, Infinity, floats, and values > MAX_SAFE_INTEGER.
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AcaPtcInvalidInputError(`${name} must be a non-negative integer (cents); got ${value}`);
  }
}

function validateInput(input: AcaPtcInput): void {
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new AcaPtcInvalidInputError(`taxYear must be an integer 2000-2100; got ${input.taxYear}`);
  }
  if (input.filingStatus === 'MFS') {
    // §36B(c)(1)(C): MFS is ineligible for the PTC (except the unmodeled
    // "considered unmarried" exception). Callers gate on
    // `acaPtcEligibleForFilingStatus` and emit a $0 PTC BEFORE calling this
    // engine, so reaching it with MFS is a caller bug — fail fast rather than
    // silently return a positive credit an MFS filer cannot claim.
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

/**
 * Linear interpolation of the applicable figure within a band.
 * Returns a value rounded to 4 decimal places (matching IRS table precision).
 */
function interpolateApplicableFigure(
  fplPercentage: number,
  band: AcaApplicableFigureBand,
): number {
  const { fplFloorPct, fplCeilingPct, floorContributionPct, ceilingContributionPct } = band;
  // Flat band (floor === ceiling, or Infinity ceiling with equal rates).
  if (floorContributionPct === ceilingContributionPct) {
    return floorContributionPct;
  }
  const rangePct = fplCeilingPct - fplFloorPct;
  const positionInBand = (fplPercentage - fplFloorPct) / rangePct;
  const raw = floorContributionPct + positionInBand * (ceilingContributionPct - floorContributionPct);
  return Math.round(raw * 10_000) / 10_000;
}

/** Build the ineligible result object for below-FPL and above-400-cliff tiers. */
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

/** Determine the eligible tier for households at or above 100% FPL. */
function resolveEligibilityTier(regime: AcaPtcTable['regime'], fplPercentage: number): AcaPtcTier {
  if (regime === 'ira-expanded' && fplPercentage >= 400) return 'cap-applies';
  return 'sliding';
}

/**
 * Determine the applicable figure percentage for an eligible household.
 * Short-circuits to the cap-band rate when tier is cap-applies (no band search needed).
 */
function resolveApplicableFigurePct(
  tier: AcaPtcTier,
  fplPercentage: number,
  bands: readonly AcaApplicableFigureBand[],
  taxYear: number,
): number {
  // IRA-expanded cap: find the open-ended band (fplCeilingPct = Infinity) for its flat rate.
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
  // Pre-ARPA, a raw FPL% in the (400, 401) sliver is rendered
  // subsidy-eligible by the whole-percent cliff floor (400.9 → 400 ≤ 400), but
  // the raw value falls just past the top band's inclusive ceiling, so the
  // band search above misses. Form 8962 truncates household income to a whole
  // percent, so such a household pays the top band's flat rate. Clamp to the
  // top band here. This NEVER changes a value at or below the top ceiling
  // (every ARPA / in-range case still matches its own band first), so
  // ARPA / sliding output stays byte-identical.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the ACA Premium Tax Credit for a household.
 *
 * @param input   Validated household inputs for the tax year.
 * @param snapshot  Year-keyed calibration config (ACA_PTC_PARAMETERS).
 * @throws {AcaPtcInvalidInputError}  Invalid input fields.
 * @throws {UnsupportedTaxYearError}  No calibration row for taxYear.
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

  // The FPL denominator is region-aware. `fplDollarsForRegion` returns the
  // contiguous pair for `'contiguous'` (and for an Alaska/Hawaii request the
  // year's calibration row cannot serve), so an absent region reproduces the
  // household-size formula `base + (householdSize - 1) × increment` exactly.
  const fplDollars = fplDollarsForRegion(fpl, householdSize, input.fplRegion ?? 'contiguous');
  const fplPercentage = (magiCents / 100 / fplDollars) * 100;
  // Form 8962 reports household income as a WHOLE percent of the FPL, so
  // the >400% cliff test floors the percentage (400.9% → 400 → not over the
  // cliff). This floored value is used ONLY for the pre-ARPA hard-cliff
  // comparison below; the raw `fplPercentage` continues to feed the <100%
  // floor, eligibility-tier resolution, sliding-scale interpolation, and the
  // returned `fplPercentage` field, so ARPA/post-ARPA output is unchanged.
  const fplPercentageForCliff = Math.floor(fplPercentage);

  if (fplPercentage < 100) return ineligibleResult('below-fpl', fplPercentage, fplDollars);
  if (regime === 'pre-arpa' && fplPercentageForCliff > 400) {
    return ineligibleResult('above-400-cliff', fplPercentage, fplDollars);
  }

  const tier = resolveEligibilityTier(regime, fplPercentage);
  const applicableFigurePct = resolveApplicableFigurePct(tier, fplPercentage, bands, input.taxYear);
  // Re-inflate the affordability output to projection-year dollars. The
  // `magiCents` input is already deflated to the clamped snapshot year for tier
  // classification, so `MAGI(deflated) × applicableFigure` is in clamped-year
  // dollars; scaling restores projection-year dollars. The benchmark premium is
  // NOT scaled: nothing inflates it (the rough fallback depends on age alone, and
  // a user-entered override is used as entered for its year).
  const contributionScaling =
    input.expectedContributionScalingFactor !== undefined &&
    input.expectedContributionScalingFactor > 0
      ? input.expectedContributionScalingFactor
      : 1;
  // §36B(b)(2) sums the credit over COVERAGE MONTHS, each month crediting
  // `monthly benchmark − applicable% × household income ÷ 12`. The benchmark
  // input is already summed over covered member-months, so the contribution must
  // be prorated by the SAME month range: subtracting a whole year's contribution
  // from a part-year benchmark understates the credit (usually to $0). Absent →
  // 12, which reduces to the plain annual formula exactly.
  const coverageMonths = input.coverageMonths ?? 12;
  const annualContributionCents = magiCents * applicableFigurePct * contributionScaling;
  // The 12-month branch is written out rather than folded into the proration so
  // a whole-year household is BYTE-identical to the plain annual formula
  // (`(x / 12) * 12` is not exactly `x` in IEEE-754 and could shift a cent).
  const expectedContributionCents =
    coverageMonths === 12
      ? Math.round(annualContributionCents)
      : Math.round((annualContributionCents * coverageMonths) / 12);
  const annualPtcCents = Math.max(0, benchmarkAnnualSlcspCents - expectedContributionCents);

  return { annualPtcCents, fplPercentage, applicableFigurePct, tier, fplDollars, expectedContributionCents, coverageMonths, eligible: true };
}

// ---------------------------------------------------------------------------
// Region-aware FPL + per-member monthly rough benchmark
// ---------------------------------------------------------------------------
//
// The live `computeAcaPtc` prices per-member, month-aware benchmarks
// against a region-aware FPL. These are the pieces the month-aware,
// per-member, region-aware health-coverage engine needs — all pure, and all
// reached from the live planning path:
//   - `fplDollarsForRegion`  — the poverty line for a household size + region.
//   - `roughMonthlyBenchmarkCentsForMember` — a rough per-MEMBER, per-MONTH SLCSP
//     premium estimate (the transparent fallback the user can override).
//   - `roughHouseholdAnnualBenchmarkCents` — the household benchmark as the SUM
//     of each covered member's monthly premium × their covered months (NOT
//     the oldest member's premium × covered count), or a user
//     annual override used verbatim.

/**
 * Resolve the federal poverty line (dollars) for a household size and region.
 * `alaska`/`hawaii` use their own HHS schedule when the year's calibration row
 * carries one; absent → the contiguous pair. That fallback usually UNDERSTATES
 * the true Alaska/Hawaii poverty line, so it usually overstates the household's
 * FPL% and understates its estimated subsidy — but near the 100%-FPL
 * eligibility floor the lower contiguous line can push an otherwise-ineligible
 * Alaska/Hawaii household above 100% FPL and make it appear eligible (the
 * opposite direction), so the fallback is not universally conservative.
 * `fplDollars = base + (householdSize - 1) × increment`.
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
 * Rough ACA benchmark assumptions. The fallback benchmark is an
 * age-priced approximation, NOT an exchange quote: a base monthly premium at a
 * reference age growing a fixed percentage per year of age. Surfaced wherever
 * the ACA estimate is shown/exported so the assumption is never presented as a
 * real SLCSP. This is the SINGLE SOURCE OF TRUTH for the age-premium curve
 * ($700/mo at age 60, +5%/yr): the annual `acaBenchmarkByAge` in
 * `tax-integration-helpers.ts` derives its base/growth/age from these constants
 * (×12 to annual dollars), so the two curves cannot drift apart. Expressed
 * per member per month so the household benchmark can be summed per member.
 */
export const ROUGH_BENCHMARK_ASSUMPTIONS = {
  baseMonthlyDollars: 700,
  baseAge: 60,
  ageGrowthRate: 0.05,
  disclosure:
    'Rough estimate: age-priced benchmark ($700/mo at age 60, +5% per year of age), summed per covered member per covered month — not an exchange SLCSP quote. Editable per year.',
} as const;

/**
 * Assert a member `age` is usable on the rough age-premium curve. The
 * curve is only meaningful for a finite, non-negative INTEGER age: a negative
 * age (-5) or fractional age (60.5) has no benchmark and must fail fast rather
 * than silently price an off-curve premium. `Number.isSafeInteger` rejects NaN,
 * Infinity, floats, and values beyond `MAX_SAFE_INTEGER` in one check (matches
 * `assertCentField`); the `< 0` guard rejects negatives.
 *
 * @throws {AcaPtcInvalidInputError} age is not a non-negative safe integer.
 */
function assertBenchmarkAge(age: number): void {
  if (!Number.isSafeInteger(age) || age < 0) {
    throw new AcaPtcInvalidInputError(`age must be a non-negative integer; got ${age}`);
  }
}

/**
 * Rough MONTHLY SLCSP benchmark premium (integer cents) for one covered member
 * at `age`. The transparent, user-overridable fallback. Region does NOT change the premium curve
 * (only the FPL denominator), so this takes only age.
 *
 * @throws {AcaPtcInvalidInputError} age is not a non-negative integer, or
 *   a large-but-finite age overflows the integer-cent contract (the exponential
 *   curve can exceed `MAX_SAFE_INTEGER` before hitting `Infinity`) — signalled
 *   rather than returning an out-of-range value.
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

/** One covered member's age + Marketplace coverage months for the year. */
export interface AcaMemberCoverage {
  /** Member age this tax year. */
  readonly age: number;
  /** ACA Marketplace coverage months this year (0..12). */
  readonly marketplaceMonths: number;
}

/**
 * Household annual rough benchmark (integer cents) — the SUM over covered
 * members of `roughMonthlyBenchmarkCentsForMember(age) × marketplaceMonths`
 * (a genuine per-member sum, NOT the oldest member's premium ×
 * covered count). A user-supplied annual override (`overrideAnnualDollars`, the
 * reused `acaPtcBenchmark` scenario field) is used VERBATIM (×100 to cents) and
 * bypasses the age/month fallback entirely — so a caller passing a
 * WHOLE-YEAR override for a part-year household must prorate it first
 * (`overrideBenchmarkCentsForCoverageMonths`); the live integration layer
 * never passes this argument. Members with 0 marketplace months contribute $0.
 * Returns 0 for an empty covered set.
 *
 * @throws {AcaPtcInvalidInputError} a member's `marketplaceMonths`
 *   is not an integer in [0, 12], a member's `age` is not a non-negative integer
 *   (validated for EVERY member, including zero-month members that contribute
 *   $0 — an invalid age record is an input error regardless of coverage months),
 *   an `overrideAnnualDollars` that is non-finite or negative, or a benchmark
 *   sum/override that overflows the integer-cent contract
 *   (`Number.isSafeInteger`) — signalled rather than silently clamped/coerced,
 *   dropped back to the calculated value, or returned out of range.
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
    // Age is validated for EVERY member, so a member record with an invalid age
    // throws regardless of month count. A covered member's age is
    // validated once, INSIDE `roughMonthlyBenchmarkCentsForMember` — asserting
    // again here would double-validate on the Monte Carlo hot path.
    if (m.marketplaceMonths === 0) {
      assertBenchmarkAge(m.age);
      return sum;
    }
    // Annual coverage cost = monthly premium × covered months (12 → whole-year).
    return sum + roughMonthlyBenchmarkCentsForMember(m.age) * m.marketplaceMonths;
  }, 0);
  if (!Number.isSafeInteger(total)) {
    throw new AcaPtcInvalidInputError(
      `household benchmark exceeds the safe integer cent range; got ${total}`,
    );
  }
  return total;
}
