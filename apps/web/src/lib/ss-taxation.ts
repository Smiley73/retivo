/** Social Security taxation under IRS §86: the provisional-income 50% / 85% rule. Pure. */

import { type CalibrationSnapshot } from './calibration';
import { type FilingStatus } from './federal-tax';

type SsTaxFilingStatus = FilingStatus;

interface SsTaxThresholdsByStatus {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
}

/** Tier-1 and tier-2 provisional-income thresholds (whole dollars, §86(c)); statutory, so one 2024 entry covers later years. */
export interface SsTaxThresholds {
  readonly tier1: SsTaxThresholdsByStatus;
  readonly tier2: SsTaxThresholdsByStatus;
}

/**
 * Cent fields must be finite non-negative safe integers. `otherAgiCents` is AGI excluding the SS benefits
 * (including any §86(b)(2)(A) income); `taxExemptInterestCents` is the §86(b)(2)(B) interest added back.
 */
export interface SsTaxationInput {
  readonly grossSsCents: number;
  readonly otherAgiCents: number;
  readonly taxExemptInterestCents: number;
  readonly filingStatus: SsTaxFilingStatus;
  readonly taxYear: number;
  /** MFS only: true (lived with the spouse at any point in the year) makes the §86 base amounts $0; false or absent uses the Single pair. */
  readonly mfsLivedWithSpouse?: boolean;
}

/** `taxableSsCents` is at most 0.85 × `grossSsCents`; `provisionalIncomeCents` is rounded half-up. */
export interface SsTaxationResult {
  readonly taxableSsCents: number;
  readonly provisionalIncomeCents: number;
  readonly tier: 'none' | 'fifty' | 'eighty-five';
}

/** Thrown when taxYear is below every snapshot key. Its `code` is shared with the federal-tax and RMD classes; narrow by `instanceof`. */
export class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(`SS taxation does not support tax year ${year}`);
    this.name = 'UnsupportedTaxYearError';
  }
}

/** Thrown when an input field fails boundary validation, before snapshot resolution. */
class SsTaxationInvalidInputError extends Error {
  readonly code = 'SS_TAXATION_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid SS taxation input: ${reason}`);
    this.name = 'SsTaxationInvalidInputError';
  }
}

const VALID_FILING_STATUSES: ReadonlySet<SsTaxFilingStatus> = new Set<SsTaxFilingStatus>([
  'Single',
  'MFJ',
  'HoH',
  'MFS',
  'QSS',
]);

function assertCentField(fieldName: string, x: number): void {
  if (!Number.isInteger(x) || x < 0 || x > Number.MAX_SAFE_INTEGER) {
    throw new SsTaxationInvalidInputError(
      `${fieldName} must be a finite non-negative safe integer; got ${x}`,
    );
  }
}

const SS_TAX_SNAPSHOT_KEYS = new WeakMap<CalibrationSnapshot<SsTaxThresholds>, number[]>();

function resolveSnapshot(
  snapshot: CalibrationSnapshot<SsTaxThresholds>,
  taxYear: number,
): SsTaxThresholds {
  let keys = SS_TAX_SNAPSHOT_KEYS.get(snapshot);
  if (keys === undefined) {
    keys = Object.keys(snapshot.values).map(Number).sort((a, b) => a - b);
    SS_TAX_SNAPSHOT_KEYS.set(snapshot, keys);
  }
  if (keys.length === 0 || taxYear < keys[0]) {
    throw new UnsupportedTaxYearError(taxYear);
  }
  let resolved = keys[0];
  for (const k of keys) {
    if (k <= taxYear) resolved = k;
  }
  return snapshot.values[resolved];
}

// MFJ uses the MFJ pair. MFS lived with spouse is {0, 0} (§86(c)(1)(C)(ii), §86(c)(2)(C)), so the 85% tier applies from
// the first dollar. Single, HoH (§86(c)(1)(A)), QSS (an individual filer) and MFS-not-lived-together use the Single pair.
function canonicalThresholds(
  thresholds: SsTaxThresholds,
  filingStatus: SsTaxFilingStatus,
  mfsLivedWithSpouse: boolean,
): { tier1: number; tier2: number } {
  if (filingStatus === 'MFS' && mfsLivedWithSpouse) {
    return { tier1: 0, tier2: 0 };
  }
  const statusKey: 'Single' | 'MFJ' = filingStatus === 'MFJ' ? 'MFJ' : 'Single';
  return { tier1: thresholds.tier1[statusKey], tier2: thresholds.tier2[statusKey] };
}

function computeTierAndTaxable(
  piDollars: number,
  grossSsDollars: number,
  tier1: number,
  tier2: number,
): { taxableDollars: number; tier: SsTaxationResult['tier'] } {
  if (piDollars <= tier1) {
    // §86(a)(1): PI ≤ base amount → no SS taxation.
    return { taxableDollars: 0, tier: 'none' };
  }
  if (piDollars <= tier2) {
    // §86(a)(2)(A): PI in (tier1, tier2] → 50% tier.
    return {
      taxableDollars: Math.min(0.5 * grossSsDollars, 0.5 * (piDollars - tier1)),
      tier: 'fifty',
    };
  }
  // §86(a)(2)(B): PI > tier2 → 85% tier.
  // innerMin: min(0.5 × (tier2 − tier1), 0.5 × grossSS) — the §86(a)(2)(B)
  // "smaller of" term; for MFJ caps at $6,000 (0.5 × $12k tier-spread).
  const innerMin = Math.min(0.5 * (tier2 - tier1), 0.5 * grossSsDollars);
  // Cap on the float before rounding so it binds exactly.
  return {
    taxableDollars: Math.min(
      0.85 * grossSsDollars,
      0.85 * (piDollars - tier2) + innerMin,
    ),
    tier: 'eighty-five',
  };
}

/**
 * Provisional income in cents, rounded half-up: otherAGI + taxExemptInterest + 0.5 × grossSS. Unvalidated
 * and snapshot-free, so callers can show PI without the full computation.
 */
function provisionalIncomeCents(
  grossSsCents: number,
  otherAgiCents: number,
  taxExemptInterestCents: number,
): number {
  // Compute in dollars to avoid half-cent issues at threshold comparisons.
  const grossSsDollars = grossSsCents / 100;
  const otherAgiDollars = otherAgiCents / 100;
  const taxExemptDollars = taxExemptInterestCents / 100;
  const piDollars = otherAgiDollars + taxExemptDollars + 0.5 * grossSsDollars;
  return Math.round(piDollars * 100);
}

function validateInput(input: SsTaxationInput): void {
  assertCentField('grossSsCents', input.grossSsCents);
  assertCentField('otherAgiCents', input.otherAgiCents);
  assertCentField('taxExemptInterestCents', input.taxExemptInterestCents);
  if (!Number.isInteger(input.taxYear)) {
    throw new SsTaxationInvalidInputError(
      `taxYear must be a finite integer; got ${input.taxYear}`,
    );
  }
  if (!VALID_FILING_STATUSES.has(input.filingStatus)) {
    throw new SsTaxationInvalidInputError(
      `filingStatus must be 'Single', 'MFJ', 'HoH', 'MFS', or 'QSS'; got ${String(input.filingStatus)}`,
    );
  }
  // A truthy non-boolean (e.g. the string "false") would silently select the §86(c)(1)(C)(ii) zero-base MFS rule.
  if (
    input.mfsLivedWithSpouse !== undefined &&
    typeof input.mfsLivedWithSpouse !== 'boolean'
  ) {
    throw new SsTaxationInvalidInputError(
      `mfsLivedWithSpouse must be a boolean or undefined; got ${String(input.mfsLivedWithSpouse)}`,
    );
  }
}

/**
 * Taxable portion of gross SS benefits per IRS §86. Year resolution clamps to the latest snapshot key
 * (unlike federal-tax) because §86 thresholds are statutorily fixed.
 *
 * @throws UnsupportedTaxYearError when taxYear is below every snapshot key.
 * @throws SsTaxationInvalidInputError on an invalid cent field, taxYear or filingStatus.
 */
export function computeSsTaxation(
  input: SsTaxationInput,
  snapshot: CalibrationSnapshot<SsTaxThresholds>,
): SsTaxationResult {
  validateInput(input);

  const thresholds = resolveSnapshot(snapshot, input.taxYear);
  const { tier1, tier2 } = canonicalThresholds(
    thresholds,
    input.filingStatus,
    input.mfsLivedWithSpouse ?? false,
  );

  const grossSsDollars = input.grossSsCents / 100;
  const piCents = provisionalIncomeCents(
    input.grossSsCents,
    input.otherAgiCents,
    input.taxExemptInterestCents,
  );
  const piDollars = piCents / 100;

  const { taxableDollars, tier } = computeTierAndTaxable(
    piDollars,
    grossSsDollars,
    tier1,
    tier2,
  );

  return {
    taxableSsCents: Math.round(taxableDollars * 100),
    provisionalIncomeCents: piCents,
    tier,
  };
}
