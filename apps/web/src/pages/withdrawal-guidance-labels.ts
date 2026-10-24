/** Plain-language labels for RMD aggregation-group account types. */
import type { AccountType } from '../db/types';

export function aggregationTypeLabel(type: AccountType): string {
  switch (type) {
    case 'RETIREMENT_IRA':
      return 'Traditional IRAs';
    case 'RETIREMENT_403B':
      return '403(b) accounts';
    case 'RETIREMENT_401K':
      return '401(k)';
    case 'RETIREMENT_457B':
      return '457(b)';
    case 'RETIREMENT_TSP':
      return 'Thrift Savings Plan';
    case 'RETIREMENT_CASH_BALANCE':
      return 'Cash Balance Pension';
    default:
      // Non-RMD types never reach the grouping; fall back to the raw type so a future RMD-bearing type stays legible.
      return type;
  }
}
