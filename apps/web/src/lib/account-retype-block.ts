// Whether an account has real balance history (`blocked`) or none (`clear`), for the retype guard, judged the same for every account type.

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
 * True when `accountId` has a live row that is return-bearing (`isReturnBearingRow`, which excludes the automatic seed row),
 * has a valid tax year with a strictly positive dated Roth fact amount, or has `contributionCentsOf(payload).personalCents > 0n`
 * (catches a mixed row whose negative company split nets total contributions to zero). Callers must still filter tombstones.
 * Known gap: `rothIraFirstContributionTaxYear` and `designatedRothFirstParticipationTaxYear` live on the account, not a balance row,
 * so an account whose only evidence is one of them reads `clear` and retyping it can move the pooled five-year clock.
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
