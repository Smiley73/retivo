import { describe, expect, it } from 'vitest';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import {
  accountReturns,
  gainLoss,
  totalContributions,
} from './balance-calc';
import { buildReportAccountMetrics } from './report-account-metrics';

const HOUSEHOLD_ID = 'household-1';

function account(
  id: string,
  patch: Partial<AccountPayload> = {},
  deletedAt?: string,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 6,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    ...(deletedAt ? { deletedAt } : {}),
    deviceId: 'device-1',
    aggregateType: 'account',
    payload: {
      name: id,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'member-1',
      institution: '',
      notes: '',
      planningReturnPct: 6,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...patch,
    },
  };
}

function balance(
  id: string,
  accountId: string,
  year: number,
  patch: Partial<AccountBalancePayload> = {},
  deletedAt?: string,
): Aggregate<AccountBalancePayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T20:00:00Z`,
    ...(deletedAt ? { deletedAt } : {}),
    deviceId: 'device-1',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31T20:00:00Z`,
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
      endingBalance: 0,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...patch,
    },
  };
}

function member(
  id: string,
  firstName: string,
  deletedAt?: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    ...(deletedAt ? { deletedAt } : {}),
    deviceId: 'device-1',
    aggregateType: 'householdMember',
    payload: {
      isPrimary: id === 'member-1',
      firstName,
      lastName: '',
      email: '',
      birthdate: '1970-01-01',
    },
  };
}

describe('buildReportAccountMetrics', () => {
  it('uses latest live row and canonical all-history return, contribution, and gain math without mutating inputs', () => {
    const accounts = [
      account('mixed-plan', {
        type: 'RETIREMENT_401K',
        taxTreatment: 'MIXED',
      }),
    ];
    const seed = balance('seed', 'mixed-plan', 2022);
    const first = balance('first', 'mixed-plan', 2023, {
      startingBalance: 100_000,
      contributionsPreTax: 8_000,
      contributionsPostTax: 2_000,
      companyContributions: 4_000,
      companyContributionsPreTax: 3_000,
      companyContributionsPostTax: 1_000,
      rollover: 5_000,
      distributions: 1_500,
      endingBalance: 125_000,
      endingBalancePreTax: 100_000,
      endingBalancePostTax: 25_000,
      totalContributions: 999_999,
    });
    const latest = balance('latest', 'mixed-plan', 2024, {
      lastUpdated: '2024-09-14T18:30:00Z',
      startingBalance: 125_000,
      contributionsPreTax: 9_000,
      contributionsPostTax: 2_500,
      companyContributions: 4_500,
      companyContributionsPreTax: 3_500,
      companyContributionsPostTax: 1_000,
      rollover: 2_000,
      distributions: 4_000,
      endingBalance: 150_000,
      endingBalancePreTax: 118_000,
      endingBalancePostTax: 32_000,
      totalContributions: 888_888,
    });
    const balances = [latest, seed, first];
    const members = [member('member-1', '  Ada  ')];
    const accountsBefore = structuredClone(accounts);
    const balancesBefore = structuredClone(balances);
    const membersBefore = structuredClone(members);

    const result = buildReportAccountMetrics(accounts, balances, members);

    expect(result.get('mixed-plan')).toEqual({
      ownerDisplayName: 'Ada',
      historicalReturnPct: accountReturns([latest, seed, first]).twr,
      totalContributions:
        totalContributions(latest.payload) +
        totalContributions(seed.payload) +
        totalContributions(first.payload),
      totalGains:
        gainLoss(latest.payload) + gainLoss(seed.payload) + gainLoss(first.payload),
      currentBalance: 150_000,
      currentBalancePreTax: 118_000,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 32_000,
      balanceAsOfYear: 2024,
      balanceAsOfDate: '2024-09-14',
    });
    expect(accounts).toEqual(accountsBefore);
    expect(balances).toEqual(balancesBefore);
    expect(members).toEqual(membersBefore);
  });

  it('routes latest balances into mutually exclusive tax buckets for every treatment', () => {
    const accounts = [
      account('pre'),
      account('post', { type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
      account('post-tsp', { type: 'RETIREMENT_TSP', taxTreatment: 'POST_TAX' }),
      account('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
      account('roth-401k', { type: 'RETIREMENT_ROTH_401K', taxTreatment: 'ROTH' }),
      account('roth-403b', { type: 'RETIREMENT_ROTH_403B', taxTreatment: 'ROTH' }),
      account('roth-457b', { type: 'RETIREMENT_ROTH_457B', taxTreatment: 'ROTH' }),
      account('roth-tsp', { type: 'RETIREMENT_ROTH_TSP', taxTreatment: 'ROTH' }),
      account('hsa', { type: 'HSA', taxTreatment: 'HSA' }),
      account('mixed-plan', { type: 'RETIREMENT_401K', taxTreatment: 'MIXED' }),
      account('mixed-other', { type: 'OTHER', taxTreatment: 'MIXED' }),
      account('fallback-plan', { type: 'RETIREMENT_403B', taxTreatment: 'MIXED' }),
      account('fallback-other', { type: 'OTHER', taxTreatment: 'MIXED' }),
    ];
    const balances = [
      balance('pre-row', 'pre', 2025, { endingBalance: 100 }),
      balance('post-row', 'post', 2025, { endingBalance: 200 }),
      balance('post-tsp-row', 'post-tsp', 2025, { endingBalance: 300 }),
      balance('roth-row', 'roth', 2025, { endingBalance: 400 }),
      balance('roth-401k-row', 'roth-401k', 2025, { endingBalance: 410 }),
      balance('roth-403b-row', 'roth-403b', 2025, { endingBalance: 420 }),
      balance('roth-457b-row', 'roth-457b', 2025, { endingBalance: 430 }),
      balance('roth-tsp-row', 'roth-tsp', 2025, { endingBalance: 440 }),
      balance('hsa-row', 'hsa', 2025, { endingBalance: 500 }),
      balance('mixed-plan-row', 'mixed-plan', 2025, {
        endingBalance: 600,
        endingBalancePreTax: 450,
        endingBalancePostTax: 150,
      }),
      balance('mixed-other-row', 'mixed-other', 2025, {
        endingBalance: 700,
        endingBalancePreTax: 425,
        endingBalancePostTax: 275,
      }),
      balance('fallback-plan-row', 'fallback-plan', 2025, {
        endingBalance: 800,
        endingBalancePreTax: 0,
        endingBalancePostTax: 0,
      }),
      balance('fallback-other-row', 'fallback-other', 2025, {
        endingBalance: 900,
      }),
    ];

    const result = buildReportAccountMetrics(accounts, balances, [member('member-1', 'Ada')]);
    const buckets = (id: string): [number | null, number | null, number | null] => {
      const metric = result.get(id);
      return [
        metric?.currentBalancePreTax ?? null,
        metric?.currentBalancePostTax ?? null,
        metric?.currentBalanceTaxFree ?? null,
      ];
    };

    expect(buckets('pre')).toEqual([100, null, null]);
    expect(buckets('post')).toEqual([null, 200, null]);
    expect(buckets('post-tsp')).toEqual([null, null, 300]);
    expect(buckets('roth')).toEqual([null, null, 400]);
    expect(buckets('roth-401k')).toEqual([null, null, 410]);
    expect(buckets('roth-403b')).toEqual([null, null, 420]);
    expect(buckets('roth-457b')).toEqual([null, null, 430]);
    expect(buckets('roth-tsp')).toEqual([null, null, 440]);
    expect(buckets('hsa')).toEqual([null, null, 500]);
    expect(buckets('mixed-plan')).toEqual([450, null, 150]);
    expect(buckets('mixed-other')).toEqual([425, 275, null]);
    expect(buckets('fallback-plan')).toEqual([800, null, 0]);
    expect(buckets('fallback-other')).toEqual([900, 0, null]);
  });

  it('uses zero for applicable empty-history buckets and null for inapplicable buckets', () => {
    const accounts = [
      account('pre'),
      account('post', { type: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
      account('post-tsp', { type: 'RETIREMENT_TSP', taxTreatment: 'POST_TAX' }),
      account('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH' }),
      account('hsa', { type: 'HSA', taxTreatment: 'HSA' }),
      account('mixed-plan', { type: 'RETIREMENT_457B', taxTreatment: 'MIXED' }),
      account('mixed-other', { type: 'OTHER', taxTreatment: 'MIXED' }),
    ];

    const result = buildReportAccountMetrics(accounts, [], [member('member-1', 'Ada')]);

    expect(result.get('pre')).toMatchObject({
      historicalReturnPct: null,
      totalContributions: 0,
      totalGains: 0,
      currentBalance: 0,
      currentBalancePreTax: 0,
      currentBalancePostTax: null,
      currentBalanceTaxFree: null,
      balanceAsOfYear: null,
      balanceAsOfDate: null,
    });
    expect(result.get('post')).toMatchObject({
      currentBalancePreTax: null,
      currentBalancePostTax: 0,
      currentBalanceTaxFree: null,
    });
    expect(result.get('post-tsp')).toMatchObject({
      currentBalancePreTax: null,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 0,
    });
    expect(result.get('roth')).toMatchObject({
      currentBalancePreTax: null,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 0,
    });
    expect(result.get('hsa')).toMatchObject({
      currentBalancePreTax: null,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 0,
    });
    expect(result.get('mixed-plan')).toMatchObject({
      currentBalancePreTax: 0,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 0,
    });
    expect(result.get('mixed-other')).toMatchObject({
      currentBalancePreTax: 0,
      currentBalancePostTax: 0,
      currentBalanceTaxFree: null,
    });
  });

  it('retains inactive accounts while filtering tombstoned accounts plus tombstoned and orphaned balance rows', () => {
    const live = account('live');
    const inactive = account('inactive', { active: false });
    const deleted = account('deleted', {}, '2026-01-02T00:00:00Z');
    const result = buildReportAccountMetrics(
      [live, inactive, deleted],
      [
        balance('live-row', 'live', 2024, { endingBalance: 125 }),
        balance('deleted-newer-row', 'live', 2025, { endingBalance: 999 }, '2026-01-02T00:00:00Z'),
        balance('inactive-row', 'inactive', 2025, { endingBalance: 500 }),
        balance('deleted-account-row', 'deleted', 2025, { endingBalance: 600 }),
        balance('orphan-row', 'orphan', 2025, { endingBalance: 700 }),
      ],
      [member('member-1', 'Ada')],
    );

    expect([...result.keys()]).toEqual(['live', 'inactive']);
    expect(result.get('live')?.currentBalance).toBe(125);
    expect(result.get('live')?.balanceAsOfYear).toBe(2024);
    expect(result.get('inactive')?.currentBalance).toBe(500);
  });

  it('formats owners as Joint, trimmed first name, Member, or an em dash', () => {
    const result = buildReportAccountMetrics(
      [
        account('joint', { ownershipType: 'JOINT', ownerId: 'missing' }),
        account('named', { ownerId: 'member-1' }),
        account('blank', { ownerId: 'member-2' }),
        account('missing', { ownerId: 'missing' }),
        account('deleted-member', { ownerId: 'member-3' }),
      ],
      [],
      [
        member('member-1', '  Ada  '),
        member('member-2', '   '),
        member('member-3', 'Grace', '2026-01-02T00:00:00Z'),
      ],
    );

    expect(result.get('joint')?.ownerDisplayName).toBe('Joint');
    expect(result.get('named')?.ownerDisplayName).toBe('Ada');
    expect(result.get('blank')?.ownerDisplayName).toBe('Member');
    expect(result.get('missing')?.ownerDisplayName).toBe('—');
    expect(result.get('deleted-member')?.ownerDisplayName).toBe('—');
  });
});
