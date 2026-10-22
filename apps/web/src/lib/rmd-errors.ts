/** Typed RMD engine errors, in their own file so rmd-validation.ts does not cycle with rmd.ts. */

/**
 * Thrown when the tax year is below the snapshot's minimum key. Shares its `code` with the class in
 * federal-tax.ts; consumers narrow by `instanceof`.
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
 * Thrown on invalid RMD input: malformed birthdate, out-of-range or misplaced `rothPortionCents`,
 * negative or non-integer balance, duplicate or empty account ID, missing divisor.
 */
export class RmdInvalidInputError extends Error {
  readonly code = 'RMD_INVALID_INPUT' as const;
  constructor(public readonly reason: string) {
    super(`Invalid RMD input: ${reason}`);
    this.name = 'RmdInvalidInputError';
  }
}
