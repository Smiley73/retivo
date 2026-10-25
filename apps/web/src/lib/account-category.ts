// Maps `AccountType` to the six whole-account categories of the dashboard's by-account-type card; finer than `accountBucket` (HSA is its own category) and not `taxTreatment`.
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
