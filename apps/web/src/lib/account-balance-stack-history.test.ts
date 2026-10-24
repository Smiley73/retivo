import { describe, expect, it } from 'vitest';
import {
  buildAccountBalanceStackHistory,
  distinctBalanceYearCount,
  latestActualBalanceYear,
} from './account-balance-stack-history';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

let seq = 0;
function makeAccount(args: {
  id: string;
  type: AccountPayload['type'];
  taxTreatment: AccountPayload['taxTreatment'];
  active?: boolean;
  deletedAt?: string;
}): Aggregate<AccountPayload> {
  return {
    id: args.id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: args.deletedAt,
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: args.id,
      type: args.type,
      ownerId: 'p',
      ownershipType: 'JOINT',
      taxTreatment: args.taxTreatment,
      institution: '',
      notes: '',
      active: args.active ?? true,
      planningReturnPct: 6,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
}

function makeBalance(args: {
  accountId: string;
  year: number;
  endingBalance: number;
  endingBalancePreTax?: number | null;
  endingBalancePostTax?: number | null;
  deletedAt?: string;
}): Aggregate<AccountBalancePayload> {
  seq += 1;
  return {
    id: `bal-${seq}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: args.deletedAt,
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId: args.accountId,
      year: args.year,
      lastUpdated: '2026-01-01',
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: args.endingBalance,
      endingBalancePreTax: args.endingBalancePreTax ?? null,
      endingBalancePostTax: args.endingBalancePostTax ?? null,
      totalContributions: 0,
      comment: null,
    },
  };
}

describe('buildAccountBalanceStackHistory', () => {
  it('builds one row per year for a single pre-tax account', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'a', year: 2021, endingBalance: 120 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows.map((r) => r.year)).toEqual([2020, 2021]);
    expect(rows[0].accountBalances.get('a')).toEqual({
      balance: 100,
      preEnd: 100,
      postEnd: 0,
      carriedForward: false,
    });
  });

  it('stacks multiple accounts across the union of their years', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      makeAccount({ id: 'b', type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'b', year: 2021, endingBalance: 50 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows.map((r) => r.year)).toEqual([2020, 2021]);
    expect(rows[0].accountBalances.has('b')).toBe(false);
    expect(rows[1].accountBalances.get('a')?.carriedForward).toBe(true);
    expect(rows[1].accountBalances.get('b')?.balance).toBe(50);
  });

  it('splits a MIXED account into preEnd/postEnd from the stored split', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_TSP', taxTreatment: 'MIXED' }),
    ];
    const balances = [
      makeBalance({
        accountId: 'a',
        year: 2020,
        endingBalance: 1000,
        endingBalancePreTax: 600,
        endingBalancePostTax: 400,
      }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows[0].accountBalances.get('a')).toEqual({
      balance: 1000,
      preEnd: 600,
      postEnd: 400,
      carriedForward: false,
    });
  });

  it('routes HSA balances to post-tax with preEnd===0', () => {
    const accounts = [makeAccount({ id: 'a', type: 'HSA', taxTreatment: 'HSA' })];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 500 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    const ay = rows[0].accountBalances.get('a')!;
    expect(ay.preEnd).toBe(0);
    expect(ay.postEnd).toBe(500);
  });

  it('routes Roth balances to post-tax with preEnd===0', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 700 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    const ay = rows[0].accountBalances.get('a')!;
    expect(ay.preEnd).toBe(0);
    expect(ay.postEnd).toBe(700);
  });

  it('carries the last known balance forward across gap years with the marker set', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'a', year: 2023, endingBalance: 130 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows.map((r) => r.year)).toEqual([2020, 2021, 2022, 2023]);
    expect(rows[1].accountBalances.get('a')).toEqual({
      balance: 100,
      preEnd: 100,
      postEnd: 0,
      carriedForward: true,
    });
    expect(rows[2].accountBalances.get('a')?.carriedForward).toBe(true);
    expect(rows[3].accountBalances.get('a')?.carriedForward).toBe(false);
  });

  it('marks years after the account own last entry carried-forward up to the latest actual year', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      makeAccount({ id: 'b', type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'b', year: 2022, endingBalance: 50 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(latestActualBalanceYear(balances)).toBe(2022);
    expect(rows[rows.length - 1].accountBalances.get('a')).toEqual({
      balance: 100,
      preEnd: 100,
      postEnd: 0,
      carriedForward: true,
    });
  });

  it('drops an account whose last entry is $0 (closed)', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      makeAccount({ id: 'b', type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'a', year: 2021, endingBalance: 0 }),
      makeBalance({ accountId: 'b', year: 2022, endingBalance: 50 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows[1].accountBalances.get('a')?.balance).toBe(0);
    expect(rows[2].accountBalances.has('a')).toBe(false);
  });

  it('includes inactive accounts', () => {
    const accounts = [
      makeAccount({
        id: 'a',
        type: 'RETIREMENT_401K',
        taxTreatment: 'PRE_TAX',
        active: false,
      }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'a', year: 2021, endingBalance: 110 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows[0].accountBalances.get('a')?.balance).toBe(100);
  });

  it('MIXED account with null splits falls back to full balance in preEnd', () => {
    const accounts = [
      makeAccount({ id: 'a', type: 'RETIREMENT_TSP', taxTreatment: 'MIXED' }),
    ];
    const balances = [
      makeBalance({
        accountId: 'a',
        year: 2020,
        endingBalance: 50000,
        endingBalancePreTax: null,
        endingBalancePostTax: null,
      }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountBalances.get('a')).toEqual({
      balance: 50000,
      preEnd: 50000,
      postEnd: 0,
      carriedForward: false,
    });
  });

  it('excludes deleted-account years from the timeline window', () => {
    const accounts = [
      makeAccount({ id: 'live', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      makeAccount({
        id: 'gone',
        type: 'BROKERAGE',
        taxTreatment: 'POST_TAX',
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const balances = [
      makeBalance({ accountId: 'live', year: 2023, endingBalance: 100 }),
      makeBalance({ accountId: 'gone', year: 2025, endingBalance: 50 }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    // The deleted account's 2025 balance must not extend the window past 2023.
    expect(rows.map((r) => r.year)).toEqual([2023]);
  });

  it('excludes soft-deleted accounts and balances (deletedAt)', () => {
    const accounts = [
      makeAccount({
        id: 'a',
        type: 'RETIREMENT_401K',
        taxTreatment: 'PRE_TAX',
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
      makeAccount({ id: 'b', type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
    ];
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 100 }),
      makeBalance({ accountId: 'b', year: 2020, endingBalance: 50 }),
      makeBalance({
        accountId: 'b',
        year: 2021,
        endingBalance: 999,
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const rows = buildAccountBalanceStackHistory(accounts, balances);
    expect(rows.map((r) => r.year)).toEqual([2020]);
    expect(rows[0].accountBalances.has('a')).toBe(false);
    expect(rows[0].accountBalances.get('b')?.balance).toBe(50);
  });
});

describe('latestActualBalanceYear', () => {
  it('returns the most recent year across accounts', () => {
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 1 }),
      makeBalance({ accountId: 'b', year: 2024, endingBalance: 1 }),
      makeBalance({ accountId: 'a', year: 2022, endingBalance: 1 }),
    ];
    expect(latestActualBalanceYear(balances)).toBe(2024);
  });

  it('returns null with no balance rows', () => {
    expect(latestActualBalanceYear([])).toBeNull();
  });

  it('ignores balance rows from deleted accounts when accounts array is provided', () => {
    const accounts = [
      makeAccount({ id: 'live', type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' }),
      makeAccount({
        id: 'gone',
        type: 'BROKERAGE',
        taxTreatment: 'POST_TAX',
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const balances = [
      makeBalance({ accountId: 'live', year: 2023, endingBalance: 100 }),
      makeBalance({ accountId: 'gone', year: 2025, endingBalance: 50 }),
    ];
    expect(latestActualBalanceYear(balances)).toBe(2025);
    expect(latestActualBalanceYear(balances, accounts)).toBe(2023);
  });
});

describe('distinctBalanceYearCount', () => {
  it('counts 2 distinct years → render threshold met', () => {
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 1 }),
      makeBalance({ accountId: 'b', year: 2020, endingBalance: 1 }),
      makeBalance({ accountId: 'a', year: 2021, endingBalance: 1 }),
    ];
    expect(distinctBalanceYearCount(balances)).toBe(2);
  });

  it('counts 1 distinct year → render threshold not met', () => {
    const balances = [
      makeBalance({ accountId: 'a', year: 2020, endingBalance: 1 }),
      makeBalance({ accountId: 'b', year: 2020, endingBalance: 1 }),
    ];
    expect(distinctBalanceYearCount(balances)).toBe(1);
  });

  it('counts 0 with no balances and 0 when all are deleted', () => {
    expect(distinctBalanceYearCount([])).toBe(0);
    const allDeleted = [
      makeBalance({
        accountId: 'a',
        year: 2020,
        endingBalance: 1,
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    expect(distinctBalanceYearCount(allDeleted)).toBe(0);
  });
});
