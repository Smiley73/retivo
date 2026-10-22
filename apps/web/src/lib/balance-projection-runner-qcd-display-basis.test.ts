/** QCD display-basis tests at 3% inflation, where the engine's year-end gift inflation and the page's display deflation must agree. */
import { describe, expect, it } from 'vitest';
import { runBalanceProjectionForPage } from './balance-projection-runner';
import { buildQcdRows } from '../pages/balance-projection-burden-rows';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  QcdEntry,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');
const TODAY_YEAR = TODAY.getUTCFullYear();
const TODAY_MONTH = TODAY.getUTCMonth();
const INFLATION_PCT = 3;
const GIFT_DOLLARS = 10_000;

const PRIMARY: Aggregate<HouseholdMemberPayload> = {
  id: 'm1',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    isPrimary: true,
    firstName: 'Pat',
    lastName: 'Doe',
    email: 'm1@example.test',
    birthdate: '1955-01-01',
  },
};

const SS: Aggregate<SocialSecurityBenefitPayload> = {
  id: 'ss-m1',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'socialSecurityBenefit',
  payload: { householdMemberId: 'm1', pia: 2_500, piaAsOfDate: '2026-01-01', notes: null },
};

const IRA: Aggregate<AccountPayload> = {
  id: 'ira',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'account',
  payload: {
    name: 'ira',
    type: 'RETIREMENT_IRA',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'PRE_TAX',
    ownerId: 'm1',
    institution: 'Vanguard',
    notes: '',
    planningReturnPct: 4,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
  },
};

const BALANCE: Aggregate<AccountBalancePayload> = {
  id: 'b-ira-2025',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'accountBalance',
  payload: {
    accountId: 'ira',
    year: 2025,
    lastUpdated: '2025-12-31',
    startingBalance: 1_900_000,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance: 2_000_000,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    comment: null,
  },
};

const EXPENSE: Aggregate<ExpensePayload> = {
  id: 'e-living',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'expense',
  payload: {
    name: 'Living',
    categoryId: 'cat-housing',
    amount: 40_000,
    frequency: 'yearly',
    classification: 'essential',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
  },
};

const QCD: QcdEntry = {
  memberId: 'm1',
  sourceAccountId: 'ira',
  annualAmountDollars: GIFT_DOLLARS,
  start: { kind: 'year', year: 2028 },
  end: { kind: 'year', year: 2034 },
};

const SCENARIO: ScenarioAggregate = {
  id: 's',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'scenario',
  payload: {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {
      socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
      retirementAge: { primary: { ageYears: 73, ageMonths: 0 } },
      inflation: { ratePct: INFLATION_PCT },
      lifeExpectancy: { primary: 88 },
      withdrawalStrategy: { kind: 'taxEfficient' },
      qualifiedCharitableDistributions: [QCD],
    },
  },
};

// The page's Today's-dollars display deflator: the December anchor 1 / inflationFactorAt(year, 11) with asOfMonth = today.
const asOfMonth = TODAY_YEAR * 12 + TODAY_MONTH;
function decemberFactor(year: number): number {
  return Math.pow(1 + INFLATION_PCT / 100, (year * 12 + 11 - asOfMonth) / 12);
}

describe('QCD display basis at 3% inflation (year-end anchor)', () => {
  const page = runBalanceProjectionForPage({
    scenarioId: 's',
    scenarios: [SCENARIO],
    accounts: [IRA],
    balances: [BALANCE],
    members: [PRIMARY],
    ssBenefits: [SS],
    expenses: [EXPENSE],
    incomeStreams: [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
  });
  const years = page.planned?.years ?? [];
  const qcdYears = years.filter((y) => (y.qcdCents ?? 0) > 0);

  it('inflates the REAL gift by the December factor and stamps that exact factor', () => {
    expect(qcdYears.length).toBeGreaterThan(0);
    for (const y of qcdYears) {
      const expected = decemberFactor(y.year);
      expect(y.qcdInflationFactor).toBeCloseTo(expected, 10);
      expect(y.qcdCents).toBe(Math.round(GIFT_DOLLARS * expected * 100));
    }
  });

  it('gift chart/tile/PDF rows AND the split-bar amber offset both round-trip to the configured $10,000', () => {
    const rows = buildQcdRows({
      drawdown: {
        years,
        preRetirementConversionCentsByYear: new Map(),
      } as never,
      basisDeflator: (y) => 1 / decemberFactor(y),
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(rows.length).toBe(qcdYears.length);
    for (const r of rows) {
      expect(r.qcdDollars).toBeCloseTo(GIFT_DOLLARS, 2);
      // The gift is far below the ~$75k gross IRA RMD in every gift year, so the split-bar offset is the full gift and must equal
      // the configured amount on the shared year-end anchor.
      expect(r.rmdOffsetDollars).toBeCloseTo(GIFT_DOLLARS, 2);
    }
  });
});
