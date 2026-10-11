/**
 * IRMAA (Medicare Income-Related Monthly Adjustment Amount) engine.
 * Pure functions — no side effects, no I/O.
 */

import type { CalibrationSnapshot } from './calibration';
import { FilingStatus } from './federal-tax';
import type { IrmaaTable, IrmaaTableEntry } from './irmaa-tiers';
import { selectIrmaaScheduleEntries, entryAnnualSurchargeCents } from './irmaa-tiers';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Filing status for IRMAA lookups. HoH and QSS use Single tiers (QSS is an
 * individual filer for IRMAA). MFS (lived-with-spouse) uses its own steeper
 * `byMfs` schedule.
 */
export type IrmaaFilingStatus = FilingStatus;

export type { IrmaaTable } from './irmaa-tiers';

/**
 * One tax unit's buffered IRMAA look-back: the MAGI from the return two years
 * prior AND the filing status that return was filed under.
 * IRMAA must classify against the LOOK-BACK return's filing status, not the
 * current projection year's — a couple that filed MFJ two years ago but is now
 * a surviving-spouse `Single` unit is tiered on the MFJ ladder for that
 * surcharge year. Callers buffer this per tax unit and read the year-2-prior
 * entry. `applyTaxYearForFilingPlan` threads the look-back
 * return's filing status (and its MFS lived-together fact) into `computeIrmaa`.
 */
/** Internal to this module: the
 *  per-return look-back facts `IrmaaSurvivorTransitionInput` carries. */
interface IrmaaLookback {
  /** Look-back-year MAGI in integer cents. */
  readonly magiCents: number;
  /** Filing status the look-back return was filed under. */
  readonly filingStatus: IrmaaFilingStatus;
  /**
   * Only consulted when `filingStatus === 'MFS'`. CMS applies the steeper
   * two-band `byMfs` schedule ONLY to a beneficiary who lived with their spouse
   * at any time during the look-back tax year. `true` → `byMfs`; `false`/absent
   * → the individual `bySingle` ladder (lived apart all year). Ignored for every
   * other filing status.
   */
  readonly mfsLivedWithSpouse?: boolean;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** IRMAA tier label. 'none' = no surcharge (MAGI at or below tier1 threshold). */
type IrmaaTier = 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';

/** Annual per-beneficiary surcharge amounts in integer cents. */
export interface IrmaaResult {
  /** IRMAA tier the household falls into. */
  tier: IrmaaTier;
  /** Part B annual surcharge per beneficiary on Medicare, in cents. 0 for 'none'. */
  partBSurchargeCentsPerBeneficiary: number;
  /** Part D annual surcharge per beneficiary on Medicare, in cents. 0 for 'none'. */
  partDSurchargeCentsPerBeneficiary: number;
  /** Total household annual IRMAA surcharge (Part B + Part D × beneficiary count), in cents. */
  totalHouseholdAnnualCents: number;
}

/** Input to the IRMAA engine. All monetary values in integer cents. */
export interface IrmaaInput {
  /** Tax year for which to look up IRMAA brackets. */
  taxYear: number;
  /** Household MAGI from two years prior (the look-back year), in integer cents. */
  magiTwoYearsPriorCents: number;
  /** Household filing status. */
  filingStatus: IrmaaFilingStatus;
  /**
   * Only consulted when `filingStatus === 'MFS'`. `true` → the beneficiary
   * lived with their spouse at some point during the look-back year, so the
   * steeper two-band `byMfs` schedule applies. `false`/absent → the individual
   * `bySingle` ladder (lived apart all year, §1.36B-parallel CMS practice).
   * Ignored for every other filing status.
   */
  mfsLivedWithSpouse?: boolean;
  /**
   * Number of household members enrolled in Medicare Part B or Part D.
   * 0 means no beneficiaries → all-zero result short-circuit.
   * Maximum 2 (one household).
   */
  beneficiariesOnMedicareCount: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the requested tax year is not present in the calibration snapshot.
 * IRMAA uses strict-year lookup (no clamp-to-latest).
 */
export class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(`IRMAA brackets not available for tax year ${year}`);
    this.name = 'UnsupportedTaxYearError';
  }
}

/** Thrown when any field of IrmaaInput fails validation. */
export class IrmaaInvalidInputError extends Error {
  readonly code = 'IRMAA_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid IRMAA input: ${reason}`);
    this.name = 'IrmaaInvalidInputError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Assert a value is a non-negative safe integer (for cent-valued fields). */
function assertCentField(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be a non-negative safe integer (cents); got ${value}`,
    );
  }
}

/**
 * Assert a tax year is an integer in the supported [2000, 2100] range. Shared by
 * both the whole-year `validateInput` and `computeMonthAwareIrmaa` so the
 * two engines validate the year identically.
 */
function assertTaxYear(taxYear: number): void {
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    throw new IrmaaInvalidInputError(
      `taxYear must be an integer between 2000 and 2100; got ${taxYear}`,
    );
  }
}

/**
 * Assert a value is a supported IRMAA filing status (shared by both
 * engines). `fieldName` names the offending field in the error (the month-aware
 * engine passes `lookback.filingStatus`).
 */
function assertIrmaaFilingStatus(
  filingStatus: FilingStatus,
  fieldName = 'filingStatus',
): void {
  if (
    filingStatus !== 'Single' &&
    filingStatus !== 'MFJ' &&
    filingStatus !== 'HoH' &&
    filingStatus !== 'MFS' &&
    filingStatus !== 'QSS'
  ) {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be 'Single', 'MFJ', 'HoH', 'MFS', or 'QSS'; got ${String(filingStatus)}`,
    );
  }
}

/**
 * Assert mfsLivedWithSpouse is a genuine boolean or absent (shared
 * by both engines). A truthy non-boolean (e.g. the STRING "true") would
 * otherwise silently select the steeper byMfs schedule (or, when
 * falsy-but-non-boolean, wrongly fall through to bySingle) — fail fast like
 * every other field. `fieldName` names the offending field in the error.
 */
function assertMfsLivedWithSpouse(
  mfsLivedWithSpouse: boolean | undefined,
  fieldName = 'mfsLivedWithSpouse',
): void {
  if (mfsLivedWithSpouse !== undefined && typeof mfsLivedWithSpouse !== 'boolean') {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be a boolean or undefined; got ${String(mfsLivedWithSpouse)}`,
    );
  }
}

/** Validate all IrmaaInput fields before touching the snapshot. */
function validateInput(input: IrmaaInput): void {
  assertTaxYear(input.taxYear);
  assertCentField(input.magiTwoYearsPriorCents, 'magiTwoYearsPriorCents');
  assertIrmaaFilingStatus(input.filingStatus);
  assertMfsLivedWithSpouse(input.mfsLivedWithSpouse);
  if (
    !Number.isInteger(input.beneficiariesOnMedicareCount) ||
    input.beneficiariesOnMedicareCount < 0 ||
    input.beneficiariesOnMedicareCount > 2
  ) {
    throw new IrmaaInvalidInputError(
      `beneficiariesOnMedicareCount must be 0, 1, or 2; got ${input.beneficiariesOnMedicareCount}`,
    );
  }
}

/**
 * Resolve IRMAA tier from MAGI (cents) against a 5-entry tier array.
 * Cent-space comparison avoids float rounding at tier boundaries.
 *
 * Tier cliff inclusivity:
 *   Tiers 1–4: magi > thresholdDollars×100 → that tier
 *   Tier 5: magi >= thresholdDollars×100 → tier5 (inclusive upper end)
 */
function resolveTier(
  magiCents: number,
  entries: readonly IrmaaTableEntry[],
): IrmaaTier {
  if (magiCents >= entries[4].thresholdDollars * 100) return 'tier5';
  if (magiCents > entries[3].thresholdDollars * 100) return 'tier4';
  if (magiCents > entries[2].thresholdDollars * 100) return 'tier3';
  if (magiCents > entries[1].thresholdDollars * 100) return 'tier2';
  if (magiCents > entries[0].thresholdDollars * 100) return 'tier1';
  return 'none';
}

/** Convert a tier's monthly dollar surcharges to annual cents. Returns zeros for 'none'. */
function computeSurcharges(
  tier: IrmaaTier,
  entries: readonly IrmaaTableEntry[],
): { partBCents: number; partDCents: number } {
  if (tier === 'none') return { partBCents: 0, partDCents: 0 };
  const idx = parseInt(tier.replace('tier', ''), 10) - 1;
  return entryAnnualSurchargeCents(entries[idx]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute Medicare IRMAA surcharges for a household.
 *
 * @param input    - Validated household inputs (MAGI look-back, filing status, beneficiaries).
 * @param snapshot - Calibration snapshot keyed by tax year (Monte Carlo safe).
 * @throws {IrmaaInvalidInputError}   Any input field fails validation (fires first).
 * @throws {UnsupportedTaxYearError}  taxYear not present in snapshot (strict-year).
 */
export function computeIrmaa(
  input: IrmaaInput,
  snapshot: CalibrationSnapshot<IrmaaTable>,
): IrmaaResult {
  validateInput(input);

  // Short-circuit before snapshot read: no beneficiaries → no surcharge regardless of year.
  if (input.beneficiariesOnMedicareCount === 0) {
    return { tier: 'none', partBSurchargeCentsPerBeneficiary: 0, partDSurchargeCentsPerBeneficiary: 0, totalHouseholdAnnualCents: 0 };
  }

  const table = snapshot.values[input.taxYear];
  if (table === undefined) throw new UnsupportedTaxYearError(input.taxYear);

  // Filing-status routing lives in the shared `selectIrmaaScheduleEntries`
  // selector (MFS lived-with-spouse → the steeper byMfs schedule; MFS
  // lived-apart / Single / HoH / QSS → bySingle; MFJ → byMfj), so the whole-year
  // and month-aware engines can never disagree.
  const entries = selectIrmaaScheduleEntries(
    table,
    input.filingStatus,
    input.mfsLivedWithSpouse,
  );
  const tier = resolveTier(input.magiTwoYearsPriorCents, entries);
  const { partBCents, partDCents } = computeSurcharges(tier, entries);
  const totalHouseholdAnnualCents = (partBCents + partDCents) * input.beneficiariesOnMedicareCount;

  return { tier, partBSurchargeCentsPerBeneficiary: partBCents, partDSurchargeCentsPerBeneficiary: partDCents, totalHouseholdAnnualCents };
}

// ---------------------------------------------------------------------------
// Month-aware IRMAA
// ---------------------------------------------------------------------------
//
// `computeIrmaa` above charges a whole-year surcharge for every beneficiary. A
// beneficiary is only actually liable for the months they are ENROLLED, and Part
// B and Part D enrollment are INDEPENDENT — a member turning 65 mid-year, or
// transitioning from Marketplace coverage to Medicare, may start each part in a
// different month, or decline one part entirely. `computeMonthAwareIrmaa`
// prorates Part B and Part D SEPARATELY by each beneficiary's own month counts
// and consumes the LOOK-BACK return's filing status (via `IrmaaLookback`), so a
// surviving-spouse `Single` unit is still tiered on the MFJ ladder two years
// after the joint return. `tax-integration.ts` calls it on
// BOTH production engines' path (the deterministic runner and Monte Carlo), so
// this — not the whole-year `computeIrmaa` above — is the engine the projection
// charges. `computeIrmaa` survives only for the Roth-conversion probe.

/**
 * One beneficiary's Medicare enrollment months for a surcharge year. Part B and
 * Part D are counted independently (0 = not enrolled in that part → no surcharge
 * for it).
 */
export interface IrmaaBeneficiaryEnrollment {
  /** Medicare Part B enrollment months this year (integer 0..12). */
  readonly partBMonths: number;
  /** Medicare Part D enrollment months this year (integer 0..12). */
  readonly partDMonths: number;
}

/** Input to the month-aware IRMAA engine. */
export interface MonthAwareIrmaaInput {
  /** Tax year for which to look up IRMAA brackets. */
  readonly taxYear: number;
  /**
   * The LOOK-BACK return's MAGI + filing status (two years prior). Tiering uses
   * this status, not the current projection year's.
   */
  readonly lookback: IrmaaLookback;
  /** One entry per household member on Medicare (max 2). Empty → all-zero. */
  readonly beneficiaries: readonly IrmaaBeneficiaryEnrollment[];
}

/** Month-aware IRMAA result — Part B and Part D prorated separately. */
export interface MonthAwareIrmaaResult {
  /** IRMAA tier the household's look-back MAGI falls into. */
  readonly tier: IrmaaTier;
  /** Full-year (12-month) Part B surcharge per beneficiary at this tier, cents. */
  readonly partBAnnualCentsPerBeneficiary: number;
  /** Full-year Part D surcharge per beneficiary at this tier, cents. */
  readonly partDAnnualCentsPerBeneficiary: number;
  /** Household Part B surcharge after month proration across all beneficiaries, cents. */
  readonly partBProratedHouseholdCents: number;
  /** Household Part D surcharge after month proration across all beneficiaries, cents. */
  readonly partDProratedHouseholdCents: number;
  /** `partBProratedHouseholdCents + partDProratedHouseholdCents`, cents. */
  readonly totalHouseholdAnnualCents: number;
}

/** Assert a value is an integer month count in [0, 12]. */
function assertMonths(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be an integer between 0 and 12 (months); got ${value}`,
    );
  }
}

/** All-zero month-aware result (no enrolled months → no surcharge). */
const ZERO_MONTH_AWARE_IRMAA: MonthAwareIrmaaResult = {
  tier: 'none',
  partBAnnualCentsPerBeneficiary: 0,
  partDAnnualCentsPerBeneficiary: 0,
  partBProratedHouseholdCents: 0,
  partDProratedHouseholdCents: 0,
  totalHouseholdAnnualCents: 0,
};

/**
 * Compute month-aware Medicare IRMAA for a household, prorating Part B and Part D
 * separately by each beneficiary's enrollment months (the projection engine both runners charge).
 *
 * @param input    - Tax year, look-back MAGI + filing status, per-beneficiary months.
 * @param snapshot - Calibration snapshot keyed by tax year.
 * @throws {IrmaaInvalidInputError}   Any field fails validation (fires first).
 * @throws {UnsupportedTaxYearError}  taxYear not present in snapshot (strict-year).
 */
export function computeMonthAwareIrmaa(
  input: MonthAwareIrmaaInput,
  snapshot: CalibrationSnapshot<IrmaaTable>,
): MonthAwareIrmaaResult {
  const { taxYear, lookback, beneficiaries } = input;
  assertTaxYear(taxYear);
  assertCentField(lookback.magiCents, 'lookback.magiCents');
  assertIrmaaFilingStatus(lookback.filingStatus, 'lookback.filingStatus');
  assertMfsLivedWithSpouse(lookback.mfsLivedWithSpouse, 'lookback.mfsLivedWithSpouse');
  if (beneficiaries.length > 2) {
    throw new IrmaaInvalidInputError(
      `beneficiaries must have at most 2 entries (one household); got ${beneficiaries.length}`,
    );
  }
  for (const [i, b] of beneficiaries.entries()) {
    assertMonths(b.partBMonths, `beneficiaries[${i}].partBMonths`);
    assertMonths(b.partDMonths, `beneficiaries[${i}].partDMonths`);
  }

  // No enrolled months anywhere → no surcharge regardless of MAGI/year.
  const anyEnrolled = beneficiaries.some((b) => b.partBMonths > 0 || b.partDMonths > 0);
  if (!anyEnrolled) return ZERO_MONTH_AWARE_IRMAA;

  const table = snapshot.values[taxYear];
  if (table === undefined) throw new UnsupportedTaxYearError(taxYear);

  const entries = selectIrmaaScheduleEntries(
    table,
    lookback.filingStatus,
    lookback.mfsLivedWithSpouse,
  );
  const tier = resolveTier(lookback.magiCents, entries);
  const { partBCents: partBAnnual, partDCents: partDAnnual } = computeSurcharges(tier, entries);

  // Prorate each part SEPARATELY by each beneficiary's own months, then sum.
  let partBProratedHouseholdCents = 0;
  let partDProratedHouseholdCents = 0;
  for (const b of beneficiaries) {
    partBProratedHouseholdCents += Math.round((partBAnnual * b.partBMonths) / 12);
    partDProratedHouseholdCents += Math.round((partDAnnual * b.partDMonths) / 12);
  }

  return {
    tier,
    partBAnnualCentsPerBeneficiary: partBAnnual,
    partDAnnualCentsPerBeneficiary: partDAnnual,
    partBProratedHouseholdCents,
    partDProratedHouseholdCents,
    totalHouseholdAnnualCents: partBProratedHouseholdCents + partDProratedHouseholdCents,
  };
}
