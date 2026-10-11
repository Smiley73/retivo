/**
 * Shared Roth distribution-tax fact validators. Single source
 * of truth for the [1998, 2200] tax-year bound and the money-magnitude bound, so
 * the MIGRATION-TIME sanitiser (`migrations.ts`) and the RUNTIME consumption
 * boundary (`balance-projection-runner-tax-helpers.ts`) cannot silently diverge.
 *
 * A CURRENT-schema-version row bypasses its migrations entirely (migrations only
 * run on payloads below the current version), so a directly-imported /
 * hand-constructed payload must be re-validated at the runtime boundary against
 * the IDENTICAL bounds.
 *
 * A structural sanitiser for the two per-transfer LOT ARRAYS used to live here
 * too, with its own 200-entry DoS caps. Both dated Roth facts moved to the annual
 * balance rows and nothing reads those keys now, so it was guarding
 * data no consumer can see; it and its caps are gone. The runtime adapter derives
 * one lot per tax year from the balance rows, where the valid tax-year range is
 * itself the bound.
 */

/** Roth IRAs began in tax year 1998; a first-contribution / conversion / first-
 *  participation / in-plan-rollover tax year outside `[1998, 2200]` (or
 *  non-integer) is corrupt. */
const MIN_ROTH_TAX_YEAR = 1998;
const MAX_ROTH_TAX_YEAR = 2200;

/** Maximum accepted Roth money magnitude (whole dollars). Bounded so the ×100
 *  cents conversion stays a safe integer — an extreme-but-finite stored
 *  value (e.g. 1e308) must NOT survive to overflow to Infinity downstream. */
const MAX_ROTH_MONEY = Math.floor(Number.MAX_SAFE_INTEGER / 100);

/** True when `value` is a valid stored Roth money amount: finite, nonnegative,
 *  and within the magnitude bound. */
export function isValidRothMoney(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_ROTH_MONEY
  );
}

/** True when `value` is a valid stored Roth tax year: an integer in
 *  `[1998, 2200]`. */
export function isValidRothTaxYear(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ROTH_TAX_YEAR &&
    value <= MAX_ROTH_TAX_YEAR
  );
}

/** Whole dollars → integer cents for the Roth fact adapters, validated to a
 *  safe integer at the point of conversion: a non-finite / non-positive /
 *  out-of-magnitude value contributes 0 (conservative $0 default), and the
 *  ×100 result is rejected to 0 if it is not a safe integer. Callers sum the
 *  already-integer cents so no float drift accumulates across many facts. */
export function rothFactDollarsToCents(dollars: unknown): number {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars <= 0) {
    return 0;
  }
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}


/** Largest cents aggregate representable exactly as a `Number`. */
const MAX_SAFE_ROTH_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/** Read a BigInt cents aggregate (summed from many already-validated per-fact
 *  cents) back to a `Number`, degrading a value past `Number.MAX_SAFE_INTEGER`
 *  (or a negative) to a conservative `0` rather than overflowing IEEE-754
 *  precision. Mirrors the BigInt aggregation discipline in
 *  `roth-distribution-tax.ts`, but at the RUNTIME fact boundary an overflow
 *  degrades SAFELY (never throws) — `0` basis is the max-tax conservative
 *  default, the correct direction when a fact set is too large to represent. */
export function safeRothCentsFromBigInt(sum: bigint): number {
  return sum > 0n && sum <= MAX_SAFE_ROTH_CENTS ? Number(sum) : 0;
}

/** Read a BigInt cents aggregate used as a KNOWN-basis LOWER-BOUND FLOOR (not an
 *  authoritative basis value) back to a `Number`, SATURATING a value past
 *  `Number.MAX_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER` — the largest
 *  representable floor — rather than collapsing to `0`. The `0`-collapse of
 *  `safeRothCentsFromBigInt` is only conservative when the aggregate is used AS
 *  the basis value (less basis → more tax). When the aggregate is instead a floor
 *  the true basis can only exceed — the summed in-plan Roth rollover-lot principal
 *  that designated-Roth basis is floored at — a `0`-collapse REMOVES the
 *  floor and lets known, individually-valid taxable rollover principal be
 *  misclassified as (penalty-exempt, for governmental 457(b)) earnings, silently
 *  dropping it from the recapture/additional-tax base and UNDERSTATING tax.
 *  Saturating high keeps the floor as large as representable, so the ordered
 *  recapture allocator still draws that in-window taxable principal. A negative
 *  (impossible for a sum of nonnegatives, guarded defensively) degrades to `0`. */
export function safeRothBasisFloorFromBigInt(sum: bigint): number {
  if (sum <= 0n) return 0;
  return sum <= MAX_SAFE_ROTH_CENTS ? Number(sum) : Number.MAX_SAFE_INTEGER;
}
