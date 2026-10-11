import { describe, expect, it } from 'vitest';
import type { StackBandYear } from '../account-balance-stack-timeline';
import type { ReportAccount, ReportExpense, ReportIncomeStream } from '../report-data';
import {
  buildAccountBalancesByAccountTableSpec,
  buildAccountBreakdownTableSpec,
  buildReportExpensesTableSpec,
  buildReportIncomeTableSpec,
  formatDollars,
  type StackTableAccount,
} from './pdf-tables';
import { buildRothTaxFreeRows } from '../report-roth-tax-free';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../../db/types';

const expense = (id: string, overrides: Partial<ReportExpense> = {}) => ({
  id, name: id, categoryName: 'Other', classification: 'essential',
  frequency: 'monthly', annualAmount: 1_200, effectiveStartMonth: 24_360,
  effectiveEndMonth: 24_372, startLabel: 'Start', endLabel: 'End',
  glideSummary: null, ...overrides,
}) as ReportExpense;
const income = (id: string, overrides: Partial<ReportIncomeStream> = {}) => ({
  id, name: id, kind: 'partTime', memberName: 'Owner', ownerSortRank: 0,
  annualAmount: 1_000, scheduleLabel: 'Schedule', colaPct: 0,
  tracksInflation: false, ...overrides,
}) as ReportIncomeStream;
const account = (id: string, name: string) => ({
  id, name, ownerDisplayName: 'Owner', type: 'RETIREMENT_401K',
  taxTreatment: 'PRE_TAX', assetMix: { stocksPct: 60, bondsPct: 35, cashPct: 5 },
  historicalReturnPct: 5, totalContributions: 10, totalGains: 20,
  currentBalance: 100, currentBalancePreTax: 100, currentBalancePostTax: null,
  currentBalanceTaxFree: null, plannedContributionPreTax: 0,
  plannedContributionPostTax: 0, configuredReturnPct: 5,
  balanceAsOfYear: 2025, balanceAsOfDate: '2025-12-31',
}) as ReportAccount;

describe('PDF table ordering', () => {
  it('orders expense and income rows before mapping them', () => {
    expect(buildReportExpensesTableSpec([
      expense('discretionary', { classification: 'discretionary' }),
      expense('late', { categoryName: 'Category 2', effectiveStartMonth: 24_500 }),
      expense('early', { categoryName: 'Category 10', effectiveStartMonth: 24_300 }),
    ]).body.map((row) => row[0])).toEqual(['late', 'early', 'discretionary']);
    expect(buildReportIncomeTableSpec([
      income('unknown', { ownerSortRank: 2 }), income('Pension 10'),
      income('pension 2'), income('secondary', { ownerSortRank: 1 }),
    ]).body.map((row) => row[0]))
      .toEqual(['pension 2', 'Pension 10', 'secondary', 'unknown']);
  });

  it('sorts account headers while preserving each balance cell', () => {
    const accounts: StackTableAccount[] = [
      { id: 'ten', name: 'Account 10', ownerDisplayName: 'Alex', type: 'RETIREMENT_401K' },
      { id: 'two-z', name: 'account 2', ownerDisplayName: 'Zoe', type: 'BROKERAGE' },
      { id: 'two-a', name: 'Account 2', ownerDisplayName: 'Alex', type: 'SAVINGS' },
    ];
    const rows: StackBandYear[] = [{
      year: 2040, zone: 'projected', accountBalances: new Map([
        ['ten', { balance: 10, preEnd: 10, postEnd: 0, carriedForward: false }],
        ['two-z', { balance: 20, preEnd: 0, postEnd: 20, carriedForward: false }],
        ['two-a', { balance: 30, preEnd: 0, postEnd: 30, carriedForward: false }],
      ]),
    }];
    const spec = buildAccountBalancesByAccountTableSpec(rows, accounts);
    expect(spec.head[0]).toEqual(['Year', 'Account 2', 'account 2', 'Account 10']);
    expect(spec.body[0]).toEqual([
      '2040', formatDollars(30), formatDollars(20), formatDollars(10),
    ]);
    expect(buildAccountBreakdownTableSpec([
      account('ten', 'Account 10'), account('two', 'account 2'),
    ]).body.map((row) => row[0])).toEqual(['account 2', 'Account 10']);
  });

  it('orders Roth tax-free rows: person pools by display name/member id, then employer plans via sortReportAccounts', () => {
    const rothMember = (id: string, firstName: string): Aggregate<HouseholdMemberPayload> => ({
      id, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-01-01T00:00:00Z', deviceId: 'd', aggregateType: 'householdMember',
      payload: { isPrimary: id === 'm1', firstName, lastName: '', email: '', birthdate: '1965-01-01' },
    });
    const rothAccount = (
      id: string,
      ownerId: string,
      type: AccountPayload['type'],
      taxTreatment: AccountPayload['taxTreatment'],
      over: Partial<AccountPayload> = {},
    ): Aggregate<AccountPayload> => ({
      id, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-01-01T00:00:00Z', deviceId: 'd', aggregateType: 'account',
      payload: {
        name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId,
        institution: '', notes: '', planningReturnPct: 5, active: true,
        plannedContributionPreTax: 0, plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 }, ...over,
      },
    });
    const rothBalance = (
      accountId: string,
      over: Partial<AccountBalancePayload> = {},
    ): Aggregate<AccountBalancePayload> => ({
      id: `b-${accountId}`, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-12-31T00:00:00Z', deviceId: 'd', aggregateType: 'accountBalance',
      payload: {
        accountId, year: 2025, lastUpdated: '2025-12-31', startingBalance: 0,
        startingBalancePreTax: null, startingBalancePostTax: null,
        contributionsPreTax: null, contributionsPostTax: null,
        companyContributions: 0, companyContributionsPreTax: null,
        companyContributionsPostTax: null, rollover: 0, distributions: 0,
        endingBalance: 0, endingBalancePreTax: null, endingBalancePostTax: null,
        totalContributions: 0, comment: null, ...over,
      },
    });

    const rows = buildRothTaxFreeRows({
      accounts: [
        rothAccount('emp-b', 'm1', 'RETIREMENT_401K', 'MIXED', {
          designatedRothFirstParticipationTaxYear: 2015,
        }),
        rothAccount('emp-a', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH'),
        rothAccount('ira-zed', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH'),
        rothAccount('ira-alex', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      ],
      balances: [
        rothBalance('emp-b', { rothInPlanRolloverTaxableAmount: 1000 }),
        rothBalance('emp-a'),
        rothBalance('ira-zed'),
        rothBalance('ira-alex'),
      ],
      members: [rothMember('m1', 'Alex'), rothMember('m2', 'Zed')],
    });
    expect(rows.map((r) => r.label)).toEqual(['Alex', 'Zed', 'emp-a', 'emp-b']);
    expect(rows.map((r) => r.kind)).toEqual(['person', 'person', 'employer', 'employer']);
  });
});
