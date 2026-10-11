/**
 * Typed error classes for the RMD engine.
 *
 * Extracted so rmd-validation.ts can import them without creating a circular
 * dependency with rmd.ts. rmd.ts re-exports both classes so existing import
 * sites (`import { RmdInvalidInputError } from './rmd'`) keep working.
 */

/**
 * Thrown when the requested tax year is below the minimum key in the snapshot.
 *
 * NOTE: The `code` literal `'UNSUPPORTED_TAX_YEAR'` is intentionally shared
 * with `UnsupportedTaxYearError` in `federal-tax.ts`. These are separate
 * exported classes — consumers narrow by `instanceof`, not by `code`. Do NOT
 * deduplicate them into a shared base class without first verifying that every
 * consumer site narrows by instanceof. The two classes have different
 * constructor signatures (year-only here vs year-only there) and different
 * error messages — they are independently maintained.
 */
export class UnsupportedTaxYearError extends Error {
  readonly code = 'UNSUPPORTED_TAX_YEAR' as const;
  constructor(public readonly year: number) {
    super(
      `RMD tax year ${year} is below the minimum supported year. ` +
        'Update rmd-divisors.ts when new IRS Uniform Lifetime Table entries are needed.',
    );
    this.name = 'UnsupportedTaxYearError';
  }
}

/**
 * Thrown on invalid RMD input (malformed birthdate, out-of-range rothPortionCents,
 * rothPortionCents supplied on an account with no Roth-designated pocket (PRE_TAX /
 * HSA), negative or non-integer balance, duplicate or empty account ID,
 * missing/invalid divisor in snapshot, etc.).
 */
export class RmdInvalidInputError extends Error {
  readonly code = 'RMD_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid RMD input: ${reason}`);
    this.name = 'RmdInvalidInputError';
  }
}
