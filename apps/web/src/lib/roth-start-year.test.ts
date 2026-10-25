import { describe, expect, it } from 'vitest';
import type { AccountBalancePayload, AccountPayload, Aggregate } from '../db/types';
import { resolveEffectiveRothStartYear, resolveRothStartYear } from './roth-start-year';

function row(
  year: number,
  over: Partial<AccountBalancePayload> = {},
  deletedAt?: string,
): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-a-${year}-${Math.random()}`,
    householdId: 'h1',
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00.000Z`,
    deviceId: 'dev-1',
    ...(deletedAt ? { deletedAt } : {}),
    payload: {
      accountId: 'a',
      year,
      lastUpdated: `${year}-12-31T00:00:00.000Z`,
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
      ...over,
    },
  };
}

const resolve = (
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  over: Partial<Parameters<typeof resolveRothStartYear>[0]> = {},
) =>
  resolveRothStartYear({
    accountId: 'a',
    type: 'RETIREMENT_ROTH_IRA',
    taxTreatment: 'ROTH',
    explicitYear: undefined,
    balances,
    ...over,
  });

function account(
  id: string,
  ownerId: string,
  over: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h1',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      type: 'RETIREMENT_ROTH_IRA',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'ROTH',
      ownerId,
      institution: '',
      notes: '',
      planningReturnPct: 6,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...over,
    },
  };
}

describe('resolveRothStartYear', () => {
  it('uses a valid explicit year before earlier balance evidence', () => {
    expect(resolve([row(2005, { endingBalance: 1 })], { explicitYear: 2018 })).toEqual({
      year: 2018,
      source: 'explicit',
    });
  });

  it.each([
    ['startingBalance', { startingBalance: 1 }],
    ['endingBalance', { endingBalance: 1 }],
    ['totalContributions', { totalContributions: 1 }],
    ['rollover', { rollover: 1 }],
    ['taxable conversion', { rothConversionTaxableAmount: 1 }],
    ['nontaxable conversion', { rothConversionNontaxableAmount: 1 }],
  ] satisfies ReadonlyArray<[string, Partial<AccountBalancePayload>]>)
    ('infers a Roth IRA year from positive %s evidence', (_label, evidence) => {
      expect(resolve([row(2016, evidence)])).toEqual({ year: 2016, source: 'balance-history' });
    });

  it('uses only Roth/post-tax-specific evidence for a MIXED employer plan', () => {
    const mixed = { type: 'RETIREMENT_401K', taxTreatment: 'MIXED' } as const;
    expect(
      resolve([row(2014, { endingBalance: 50_000, totalContributions: 5_000, rollover: 2_000 })], mixed),
    ).toEqual({ source: 'unavailable' });
    expect(
      resolve(
        [row(2017, { endingBalancePostTax: 10 }), row(2015, { companyContributionsPostTax: 1 })],
        mixed,
      ),
    ).toEqual({ year: 2015, source: 'balance-history' });
  });

  it('supports designated-Roth plan rollover evidence but excludes regular post-tax TSP', () => {
    const balances = [row(2019, { rothInPlanRolloverTaxableAmount: 100 })];
    expect(resolve(balances, { type: 'RETIREMENT_ROTH_TSP' })).toEqual({
      year: 2019,
      source: 'balance-history',
    });
    expect(resolve(balances, { type: 'RETIREMENT_TSP', taxTreatment: 'POST_TAX' })).toEqual({
      source: 'unavailable',
    });
  });

  it('ignores zero, invalid, deleted, and other-account rows', () => {
    expect(
      resolve([
        row(2010),
        row(2011, { endingBalance: Number.NaN }),
        row(2012, { endingBalance: 1 }, '2020-01-01T00:00:00.000Z'),
        row(2013, { accountId: 'other', endingBalance: 1 }),
      ]),
    ).toEqual({ source: 'unavailable' });
  });

  it('lets the first duplicate row claim a year even when its evidence is zero', () => {
    expect(resolve([row(2012), row(2012, { endingBalance: 1 }), row(2018, { endingBalance: 1 })])).toEqual({
      year: 2018,
      source: 'balance-history',
    });
  });

  it('re-evaluates the same history using the current account classification', () => {
    const balances = [row(2013, { endingBalance: 10 })];
    expect(resolve(balances, { type: 'BROKERAGE', taxTreatment: 'POST_TAX' })).toEqual({
      source: 'unavailable',
    });
    expect(resolve(balances)).toEqual({ year: 2013, source: 'balance-history' });
  });

  it("uses the earliest clock from an owner's own Roth IRA pool but keeps inherited accounts separate", () => {
    const accounts = [
      account('a', 'owner'),
      account('older', 'owner', { rothIraFirstContributionTaxYear: 2010 }),
      account('inherited', 'owner', {
        rmdInheritedAccount: true,
        rothIraFirstContributionTaxYear: 2005,
      }),
      account('other-owner', 'other', { rothIraFirstContributionTaxYear: 2001 }),
    ];
    const shared = resolveEffectiveRothStartYear({
      accountId: 'a',
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      explicitYear: undefined,
      balances: [],
      ownerId: 'owner',
      inherited: false,
      accounts,
    });
    expect(shared).toEqual({ year: 2010, source: 'roth-ira-pool' });

    const inherited = resolveEffectiveRothStartYear({
      accountId: 'inherited',
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      explicitYear: 2005,
      balances: [],
      ownerId: 'owner',
      inherited: true,
      accounts,
    });
    expect(inherited).toEqual({ year: 2005, source: 'explicit' });
  });

  it('keeps ownerless imported Roth IRAs in singleton pools like the engine', () => {
    expect(
      resolveEffectiveRothStartYear({
        accountId: 'a',
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'ROTH',
        explicitYear: undefined,
        balances: [],
        ownerId: '',
        inherited: false,
        accounts: [account('older-ownerless', '', { rothIraFirstContributionTaxYear: 2001 })],
      }),
    ).toEqual({ source: 'unavailable' });
  });
});
