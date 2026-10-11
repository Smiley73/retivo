/**
 * Account-*category* classifier — the dashboard "By account type" card.
 *
 * Maps the domain `AccountType` enum to one of six whole-account categories
 * the dashboard's by-account-type card groups balances into. This is a
 * separate, finer-grained classification than `accountBucket` (the locked
 * four-way visual bucket the account tables tint by): `accountCategory`
 * splits HSA out as its own category and keeps Retirement / Roth / Brokerage
 * / Cash / Other apart, mirroring the groups the Balance-Projection
 * account-balance stack chart already uses.
 *
 * Pure function; no behavioural contract. The category drives only which
 * `bg-*` swatch + label the by-account-type card paints — it is NOT the
 * account's `taxTreatment`.
 */
import type { AccountType } from '../db/types';

export type AccountCategory =
  | 'retirement'
  | 'roth'
  | 'brokerage'
  | 'hsa'
  | 'cash'
  | 'other';

export function accountCategory(type: AccountType): AccountCategory {
  switch (type) {
    case 'RETIREMENT_401K':
    case 'RETIREMENT_IRA':
    case 'RETIREMENT_403B':
    case 'RETIREMENT_457B':
    case 'RETIREMENT_TSP':
    case 'RETIREMENT_CASH_BALANCE':
      return 'retirement';
    case 'RETIREMENT_ROTH_IRA':
    case 'RETIREMENT_ROTH_401K':
    case 'RETIREMENT_ROTH_403B':
    case 'RETIREMENT_ROTH_457B':
    case 'RETIREMENT_ROTH_TSP':
      return 'roth';
    case 'BROKERAGE':
      return 'brokerage';
    case 'HSA':
      return 'hsa';
    case 'SAVINGS':
    case 'MONEY_MARKET':
    case 'CD':
      return 'cash';
    case 'OTHER':
      return 'other';
  }
}
