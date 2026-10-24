// Faster Medical inflation raises the expense series, pre-tax withdrawals, MAGI and so federal tax: two otherwise-identical runs differ only by the Medical rate (general+2pp default vs an explicit override at general).
import { describe, expect, it } from 'vitest';
import { runBalanceProjection } from './balance-projection-runner';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');

function member(
  id: string,
  isPrimary: boolean,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName: id,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

function preTaxAccount(id: string, ownerId: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId,
      institution: 'Fidelity',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

function medicalExpense(amount: number): Aggregate<ExpensePayload> {
  return {
    id: 'e-med',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: 'Healthcare',
      categoryId: 'cat-medical',
      amount,
      frequency: 'monthly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

function taxScenario(inflation: ScenarioOverrides['inflation']): ScenarioAggregate {
  return {
    id: 's',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'TaxAware',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
        retirementAge: { primary: { ageYears: 67, ageMonths: 0 } },
        lifeExpectancy: { primary: 90 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        inflation,
      },
    },
  };
}

function runWith(inflation: ScenarioOverrides['inflation']) {
  const scenario = taxScenario(inflation);
  return runBalanceProjection({
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [preTaxAccount('a1', 'm1')],
    balances: [balanceRow('a1', 2025, 2_000_000)],
    members: [member('m1', true, 1965)],
    ssBenefits: [ssBenefit('m1', 2000)],
    expenses: [medicalExpense(8_000)],
    incomeStreams: [],
    todayYear: TODAY.getUTCFullYear(),
    todayMonthIndex: TODAY.getUTCMonth(),
  });
}

describe('deterministic tax feedback from per-category Medical inflation', () => {
  it('the Medical +2pp default raises later-year withdrawals → MAGI → federal tax', () => {
    const withSpread = runWith({ ratePct: 3 });
    const noSpread = runWith({ ratePct: 3, categoryRates: { 'cat-medical': 3 } });

    // Born 1965, retire 2032, horizon 2055: 2050 is late enough for the compounded spread to matter.
    const targetYear = 2050;
    const wSpread = withSpread.drawdownYears.find((y) => y.year === targetYear);
    const wNoSpread = noSpread.drawdownYears.find((y) => y.year === targetYear);
    expect(wSpread).toBeDefined();
    expect(wNoSpread).toBeDefined();

    expect(wSpread!.magiCents).toBeGreaterThan(wNoSpread!.magiCents ?? 0);
    expect(wSpread!.federalTaxCents ?? 0).toBeGreaterThan(
      wNoSpread!.federalTaxCents ?? 0,
    );
  });
});
