// Shared Roth distribution-tax fact validators ([1998, 2200] tax-year and money-magnitude bounds) used by both the
// migration sanitiser and the runtime boundary, which re-validates because a current-version row bypasses migrations.

// Roth IRAs began in 1998; a first-contribution, conversion, first-participation or in-plan-rollover tax year outside
// `[1998, 2200]` (or non-integer) is corrupt.
const MIN_ROTH_TAX_YEAR = 1998;
const MAX_ROTH_TAX_YEAR = 2200;

// Bounded so the x100 cents conversion stays a safe integer: an extreme-but-finite stored value (e.g. 1e308) must not
// overflow to Infinity downstream.
const MAX_ROTH_MONEY = Math.floor(Number.MAX_SAFE_INTEGER / 100);

/** True for a stored Roth money amount: finite, nonnegative, within the magnitude bound. */
export function isValidRothMoney(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_ROTH_MONEY
  );
}

/** True for a stored Roth tax year: an integer in `[1998, 2200]`. */
export function isValidRothTaxYear(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ROTH_TAX_YEAR &&
    value <= MAX_ROTH_TAX_YEAR
  );
}

/**
 * Whole dollars to integer cents for the Roth fact adapters: a non-finite, non-positive or out-of-magnitude value
 * contributes 0 (conservative $0 default), and a x100 result that is not a safe integer is rejected to 0. Callers sum
 * already-integer cents, so no float drift accumulates.
 */
export function rothFactDollarsToCents(dollars: unknown): number {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars <= 0) {
    return 0;
  }
  const cents = Math.round(dollars * 100);
  return Number.isSafeInteger(cents) ? cents : 0;
}

const MAX_SAFE_ROTH_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Reads a BigInt cents aggregate (summed from validated per-fact cents) back to a Number; a value past
 * `Number.MAX_SAFE_INTEGER`, or a negative, degrades to a conservative 0 instead of overflowing IEEE-754 precision
 * (mirrors `roth-distribution-tax.ts`). At this runtime boundary overflow never throws: 0 basis is the max-tax default,
 * the right direction when a fact set is too large to represent.
 */
export function safeRothCentsFromBigInt(sum: bigint): number {
  return sum > 0n && sum <= MAX_SAFE_ROTH_CENTS ? Number(sum) : 0;
}

/**
 * As {@link safeRothCentsFromBigInt}, for an aggregate used as a known-basis lower-bound floor: it saturates at
 * `Number.MAX_SAFE_INTEGER` instead of collapsing to 0. A 0-collapse is conservative only when the aggregate is the
 * basis itself (less basis, more tax); as a floor (the summed in-plan rollover-lot principal that designated-Roth basis
 * is floored at) it would remove the floor and let known taxable rollover principal be misclassified as penalty-exempt
 * earnings, understating tax. A negative degrades to 0.
 */
export function safeRothBasisFloorFromBigInt(sum: bigint): number {
  if (sum <= 0n) return 0;
  return sum <= MAX_SAFE_ROTH_CENTS ? Number(sum) : Number.MAX_SAFE_INTEGER;
}
