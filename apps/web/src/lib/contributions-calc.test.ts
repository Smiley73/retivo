import {
  computeContributionSummary,
  isTreatmentEditablePreTax,
  isTreatmentEditablePostTax,
} from '../lib/contributions-calc';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';

const YEAR = 2026;

function aggregate<T extends Record<string, unknown>>(
  type: 'account' | 'accountBalance',
  id: string,
  body: T,
): Aggregate<T> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: body,
  };
}

function accountAgg(
  id: string,
  overrides: Partial<AccountPayload> = {},
): Aggregate<AccountPayload> {
  return aggregate('account', id, {
    name: id,
    type: 'RETIREMENT_401K',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'MIXED',
    ownerId: 'hm-1',
    institution: 'Bank',
    notes: '',
    planningReturnPct: 6,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    ...overrides,
  });
}

function balanceAgg(
  accountId: string,
  year: number,
  overrides: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return aggregate('accountBalance', `bal-${accountId}-${year}`, {
    accountId,
    year,
    lastUpdated: `${year}-12-31T23:59:59Z`,
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
    ...overrides,
  });
}

const members = new Map<string, HouseholdMemberPayload>([
  [
    'hm-1',
    {
      isPrimary: true,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'j@x',
      birthdate: '1985-01-01',
    },
  ],
]);

describe('computeContributionSummary', () => {
  it('returns zero totals for an empty workspace', () => {
    const r = computeContributionSummary([], [], members, YEAR);
    expect(r.year).toBe(YEAR);
    expect(r.accounts).toEqual([]);
    expect(r.summary.totalPlanned).toBe(0);
    expect(r.summary.totalRemaining).toBe(0);
  });

  it('MIXED account splits actuals across pre/post-tax columns', () => {
    const acc = accountAgg('acc-mix', {
      taxTreatment: 'MIXED',
      plannedContributionPreTax: 12000,
      plannedContributionPostTax: 6000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const bal = balanceAgg('acc-mix', YEAR, {
      contributionsPreTax: 5000,
      contributionsPostTax: 2000,
      companyContributionsPreTax: 1000,
      companyContributionsPostTax: 0,
      totalContributions: 8000,
    });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [bal],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(6000);
    expect(r.accounts[0].actualPostTax).toBe(2000);
    expect(r.accounts[0].remainingPreTax).toBe(6000);
    expect(r.accounts[0].remainingPostTax).toBe(4000);
    expect(r.accounts[0].plannedTotal).toBe(18000);
  });

  it('PRE_TAX account places totalContributions on the pre-tax side', () => {
    const acc = accountAgg('acc-ira', {
      taxTreatment: 'PRE_TAX',
      plannedContributionPreTax: 7000,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const bal = balanceAgg('acc-ira', YEAR, { totalContributions: 3000 });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [bal],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(3000);
    expect(r.accounts[0].actualPostTax).toBe(0);
    expect(r.accounts[0].remainingPreTax).toBe(4000);
  });

  it('POST_TAX account places totalContributions on the post-tax side', () => {
    const acc = accountAgg('acc-roth', {
      taxTreatment: 'POST_TAX',
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 7000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const bal = balanceAgg('acc-roth', YEAR, { totalContributions: 1000 });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [bal],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(0);
    expect(r.accounts[0].actualPostTax).toBe(1000);
    expect(r.accounts[0].remainingPostTax).toBe(6000);
  });

  it('HSA account places totalContributions on the pre-tax side (actualPostTax = 0)', () => {
    // HSA contributions are pre-tax, so a recorded HSA's totalContributions lands in the pre-tax actual column.
    const acc = accountAgg('acc-hsa', {
      type: 'HSA',
      taxTreatment: 'HSA',
      plannedContributionPreTax: 4150,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const bal = balanceAgg('acc-hsa', YEAR, { totalContributions: 4150 });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [bal],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(4150);
    expect(r.accounts[0].actualPostTax).toBe(0);
  });

  it('ROTH account places totalContributions on the post-tax side (actualPreTax = 0)', () => {
    const acc = accountAgg('acc-roth', {
      type: 'RETIREMENT_ROTH_IRA',
      taxTreatment: 'ROTH',
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 7000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const bal = balanceAgg('acc-roth', YEAR, { totalContributions: 1000 });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [bal],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(0);
    expect(r.accounts[0].actualPostTax).toBe(1000);
    expect(r.accounts[0].remainingPostTax).toBe(6000);
  });

  it('treats accounts with no current-year balance as actuals = 0', () => {
    const acc = accountAgg('acc-new', {
      taxTreatment: 'PRE_TAX',
      plannedContributionPreTax: 5000,
    });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(0);
    expect(r.accounts[0].remainingPreTax).toBe(5000);
  });

  it('ignores balance rows from prior years', () => {
    const acc = accountAgg('acc', {
      taxTreatment: 'PRE_TAX',
      plannedContributionPreTax: 10_000,
    });
    const balPrior = balanceAgg('acc', YEAR - 1, { totalContributions: 8000 });
    const balThis = balanceAgg('acc', YEAR, { totalContributions: 1500 });
    const r = computeContributionSummary(
      [{ account: acc, ownerDisplayName: 'Jane Doe' }],
      [balPrior, balThis],
      members,
      YEAR,
    );
    expect(r.accounts[0].actualPreTax).toBe(1500);
    expect(r.accounts[0].remainingPreTax).toBe(8500);
  });

  it('summary aggregates across rows', () => {
    const a1 = accountAgg('a1', {
      taxTreatment: 'PRE_TAX',
      plannedContributionPreTax: 5000,
    });
    const a2 = accountAgg('a2', {
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 7000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const b1 = balanceAgg('a1', YEAR, { totalContributions: 1000 });
    const r = computeContributionSummary(
      [
        { account: a1, ownerDisplayName: 'Jane Doe' },
        { account: a2, ownerDisplayName: 'Jane Doe' },
      ],
      [b1],
      members,
      YEAR,
    );
    expect(r.summary.totalPlanned).toBe(12000);
    expect(r.summary.totalPlannedPreTax).toBe(5000);
    expect(r.summary.totalPlannedPostTax).toBe(7000);
    expect(r.summary.totalRemaining).toBe(11000);
  });
});

describe('treatment editability (contribution input visibility)', () => {
  it('HSA shows the pre-tax field ONLY (made pre-tax; post-tax hidden)', () => {
    expect(isTreatmentEditablePreTax('HSA')).toBe(true);
    expect(isTreatmentEditablePostTax('HSA')).toBe(false);
  });

  it('MIXED shows BOTH pre-tax and post-tax fields', () => {
    expect(isTreatmentEditablePreTax('MIXED')).toBe(true);
    expect(isTreatmentEditablePostTax('MIXED')).toBe(true);
  });

  it('PRE_TAX shows pre-tax only; POST_TAX shows post-tax only', () => {
    expect(isTreatmentEditablePreTax('PRE_TAX')).toBe(true);
    expect(isTreatmentEditablePostTax('PRE_TAX')).toBe(false);
    expect(isTreatmentEditablePreTax('POST_TAX')).toBe(false);
    expect(isTreatmentEditablePostTax('POST_TAX')).toBe(true);
  });

  it('ROTH shows the post-tax field ONLY (post-tax funded; pre-tax hidden)', () => {
    expect(isTreatmentEditablePreTax('ROTH')).toBe(false);
    expect(isTreatmentEditablePostTax('ROTH')).toBe(true);
  });
});
