/**
 * Social Security taxation engine — IRS §86 provisional-income / 50% / 85% rule.
 * Pure function, no I/O, no React.
 */

import { type CalibrationSnapshot } from './calibration';
import { type FilingStatus } from './federal-tax';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Filing statuses supported by this engine.
 * Re-exports federal-tax's FilingStatus to keep the two engines in sync.
 * HoH shares the Single threshold pair per §86(c)(1)(A).
 *
 * `MFS` and `QSS` are live: the filing plan can resolve a year to either
 * status:
 *   - `QSS` is an INDIVIDUAL filer for §86, so it uses the Single threshold pair
 *     (a surviving spouse is not filing a joint return).
 *   - `MFS` filers who lived with their spouse at any time during the year use
 *     the statutory ZERO base amount (§86(c)(1)(C)(ii) / §86(c)(2)(C)) — both
 *     tier thresholds are $0, so up to 85% of benefits are taxable from the
 *     first dollar of provisional income. An MFS filer who did NOT live with
 *     their spouse uses the Single pair (§86(c)(1)(A)). Callers signal
 *     lived-together via `SsTaxationInput.mfsLivedWithSpouse`.
 */
type SsTaxFilingStatus = FilingStatus;

/**
 * Per-filing-status container for a single tier threshold (in whole dollars).
 * Declared as a concrete interface matching federal-tax's Age65AddOn / NiitThresholds
 * / LtcgBrackets pattern rather than a generic Record<SsTaxFilingStatus, number>.
 */
interface SsTaxThresholdsByStatus {
  readonly Single: number;
  readonly MFJ: number;
  readonly HoH: number;
}

/**
 * CalibrationSnapshot payload T for SS taxation.
 * Tier-1 and tier-2 provisional-income thresholds (whole dollars, per §86(c)).
 * Statutory — not inflation-indexed. Single 2024 entry covers all future years
 * via the clamp-to-latest year-resolution rule.
 */
export interface SsTaxThresholds {
  readonly tier1: SsTaxThresholdsByStatus;
  readonly tier2: SsTaxThresholdsByStatus;
}

/**
 * Input to computeSsTaxation.
 * All cent fields must be finite, non-negative safe integers.
 * otherAgiCents = AGI minus SS portion (ordinary income + LTCG + any §86(b)(2)(A)
 * income, excluding the SS benefits themselves).
 * taxExemptInterestCents = §86(b)(2)(B) muni-bond interest added back to PI.
 */
export interface SsTaxationInput {
  readonly grossSsCents: number;
  readonly otherAgiCents: number;
  readonly taxExemptInterestCents: number;
  readonly filingStatus: SsTaxFilingStatus;
  readonly taxYear: number;
  /**
   * Only consulted when `filingStatus === 'MFS'`. `true` → the taxpayer
   * lived with their spouse at some point during the year, so the §86 base
   * amounts are $0 (up to 85% of benefits taxable from the first dollar).
   * `false`/absent → MFS uses the Single threshold pair (did not live together).
   * Ignored for every other filing status.
   */
  readonly mfsLivedWithSpouse?: boolean;
}

/**
 * Result from computeSsTaxation.
 * taxableSsCents: integer cents, 0 ≤ taxable ≤ 0.85 × grossSsCents.
 * provisionalIncomeCents: integer cents, rounded half-up (for caller introspection).
 * tier: which §86 tier applied — 'none' / 'fifty' / 'eighty-five'.
 */
export interface SsTaxationResult {
  readonly taxableSsCents: number;
  readonly provisionalIncomeCents: number;
  readonly tier: 'none' | 'fifty' | 'eighty-five';
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when taxYear is below every snapshot key (not-yet-supported year).
 * TSDoc note: the `code` literal 'UNSUPPORTED_TAX_YEAR' also appears on the
 * federal-tax and RMD UnsupportedTaxYearError classes — narrow by instanceof,
 * not by code.
 */
export class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(`SS taxation does not support tax year ${year}`);
    this.name = 'UnsupportedTaxYearError';
  }
}

/**
 * Thrown when any input field fails boundary validation.
 * Fires before snapshot resolution or any tier arithmetic.
 */
export class SsTaxationInvalidInputError extends Error {
  readonly code = 'SS_TAXATION_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid SS taxation input: ${reason}`);
    this.name = 'SsTaxationInvalidInputError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_FILING_STATUSES: ReadonlySet<SsTaxFilingStatus> = new Set<SsTaxFilingStatus>([
  'Single',
  'MFJ',
  'HoH',
  'MFS',
  'QSS',
]);

/** Validate that x is a finite, non-negative, safe integer (cent field). */
function assertCentField(fieldName: string, x: number): void {
  // Number.isInteger already returns false for NaN/±Infinity, so isFinite guard is redundant.
  if (!Number.isInteger(x) || x < 0 || x > Number.MAX_SAFE_INTEGER) {
    throw new SsTaxationInvalidInputError(
      `${fieldName} must be a finite non-negative safe integer; got ${x}`,
    );
  }
}

/** Sorted numeric keys per snapshot, computed once (same
 *  sorted-keys WeakMap cache as `rmd.ts`'s `resolveSnapshot`). */
const SS_TAX_SNAPSHOT_KEYS = new WeakMap<CalibrationSnapshot<SsTaxThresholds>, number[]>();

/**
 * Clamp-to-latest year resolution — identical to rmd.ts pattern.
 * Throws UnsupportedTaxYearError when taxYear < every snapshot key.
 */
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

/**
 * Map filingStatus + thresholds snapshot to the canonical tier1/tier2 dollar pair.
 *
 *   - `MFJ` → MFJ pair.
 *   - `MFS` with `mfsLivedWithSpouse` → {0, 0} (§86(c)(1)(C)(ii)): both base
 *     amounts are $0, so the 85% tier applies from the first dollar of PI.
 *   - everything else — `Single`, `HoH` (§86(c)(1)(A)), `QSS` (individual
 *     filer), and MFS-not-lived-together — → Single pair.
 */
function canonicalThresholds(
  thresholds: SsTaxThresholds,
  filingStatus: SsTaxFilingStatus,
  mfsLivedWithSpouse: boolean,
): { tier1: number; tier2: number } {
  if (filingStatus === 'MFS' && mfsLivedWithSpouse) {
    // Statutory $0 base amounts — no per-status snapshot entry needed.
    return { tier1: 0, tier2: 0 };
  }
  const statusKey: 'Single' | 'MFJ' = filingStatus === 'MFJ' ? 'MFJ' : 'Single';
  return { tier1: thresholds.tier1[statusKey], tier2: thresholds.tier2[statusKey] };
}

/**
 * Apply §86 tier logic (all values in dollars, float).
 * Returns taxableDollars (float, 85% cap applied before rounding) and tier label.
 */
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
  // Apply 85% cap on float BEFORE rounding so cap binds exactly.
  return {
    taxableDollars: Math.min(
      0.85 * grossSsDollars,
      0.85 * (piDollars - tier2) + innerMin,
    ),
    tier: 'eighty-five',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute provisional income (dollars-returned-as-cents, rounded half-up).
 * Formula: otherAGI + taxExemptInterest + 0.5 × grossSS (all in cents → sum → cents).
 * Exported separately so callers can surface the PI value without running the
 * full taxation computation (no snapshot dependence).
 * No validation — callers who want validation should use computeSsTaxation.
 */
export function provisionalIncomeCents(
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

/**
 * Validate all SsTaxationInput fields. Throws SsTaxationInvalidInputError on first
 * failing field; throws before snapshot resolution (fail-fast per CODING_STANDARDS).
 */
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
  // mfsLivedWithSpouse must be a genuine boolean or absent. A truthy
  // non-boolean (e.g. the STRING "false") would otherwise silently select the
  // §86(c)(1)(C)(ii) zero-base MFS rule — fail fast like every other field.
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
 * Compute the taxable portion of a household's gross SS benefits per IRS §86.
 *
 * @param input - validated fields: grossSsCents, otherAgiCents,
 *   taxExemptInterestCents (all integer cents ≥ 0), filingStatus, taxYear.
 * @param snapshot - CalibrationSnapshot<SsTaxThresholds>; clamp-to-latest
 *   year-resolution — diverges from federal-tax's no-clamp pattern
 *   because §86 thresholds are statutorily fixed, not inflation-indexed.
 * @throws UnsupportedTaxYearError — taxYear below minimum snapshot key.
 * @throws SsTaxationInvalidInputError — any cent field is not a finite
 *   non-negative safe integer, taxYear is non-finite/non-integer, or
 *   filingStatus is not in the literal union.
 */
export function computeSsTaxation(
  input: SsTaxationInput,
  snapshot: CalibrationSnapshot<SsTaxThresholds>,
): SsTaxationResult {
  // Validate all inputs BEFORE snapshot resolution.
  validateInput(input);

  // Clamp-to-latest year resolution.
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

  // Half-up rounding to integer cents.
  return {
    taxableSsCents: Math.round(taxableDollars * 100),
    provisionalIncomeCents: piCents,
    tier,
  };
}
