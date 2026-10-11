/**
 * Focused report-data plumbing tests for PDF account metrics.
 */
import { describe, expect, it } from 'vitest';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { ReportAccountMetrics } from './report-account-metrics';
import {
  buildReportData,
  type BuildReportDataInput,
} from './report-data';

const HOUSEHOLD_ID = 'household-1';
const NOW = new Date('2026-08-25T12:00:00Z');

function member(id: string, firstName: string): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'device-1',
    aggregateType: 'householdMember',
    payload: {
      isPrimary: true,
      firstName,
      lastName: '',
      email: '',
      birthdate: '1970-01-01',
    },
  };
}

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
      plannedContributionPreTax: 10_000,
      plannedContributionPostTax: 2_000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...patch,
    },
  };
}

function scenario(
  id: string,
  patch: Partial<ScenarioPayload>,
): ScenarioAggregate {
  return {
    id,
    householdId: HOUSEHOLD_ID,
    schemaVersion: 4,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'device-1',
    aggregateType: 'scenario',
    payload: {
      name: patch.name ?? id,
      description: patch.description ?? '',
      parentScenarioId: patch.parentScenarioId ?? null,
      isPrimary: patch.isPrimary ?? false,
      notes: patch.notes ?? '',
      overrides: patch.overrides ?? {},
    },
  };
}

function metric(
  patch: Partial<ReportAccountMetrics> = {},
): ReportAccountMetrics {
  return {
    ownerDisplayName: 'Ada',
    historicalReturnPct: 7.25,
    totalContributions: 55_000,
    totalGains: 12_345,
    currentBalance: 123_456,
    currentBalancePreTax: 100_000,
    currentBalancePostTax: null,
    currentBalanceTaxFree: 23_456,
    balanceAsOfYear: 2025,
    balanceAsOfDate: '2025-11-30',
    ...patch,
  };
}

function input(
  overrides: Partial<BuildReportDataInput> = {},
): BuildReportDataInput {
  const base = scenario('base', { name: 'Base', isPrimary: true });
  const selected = scenario('selected', {
    name: 'Selected',
    parentScenarioId: 'base',
    overrides: {
      accountReturns: {
        perAccount: { 'account-1': { planningReturnPct: 8.5 } },
      },
      accountContributions: {
        perAccount: {
          'account-1': {
            plannedContributionPreTax: 12_000,
            plannedContributionPostTax: 3_000,
          },
        },
      },
    },
  });
  return {
    household: undefined,
    members: [member('member-1', 'Ada')],
    accounts: [account('account-1')],
    currentBalanceByAccountId: new Map([['account-1', 1]]),
    currentBalancePreTaxById: new Map([['account-1', 1]]),
    currentBalancePostTaxById: new Map([['account-1', null]]),
    expenses: [],
    expenseCategoryNameById: new Map(),
    incomeStreams: [],
    socialSecurity: [],
    scenarios: [base, selected],
    activeScenarioId: 'selected',
    ...overrides,
  };
}

describe('buildReportData — account metric plumbing', () => {
  it('copies exact metric fields while preserving scenario-resolved planned values', () => {
    const inactive = account('inactive', {
      active: false,
      ownershipType: 'JOINT',
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
    });
    const deleted = account(
      'deleted',
      {},
      '2026-01-02T00:00:00Z',
    );
    const accountMetricsById = new Map<string, ReportAccountMetrics>([
      ['account-1', metric()],
      [
        'inactive',
        metric({
          ownerDisplayName: 'Joint',
          historicalReturnPct: null,
          totalContributions: 0,
          totalGains: -250,
          currentBalance: 500,
          currentBalancePreTax: 500,
          currentBalanceTaxFree: null,
          balanceAsOfYear: 2024,
          balanceAsOfDate: '2024-12-31',
        }),
      ],
      ['deleted', metric({ currentBalance: 999_999 })],
    ]);

    const data = buildReportData(
      input({
        accounts: [account('account-1'), inactive, deleted],
        accountMetricsById,
      }),
      NOW,
    );

    expect(data.accounts.map((row) => row.id)).toEqual([
      'account-1',
      'inactive',
    ]);
    expect(data.accounts[0]).toMatchObject({
      ownerDisplayName: 'Ada',
      historicalReturnPct: 7.25,
      totalContributions: 55_000,
      totalGains: 12_345,
      currentBalance: 123_456,
      currentBalancePreTax: 100_000,
      currentBalancePostTax: null,
      currentBalanceTaxFree: 23_456,
      balanceAsOfYear: 2025,
      balanceAsOfDate: '2025-11-30',
      plannedContributionPreTax: 12_000,
      plannedContributionPostTax: 3_000,
      configuredReturnPct: 8.5,
    });
    expect(data.accounts[1]).toMatchObject({
      ownerDisplayName: 'Joint',
      totalGains: -250,
      currentBalance: 500,
    });
    expect(data.overview.totalCurrentPortfolio).toBe(123_956);
  });

  it('supplies safe metric defaults for legacy direct callers', () => {
    const data = buildReportData(input(), NOW);

    expect(data.accounts[0]).toMatchObject({
      ownerDisplayName: 'Ada',
      historicalReturnPct: null,
      totalContributions: 0,
      totalGains: 0,
      currentBalance: 1,
      currentBalancePreTax: 1,
      currentBalancePostTax: null,
      currentBalanceTaxFree: null,
    });
  });
});
