/** Input validation for the RMD engine; runs before the trigger-age gate so malformed inputs always throw. */

import { RmdInvalidInputError } from './rmd-errors';
import type { AccountTaxTreatment, RmdInput, RmdAccountProfileFacts } from './rmd';

/**
 * True when the tax treatment has a Roth-designated pocket (`MIXED`, or a pure Roth `POST_TAX` / `ROTH`) that
 * SECURE 2.0 §325 keeps out of the RMD base; `PRE_TAX` and `HSA` have none, so a Roth portion for them throws.
 * The one §325 admission rule for every RMD base resolver and producer; defined here because rmd.ts imports this module.
 */
export function hasRothDesignatedPocket(taxTreatment: AccountTaxTreatment): boolean {
  return taxTreatment === 'MIXED' || taxTreatment === 'POST_TAX' || taxTreatment === 'ROTH';
}

function validateAccountIdentity(id: string, seenIds: Set<string>): void {
  if (!id) {
    throw new RmdInvalidInputError('account id must be a non-empty string');
  }
  if (seenIds.has(id)) {
    throw new RmdInvalidInputError(`duplicate account id "${id}"`);
  }
  seenIds.add(id);
}

function validateAccountBalance(id: string, balanceDec31PriorYearCents: number): void {
  if (
    !Number.isSafeInteger(balanceDec31PriorYearCents) ||
    balanceDec31PriorYearCents < 0
  ) {
    throw new RmdInvalidInputError(
      `balanceDec31PriorYearCents must be a non-negative integer; ` +
        `account "${id}" has ${balanceDec31PriorYearCents}`,
    );
  }
}

function validateRothPortion(
  id: string,
  rothPortionCents: number,
  taxTreatment: AccountTaxTreatment,
  balanceDec31PriorYearCents: number,
): void {
  if (!Number.isSafeInteger(rothPortionCents) || rothPortionCents < 0) {
    throw new RmdInvalidInputError(
      `rothPortionCents must be a non-negative integer; ` +
        `account "${id}" has ${rothPortionCents}`,
    );
  }
  if (!hasRothDesignatedPocket(taxTreatment)) {
    throw new RmdInvalidInputError(
      `rothPortionCents is only valid for accounts with a Roth-designated ` +
        `pocket (MIXED, POST_TAX, ROTH); ` +
        `account "${id}" has taxTreatment "${taxTreatment}"`,
    );
  }
  if (rothPortionCents > balanceDec31PriorYearCents) {
    throw new RmdInvalidInputError(
      `rothPortionCents (${rothPortionCents}) exceeds balanceDec31PriorYearCents ` +
        `(${balanceDec31PriorYearCents}) on account "${id}"`,
    );
  }
}

// Unvalidated, a NaN or negative value would silently poison a first-year deferral catch-up amount.
function validateTwoYearsPriorBase(
  id: string,
  balanceDec31TwoYearsPriorCents: number | undefined,
  rothPortionTwoYearsPriorCents: number | undefined,
  taxTreatment: AccountTaxTreatment,
): void {
  if (balanceDec31TwoYearsPriorCents !== undefined) {
    if (
      !Number.isSafeInteger(balanceDec31TwoYearsPriorCents) ||
      balanceDec31TwoYearsPriorCents < 0
    ) {
      throw new RmdInvalidInputError(
        `balanceDec31TwoYearsPriorCents must be a non-negative integer; ` +
          `account "${id}" has ${balanceDec31TwoYearsPriorCents}`,
      );
    }
  }
  if (rothPortionTwoYearsPriorCents === undefined) return;
  if (
    !Number.isSafeInteger(rothPortionTwoYearsPriorCents) ||
    rothPortionTwoYearsPriorCents < 0
  ) {
    throw new RmdInvalidInputError(
      `rothPortionTwoYearsPriorCents must be a non-negative integer; ` +
        `account "${id}" has ${rothPortionTwoYearsPriorCents}`,
    );
  }
  if (!hasRothDesignatedPocket(taxTreatment)) {
    throw new RmdInvalidInputError(
      `rothPortionTwoYearsPriorCents is only valid for accounts with a ` +
        `Roth-designated pocket (MIXED, POST_TAX, ROTH); ` +
        `account "${id}" has taxTreatment "${taxTreatment}"`,
    );
  }
  if (rothPortionTwoYearsPriorCents > (balanceDec31TwoYearsPriorCents ?? 0)) {
    throw new RmdInvalidInputError(
      `rothPortionTwoYearsPriorCents (${rothPortionTwoYearsPriorCents}) exceeds ` +
        `balanceDec31TwoYearsPriorCents (${balanceDec31TwoYearsPriorCents ?? 0}) ` +
        `on account "${id}"`,
    );
  }
}

/** Validates top-level and per-account RMD input. @throws {RmdInvalidInputError} on any invalid input. */
export function validateRmdInput(input: RmdInput): void {
  if (!Number.isSafeInteger(input.taxYear)) {
    throw new RmdInvalidInputError(
      `taxYear must be a finite safe integer; got ${input.taxYear}`,
    );
  }

  const seenIds = new Set<string>();
  for (const acct of input.accounts) {
    validateAccountIdentity(acct.id, seenIds);
    validateAccountBalance(acct.id, acct.balanceDec31PriorYearCents);
    if (acct.accountType === 'RETIREMENT_IRA' && acct.taxTreatment !== 'PRE_TAX') {
      throw new RmdInvalidInputError(
        `RETIREMENT_IRA must have taxTreatment 'PRE_TAX'; ` +
          `account "${acct.id}" has '${acct.taxTreatment}' ` +
          `(Roth IRAs are RETIREMENT_ROTH_IRA, a separate type)`,
      );
    }
    if (acct.rothPortionCents !== undefined) {
      validateRothPortion(
        acct.id,
        acct.rothPortionCents,
        acct.taxTreatment,
        acct.balanceDec31PriorYearCents,
      );
    }
    validateTwoYearsPriorBase(
      acct.id,
      acct.balanceDec31TwoYearsPriorCents,
      acct.rothPortionTwoYearsPriorCents,
      acct.taxTreatment,
    );
  }
}

interface RmdProfileBlocker {
  readonly field: string;
  readonly reason: string;
}

/** `ok` when no required fact is missing. */
export interface RmdProfileValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly RmdProfileBlocker[];
}

/**
 * Missing-fact blockers for an account's RMD profile, returned rather than thrown so the account editor can
 * withhold an inherited-account RMD and show which inputs to supply. An owner account has none. An inherited
 * account needs the beneficiary category, owner death date and died-on/after-RBD flag; the flag is skipped
 * when `ownerAlwaysDiedBeforeRbd` (a Roth account: `resolveRmdRule` forces death-before-RBD and never reads it).
 * Facts whose need depends on the resolved rule are surfaced by `resolveRmdRule`.
 */
export function validateRmdProfileFacts(
  facts: RmdAccountProfileFacts,
  ownerAlwaysDiedBeforeRbd = false,
): RmdProfileValidationResult {
  const blockers: RmdProfileBlocker[] = [];
  if (facts.inheritedAccount === true) {
    if (facts.beneficiaryType === undefined) {
      blockers.push({
        field: 'beneficiaryType',
        reason: 'An inherited account needs a beneficiary category to select the post-death rule.',
      });
    }
    if (facts.inheritedOwnerDeathDate === undefined) {
      blockers.push({
        field: 'inheritedOwnerDeathDate',
        reason: "The original owner's date of death sets the post-death distribution schedule.",
      });
    }
    if (!ownerAlwaysDiedBeforeRbd && facts.inheritedOwnerDiedOnOrAfterRbd === undefined) {
      blockers.push({
        field: 'inheritedOwnerDiedOnOrAfterRbd',
        reason:
          'Whether the original owner died on/after their required beginning date governs annual distributions.',
      });
    }
  }
  return { ok: blockers.length === 0, blockers };
}
