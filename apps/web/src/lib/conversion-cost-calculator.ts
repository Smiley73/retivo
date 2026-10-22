/**
 * Incremental all-in cost probe for a Roth conversion.
 *
 * Re-runs the four real federal tax engines — §86 SS-taxation, IRMAA (the
 * 2-years-prior surcharge), ACA-PTC, and the ordinary federal bracket tax — at a
 * baseline income state and at `+ conversionCents`, returning the marginal
 * (delta) cost per engine and the combined all-in cost / rate. The two-arg
 * `(input, bundle)` shape mirrors `applyTaxYear(input, bundle)` so the probe
 * threads the same typed inputs and resolves the same year-keyed snapshots
 * (never throwing `UnsupportedTaxYearError`) rather than re-deriving scalars.
 *
 * The federal delta is a bracket-only delta on the caller's already-post-
 * deduction taxable-income proxy. KNOWN LIMITATION: it does NOT model the
 * OBBBA senior-bonus deduction's 6%-of-MAGI phase-out (2025-2028, age-65+). A
 * conversion that raises MAGI inside the phase-out band shrinks that deduction,
 * raising taxable income by slightly MORE than `conversionCents`, so the probe
 * modestly UNDERSTATES the income-tax delta there. A correct cascade would need
 * `taxpayersAge65Plus` (to know whether anyone qualifies and how many caps to
 * phase out), which `AllInConversionCostInput` does NOT carry — so the cascade
 * is documented and bounded rather than corrected. Bounded to 2025-2028; the
 * break-even page lists it under "Simplified or left out" (`docs/math-retirement-accounts.md`).
 */

import { computeSsTaxation } from './ss-taxation';
import { computeIrmaa, computeMonthAwareIrmaa, type IrmaaBeneficiaryEnrollment } from './irmaa';
import { computeAcaPtc, type AcaFplRegion } from './aca-ptc';
import { federalOrdinaryTaxCents, type FilingStatus } from './federal-tax';
import {
  resolveSnapshotYear,
  resolveFederalTaxSnapshotForYear,
  type TaxCalibrationBundle,
} from './tax-integration-helpers';

/**
 * Every value the four engines need for the incremental probe. None is
 * derivable from `taxableIncomeCents` / `magiCents` alone — the §86 / IRMAA /
 * ACA engines each require the threaded inputs below.
 */
export interface AllInConversionCostInput {
  /**
   * Projection calendar year — `number`, NOT the engine's
   * `TaxYear = 2024|2025|2026` union, because retirement rows span 2030/2035.
   * Year-keyed snapshots come from `resolveFederalTaxSnapshotForYear` /
   * `resolveSnapshotYear`, both of which accept arbitrary years and extrapolate.
   */
  readonly year: number;
  readonly filingStatus: FilingStatus;
  /** The conversion amount being probed, in integer cents. Must be > 0. */
  readonly conversionCents: number;
  /**
   * Total-taxable proxy base, ALREADY post-deduction. The federal income-
   * tax delta is the bracket-only delta of `federalOrdinaryTaxCents` at this
   * value vs `+ conversionCents` — NOT `computeFederalTax`, whose `TaxInput`
   * takes pre-deduction dollars and re-subtracts the standard deduction.
   */
  readonly taxableIncomeCents: number;
  /** Baseline federal / IRMAA MAGI (`DrawdownYear.magiCents`), integer cents. */
  readonly magiCents: number;
  /**
   * Baseline §86 taxable-SS (`DrawdownYear.taxableSsCents`), integer cents.
   * Used to derive `otherAgiForSsCents` and the ACA full-SS add-back.
   */
  readonly taxableSsCents: number;
  /**
   * Annual GROSS SS from the scenario's `SocialSecurityBenefit` aggregate
   * (NOT `taxableSsCents`, which is already post-§86), integer cents. Required
   * to re-run §86 provisional income and to add back the nontaxable SS portion
   * for ACA MAGI.
   */
  readonly grossSsAnnualCents: number;
  /** §86(b) tax-exempt-interest add-back, integer cents. 0 in the current model. */
  readonly taxExemptInterestCents: number;
  /** Household members enrolled in Medicare — required by `computeIrmaa`. */
  readonly beneficiariesOnMedicareCount: 0 | 1 | 2;
  /** Each beneficiary's Part B / Part D months in year `year + 2`; when present
   *  it replaces the count above, else every beneficiary is billed 12 months. */
  readonly irmaaBeneficiaries?: readonly IrmaaBeneficiaryEnrollment[];
  /** `members.length` — required by `computeAcaPtc`. */
  readonly householdSize: number;
  /** User override else `defaultHouseholdSlcspByAge`, integer cents. */
  readonly benchmarkAnnualSlcspCents: number;
  /**
   * The household's federal-poverty-level region, so the probe
   * sizes the lost credit against the SAME poverty line the live projection
   * uses. Absent → `'contiguous'` (the 48-state schedule), the default for every household
   * that sets no region.
   */
  readonly acaFplRegion?: AcaFplRegion;
  /**
   * The household's Marketplace coverage MONTHS for the row's year.
   * §36B(b)(2) sums the credit over coverage months, so a household covered for
   * part of the year has a proportionally smaller credit to lose. Absent → 12.
   */
  readonly acaCoverageMonths?: number;
  /**
   * Scenario projection inflation rate (e.g. 2.5 for 2.5%). The probe feeds it
   * to `resolveSnapshotYear` to resolve the year-keyed IRMAA/ACA snapshots and
   * their scaling factors, exactly as `applyTaxYear` does. The bundle carries
   * only base snapshots, not pre-scaled per-year tables, so the scaling cannot
   * be read off the bundle.
   */
  readonly inflationRatePct: number;
}

/** Per-engine marginal deltas + the combined all-in cost of one conversion. */
export interface AllInConversionCostResult {
  /** Federal ordinary income-tax delta on the conversion dollars, integer cents (≥ 0). */
  readonly incomeTaxDeltaCents: number;
  /** §86 SS-taxation delta — extra income tax from more taxable SS, integer cents (≥ 0). */
  readonly ssTaxDeltaCents: number;
  /** IRMAA Y+2 surcharge delta, integer cents (≥ 0). */
  readonly irmaaDeltaCents: number;
  /** ACA-PTC delta — LOST subsidy is a positive cost, integer cents (≥ 0). */
  readonly ptcDeltaCents: number;
  /** Sum of the four deltas above, integer cents. */
  readonly allInCents: number;
  /** `allInCents / conversionCents` — the all-in effective rate (0..1+). */
  readonly allInRate: number;
}

/** Round to the nearest integer cent (engine inputs must be safe integers). */
function roundCents(cents: number): number {
  return Math.round(cents);
}

/**
 * Taxable-SS amount (integer cents) under §86 at a given `otherAgi`. The
 * conversion adds to `otherAgi`, raising provisional income and possibly moving
 * SS across the 0% / 50% / 85% tiers. §86 thresholds are statutorily fixed
 * (not inflation-indexed), so `bundle.ssTax` is used with no scaling — exactly
 * as `applyTaxYear` passes `bundle.ssTax`.
 */
function taxableSsAt(
  input: AllInConversionCostInput,
  bundle: TaxCalibrationBundle,
  otherAgiCents: number,
): number {
  return computeSsTaxation(
    {
      grossSsCents: roundCents(input.grossSsAnnualCents),
      otherAgiCents: roundCents(Math.max(0, otherAgiCents)),
      taxExemptInterestCents: roundCents(input.taxExemptInterestCents),
      filingStatus: input.filingStatus,
      taxYear: input.year,
    },
    bundle.ssTax,
  ).taxableSsCents;
}

/** IRMAA household surcharge (integer cents) for a given current-year MAGI. The
 *  conversion raises year-`year` MAGI, which moves the surcharge in `year + 2`. */
function irmaaSurchargeAt(
  input: AllInConversionCostInput,
  bundle: TaxCalibrationBundle,
  magiCents: number,
): number {
  // IRMAA's 2-years-prior rule: the surcharge at `year` is priced from the
  // `year + 2` table; the flat count bills every beneficiary all 12 months.
  const { irmaaBeneficiaries } = input;
  if (irmaaBeneficiaries === undefined && input.beneficiariesOnMedicareCount === 0) return 0;
  if (irmaaBeneficiaries !== undefined && irmaaBeneficiaries.length === 0) return 0;
  // Resolve the SURCHARGE year's table (year + 2) + its scaling. Passing the
  // resolved/clamped effectiveYear as taxYear keeps computeIrmaa's strict lookup
  // from throwing for future rows (the raw year + 2 may not exist in the table).
  const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
    bundle.irmaa,
    input.year + 2,
    input.inflationRatePct,
  );
  const magiTwoYearsPriorCents = roundCents(Math.max(0, magiCents) / thresholdScalingFactor);
  const totalHouseholdAnnualCents =
    irmaaBeneficiaries === undefined
      ? computeIrmaa(
          {
            taxYear: effectiveYear,
            magiTwoYearsPriorCents,
            filingStatus: input.filingStatus,
            beneficiariesOnMedicareCount: input.beneficiariesOnMedicareCount,
          },
          bundle.irmaa,
        ).totalHouseholdAnnualCents
      : computeMonthAwareIrmaa(
          {
            taxYear: effectiveYear,
            lookback: { magiCents: magiTwoYearsPriorCents, filingStatus: input.filingStatus },
            beneficiaries: irmaaBeneficiaries,
          },
          bundle.irmaa,
        ).totalHouseholdAnnualCents;
  // Re-inflate the surcharge dollars to projection-year dollars (the MAGI was
  // deflated above for tier classification only), mirroring applyTaxYear.
  return Math.round(totalHouseholdAnnualCents * thresholdScalingFactor);
}

/** ACA PTC subsidy (integer cents) for a given ACA MAGI (full-SS add-back already
 *  applied by the caller). The conversion raises year-`year` MAGI. */
function acaSubsidyAt(
  input: AllInConversionCostInput,
  bundle: TaxCalibrationBundle,
  acaMagiCents: number,
): number {
  const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(
    bundle.acaPtc,
    input.year,
    input.inflationRatePct,
  );
  return computeAcaPtc(
    {
      taxYear: effectiveYear,
      filingStatus: input.filingStatus,
      householdSize: input.householdSize,
      magiCents: roundCents(Math.max(0, acaMagiCents) / thresholdScalingFactor),
      benchmarkAnnualSlcspCents: roundCents(input.benchmarkAnnualSlcspCents),
      expectedContributionScalingFactor: thresholdScalingFactor,
      // Price the SAME ACA position the live projection prices:
      // the household's own poverty-guideline schedule and its actual coverage
      // months, not a contiguous-48 full-year approximation.
      ...(input.acaFplRegion !== undefined ? { fplRegion: input.acaFplRegion } : {}),
      ...(input.acaCoverageMonths !== undefined
        ? { coverageMonths: input.acaCoverageMonths }
        : {}),
    },
    bundle.acaPtc,
  ).annualPtcCents;
}

/**
 * Probe the all-in incremental cost of converting `conversionCents` at one row.
 *
 * Each delta = a re-run at baseline vs `+ conversionCents`:
 *   - income tax: bracket-only federal delta on the post-deduction proxy;
 *   - §86: the EXTRA taxable SS the conversion drags into income, valued at the
 *     row's marginal income-tax rate (the federal delta across that SS slice);
 *   - IRMAA: the `year + 2` surcharge delta from the higher current-year MAGI;
 *   - ACA: the LOST PTC subsidy (a positive cost) from the higher ACA MAGI.
 *
 * @param input  Every threaded engine input (line-by-line in AllInConversionCostInput).
 * @param bundle The calibration bundle (same one applyTaxYear consumes).
 * @returns Per-engine deltas + the combined all-in cost / rate.
 */
export function computeAllInConversionCost(
  input: AllInConversionCostInput,
  bundle: TaxCalibrationBundle,
): AllInConversionCostResult {
  const { conversionCents, taxableIncomeCents, magiCents, taxableSsCents } = input;

  // --- Federal year-keyed snapshot (bundle.federalTax, NOT the global config) ---
  const { lookupYear, snapshot: federalSnapshot } = resolveFederalTaxSnapshotForYear(
    bundle.federalTax,
    input.year,
    input.inflationRatePct,
  );

  // --- §86 taxable-SS delta (baseline vs +conversion otherAgi) ---
  const otherAgiBaseCents = Math.max(
    0,
    magiCents - taxableSsCents - input.taxExemptInterestCents,
  );
  const ssBaseCents = taxableSsAt(input, bundle, otherAgiBaseCents);
  const ssBumpCents = taxableSsAt(input, bundle, otherAgiBaseCents + conversionCents);
  const ssTaxableDeltaCents = Math.max(0, ssBumpCents - ssBaseCents);

  // --- Federal income-tax delta on the conversion dollars (bracket-only) ---
  const baseFedCents = federalOrdinaryTaxCents(
    taxableIncomeCents,
    lookupYear,
    input.filingStatus,
    federalSnapshot,
  );
  const conversionFedCents = federalOrdinaryTaxCents(
    taxableIncomeCents + conversionCents,
    lookupYear,
    input.filingStatus,
    federalSnapshot,
  );
  const incomeTaxDeltaCents = Math.max(0, conversionFedCents - baseFedCents);

  // §86 cost = the income tax on the EXTRA taxable SS, stacked on top of the
  // conversion dollars (so it is valued at the post-conversion marginal rate).
  const ssStackedFedCents = federalOrdinaryTaxCents(
    taxableIncomeCents + conversionCents + ssTaxableDeltaCents,
    lookupYear,
    input.filingStatus,
    federalSnapshot,
  );
  const ssTaxDeltaCents = Math.max(0, ssStackedFedCents - conversionFedCents);

  // --- IRMAA Y+2 surcharge delta (baseline vs +conversion MAGI) ---
  // The conversion raises ordinary income, which raises §86 provisional income
  // and may drag MORE SS into the taxable base (ssTaxableDeltaCents, derived
  // above). IRMAA MAGI is AGI-based and AGI includes the taxable SS portion, so
  // the bumped IRMAA MAGI rises by the conversion PLUS that incremental taxable
  // SS — not by the conversion alone (§86 → IRMAA cascade).
  const irmaaBaseCents = irmaaSurchargeAt(input, bundle, magiCents);
  const irmaaBumpCents = irmaaSurchargeAt(
    input,
    bundle,
    magiCents + conversionCents + ssTaxableDeltaCents,
  );
  const irmaaDeltaCents = Math.max(0, irmaaBumpCents - irmaaBaseCents);

  // --- ACA-PTC delta (LOST subsidy is a positive cost) ---
  // ACA MAGI adds back the full nontaxable SS portion (gross − taxable).
  const acaMagiBaseCents = magiCents + Math.max(0, input.grossSsAnnualCents - taxableSsCents);
  const acaSubsidyBaseCents = acaSubsidyAt(input, bundle, acaMagiBaseCents);
  const acaSubsidyBumpCents = acaSubsidyAt(input, bundle, acaMagiBaseCents + conversionCents);
  const ptcDeltaCents = Math.max(0, acaSubsidyBaseCents - acaSubsidyBumpCents);

  const allInCents = incomeTaxDeltaCents + ssTaxDeltaCents + irmaaDeltaCents + ptcDeltaCents;
  const allInRate = conversionCents > 0 ? allInCents / conversionCents : 0;

  return {
    incomeTaxDeltaCents,
    ssTaxDeltaCents,
    irmaaDeltaCents,
    ptcDeltaCents,
    allInCents,
    allInRate,
  };
}
