/** IRMAA (Medicare income-related monthly adjustment amount) engine: pure functions, integer cents. */

import type { CalibrationSnapshot } from './calibration';
import { FilingStatus } from './federal-tax';
import type { IrmaaTable, IrmaaTableEntry } from './irmaa-tiers';
import { selectIrmaaScheduleEntries, entryAnnualSurchargeCents } from './irmaa-tiers';

/** Filing status for IRMAA lookups: HoH and QSS use the Single tiers; MFS lived with spouse uses the steeper `byMfs` schedule. */
type IrmaaFilingStatus = FilingStatus;

export type { IrmaaTable } from './irmaa-tiers';

interface IrmaaLookback {
  readonly magiCents: number;
  readonly filingStatus: IrmaaFilingStatus;
  readonly mfsLivedWithSpouse?: boolean;
}

type IrmaaTier = 'none' | 'tier1' | 'tier2' | 'tier3' | 'tier4' | 'tier5';

/** Annual per-beneficiary surcharge amounts in integer cents. */
export interface IrmaaResult {
  tier: IrmaaTier;
  partBSurchargeCentsPerBeneficiary: number;
  partDSurchargeCentsPerBeneficiary: number;
  /** Total household annual IRMAA surcharge (Part B + Part D × beneficiary count), in cents. */
  totalHouseholdAnnualCents: number;
}

interface IrmaaInput {
  taxYear: number;
  magiTwoYearsPriorCents: number;
  filingStatus: IrmaaFilingStatus;
  /** MFS only: true if the beneficiary lived with their spouse at some point in the look-back year (steeper `byMfs` schedule); false or absent uses `bySingle`. */
  mfsLivedWithSpouse?: boolean;
  /** Household members on Medicare (max 2); 0 short-circuits to an all-zero result. */
  beneficiariesOnMedicareCount: 0 | 1 | 2;
}

/** Thrown when taxYear is not in the snapshot; IRMAA looks up the strict year (no clamp-to-latest). */
class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(`IRMAA brackets not available for tax year ${year}`);
    this.name = 'UnsupportedTaxYearError';
  }
}

/** Thrown when any field of IrmaaInput fails validation. */
class IrmaaInvalidInputError extends Error {
  readonly code = 'IRMAA_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid IRMAA input: ${reason}`);
    this.name = 'IrmaaInvalidInputError';
  }
}

function assertCentField(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be a non-negative safe integer (cents); got ${value}`,
    );
  }
}

function assertTaxYear(taxYear: number): void {
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    throw new IrmaaInvalidInputError(
      `taxYear must be an integer between 2000 and 2100; got ${taxYear}`,
    );
  }
}

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

// A truthy non-boolean (e.g. the string "true") would silently select byMfs, and a falsy one would fall through to bySingle.
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

// Cent-space comparison avoids float rounding at tier boundaries. Tiers 1–4 start strictly above their threshold; tier 5 is inclusive.
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

function computeSurcharges(
  tier: IrmaaTier,
  entries: readonly IrmaaTableEntry[],
): { partBCents: number; partDCents: number } {
  if (tier === 'none') return { partBCents: 0, partDCents: 0 };
  const idx = parseInt(tier.replace('tier', ''), 10) - 1;
  return entryAnnualSurchargeCents(entries[idx]);
}

/**
 * Whole-year IRMAA surcharges for a household; used only by the Roth-conversion probe (the projection charges
 * `computeMonthAwareIrmaa`).
 *
 * @throws {IrmaaInvalidInputError} any input field fails validation.
 * @throws {UnsupportedTaxYearError} taxYear not in the snapshot (strict year).
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

/** Part B and Part D enrollment months are independent (0 = not enrolled in that part): a member turning 65 mid-year may start each in a different month or decline one. */
export interface IrmaaBeneficiaryEnrollment {
  readonly partBMonths: number;
  readonly partDMonths: number;
}

interface MonthAwareIrmaaInput {
  readonly taxYear: number;
  /** Look-back return's MAGI and filing status (two years prior); tiering uses its status, so a surviving-spouse Single unit is still tiered on the MFJ ladder. */
  readonly lookback: IrmaaLookback;
  /** One entry per household member on Medicare (max 2). Empty → all-zero. */
  readonly beneficiaries: readonly IrmaaBeneficiaryEnrollment[];
}

/** Month-aware IRMAA result, with Part B and Part D prorated separately. */
export interface MonthAwareIrmaaResult {
  readonly tier: IrmaaTier;
  readonly partBAnnualCentsPerBeneficiary: number;
  readonly partDAnnualCentsPerBeneficiary: number;
  readonly partBProratedHouseholdCents: number;
  readonly partDProratedHouseholdCents: number;
  readonly totalHouseholdAnnualCents: number;
}

function assertMonths(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 12) {
    throw new IrmaaInvalidInputError(
      `${fieldName} must be an integer between 0 and 12 (months); got ${value}`,
    );
  }
}

const ZERO_MONTH_AWARE_IRMAA: MonthAwareIrmaaResult = {
  tier: 'none',
  partBAnnualCentsPerBeneficiary: 0,
  partDAnnualCentsPerBeneficiary: 0,
  partBProratedHouseholdCents: 0,
  partDProratedHouseholdCents: 0,
  totalHouseholdAnnualCents: 0,
};

/**
 * Month-aware IRMAA for a household: Part B and Part D are prorated separately by each beneficiary's own
 * enrollment months and tiered on the look-back return's filing status. Both production runners charge this.
 *
 * @throws {IrmaaInvalidInputError} any field fails validation.
 * @throws {UnsupportedTaxYearError} taxYear not in the snapshot (strict year).
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
