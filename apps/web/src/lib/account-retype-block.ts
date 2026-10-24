// Whether an account has real balance history (`blocked`) or none (`clear`), for the retype guard.
// A total function with no account-type input to scope on.

import type { AccountBalancePayload } from '../db/types';
import { isReturnBearingRow } from './balance-calc';
import { contributionCentsOf } from './roth-basis-derivation';
import { isValidRothMoney, isValidRothTaxYear } from '../db/roth-fact-validation';

/** A balance row as the store hands it over; structurally an `Aggregate<AccountBalancePayload>`. */
export interface RetypeHistoryRow {
  readonly payload: AccountBalancePayload;
  readonly deletedAt?: string;
}

// Mirrors the private `positive()` in `roth-start-year.ts`; restated because that module exports none, and the two must stay identical.
function positive(value: unknown): boolean {
  return isValidRothMoney(value) && value > 0;
}

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
 * True when `accountId` has real balance history, judged the same for every
 * account type. A live row counts when any of these holds: it is return-bearing
 * (`isReturnBearingRow`, which excludes the automatic seed row); its tax year is
 * valid and one of the four dated Roth fact amounts is strictly positive; or
 * `contributionCentsOf(payload).personalCents > 0n`, which catches a MIXED row
 * whose negative company split nets total contributions to zero.
 *
 * Deliberately not `hasRecordedPersonalContributions` (employer money, growth or
 * withdrawals alone still make an account the wrong one to relabel) nor
 * `rowHasEvidence` (the five-year-clock rule: type-keyed and blind to `distributions`).
 *
 * The tombstone filter is defence in depth; callers must still filter tombstones.
 * Known gap: `rothIraFirstContributionTaxYear` and
 * `designatedRothFirstParticipationTaxYear` live on the account, not a balance
 * row, so an account whose only evidence is one of them reads `clear` and
 * retyping it can move the pooled five-year clock. Closing that needs a
 * signature change in the callers.
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
