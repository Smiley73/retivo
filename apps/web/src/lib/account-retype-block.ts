/**
 * One question, one account: does it have real balance history? Answers
 * `blocked` (at least one row below qualifies) or `clear` (none do) — no
 * third *could not check* verdict, no throw, no callback.
 *
 * The bar is a union of three terms, each independently sufficient, evaluated
 * identically for every account type — there is no type input to scope them
 * with:
 *
 * 1. `isReturnBearingRow(payload)` (`./balance-calc`) — a row is
 *    return-bearing unless `startingBalance`, `endingBalance`,
 *    `totalContributions(payload)`, `rollover` and `distributions` are all
 *    exactly zero (the automatic seed row every new account gets). Not
 *    gated by year.
 * 2. The row's own tax year is `isValidRothTaxYear` AND at least one of the
 *    four sparse-optional dated Roth fact fields
 *    (`rothConversionTaxableAmount`, `rothConversionNontaxableAmount`,
 *    `rothInPlanRolloverTaxableAmount`, `rothInPlanRolloverNontaxableAmount`)
 *    is a well-formed, strictly-positive amount (`isValidRothMoney(v) && v >
 *    0`). All four count on every account type — an in-plan rollover
 *    recorded on a Savings account is still recorded money movement.
 * 3. `contributionCentsOf(payload).personalCents > 0n` (`./roth-basis-
 *    derivation`) — closes the containment hole a MIXED row can open when its
 *    company split is entered negative: `totalContributions` can net to
 *    zero (term 1 reads clear) while the personal share stays positive.
 *
 * Deliberately **not** two lookalikes that were considered and rejected:
 * - `hasRecordedPersonalContributions`'s (`./roth-pool-warnings`)
 *   contributions-only bar — an account can carry employer money, market
 *   growth or withdrawals with zero personal contributions and still be the
 *   wrong account to relabel.
 * - `rowHasEvidence` and its balance-evidence matrix —
 *   the five-year-clock evidence rule, keyed on account type *and* tax
 *   treatment, silent for most account types, and blind to `distributions`.
 *   Following it would re-introduce a type table and drop the block on
 *   exactly the mixed-eligible plans this module exists to catch.
 *
 * Rows are considered only when `payload.accountId === accountId` and
 * `deletedAt === undefined`. The tombstone filter here is defence in depth,
 * not a relaxation of the caller's own duty to filter: a row whose
 * `deletedAt` was dropped on the way in is indistinguishable from a live one
 * at this boundary, so every one of this module's callers must still filter
 * tombstones itself.
 *
 * No account-type field, no tax-treatment field, no active flag, no
 * inherited-account marker, and no `AccountPayload` at all is read anywhere
 * here — nothing in the signature to scope on.
 *
 * No caller yet. The account editor's type picker consumes this in a
 * following change.
 *
 * Known, deliberately out-of-scope gap: `rothIraFirstContributionTaxYear`
 * and `designatedRothFirstParticipationTaxYear` (`../db/types/account.ts`)
 * are recorded on the account itself, not on any balance row, and
 * `resolveRothStartYear` / `resolveEffectiveRothStartYear`
 * (`./roth-start-year.ts`) treat either as sufficient on its own — no
 * balance evidence required. An account whose only recorded evidence is one
 * of those fields (for example a legacy account kept only for its clock,
 * with nothing else but the automatic seed row) reads `clear` here, so
 * retyping it away can move the owner's pooled five-year clock with no
 * block. This module's signature is `accountId` plus balance rows only
 * and cannot see account-level fields at all; closing this gap needs a
 * signature change reaching into its callers — not a change confined to
 * this file.
 */
import type { AccountBalancePayload } from '../db/types';
import { isReturnBearingRow } from './balance-calc';
import { contributionCentsOf } from './roth-basis-derivation';
import { isValidRothMoney, isValidRothTaxYear } from '../db/roth-fact-validation';

/** A balance row as the store hands it over — structurally an
 *  `Aggregate<AccountBalancePayload>`, so a caller passes its rows straight
 *  through. */
export interface RetypeHistoryRow {
  readonly payload: AccountBalancePayload;
  readonly deletedAt?: string;
}

/** `isValidRothMoney(v) && v > 0` — mirrors the private `positive()` in
 *  `roth-start-year.ts`. Restated rather than imported: that module owns no
 *  export for it, and the two tests must stay identical. */
function positive(value: unknown): boolean {
  return isValidRothMoney(value) && value > 0;
}

/** True when `payload`'s own tax year is readable and at least one of the
 *  four sparse-optional dated Roth fact fields is a well-formed,
 *  strictly-positive amount (term 2). */
function hasDatedRothFact(payload: AccountBalancePayload): boolean {
  return (
    isValidRothTaxYear(payload.year) &&
    [
      payload.rothConversionTaxableAmount,
      payload.rothConversionNontaxableAmount,
      payload.rothInPlanRolloverTaxableAmount,
      payload.rothInPlanRolloverNontaxableAmount,
    ].some(positive)
  );
}

/**
 * Does `accountId` have real balance history? `balances` may hold rows for
 * other accounts (filtered out) and may include a household's whole row
 * list. A total function: never throws, reads no clock, no store, no module
 * state, and returns a verdict for every typed input — an unknown
 * `accountId`, an empty array, and an array holding only other accounts'
 * rows all return `false`.
 */
export function hasRetypeBlockingHistory(
  accountId: string,
  balances: ReadonlyArray<RetypeHistoryRow>,
): boolean {
  return balances.some(({ payload, deletedAt }) => {
    if (payload.accountId !== accountId || deletedAt !== undefined) return false;
    return (
      isReturnBearingRow(payload) ||
      hasDatedRothFact(payload) ||
      contributionCentsOf(payload).personalCents > 0n
    );
  });
}
