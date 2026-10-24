// Maps `AccountType` to the five visual buckets the account tables colour-code by (a grouping affordance, not `taxTreatment`).

import type { AccountType } from '../db/types';

export type AccountBucket = 'pretax' | 'roth' | 'taxable' | 'cash' | 'tax_free';

export const ACCOUNT_BUCKET_LABEL: Readonly<Record<AccountBucket, string>> = {
  pretax: 'Tax-deferred',
  roth: 'Roth',
  taxable: 'Taxable',
  cash: 'Cash',
  tax_free: 'HSA',
};

export function accountBucket(type: AccountType): AccountBucket {
  switch (type) {
    case 'RETIREMENT_ROTH_IRA':
    case 'RETIREMENT_ROTH_401K':
    case 'RETIREMENT_ROTH_403B':
    case 'RETIREMENT_ROTH_457B':
    case 'RETIREMENT_ROTH_TSP':
      return 'roth';
    case 'BROKERAGE':
      return 'taxable';
    case 'SAVINGS':
    case 'MONEY_MARKET':
    case 'CD':
      return 'cash';
    case 'HSA':
      return 'tax_free';
    default:
      return 'pretax';
  }
}
