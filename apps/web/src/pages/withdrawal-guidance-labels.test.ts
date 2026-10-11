import { describe, expect, it } from 'vitest';
import type { AccountType } from '../db/types';
import { aggregationTypeLabel } from './withdrawal-guidance-labels';

describe('aggregationTypeLabel', () => {
  it.each([
    ['RETIREMENT_IRA', 'Traditional IRAs'],
    ['RETIREMENT_403B', '403(b) accounts'],
    ['RETIREMENT_401K', '401(k)'],
    ['RETIREMENT_457B', '457(b)'],
    ['RETIREMENT_TSP', 'Thrift Savings Plan'],
    ['RETIREMENT_CASH_BALANCE', 'Cash Balance Pension'],
  ] as const)('%s → %s', (type, expected) => {
    expect(aggregationTypeLabel(type as AccountType)).toBe(expected);
  });

  it('passes through unknown types verbatim', () => {
    expect(aggregationTypeLabel('SOME_FUTURE_TYPE' as AccountType)).toBe(
      'SOME_FUTURE_TYPE',
    );
  });
});
