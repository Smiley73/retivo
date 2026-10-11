/**
 * Input validation for the RMD engine.
 *
 * Extracted from rmd.ts to keep that file within the shape limit.
 * Validation runs BEFORE the trigger-age gate so malformed inputs always throw.
 * Engine: apps/web/src/lib/rmd.ts
 */

import { RmdInvalidInputError } from './rmd-errors';
import type { AccountTaxTreatment, RmdInput, RmdAccountProfileFacts } from './rmd';

/**
 * True when the account's tax treatment HAS a Roth-designated pocket, i.e. the
 * account can carry a `rothPortionCents` / `rothPortionTwoYearsPriorCents` slice
 * that SECURE 2.0 §325 keeps out of the RMD base: `MIXED` (a pre-tax employer plan
 * holding a designated-Roth sub-account) or a pure Roth account (`POST_TAX` /
 * `ROTH`, whose WHOLE balance is Roth money). `PRE_TAX` and `HSA` accounts have no
 * such pocket, so supplying a portion for them is incoherent input and throws.
 *
 * THE single §325 admission rule for the whole codebase: the RMD
 * engine's base resolvers, the validator below, and every producer that assembles
 * an `RmdAccountInput` (both engines' funded passes, the MC representative pass,
 * the deterministic snapshot builder) read it, so no two of them can disagree
 * about whether one account's Roth dollars belong in the base. It lives here
 * rather than in `rmd.ts` because `rmd.ts` imports this module (the reverse would
 * be a value cycle); `rmd.ts` re-exports it for callers.
 */
export function hasRothDesignatedPocket(taxTreatment: AccountTaxTreatment): boolean {
  return taxTreatment === 'MIXED' || taxTreatment === 'POST_TAX' || taxTreatment === 'ROTH';
}

// ---------------------------------------------------------------------------
// Per-account validators (each ≤ 40 ln)
// ---------------------------------------------------------------------------

/**
 * Validate account id: must be non-empty and unique within the call.
 * @throws {RmdInvalidInputError} on empty or duplicate id.
 */
function validateAccountIdentity(id: string, seenIds: Set<string>): void {
  if (!id) {
    throw new RmdInvalidInputError('account id must be a non-empty string');
  }
  if (seenIds.has(id)) {
    throw new RmdInvalidInputError(`duplicate account id "${id}"`);
  }
  seenIds.add(id);
}

/**
 * Validate balanceDec31PriorYearCents: must be a safe non-negative integer.
 * @throws {RmdInvalidInputError} on non-finite, negative, or non-integer value.
 */
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

/**
 * Validate rothPortionCents when present: must be a safe non-negative integer,
 * only on an account that has a Roth-designated pocket, and not exceed balance.
 * @throws {RmdInvalidInputError} on any invalid condition.
 */
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

/**
 * Validate the two-years-prior catch-up base pair when present: the balance
 * must be a safe non-negative integer, and its Roth-designated portion follows
 * the same rules as `rothPortionCents` (only on an account with a Roth-designated
 * pocket, never exceeding the balance).
 * Unvalidated, a `NaN` / negative value would silently poison a first-year
 * deferral catch-up amount.
 * @throws {RmdInvalidInputError} on any invalid condition.
 */
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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validate top-level and per-account RMD input.
 * Runs BEFORE the trigger-age gate so malformed inputs always throw.
 *
 * @throws {RmdInvalidInputError} on any invalid input condition.
 */
export function validateRmdInput(input: RmdInput): void {
  // taxYear must be a finite safe integer — checked first, before snapshot
  // resolution or per-account loops, so callers get a clear error immediately.
  if (!Number.isSafeInteger(input.taxYear)) {
    throw new RmdInvalidInputError(
      `taxYear must be a finite safe integer; got ${input.taxYear}`,
    );
  }

  const seenIds = new Set<string>();
  for (const acct of input.accounts) {
    validateAccountIdentity(acct.id, seenIds);
    validateAccountBalance(acct.id, acct.balanceDec31PriorYearCents);
    // RETIREMENT_IRA is PRE_TAX only — MIXED/POST_TAX are incoherent
    // (Roth IRAs are RETIREMENT_ROTH_IRA, a separate type).
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

// ---------------------------------------------------------------------------
// Explicit missing-fact BLOCKERS for the fact-based RMD rule
// resolver. Unlike `validateRmdInput` (which THROWS on malformed engine input),
// this RETURNS a structured result listing the required facts that are absent —
// the "validation result" pattern — so a caller (and the account-editor
// readiness surface) can WITHHOLD an inherited-account RMD and show the user
// exactly which inputs to supply (never silently guess an inherited
// distribution rule). The editor's blocker list resolves the engine's own rule
// to collect these, see `account-tax-profile.ts`.
// ---------------------------------------------------------------------------

/** One missing-required-fact blocker. */
interface RmdProfileBlocker {
  readonly field: string;
  readonly reason: string;
}

/** Result of an RMD-profile fact check: `ok` when no required fact is missing. */
export interface RmdProfileValidationResult {
  readonly ok: boolean;
  readonly blockers: readonly RmdProfileBlocker[];
}

/**
 * Return the BASELINE missing-fact blockers for an account's RMD profile. An
 * OWNER account has no required facts (absent facts resolve to the conservative
 * owner default), so it is always `ok`. An INHERITED account requires the
 * beneficiary category, the original-owner death date, and the died-on/after-RBD
 * flag before ANY post-death rule can be selected; each absent fact is reported
 * as a blocker — EXCEPT the died-on/after-RBD flag on a Roth account, whose owner
 * has no lifetime Required Beginning Date: `resolveRmdRule` always
 * forces that case to death-before-RBD and never reads the stored flag, so
 * demanding it here would withhold a fully-specified inherited Roth account on a
 * fact the engine provably cannot use. Conditional facts whose necessity depends
 * on the resolved rule (e.g. the beneficiary birthdate for a life-expectancy
 * stretch) are surfaced by `resolveRmdRule` itself, not here. Pure/never-throws.
 */
export function validateRmdProfileFacts(
  facts: RmdAccountProfileFacts,
  /** True when the account's owner has no lifetime Required Beginning Date (a
   *  Roth account) — the caller passes the same test `resolveRmdRule`
   *  uses, so this function and the engine can never disagree about whether the
   *  died-on/after-RBD flag is required. Absent → required, as before. */
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
